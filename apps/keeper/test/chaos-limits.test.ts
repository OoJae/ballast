import { afterEach, describe, expect, it, vi } from "vitest";
import { activate, type KeeperHarness, restingAsks, SYMBOL, startKeeper } from "./harness.js";

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
