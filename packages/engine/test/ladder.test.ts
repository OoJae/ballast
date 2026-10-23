import { microUsd, notionalCeil, refPrice, ticks } from "@ballast/core";
import { dec } from "@ballast/market";
import { describe, expect, it } from "vitest";
import {
  buildLadder,
  capLadderNotional,
  engineMarket,
  type LadderInput,
  LEVEL_RATIONS,
  REFERENCE_MARKETS,
} from "../src/index.js";
import { NIGHT } from "./helpers.js";

const index = refPrice(NIGHT.tick, "0.0383");
const base = (over: Partial<LadderInput> = {}): LadderInput => ({
  floorTicks: ticks(0n),
  index,
  minOffsetBps: 38n,
  spacingBps: [10n, 25n],
  levels: 3,
  bestAskTicks: ticks(38_750n),
  minImprovementBps: 5n,
  rations: [...LEVEL_RATIONS],
  rate: NIGHT.rate,
  ...over,
});

describe("ladder (plan section 5)", () => {
  it("L1 = ceil(index × 1.0038); L2 = L1 + 10 bps; L3 = L1 + 25 bps, all ceil to tick", () => {
    const r = buildLadder(base());
    if (!r.ok) throw new Error(r.detail);
    // 0.0383 × 1.0038 = 0.03844554 → 38446 ticks
    expect(r.l1).toBe(38_446n);
    // 38446 × 1.001 = 38484.446 → 38485; × 1.0025 = 38542.115 → 38543
    expect(r.levels.map((l) => l.px)).toEqual([38_446n, 38_485n, 38_543n]);
    // Rations $300 / $700 / $1,500 at each level's price, floored to whole NIGHT.
    expect(r.levels.map((l) => l.qty)).toEqual([7_803n, 18_188n, 38_917n]);
    for (const l of r.levels) expect(notionalCeil(l.px, l.qty, NIGHT.rate) <= l.ration).toBe(true);
  });

  it("L1 is the max of F, the P2-safe price, the mark and the index offset", () => {
    expect(buildLadder(base({ floorTicks: ticks(38_600n) }))).toMatchObject({ l1: 38_600n });
    expect(buildLadder(base({ p2SafeTicks: ticks(38_610n) }))).toMatchObject({ l1: 38_610n });
    expect(buildLadder(base({ markTicks: ticks(38_620n) }))).toMatchObject({ l1: 38_620n });
  });

  it("arms only while L1 ≤ best non-Ballast ask − 5 bps", () => {
    // 38750 × 0.9995 = 38730.6 → 38730
    expect(buildLadder(base({ floorTicks: ticks(38_730n) })).ok).toBe(true);
    expect(buildLadder(base({ floorTicks: ticks(38_731n) }))).toMatchObject({
      ok: false,
      reason: "no-improvement",
    });
    expect(buildLadder(base({ bestAskTicks: null }))).toMatchObject({
      ok: false,
      reason: "no-reference-ask",
    });
  });

  it("keeps levels strictly increasing even where a bps step is under one tick", () => {
    const ada = engineMarket({ ...REFERENCE_MARKETS["ADA-USD"], order_tick_price: "0.01" });
    const r = buildLadder(
      base({
        index: refPrice(ada.tick, "0.21"),
        minOffsetBps: 5n,
        spacingBps: [1n, 2n],
        bestAskTicks: ticks(30n),
        rate: ada.rate,
      }),
    );
    if (!r.ok) throw new Error(r.detail);
    expect(r.levels.map((l) => l.px)).toEqual([22n, 23n, 24n]);
  });

  it("refuses a level count the spacing cannot support", () => {
    expect(buildLadder(base({ spacingBps: [10n] }))).toMatchObject({
      ok: false,
      reason: "bad-input",
    });
  });

  it("caps the total notional near-first (P2-blind $300)", () => {
    const r = buildLadder(base());
    if (!r.ok) throw new Error(r.detail);
    const capped = capLadderNotional(r.levels, microUsd(300_000_000n), NIGHT.rate);
    expect(capped).toHaveLength(1);
    expect(capped[0]?.level).toBe(1);
    const two = capLadderNotional(r.levels, microUsd(500_000_000n), NIGHT.rate);
    expect(two.map((l) => l.level)).toEqual([1, 2]);
    const total = two.reduce((s, l) => s + notionalCeil(l.px, l.qty, NIGHT.rate), 0n);
    expect(total <= 500_000_000n).toBe(true);
    expect(dec(total.toString()).gt(499_000_000)).toBe(true);
  });
});
