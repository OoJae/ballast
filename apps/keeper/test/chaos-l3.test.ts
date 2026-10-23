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
