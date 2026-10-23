import { microUsd, steps, ticks } from "@ballast/core";
import { describe, expect, it } from "vitest";
import {
  type AllocAccount,
  allocate,
  BALLAST_MIN_NOTIONAL,
  DEFAULT_MARGIN_THRESHOLDS,
  evaluateMarginBand,
  type KeeperInput,
  keeperStep,
} from "../src/index.js";
import { NIGHT } from "./helpers.js";

/** Findings from the M3 review, each pinned so it cannot come back. */
const margin = evaluateMarginBand(1_000n, DEFAULT_MARGIN_THRESHOLDS, {
  quoting: true,
  lastBand: "ok",
});
const k = (over: Partial<KeeperInput>): KeeperInput => ({
  symbol: "NIGHT-USD",
  shortSteps: steps(0n),
  restingSteps: steps(0n),
  unknownOrders: 0,
  coverSteps: steps(100_000n),
  rBps: 5_000n,
  mempoolSpend: null,
  stale: [],
  margin,
  lossStop: false,
  ...over,
});

describe("keeper fails closed", () => {
  it("an order of unknown size at full capacity is a breach: cancel-all", () => {
    const d = keeperStep(k({ shortSteps: steps(50_000n), unknownOrders: 1 }));
    expect(d.breach).toBe(true);
    expect(d.actions.map((a) => a.kind)).toEqual(["cancel-all"]);
    expect(d.allowCreates).toBe(false);
    // Any unknown order is cancelled to resolve it, even with room to spare.
    expect(keeperStep(k({ unknownOrders: 1 })).actions.map((a) => a.kind)).toEqual(["cancel-all"]);
  });

  it("a pending spend never raises capacity above the confirmed cover", () => {
    const d = keeperStep(
      k({ shortSteps: steps(60_000n), mempoolSpend: { coverAfterSteps: steps(200_000n) } }),
    );
    expect(d.capacity).toBe(50_000n);
    expect(d.actions).toEqual([
      { kind: "buy-back", symbol: "NIGHT-USD", qty: 10_000n, reason: "short above r × cover" },
    ]);
  });
});

describe("allocator: many small equal accounts still fill L1", () => {
  it("drops the smallest shares one at a time until the rest clear $10.50", () => {
    const accounts: AllocAccount[] = Array.from({ length: 30 }, (_, i) => ({
      id: `acct-${String(i).padStart(2, "0")}`,
      holder0: false,
      committed: steps(50_000n),
      used: steps(0n),
      room: steps(50_000n),
      usdRoom: microUsd(10n ** 12n),
    }));
    const r = allocate(accounts, [{ level: 1, px: ticks(38_446n), qty: steps(7_803n) }], {
      rate: NIGHT.rate,
      minNotional: BALLAST_MIN_NOTIONAL,
      aggregateRoom: microUsd(10n ** 12n),
    });
    // 7,803 / 28 = 278.7 steps ≈ $10.71 each; 29 would be $10.34.
    expect(r.allocations).toHaveLength(28);
    expect(r.allocations.reduce((s, a) => s + a.qty, 0n)).toBe(7_803n);
    expect(r.unallocated).toEqual([]);
  });
});
