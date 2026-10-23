import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  consume,
  type Dec,
  DOCUMENTED_MARK_PARAMS,
  dec,
  derivePosition,
  type FloorPosition,
  Grid,
  isolatedProfile,
  type Level,
  liquidationFloor,
  liquidationPrice,
  mergeLevels,
  min,
  parseMarginTiers,
  predictMark,
  type RawMarginTier,
} from "../src/index.js";

const NIGHT = parseMarginTiers(
  (
    JSON.parse(readFileSync(new URL("./fixtures/markets.json", import.meta.url), "utf8")) as {
      markets: Record<string, { margin_tiers: RawMarginTier[] }>;
    }
  ).markets["NIGHT-USD"]?.margin_tiers ?? [],
);
const market = {
  tick: new Grid("0.000001"),
  step: new Grid("1"),
  impactNotional: dec(1000),
  quotePrec: 8,
};
// The lemma does not depend on the window; a short one keeps 10k runs fast.
const params = { ...DOCUMENTED_MARK_PARAMS, basisWindow: 10 };

const arb = fc.record({
  indexMicro: fc.integer({ min: 30_000, max: 50_000 }),
  fRate: fc.integer({ min: -100, max: 100 }),
  minutesLeft: fc.integer({ min: 0, max: 60 }),
  longs: fc.array(
    fc.record({
      notional: fc.integer({ min: 100, max: 200_000 }),
      wShareBps: fc.integer({ min: 200, max: 3_000 }),
      entryBps: fc.integer({ min: -300, max: 300 }),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  bidOffBps: fc.integer({ min: 1, max: 80 }),
  bidQty: fc.integer({ min: 10_000, max: 500_000 }),
  house: fc.array(
    fc.record({
      off: fc.integer({ min: 1, max: 1_500 }),
      qty: fc.integer({ min: 100, max: 100_000 }),
    }),
    { maxLength: 4 },
  ),
  ballast: fc.array(
    fc.record({
      off: fc.integer({ min: 0, max: 200 }),
      qty: fc.integer({ min: 100, max: 20_000 }),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  basisBps: fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 10, maxLength: 10 }),
  prevMarkBps: fc.integer({ min: -60, max: 60 }),
  lastBps: fc.integer({ min: -150, max: 150 }),
  sweep: fc.double({ min: 0, max: 1, noNaN: true }),
});

function servedRow(
  x: Dec,
  l: { notional: number; wShareBps: number; entryBps: number },
): FloorPosition {
  const entry = x.times(dec(1).plus(dec(l.entryBps).div(10_000))).toDecimalPlaces(8);
  const size = dec(l.notional).div(entry).toDecimalPlaces(0).plus(1);
  const pos = {
    size: size.toFixed(),
    entryPrice: entry.toFixed(),
    leverage: 1,
    marginMode: "isolated" as const,
    isoBalance: dec(l.notional).times(l.wShareBps).div(10_000).toFixed(),
  };
  const d = derivePosition(pos, x, NIGHT, 8);
  const lp = liquidationPrice(pos, d, NIGHT, isolatedProfile(pos, d));
  return {
    size: pos.size,
    entryPrice: pos.entryPrice,
    markPrice: x.toFixed(),
    liquidationPrice: lp?.toFixed() ?? "0",
  };
}

describe("invariant 5: no Ballast fill at p ≥ F is the trade that liquidates a long", () => {
  it("under the median model, the next mark after a Ballast fill stays above every long's trigger", () => {
    const seen = { checked: 0, fallback: 0, impactFellBack: 0 };
    fc.assert(
      fc.property(arb, (a) => {
        const x = dec(a.indexMicro).div(1_000_000);
        const f = liquidationFloor({
          positions: a.longs.map((l) => servedRow(x, l)),
          tiers: NIGHT,
          positionsAgeMs: 0,
          mark: x,
          replicaP99Bps: dec(0),
          tick: market.tick,
        });
        if (!f.maxLongLp || f.ticks === 0n) return;
        const trigger = f.maxLongLp;
        const bestBid = market.tick.floorUnits(x.times(dec(1).minus(dec(a.bidOffBps).div(10_000))));
        // Ballast posts post-only asks at or above F, never crossing the bid.
        const lowest = f.ticks > bestBid ? f.ticks : bestBid + 1n;
        const ballast: Level[] = a.ballast.map((b) => ({
          px: lowest + BigInt(b.off),
          qty: BigInt(b.qty),
        }));
        const house: Level[] = a.house.map((h) => ({
          px: bestBid + BigInt(h.off),
          qty: BigInt(h.qty),
        }));
        const asks = mergeLevels(house, ballast, "ask");
        const book = { bids: [{ px: bestBid, qty: BigInt(a.bidQty) }], asks };
        const total = asks.reduce((s, l) => s + l.qty, 0n);
        const qtySteps = 1n + BigInt(Math.floor(a.sweep * Number(total)));
        const fills = consume(asks, "ask", qtySteps).fills;
        const ballastPx = new Set(ballast.map((b) => b.px));
        // Only sweeps that take a Ballast ask are Ballast fills.
        if (!fills.some((l) => ballastPx.has(l.px))) return;
        const nowMs = 1_000_000;
        const p = predictMark(
          {
            basis: a.basisBps.map((b) => x.times(b).div(10_000)),
            prevMark: x.times(dec(1).plus(dec(a.prevMarkBps).div(10_000))),
            last: x.times(dec(1).plus(dec(a.lastBps).div(10_000))),
            prevFundingRate: dec(a.fRate).div(1_000_000),
          },
          book,
          { nowMs, index: x, nextFundingMs: nowMs + a.minutesLeft * 60_000 },
          market,
          params,
          { side: "ask", qtySteps },
        );
        const before = p.before;
        const after = p.after;
        if (!before || !after) throw new Error("a positive index always gives a mark");
        // A long already below its trigger dies with or without Ballast.
        if (!before.candidate.gt(trigger)) return;
        // Two exits from the median model, both P2's: the δ fallback, and a sweep that leaves
        // the ask side short of the impact notional (impact ask → index). Invariant 6's P2
        // constraint covers those; count them so the property cannot pass vacuously.
        if (after.fallbackToP2) {
          seen.fallback += 1;
          return;
        }
        if (after.p2.lt(before.p2)) {
          seen.impactFellBack += 1;
          return;
        }
        seen.checked += 1;
        // The fill's last price is ≥ F, so P3′ ≥ F; P1 is unchanged and P2′ ≥ P2 ≥ ... hence
        // mark′ ≥ min(mark, F).
        expect(after.p3.gte(f.px)).toBe(true);
        expect(after.candidate.gte(min(before.candidate, f.px))).toBe(true);
        expect(after.mark.gt(trigger)).toBe(true);
      }),
      { numRuns: 10_000 },
    );
    expect(seen.checked).toBeGreaterThan(2_000);
  });
});
