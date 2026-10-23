import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoverState } from "../src/cover-watch.js";
import { accountBook } from "../src/facts.js";
import { activate, type KeeperHarness, restingAsks, SYMBOL, startKeeper } from "./harness.js";

let h: KeeperHarness | undefined;
afterEach(async () => {
  h?.fake.releaseEngine();
  await h?.stop();
  h = undefined;
});
const wait = { timeout: 15_000, interval: 50 };

const keeperRequests = (x: KeeperHarness) => {
  const key = x.accounts[0]?.signer.publicKeyHex;
  return x.fake.requests.filter((r) => r.headers["x-api-wallet-public-key"] === key);
};

async function quoting(opts: Parameters<typeof startKeeper>[0] = {}) {
  const harness = await startKeeper(opts);
  h = harness;
  await activate(harness);
  harness.daemon.start();
  const id = harness.accounts[0]?.id as string;
  await vi.waitFor(() => expect(restingAsks(harness, id).length).toBeGreaterThan(0), wait);
  return { x: harness, id };
}

describe("invariant 10: stale data cancels", () => {
  const faults: [string, (x: KeeperHarness, id: string) => void][] = [
    ["index/mark older than 3 s", (x) => x.fake.market.pricePaused.add(SYMBOL)],
    ["a dead user stream", (x, id) => x.fake.dropUserSockets(id, 1011)],
    [
      "cover older than 60 s",
      (x, id) => {
        const st = x.cover.view(id) as CoverState;
        st.checkedAtMs -= 61_000;
      },
    ],
  ];
  for (const [name, inject] of faults) {
    it(`${name} cancels every resting ask`, async () => {
      const { x, id } = await quoting();
      inject(x, id);
      await vi.waitFor(() => expect(restingAsks(x, id)).toEqual([]), wait);
      const kill = x.db
        .decisions()
        .filter((d) => d.kind === "kill")
        .at(-1);
      expect(kill?.guard?.decision).toBe("execute");
    }, 30_000);
  }
});

describe("invariant 11: a kill is confirmed on both stream and L3, or retried and escalated", () => {
  it("a normal kill is confirmed with both timestamps", async () => {
    const { x, id } = await quoting();
    x.fake.market.pricePaused.add(SYMBOL);
    await vi.waitFor(() => expect(restingAsks(x, id)).toEqual([]), wait);
    await vi.waitFor(
      () =>
        expect(x.db.raw.prepare("SELECT status FROM kills").all()).toContainEqual({
          status: "confirmed",
        }),
      wait,
    );
    const row = x.db.raw.prepare("SELECT * FROM kills").get() as Record<string, number>;
    expect(row.stream_confirmed_ms).toBeGreaterThanOrEqual(row.sent_at_ms as number);
    expect(row.l3_confirmed_ms).toBeGreaterThanOrEqual(row.sent_at_ms as number);
    expect(x.daemon.kills.latencies.length).toBeGreaterThan(0);
  }, 30_000);

  it("an unconfirmed kill is retried (second cancel-all + per-order cancels) and escalated with a page", async () => {
    const { x, id } = await quoting();
    x.fake.holdEngine(); // cancels are sequenced but never run: nothing confirms
    x.fake.market.pricePaused.add(SYMBOL);
    await vi.waitFor(
      () =>
        expect(
          x.notifier.alerts.some(
            (a) => a.kind === "kill-escalated" && /10 s|unconfirmed/.test(a.title),
          ),
        ).toBe(true),
      wait,
    );
    const cancels = keeperRequests(x).filter((r) => r.target === "/v2/order/cancel-all");
    expect(cancels.length).toBeGreaterThanOrEqual(2);
    expect(keeperRequests(x).some((r) => r.target === "/v2/order/cancel")).toBe(true);
    // Every step of the kill path is a signed decision record, the retry included.
    const kills = x.db.decisions().filter((d) => d.kind === "kill");
    expect(kills.length).toBeGreaterThanOrEqual(3);
    expect(kills.some((d) => d.ops?.some((o) => o.route === "DELETE /v2/order/cancel"))).toBe(true);
    await vi.waitFor(
      () =>
        expect(x.db.raw.prepare("SELECT status FROM kills").get()).toEqual({ status: "escalated" }),
      wait,
    );
    x.fake.releaseEngine();
    await vi.waitFor(() => expect(restingAsks(x, id)).toEqual([]), wait);
  }, 40_000);
});

describe("invariant 13: no blind retries; silent drops detected; never a duplicate create", () => {
  it("a create the engine never ran is declared dropped after repeated 404s, and never resent", async () => {
    const x = await startKeeper();
    h = x;
    const id = x.accounts[0]?.id as string;
    x.fake.holdEngine();
    await activate(x);
    x.daemon.start();
    await vi.waitFor(() => expect(x.fake.createCommands.size).toBeGreaterThan(0), wait);
    const [first] = [...x.fake.createCommands.keys()];
    const rt = x.daemon.accounts[0];
    await vi.waitFor(
      () => expect(rt?.reconciler.order(first as string)?.status ?? "dropped").toBe("dropped"),
      wait,
    );
    const lookups = x.fake.requests.filter((r) => r.target.includes(`client_order_id=${first}`));
    expect(lookups.filter((r) => r.status === 404).length).toBeGreaterThanOrEqual(2);
    // The engine finally runs the command: the late order is counted as resting again, not resent.
    x.fake.releaseEngine();
    await vi.waitFor(() => expect(restingAsks(x, id).length).toBeGreaterThan(0), wait);
    for (const [cid, n] of x.fake.createCommands) expect(n, cid).toBe(1);
  }, 40_000);
});

describe("invariant 14: unknown counts as resting", () => {
  it("a create whose fate is unknown stays in exposure, in the DB, and across a restart", async () => {
    const x = await startKeeper();
    h = x;
    x.fake.holdEngine();
    // Lookups fail too: the create can be neither confirmed nor declared dropped.
    x.fake.failNext({ method: "GET", path: "/v2/order", status: 503, times: 10_000 });
    await activate(x);
    x.daemon.start();
    await vi.waitFor(() => expect(x.fake.createCommands.size).toBe(1), wait);
    const rt = x.daemon.accounts[0];
    const m = x.market.view(SYMBOL).market;
    if (!rt || !m) throw new Error("no runtime");
    const book = accountBook(rt, SYMBOL, m);
    expect(book.pendingSteps).toBeGreaterThan(0n);
    expect(x.db.exposure(rt.id, SYMBOL).askSteps).toBe(book.pendingSteps);
    // Five seconds unconfirmed: no new create may be sent, whatever moves.
    await new Promise((r) => setTimeout(r, 5_500));
    x.fake.market.setPrice(SYMBOL, { mark: "0.03845", index: "0.0384" });
    await new Promise((r) => setTimeout(r, 1_500));
    expect(x.fake.createCommands.size).toBe(1);
    // A crash leaves it 'pending'; the restart marks it 'unknown', still counted as resting.
    expect(x.db.reconcileOrphanedPending(Date.now())).toBe(1);
    expect(x.db.exposure(rt.id, SYMBOL).byStatus.unknown).toBe(book.pendingSteps);
  }, 40_000);
});
