/**
 * Chaos at the keeper, against the fake Strike: dropped user-stream events, a replace-batch
 * partial reject and a cover spend mid-quote. The keeper fails closed, never resends a create,
 * and recovers once the fault clears. (L3 faults: chaos-l3; 429s and clock skew: chaos-limits;
 * the keeper crash, which needs the watchdog: apps/watchdog/test/watchdog.test.ts.)
 */
import { defaultQuotePolicy } from "@ballast/core";
import { clientOrderId } from "@ballast/engine";
import { signPolicy } from "@ballast/governance";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activate,
  type KeeperHarness,
  operator,
  passReport,
  restingAsks,
  SYMBOL,
  startKeeper,
} from "./harness.js";

let h: KeeperHarness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});
const wait = { timeout: 15_000, interval: 50 };

async function quoting(opts: Parameters<typeof startKeeper>[0] = {}) {
  const harness = await startKeeper(opts);
  h = harness;
  await activate(harness);
  harness.daemon.start();
  const id = harness.accounts[0]?.id as string;
  await vi.waitFor(() => expect(restingAsks(harness, id).length).toBeGreaterThan(0), wait);
  return { h: harness, id };
}

/** No client order id was ever sent twice (invariant 13). */
function noDuplicateCreates(x: KeeperHarness): void {
  for (const [cid, n] of x.fake.createCommands) expect(n, cid).toBe(1);
}

describe("chaos: dropped user-stream events", () => {
  it("a create with no events is confirmed by the REST lookup, never resent", async () => {
    const harness = await startKeeper();
    h = harness;
    const id = harness.accounts[0]?.id as string;
    harness.fake.setEventFilter((acct, msg) => acct === id && msg.e === "ORDER_TRADE_UPDATE");
    await activate(harness);
    harness.daemon.start();
    await vi.waitFor(() => expect(restingAsks(harness, id).length).toBe(1), wait);
    const cid = restingAsks(harness, id)[0]?.clientOrderId as string;
    const rt = harness.daemon.accounts[0];
    // PendingCreates looks the silent create up after 2 s and adopts it as open.
    await vi.waitFor(() => expect(rt?.reconciler.order(cid)?.status).toBe("open"), wait);
    expect(
      harness.fake.requests.some((r) =>
        r.target.startsWith(`/v2/order?symbol=${SYMBOL}&client_order_id=${cid}`),
      ),
    ).toBe(true);
    noDuplicateCreates(harness);
    expect(restingAsks(harness, id)).toHaveLength(1);
  }, 30_000);
});

describe("chaos: replace-batch partial reject", () => {
  it("the far create is rejected, the near one is skipped silently and declared dropped, never resent", async () => {
    const harness = await startKeeper();
    h = harness;
    const id = harness.accounts[0]?.id as string;
    // A $100 L1 refill leaves room for L2 under the $300 P2-blind cap: two creates per batch.
    const base = defaultQuotePolicy({
      policyId: "01JKEEPERCHA0S000000000000",
      validFromMs: Date.now() - 60_000,
    });
    const signed = signPolicy(
      { ...base, sizing: { ...base.sizing, l1RefillMicroUsd: "100000000" } },
      operator,
    );
    const report = await passReport(signed);
    expect(harness.daemon.activatePolicy(signed, report).ok).toBe(true);
    const head = harness.daemon.log.head().seq;
    const rejectable: string[] = [];
    for (let s = head + 1; s <= head + 8; s++) {
      const cid = clientOrderId({
        policyHash: signed.hash,
        accountId: id,
        level: 2,
        seq: BigInt(s),
      });
      rejectable.push(cid);
      harness.fake.engine.forcedRejects.set(cid, "insufficient_margin");
    }
    harness.daemon.start();
    // The far level (L2) is rejected first (far-to-near), so the batch stops before L1.
    await vi.waitFor(
      () =>
        expect(
          rejectable.some((c) => harness.fake.engine.findByClientId(id, c)?.status === "rejected"),
        ).toBe(true),
      wait,
    );
    harness.fake.engine.forcedRejects.clear();
    const rejected = rejectable.find(
      (c) => harness.fake.engine.findByClientId(id, c)?.status === "rejected",
    ) as string;
    const l1 = rejected.replace(/_2_([0-9a-z]+)$/, "_1_$1");
    expect(harness.fake.engine.findByClientId(id, l1)).toBeUndefined();
    const rt = harness.daemon.accounts[0];
    // Two 404 lookups declare the skipped L1 dropped; it is never sent again.
    await vi.waitFor(
      () => expect(rt?.reconciler.order(l1)?.status ?? "dropped").toBe("dropped"),
      wait,
    );
    expect(harness.fake.createCommands.get(l1)).toBe(1);
    await vi.waitFor(() => expect(restingAsks(harness, id).length).toBe(2), wait);
    noDuplicateCreates(harness);
  }, 60_000);
});

describe("chaos: cover spent mid-quote", () => {
  it("an unconfirmed spend of the cover cancels every ask at once and blocks creates until a new proof", async () => {
    const { h: x, id } = await quoting();
    x.cover.spend(id);
    await vi.waitFor(() => expect(restingAsks(x, id)).toEqual([]), wait);
    const kill = x.db
      .decisions()
      .filter((d) => d.kind === "kill")
      .at(-1);
    expect(kill?.ops?.[0]?.route).toBe("DELETE /v2/order/cancel-all");
    const creates = () =>
      x.fake.requests.filter(
        (r) => r.target === "/v2/order/replace-batch" && r.body.includes("new_order"),
      ).length;
    const n = creates();
    await new Promise((r) => setTimeout(r, 1_000));
    expect(creates()).toBe(n);
    x.cover.set(id, x.accounts[0]?.label as string, 200_000n);
    await vi.waitFor(() => expect(restingAsks(x, id).length).toBeGreaterThan(0), wait);
  }, 40_000);
});
