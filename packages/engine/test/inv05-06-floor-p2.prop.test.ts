import {
  basisSample,
  bookTop,
  consume,
  type Dec,
  DOCUMENTED_MARK_PARAMS,
  dec,
  type FloorPosition,
  type Level,
  type LevelBook,
  longTriggerPrice,
  mergeLevels,
  POSITIONS_STALE_MS,
  projectP2Path,
} from "@ballast/market";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { govern, NIGHT_CAPS } from "../src/index.js";
import { NIGHT, POLICY } from "./helpers.js";

/**
 * Invariant 5: every admitted ask is ≥ F (and ≥ mark when positions are stale; P2-blind mode
 * always clears the mark). Invariant 6: under the replica, the projected P2 of the admitted
 * ladder, of every partly filled state of it and of the book without it stays ≥ the
 * liquidation target; otherwise the governor stands down.
 */
const params = { ...DOCUMENTED_MARK_PARAMS, basisWindow: 10 };

const arb = fc.record({
  indexMicro: fc.integer({ min: 30_000, max: 45_000 }),
  markBps: fc.integer({ min: -60, max: 90 }),
  bidOffBps: fc.integer({ min: 1, max: 60 }),
  bidQty: fc.bigInt({ min: 5_000n, max: 600_000n }),
  askOffBps: fc.integer({ min: 20, max: 200 }),
  asks: fc.array(
    fc.record({
      gap: fc.integer({ min: 1, max: 60 }),
      qty: fc.bigInt({ min: 100n, max: 200_000n }),
    }),
    { minLength: 1, maxLength: 4 },
  ),
  longs: fc.array(
    fc.record({
      lpBps: fc.integer({ min: -400, max: 120 }),
      size: fc.integer({ min: 1_000, max: 2_000_000 }),
    }),
    { maxLength: 3 },
  ),
  stale: fc.boolean(),
  p99: fc.integer({ min: 0, max: 300 }),
  basisBps: fc.array(fc.integer({ min: -40, max: 80 }), { minLength: 10, maxLength: 10 }),
  replica: fc.boolean(),
  takeShare: fc.integer({ min: 0, max: 100 }),
});

type Arb = typeof arb extends fc.Arbitrary<infer T> ? T : never;

function scenario(a: Arb) {
  const index = dec(a.indexMicro).div(1_000_000);
  const mark = index.times(dec(1).plus(dec(a.markBps).div(10_000))).toDecimalPlaces(8);
  const center = BigInt(a.indexMicro);
  const bid = center - (center * BigInt(a.bidOffBps)) / 10_000n;
  let ask = center + (center * BigInt(a.askOffBps)) / 10_000n;
  const asks: Level[] = [];
  for (const l of a.asks) {
    asks.push({ px: ask, qty: l.qty });
    ask += BigInt(l.gap) * 10n;
  }
  const book: LevelBook = { bids: [{ px: bid, qty: a.bidQty }], asks };
  const positions: FloorPosition[] = a.longs.map((l) => ({
    size: String(l.size),
    entryPrice: index.toFixed(),
    markPrice: index.toFixed(),
    liquidationPrice: index
      .times(dec(1).plus(dec(l.lpBps).div(10_000)))
      .toDecimalPlaces(8)
      .toFixed(),
  }));
  const basis = a.basisBps.map((b) => index.times(b).div(10_000));
  return { index, mark, book, positions, basis };
}

describe("invariants 5 and 6: floor and P2 constraint on the admitted ladder", () => {
  it("every admitted ask is ≥ F, ≥ index + 38 bps, and ≥ mark when stale or P2-blind", () => {
    const seen = { ok: 0, floorBound: 0 };
    fc.assert(
      fc.property(arb, (a) => {
        const s = scenario(a);
        const r = govern({
          market: NIGHT,
          caps: NIGHT_CAPS,
          policy: POLICY,
          book: s.book,
          index: s.index,
          mark: s.mark,
          positions: s.positions,
          positionsAgeMs: a.stale ? POSITIONS_STALE_MS + 1 : 1_000,
          replicaP99Bps: dec(a.p99).div(100),
          p2: a.replica
            ? { mode: "replica", params, basis: s.basis, basisGapFree: true }
            : { mode: "blind" },
        });
        if (!r.ok) return;
        seen.ok += 1;
        const bLiq = dec(10).plus(dec(a.p99).div(50));
        const fromIndex = NIGHT.tick.ceilUnits(s.index.times("1.0038"));
        const markTicks = NIGHT.tick.ceilUnits(s.mark);
        for (const p of s.positions) {
          const t = longTriggerPrice(p, NIGHT.spec.tiers);
          if (!t) continue;
          // F is at or above every long's trigger × (1 + b_liq), checked independently.
          expect(
            NIGHT.tick.fromUnits(r.floor.ticks).gte(t.times(dec(1).plus(bLiq.div(10_000)))),
          ).toBe(true);
        }
        for (const l of r.ladder) {
          expect(l.px >= r.floor.ticks).toBe(true);
          expect(l.px >= fromIndex).toBe(true);
          if (a.stale || r.mode === "blind") expect(l.px >= markTicks).toBe(true);
        }
        if (r.floor.ticks > fromIndex) seen.floorBound += 1;
      }),
      { numRuns: 10_000 },
    );
    expect(seen.ok).toBeGreaterThan(1_000);
    expect(seen.floorBound).toBeGreaterThan(50);
  });

  it("the replica-admitted ladder keeps projected P2 ≥ target in every partly filled state", () => {
    const seen = { ok: 0, targeted: 0, standDown: 0 };
    fc.assert(
      fc.property(arb, (a) => {
        const s = scenario(a);
        const r = govern({
          market: NIGHT,
          caps: NIGHT_CAPS,
          policy: POLICY,
          book: s.book,
          index: s.index,
          mark: s.mark,
          positions: s.positions,
          positionsAgeMs: 1_000,
          replicaP99Bps: dec(a.p99).div(100),
          p2: { mode: "replica", params, basis: s.basis, basisGapFree: true },
        });
        if (!r.ok) {
          seen.standDown += 1;
          return;
        }
        seen.ok += 1;
        const target = r.floor.liquidationTarget;
        if (!target) return;
        seen.targeted += 1;
        const minP2 = (asks: Level[]): Dec =>
          projectP2Path(
            s.basis,
            basisSample(bookTop({ bids: s.book.bids, asks }, NIGHT.spec, 0), s.index, "impact"),
            s.index,
            params.basisWindow,
          ).reduce((x, y) => (x.lt(y) ? x : y));
        const ladder = r.ladder.map((l) => ({ px: l.px as bigint, qty: l.qty as bigint }));
        const full = mergeLevels(s.book.asks, ladder, "ask");
        expect(minP2(full).gte(target)).toBe(true);
        expect(minP2(s.book.asks).gte(target)).toBe(true);
        // A taker buy that lifts part of the ladder (and possibly beyond).
        const total = ladder.reduce((x, l) => x + l.qty, 0n);
        const take = (total * BigInt(a.takeShare)) / 100n;
        const after = consume(full, "ask", take).rest;
        expect(minP2(after).gte(target)).toBe(true);
      }),
      { numRuns: 10_000 },
    );
    expect(seen.targeted).toBeGreaterThan(300);
    expect(seen.standDown).toBeGreaterThan(300);
  });
});
