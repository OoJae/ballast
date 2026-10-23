import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bLiqBps,
  bLiqFromFit,
  type Dec,
  dec,
  derivePosition,
  errorStats,
  type FloorPosition,
  fragileLongs,
  Grid,
  isolatedProfile,
  liquidationFloor,
  liquidationPrice,
  longTriggerPrice,
  type MarginTier,
  POSITIONS_STALE_MS,
  parseMarginTiers,
  positionsStale,
  type RawMarginTier,
} from "../src/index.js";

const tick = new Grid("0.000001");
const markets = JSON.parse(
  readFileSync(new URL("./fixtures/markets.json", import.meta.url), "utf8"),
) as { markets: Record<string, { margin_tiers: RawMarginTier[] }> };
const NIGHT = parseMarginTiers(markets.markets["NIGHT-USD"]?.margin_tiers ?? []);

/** MB − MM at mark `px` with the tier the engine would use there (strike-calculations). */
function marginSurplus(w: Dec, entry: Dec, size: Dec, px: Dec, tiers: readonly MarginTier[]): Dec {
  const notional = px.times(size);
  let t = tiers[tiers.length - 1] as MarginTier;
  for (const x of tiers) {
    if (notional.lte(x.maxNotional)) {
      t = x;
      break;
    }
  }
  return w.plus(px.minus(entry).times(size)).minus(notional.times(t.mmr).minus(t.ma));
}

/** A long whose served LP is computed exactly as Strike serves it: the tier at the served mark. */
function servedLong(
  w: Dec,
  entry: Dec,
  size: Dec,
  mark: Dec,
  tiers: readonly MarginTier[],
): FloorPosition {
  const pos = {
    size: size.toFixed(),
    entryPrice: entry.toFixed(),
    leverage: 1,
    marginMode: "isolated" as const,
    isoBalance: w.toFixed(),
  };
  const d = derivePosition(pos, mark, tiers, 30);
  const lp = liquidationPrice(pos, d, tiers, isolatedProfile(pos, d));
  return {
    size: pos.size,
    entryPrice: pos.entryPrice,
    markPrice: mark.toFixed(),
    liquidationPrice: lp?.toFixed() ?? "0",
  };
}

const micro = (lo: number, hi: number) =>
  fc.integer({ min: lo, max: hi }).map((n) => dec(n).div(1_000_000));

/** Random valid tier schedules: ascending notional, non-decreasing MMR, non-increasing leverage. */
const arbTiers = fc
  .record({
    base: fc.integer({ min: 500, max: 50_000 }),
    steps: fc.array(
      fc.record({
        grow: fc.integer({ min: 2, max: 6 }),
        dMmrTenths: fc.integer({ min: 0, max: 80 }),
      }),
      { minLength: 0, maxLength: 7 },
    ),
    mmr0Tenths: fc.integer({ min: 10, max: 300 }),
  })
  .map(({ base, steps, mmr0Tenths }) => {
    let n = base;
    let mmr = mmr0Tenths;
    const raw: RawMarginTier[] = [
      { max_notional: String(n), max_leverage: 50, maintenance_margin_rate: `${mmr / 10_000}` },
    ];
    for (const s of steps) {
      n *= s.grow;
      mmr = Math.min(mmr + s.dMmrTenths * 10, 9_000);
      raw.push({
        max_notional: String(n),
        max_leverage: 1,
        maintenance_margin_rate: `${mmr / 10_000}`,
      });
    }
    return parseMarginTiers(raw);
  });

/** A long sized to span a few tiers, with W′ from far over- to thinly collateralized. */
const arbLong = fc.record({
  entry: micro(10_000, 2_000_000),
  markMove: fc.integer({ min: -300, max: 300 }),
  notional: fc.integer({ min: 100, max: 5_000_000 }),
  wShareBps: fc.integer({ min: 100, max: 12_000 }),
});

function buildLong(
  l: { entry: Dec; markMove: number; notional: number; wShareBps: number },
  tiers: readonly MarginTier[],
) {
  const mark = l.entry.times(dec(1).plus(dec(l.markMove).div(10_000))).toDecimalPlaces(8);
  const size = dec(l.notional).div(l.entry).toDecimalPlaces(0).plus(1);
  const w = dec(l.notional).times(l.wShareBps).div(10_000);
  return { mark, size, w, row: servedLong(w, l.entry, size, mark, tiers) };
}

describe("tier-consistent long trigger", () => {
  it("is exactly where MB meets the MM of the tier in force there, and never below the served LP", () => {
    let crossed = 0;
    fc.assert(
      fc.property(arbTiers, arbLong, (tiers, l) => {
        const { size, w, row } = buildLong(l, tiers);
        const trigger = longTriggerPrice(row, tiers);
        const served = dec(row.liquidationPrice);
        if (served.gt(0)) {
          if (!trigger) throw new Error("a served LP always has a trigger");
          expect(trigger.gte(served)).toBe(true);
          if (trigger.gt(served)) crossed += 1;
          // The root of MB − MM_actual: zero there (to rounding), negative just below.
          const tol = dec(l.notional).times("1e-15");
          expect(marginSurplus(w, l.entry, size, trigger, tiers).abs().lte(tol)).toBe(true);
          const below = trigger.times("0.999999");
          expect(marginSurplus(w, l.entry, size, below, tiers).lt(0)).toBe(true);
        }
        // Above the trigger (or anywhere, without one) the long is never liquidatable.
        const above = (trigger ?? dec(0)).times("1.000001").plus("0.00000001");
        expect(marginSurplus(w, l.entry, size, above, tiers).gt(0)).toBe(true);
      }),
      { numRuns: 10_000 },
    );
    // The generator really exercises tier drops.
    expect(crossed).toBeGreaterThan(500);
  });

  it("F keeps MB above the actual-tier MM for every long, at F and at every mark above it", () => {
    fc.assert(
      fc.property(
        arbTiers,
        fc.array(arbLong, { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 10_000 }),
        (tiers, longs, p99Ten, upBps) => {
          const built = longs.map((l) => ({ ...buildLong(l, tiers), entry: l.entry }));
          const f = liquidationFloor({
            positions: built.map((b) => b.row),
            tiers,
            positionsAgeMs: 0,
            mark: dec("0.0384"),
            replicaP99Bps: dec(p99Ten).div(10),
            tick,
          });
          const at = [f.px, f.px.times(dec(1).plus(dec(upBps).div(10_000)))];
          for (const b of built) {
            for (const px of at) {
              if (px.isZero()) continue;
              expect(marginSurplus(b.w, b.entry, b.size, px, tiers).gt(0)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it("catches the recorded case: a NIGHT cross long whose real trigger is a tier below", () => {
    // 131,000 NIGHT at 0.0384 (tier 1 at the mark), W′ = 1,059.24: served LP 0.0307000196.
    const row = servedLong(dec("1059.24"), dec("0.0384"), dec(131_000), dec("0.0384"), NIGHT);
    const served = dec(row.liquidationPrice);
    const trigger = longTriggerPrice(row, NIGHT);
    if (!trigger) throw new Error("trigger");
    // At the served LP the notional is in tier 0, whose MM is higher: liquidated already.
    expect(marginSurplus(dec("1059.24"), dec("0.0384"), dec(131_000), served, NIGHT).lt(0)).toBe(
      true,
    );
    expect(trigger.minus(served).div(served).times(10_000).gt(24)).toBe(true);
    const f = liquidationFloor({
      positions: [row],
      tiers: NIGHT,
      positionsAgeMs: 0,
      mark: dec("0.0384"),
      replicaP99Bps: dec("0.6152"),
      tick,
    });
    expect(f.tierAdjusted).toBe(1);
    expect(f.px.gte(trigger.times("1.001123"))).toBe(true);
    expect(marginSurplus(dec("1059.24"), dec("0.0384"), dec(131_000), f.px, NIGHT).gt(0)).toBe(
      true,
    );
  });

  it('bounds a served "0" by the lower tiers, and ignores it in tier 0', () => {
    // 1x long, notional 30,000 (tier 3 on NIGHT): no trigger in its tier; the lower tiers can
    // only be bounded, conservatively.
    const size = dec(781_250);
    const high = servedLong(dec(30_000), dec("0.0384"), size, dec("0.0384"), NIGHT);
    expect(high.liquidationPrice).toBe("0");
    const bound = longTriggerPrice(high, NIGHT);
    expect(bound?.gt(0)).toBe(true);
    expect(marginSurplus(dec(30_000), dec("0.0384"), size, bound ?? dec(0), NIGHT).gte(0)).toBe(
      true,
    );
    const low = servedLong(dec(100), dec("0.0384"), dec(2_000), dec("0.0384"), NIGHT);
    expect(low.liquidationPrice).toBe("0");
    expect(longTriggerPrice(low, NIGHT)).toBeNull();
  });
});

/**
 * LPs below the 0.0384 mark with arbitrary precision (served values carry up to 36 digits),
 * including "0" (none).
 */
const arbLp = fc.oneof(
  fc.constant("0"),
  fc
    .tuple(fc.integer({ min: 1, max: 38_399 }), fc.bigInt({ min: 0n, max: 10n ** 30n - 1n }))
    .map(([i, frac]) => `0.0${String(i).padStart(5, "0")}${frac.toString().padStart(30, "0")}`),
);
// Tier 0 at the mark (notional ≤ 5,000 on NIGHT) and so at every lower price: the trigger is the
// served LP itself.
const arbPos = fc.record({
  size: fc
    .integer({ min: -100_000, max: 100_000 })
    .filter((n) => n !== 0)
    .map(String),
  entryPrice: fc.constant("0.0384"),
  markPrice: fc.constant("0.0384"),
  liquidationPrice: arbLp,
});
const arbInput = fc.record({
  positions: fc.array(arbPos, { maxLength: 30 }),
  ageMs: fc.integer({ min: 0, max: 3 * POSITIONS_STALE_MS }),
  markMicro: fc.integer({ min: 10_000, max: 100_000 }),
  p99Ten: fc.integer({ min: 0, max: 200 }),
});

interface Input {
  positions: FloorPosition[];
  ageMs: number;
  markMicro: number;
  p99Ten: number;
}
const floorOf = (i: Input) =>
  liquidationFloor({
    positions: i.positions,
    tiers: NIGHT,
    positionsAgeMs: i.ageMs,
    mark: dec(i.markMicro).div(1_000_000),
    replicaP99Bps: dec(i.p99Ten).div(10),
    tick,
  });

describe("liquidation-aware floor F", () => {
  it("b_liq = 10 bps + 2 × p99", () => {
    expect(bLiqBps("0.99").toFixed()).toBe("11.98");
    expect(bLiqBps(0).toFixed()).toBe("10");
  });

  it("b_liq from a fit uses the worse of held-out and all-tick p99, and needs held-out ticks", () => {
    const s = (p99: string) => errorStats([dec(0), dec(p99)]);
    expect(bLiqFromFit({ all: s("0.6152"), heldOut: s("0.7558") })?.toFixed()).toBe("11.5116");
    expect(bLiqFromFit({ all: s("0.9"), heldOut: s("0.5") })?.toFixed()).toBe("11.8");
    expect(bLiqFromFit({ all: s("0.6"), heldOut: null })).toBeNull();
    expect(bLiqFromFit(null)).toBeNull();
  });

  it("is never below any long's LP × (1 + b_liq), and is the lowest such tick", () => {
    fc.assert(
      fc.property(arbInput, (i) => {
        const f = floorOf(i);
        const b = dec(10).plus(dec(i.p99Ten).div(10).times(2));
        let need = dec(0);
        for (const p of i.positions) {
          const lp = dec(p.liquidationPrice);
          if (dec(p.size).gt(0) && lp.gt(0)) {
            expect(longTriggerPrice(p, NIGHT)?.eq(lp)).toBe(true);
            const t = lp.times(dec(1).plus(b.div(10_000)));
            expect(f.px.gte(t)).toBe(true);
            if (t.gt(need)) need = t;
          }
        }
        if (f.stale) {
          expect(f.px.gte(dec(i.markMicro).div(1_000_000))).toBe(true);
          if (need.lt(dec(i.markMicro).div(1_000_000))) need = dec(i.markMicro).div(1_000_000);
        }
        expect(tick.isOnGrid(f.px)).toBe(true);
        // Rounded up, never further: one tick lower would violate the bound.
        if (f.ticks > 0n) expect(tick.fromUnits(f.ticks - 1n).lt(need)).toBe(true);
        else expect(need.isZero()).toBe(true);
      }),
      { numRuns: 10_000 },
    );
  });

  it("is monotone: adding positions never lowers it", () => {
    fc.assert(
      fc.property(arbInput, fc.array(arbPos, { maxLength: 10 }), (i, extra) => {
        const base = floorOf(i);
        const more = floorOf({ ...i, positions: [...i.positions, ...extra] });
        expect(more.ticks >= base.ticks).toBe(true);
      }),
      { numRuns: 10_000 },
    );
  });

  it("ignores shorts and tier-0 positions without a liquidation price", () => {
    fc.assert(
      fc.property(arbInput, fc.array(arbPos, { maxLength: 10 }), (i, extra) => {
        const ignored = extra.map((p) => (dec(p.size).gt(0) ? { ...p, liquidationPrice: "0" } : p));
        expect(floorOf({ ...i, positions: [...i.positions, ...ignored] }).ticks).toBe(
          floorOf(i).ticks,
        );
      }),
      { numRuns: 5_000 },
    );
  });

  it("requires F ≥ mark only when positions are stale", () => {
    const positions: FloorPosition[] = [
      { size: "1000", entryPrice: "0.0384", markPrice: "0.0384", liquidationPrice: "0.0300000001" },
    ];
    const base = { positions, tiers: NIGHT, mark: dec("0.0384"), replicaP99Bps: dec(1), tick };
    const fresh = liquidationFloor({ ...base, positionsAgeMs: POSITIONS_STALE_MS });
    expect(fresh.binding).toBe("liquidation");
    // 0.0300000001 × 1.0012 = 0.03003600010012 → up to 0.030037.
    expect(fresh.px.toFixed()).toBe("0.030037");
    expect(fresh.liquidationTarget?.toFixed()).toBe("0.03003600010012");
    const stale = liquidationFloor({ ...base, positionsAgeMs: POSITIONS_STALE_MS + 1 });
    expect(stale.binding).toBe("mark");
    expect(stale.px.toFixed()).toBe("0.0384");
    const none = liquidationFloor({ ...base, positions: [], positionsAgeMs: 0 });
    expect(none.binding).toBe("none");
    expect(none.ticks).toBe(0n);
  });

  it("treats an unknown, negative or infinite positions age as stale (fails closed)", () => {
    for (const age of [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(positionsStale(age)).toBe(true);
      const f = liquidationFloor({
        positions: [],
        tiers: NIGHT,
        positionsAgeMs: age,
        mark: dec("0.0384"),
        replicaP99Bps: dec(0),
        tick,
      });
      expect(f.stale).toBe(true);
      expect(f.binding).toBe("mark");
      expect(f.ticks).toBe(38_400n);
    }
    expect(positionsStale(0)).toBe(false);
    expect(positionsStale(POSITIONS_STALE_MS)).toBe(false);
    expect(positionsStale(POSITIONS_STALE_MS + 1)).toBe(true);
  });

  it("flags a long as fragile when its trigger is within b_liq below the index", () => {
    const index = dec("0.0384");
    const row = (size: string, lp: string): FloorPosition => ({
      size,
      entryPrice: "0.0390",
      markPrice: "0.0384",
      liquidationPrice: lp,
    });
    const at = (lp: string) => fragileLongs([row("1", lp)], NIGHT, index, dec(10));
    expect(at("0.03836160").length).toBe(1);
    expect(at("0.03836159").length).toBe(0);
    expect(at("0").length).toBe(0);
    expect(fragileLongs([row("-1", "0.05")], NIGHT, index, dec(10)).length).toBe(0);
    // A tier drop makes a long fragile that its served LP alone would not.
    const cross = servedLong(dec("1059.24"), dec("0.0384"), dec(131_000), dec("0.0384"), NIGHT);
    const trigger = longTriggerPrice(cross, NIGHT) ?? dec(0);
    const near = trigger.div("0.9995").toDecimalPlaces(8);
    expect(fragileLongs([cross], NIGHT, near, dec(10)).length).toBe(1);
    expect(dec(cross.liquidationPrice).gte(near.times("0.999"))).toBe(false);
  });
});
