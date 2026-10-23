import { Grid } from "@ballast/market";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ceilTicks,
  cmpTicksRef,
  floorTicks,
  microUsd,
  microUsdFromString,
  minusBpsFloor,
  notionalCeil,
  notionalFloor,
  notionalRate,
  plusBpsCeil,
  priceString,
  refDistanceBpsCeil,
  refPlusBpsCeil,
  refPlusBpsFloor,
  refPrice,
  sizeString,
  steps,
  stepsAtLeast,
  stepsWithin,
  ticks,
  toSteps,
  toTicks,
} from "../src/index.js";

const NIGHT_TICK = new Grid("0.000001");
const ADA_TICK = new Grid("0.00001");
const STEP = new Grid("1");
const FINE_STEP = new Grid("0.001");

describe("units: grid conversions go through market's Grid", () => {
  it("round-trips ticks and steps exactly", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), (n) => {
        expect(toTicks(NIGHT_TICK, priceString(NIGHT_TICK, ticks(n)))).toBe(n);
        expect(toTicks(ADA_TICK, priceString(ADA_TICK, ticks(n)))).toBe(n);
        expect(toSteps(FINE_STEP, sizeString(FINE_STEP, steps(n)))).toBe(n);
      }),
      { numRuns: 2_000 },
    );
  });

  it("rejects off-grid values instead of rounding them", () => {
    expect(() => toTicks(NIGHT_TICK, "0.0385373")).toThrow();
    expect(ceilTicks(NIGHT_TICK, "0.0385373")).toBe(38_538n);
    expect(floorTicks(NIGHT_TICK, "0.0385373")).toBe(38_537n);
  });

  it("parses policy money as integer strings only", () => {
    expect(microUsdFromString("300000000")).toBe(300_000_000n);
    for (const bad of ["1.5", "-1", "01", "", "1e6", " 1"]) {
      expect(() => microUsdFromString(bad)).toThrow();
    }
  });
});

describe("units: notional", () => {
  it("NIGHT: one tick × one step is one micro-USD", () => {
    expect(notionalRate(NIGHT_TICK, STEP)).toEqual({ num: 1n, den: 1n });
    expect(notionalRate(ADA_TICK, STEP)).toEqual({ num: 10n, den: 1n });
    // 0.000001 × 0.001 = 1e-9 USD = 1/1000 micro-USD.
    expect(notionalRate(NIGHT_TICK, FINE_STEP)).toEqual({ num: 1n, den: 1000n });
  });

  it("floor ≤ exact ≤ ceil, and the budget helpers invert them", () => {
    const rate = notionalRate(NIGHT_TICK, FINE_STEP);
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 9n }),
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        (px, qty, budget) => {
          const lo = notionalFloor(ticks(px), steps(qty), rate);
          const hi = notionalCeil(ticks(px), steps(qty), rate);
          expect(lo * rate.den <= px * qty * rate.num).toBe(true);
          expect(hi * rate.den >= px * qty * rate.num).toBe(true);
          expect(hi - lo <= 1n).toBe(true);
          const within = stepsWithin(microUsd(budget), ticks(px), rate);
          expect(notionalCeil(ticks(px), within, rate) <= budget).toBe(true);
          // One more step would exceed the budget exactly.
          if (budget > 0n) expect((within + 1n) * px * rate.num > budget * rate.den).toBe(true);
          const atLeast = stepsAtLeast(microUsd(budget), ticks(px), rate);
          expect(notionalFloor(ticks(px), atLeast, rate) >= budget || budget === 0n).toBe(true);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});

describe("units: bps on the grid", () => {
  it("plusBpsCeil is the smallest tick ≥ t × (1 + bps) and always moves up", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 9n }),
        fc.bigInt({ min: 1n, max: 500n }),
        (t, bps) => {
          const v = plusBpsCeil(ticks(t), bps);
          expect(v > t).toBe(true);
          expect(v * 10_000n >= t * (10_000n + bps)).toBe(true);
          if (v - 1n > t) expect((v - 1n) * 10_000n < t * (10_000n + bps)).toBe(true);
          const d = minusBpsFloor(ticks(t), bps);
          expect(d * 10_000n <= t * (10_000n - bps)).toBe(true);
        },
      ),
    );
  });
});

describe("units: reference prices stay exact", () => {
  it("an off-grid index is an exact fraction of a tick", () => {
    const x = refPrice(NIGHT_TICK, "0.03828181");
    expect(x).toEqual({ num: 3_828_181n, den: 100n });
    // index × 1.0038 = 0.038427280878 → ceil to the tick 0.038428
    expect(refPlusBpsCeil(x, 38n)).toBe(38_428n);
    expect(refPlusBpsFloor(x, 38n)).toBe(38_427n);
    expect(cmpTicksRef(ticks(38_282n), x)).toBe(1);
    expect(cmpTicksRef(ticks(38_281n), x)).toBe(-1);
    // 21244.905 ticks, reduced: 4248981 / 200.
    expect(refPrice(ADA_TICK, "0.21244905")).toEqual({ num: 4_248_981n, den: 200n });
  });

  it("measures distance in bps, rounded up", () => {
    const a = refPrice(NIGHT_TICK, "0.0385");
    const b = refPrice(NIGHT_TICK, "0.0384");
    // 1/384 × 10⁴ = 26.04… → 27
    expect(refDistanceBpsCeil(a, b)).toBe(27n);
    expect(refDistanceBpsCeil(b, a)).toBe(26n);
    expect(refDistanceBpsCeil(a, refPrice(NIGHT_TICK, "0"))).toBeNull();
  });
});
