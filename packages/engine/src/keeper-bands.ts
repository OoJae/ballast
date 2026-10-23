import type { QuotePolicy } from "@ballast/core";

/**
 * Margin-ratio bands (MM / MB, plan section 5): warn 40%, reduce-only 50%, flatten 60%, well
 * inside Strike's own 70% call and 90% reduce-only. Ported from Ripcord's thresholds.ts: a pure
 * band machine on integer bps, with a hysteresis latch so quoting does not flap at a boundary.
 *
 * Band semantics (boundaries belong to the more protective band):
 *   ok      : ratio <  warn
 *   warn    : warn   ≤ ratio < reduce
 *   reduce  : reduce ≤ ratio < flatten   cancel every ask, no creates
 *   flatten : ratio ≥ flatten            cancel, then buy the whole short back reduce-only
 * An unknown ratio is treated as reduce: no margin reading, no new risk.
 *
 * WHY THE LATCH: after a reduce or flatten the account may sit just under the reduce boundary,
 * where a single fill pushes it back over. Quoting resumes only once the ratio is strictly
 * below `rearm`, so one tick of noise cannot cycle cancel → create → cancel. Flatten is never
 * suppressed by the latch: an account that close to Strike's call is closed, not watched.
 */
export type MarginBand = "ok" | "warn" | "reduce" | "flatten";

export interface MarginThresholds {
  warnBps: bigint;
  reduceBps: bigint;
  flattenBps: bigint;
  /** Quoting re-arms only strictly below this. */
  rearmBps: bigint;
}

export const DEFAULT_MARGIN_THRESHOLDS: MarginThresholds = {
  warnBps: 4_000n,
  reduceBps: 5_000n,
  flattenBps: 6_000n,
  rearmBps: 3_500n,
};

export function marginThresholds(policy: QuotePolicy): MarginThresholds {
  const reduceBps = BigInt(policy.risk.marginReduceBps);
  const flattenBps = BigInt(policy.risk.marginFlattenBps);
  const warnBps = reduceBps < DEFAULT_MARGIN_THRESHOLDS.warnBps ? reduceBps : 4_000n;
  const rearmBps = warnBps > 500n ? warnBps - 500n : 0n;
  return { warnBps, reduceBps, flattenBps, rearmBps };
}

export interface BandState {
  /** Hysteresis latch: creates are allowed only while it is armed. */
  quoting: boolean;
  lastBand: MarginBand;
}

export interface BandResult {
  band: MarginBand;
  allowCreates: boolean;
  action: "none" | "cancel" | "flatten";
  reason: string;
  nextState: BandState;
}

export function classifyMarginBand(ratioBps: bigint, t: MarginThresholds): MarginBand {
  if (ratioBps >= t.flattenBps) return "flatten";
  if (ratioBps >= t.reduceBps) return "reduce";
  if (ratioBps >= t.warnBps) return "warn";
  return "ok";
}

/** One evaluation. Never mutates `state`. */
export function evaluateMarginBand(
  ratioBps: bigint | null,
  t: MarginThresholds,
  state: BandState,
): BandResult {
  if (ratioBps === null || ratioBps < 0n) {
    return {
      band: "reduce",
      allowCreates: false,
      action: "cancel",
      reason: "margin ratio unknown: treated as reduce-only",
      nextState: { quoting: false, lastBand: "reduce" },
    };
  }
  const band = classifyMarginBand(ratioBps, t);
  switch (band) {
    case "ok":
    case "warn": {
      const rearm = !state.quoting && ratioBps < t.rearmBps;
      const quoting = state.quoting || rearm;
      return {
        band,
        allowCreates: quoting,
        action: "none",
        reason: rearm
          ? `${band}: ratio strictly below rearm ${t.rearmBps} bps; quoting re-armed`
          : quoting
            ? `${band}: quoting`
            : `${band}: latch open until the ratio is below ${t.rearmBps} bps`,
        nextState: { quoting, lastBand: band },
      };
    }
    case "reduce":
      return {
        band,
        allowCreates: false,
        action: "cancel",
        reason: `reduce: ratio ${ratioBps} ≥ ${t.reduceBps} bps; cancel asks, no creates`,
        nextState: { quoting: false, lastBand: band },
      };
    case "flatten":
      return {
        band,
        allowCreates: false,
        action: "flatten",
        reason: `flatten: ratio ${ratioBps} ≥ ${t.flattenBps} bps; cancel, then buy back`,
        nextState: { quoting: false, lastBand: band },
      };
  }
}

/**
 * Arm/disarm hysteresis for the improvement condition (L1 ≤ best ask − min): once armed it stays
 * armed while the improvement is at least `minBps`; once disarmed it re-arms only at
 * `minBps + hysteresisBps`. A null improvement (no reference ask) always disarms.
 */
export function evaluateArmLatch(
  improvementBps: bigint | null,
  minBps: bigint,
  hysteresisBps: bigint,
  armed: boolean,
): boolean {
  if (improvementBps === null) return false;
  return armed ? improvementBps >= minBps : improvementBps >= minBps + hysteresisBps;
}
