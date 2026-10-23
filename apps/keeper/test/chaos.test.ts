/**
 * Chaos at the keeper, against the fake Strike: dropped user-stream events, an L3 gap and an L3
 * `clear`, a 429 storm, a replace-batch partial reject, a cover spend mid-quote, and clock skew.
 * In every case the keeper fails closed, cancels what it must, never resends a create, and
 * recovers once the fault clears. (The keeper-crash case, which needs the watchdog, is in
 * apps/watchdog/test/chaos.test.ts.)
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

const cancelAlls = (x: KeeperHarness) =>
  x.fake.requests.filter((r) => r.method === "DELETE" && r.target === "/v2/order/cancel-all");

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

describe("chaos: L3 gap and clear", () => {
  for (const fault of ["gap", "clear"] as const) {
    it(`an L3 ${fault} cancels resting asks while the book is rebuilt, then quoting resumes`, async () => {
      const { h: x, id } = await quoting({ rebuildCooldownMs: 1_500 });
      const before = cancelAlls(x).length;
      if (fault === "gap") {
        x.fake.market.injectL3Gap(SYMBOL);
        x.fake.engine.restMarketOrder(SYMBOL, "buy", "0.0382", "1000");
      } else {
        x.fake.market.injectL3Clear(SYMBOL);
      }
      await vi.waitFor(() => expect(cancelAlls(x).length).toBeGreaterThan(before), wait);
      await vi.waitFor(() => expect(restingAsks(x, id)).toEqual([]), wait);
      const kill = x.db.decisions().find((d) => d.kind === "kill");
      expect(kill?.guard?.decision).toBe("execute");
      // Rebuilt: the book is gap-free again and the keeper quotes again.
      await vi.waitFor(() => expect(restingAsks(x, id).length).toBeGreaterThan(0), wait);
      noDuplicateCreates(x);
    }, 40_000);
  }
});

describe("chaos: 429 storm", () => {
  it("three 429s pause creates for 30 s; cancels still go through", async () => {
    const { h: x, id } = await quoting();
    x.fake.failNext({ path: "/v2/order/replace-batch", status: 429, times: 3 });
    const moves = ["0.03834", "0.03838", "0.03842"];
    for (const idx of moves) {
      x.fake.market.setPrice(SYMBOL, { mark: (Number(idx) + 0.00005).toFixed(6), index: idx });
      await vi.waitFor(
        () =>
          expect(x.fake.requests.filter((r) => r.status === 429).length).toBeGreaterThan(
            moves.indexOf(idx),
          ),
        wait,
      );
    }
    await vi.waitFor(() => expect(x.rate.pausedUntil).toBeGreaterThan(Date.now()), wait);
    // While paused the Guard refuses creates (rate-budget) and records the trip.
    x.fake.market.setPrice(SYMBOL, { mark: "0.03851", index: "0.03846" });
    await vi.waitFor(
      () => expect(x.db.guardTrips().some((t) => t.ruleId === "rate-budget")).toBe(true),
      wait,
    );
    const createsWhilePaused = x.fake.requests.filter(
      (r) => r.target === "/v2/order/replace-batch" && r.status === 200,
    ).length;
    // A stale index must still cancel, pause or not.
    x.fake.market.pricePaused.add(SYMBOL);
    await vi.waitFor(() => expect(restingAsks(x, id)).toEqual([]), wait);
    expect(cancelAlls(x).some((r) => r.status === 200)).toBe(true);
    expect(
      x.fake.requests.filter((r) => r.target === "/v2/order/replace-batch" && r.status === 200)
        .length,
    ).toBe(createsWhilePaused);
    noDuplicateCreates(x);
  }, 60_000);
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

describe("chaos: clock skew", () => {
  for (const skewMs of [200_000, -60_000]) {
    it(`a ${skewMs > 0 ? "server-ahead" : "server-behind"} skew of ${Math.abs(skewMs) / 1000} s is resynced; nothing is resent blindly`, async () => {
      const { h: x, id } = await quoting();
      x.fake.skewMs = skewMs;
      x.fake.market.setPrice(SYMBOL, { mark: "0.03845", index: "0.0384" });
      await vi.waitFor(
        () =>
          expect(
            x.fake.requests.some(
              (r) => r.status === 401 && r.response.includes("signature expired"),
            ),
          ).toBe(true),
        wait,
      );
      await vi.waitFor(() => expect(Math.abs(x.clock.offsetMs - skewMs)).toBeLessThan(2_000), wait);
      // The requote lands after the resync: the ask now sits above the moved index.
      await vi.waitFor(
        () => expect(restingAsks(x, id).some((o) => o.price > 38_446_000_000_000_000n)).toBe(true),
        { timeout: 20_000, interval: 50 },
      );
      noDuplicateCreates(x);
    }, 40_000);
  }
});
