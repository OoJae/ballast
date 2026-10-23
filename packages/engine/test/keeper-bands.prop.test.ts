import { maxBigint, minBigint } from "@ballast/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type BandState,
  classifyMarginBand,
  evaluateArmLatch,
  evaluateMarginBand,
  type MarginBand,
  marginThresholds,
  DEFAULT_MARGIN_THRESHOLDS as T,
} from "../src/index.js";
import { policy } from "./helpers.js";

/**
 * Invariant 17 (margin side), ported from Ripcord's thresholds.prop.test.ts:
 *  P1: ratio < warn with an armed latch quotes; nothing at or above reduce ever creates.
 *  P2: totality: any ratio and state give one of the four bands and never throw.
 *  P3: monotone severity on a fresh state.
 *  P4: the latch: after a reduce, creates resume only strictly below rearm.
 */
const BANDS: readonly MarginBand[] = ["ok", "warn", "reduce", "flatten"];
const SEVERITY: Record<MarginBand, number> = { ok: 0, warn: 1, reduce: 2, flatten: 3 };
const stateArb: fc.Arbitrary<BandState> = fc.record({
  quoting: fc.boolean(),
  lastBand: fc.constantFrom<MarginBand>("ok", "warn", "reduce", "flatten"),
});
const ratioArb = fc.bigInt({ min: 0n, max: 20_000n });

describe("margin bands (keeper-bands.ts)", () => {
  it("pins the boundaries: they belong to the more protective band", () => {
    expect(classifyMarginBand(3_999n, T)).toBe("ok");
    expect(classifyMarginBand(4_000n, T)).toBe("warn");
    expect(classifyMarginBand(4_999n, T)).toBe("warn");
    expect(classifyMarginBand(5_000n, T)).toBe("reduce");
    expect(classifyMarginBand(5_999n, T)).toBe("reduce");
    expect(classifyMarginBand(6_000n, T)).toBe("flatten");
  });

  it("P1: nothing at or above the reduce band creates; flatten buys back", () => {
    fc.assert(
      fc.property(ratioArb, stateArb, (ratio, state) => {
        const r = evaluateMarginBand(ratio, T, state);
        if (ratio >= T.reduceBps) {
          expect(r.allowCreates).toBe(false);
          expect(r.nextState.quoting).toBe(false);
          expect(r.action).toBe(ratio >= T.flattenBps ? "flatten" : "cancel");
        } else {
          expect(r.action).toBe("none");
          if (state.quoting) expect(r.allowCreates).toBe(true);
        }
      }),
      { numRuns: 10_000 },
    );
  });

  it("P2: totality, and an unknown ratio fails closed", () => {
    fc.assert(
      fc.property(
        fc.option(fc.bigInt({ min: -10n, max: 10n ** 30n }), { nil: null }),
        stateArb,
        (ratio, state) => {
          const r = evaluateMarginBand(ratio, T, state);
          expect(BANDS).toContain(r.band);
          expect(r.nextState.lastBand).toBe(r.band);
          if (ratio === null || ratio < 0n) {
            expect(r.allowCreates).toBe(false);
            expect(r.action).toBe("cancel");
          }
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it("P3: monotone severity: a higher ratio is never a milder band", () => {
    fc.assert(
      fc.property(ratioArb, ratioArb, (a, b) => {
        const lo = minBigint(a, b);
        const hi = maxBigint(a, b);
        const fresh = (): BandState => ({ quoting: true, lastBand: "ok" });
        expect(SEVERITY[evaluateMarginBand(hi, T, fresh()).band]).toBeGreaterThanOrEqual(
          SEVERITY[evaluateMarginBand(lo, T, fresh()).band],
        );
      }),
      { numRuns: 10_000 },
    );
  });

  it("P4: after a reduce, quoting resumes only strictly below rearm", () => {
    fc.assert(
      fc.property(fc.array(ratioArb, { minLength: 1, maxLength: 30 }), (path) => {
        let state: BandState = { quoting: true, lastBand: "ok" };
        let latched = false;
        for (const ratio of path) {
          const r = evaluateMarginBand(ratio, T, state);
          if (ratio >= T.reduceBps) latched = true;
          else if (latched && ratio < T.rearmBps) latched = false;
          expect(r.allowCreates).toBe(!latched);
          state = r.nextState;
        }
      }),
      { numRuns: 10_000 },
    );
  });

  it("takes reduce and flatten from the policy", () => {
    const t = marginThresholds(policy());
    expect(t).toEqual({ warnBps: 4_000n, reduceBps: 5_000n, flattenBps: 6_000n, rearmBps: 3_500n });
  });

  it("the arm latch adds hysteresis on top of the 5 bps improvement", () => {
    expect(evaluateArmLatch(5n, 5n, 2n, true)).toBe(true);
    expect(evaluateArmLatch(4n, 5n, 2n, true)).toBe(false);
    expect(evaluateArmLatch(6n, 5n, 2n, false)).toBe(false);
    expect(evaluateArmLatch(7n, 5n, 2n, false)).toBe(true);
    expect(evaluateArmLatch(null, 5n, 2n, true)).toBe(false);
  });
});
