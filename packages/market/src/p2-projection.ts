import { type Level, type LevelBook, mergeLevels } from "./book.js";
import {
  add,
  type Dec,
  dec,
  div,
  type Grid,
  maxBig,
  min,
  minBig,
  mul,
  sum,
  ZERO,
} from "./decimal.js";
import { type FloorPosition, fragileLongs } from "./floor.js";
import { basisSample, bookTop, type MarketShape, type MarkParams } from "./mark-replica.js";
import type { MarginTier } from "./math/marginTiers.js";

/**
 * P2 after k = 0..n further samples of `next`, assuming the index and the book hold still:
 * the window is the latest n of (history ++ [next] × k).
 */
export function projectP2Path(history: readonly Dec[], next: Dec, index: Dec, n: number): Dec[] {
  const old = history.slice(-n);
  const m = old.length;
  const suffix: Dec[] = new Array(m + 1);
  suffix[m] = ZERO;
  for (let i = m - 1; i >= 0; i--) suffix[i] = add(old[i] as Dec, suffix[i + 1] as Dec);
  const path: Dec[] = [];
  for (let k = 0; k <= n; k++) {
    const start = Math.max(0, m + k - n);
    const count = m - start + k;
    path.push(
      count === 0 ? index : add(index, div(add(suffix[start] as Dec, mul(next, k)), count)),
    );
  }
  return path;
}

export type P2StandDownReason =
  | "fragile-long-top-mid"
  | "basis-history-incomplete"
  | "p2-below-target"
  | "infeasible"
  | "empty-ladder"
  | "blind-fragile-long"
  | "blind-ladder-too-large"
  | "blind-l1-below-floor";

export interface P2StandDown {
  ok: false;
  reason: P2StandDownReason;
  detail: string;
}

export interface P2Plan {
  ok: true;
  /** Cheapest L1 (ticks) whose projected P2 stays ≥ target over the MA horizon. */
  l1Ticks: bigint;
  /** Largest Ballast size at L1 (steps) that keeps it safe, capped at the impact window. */
  maxDepthSteps: bigint;
  maxDepthNotional: Dec;
  /** True when even a full impact notional at L1 is safe. */
  depthCapped: boolean;
  /** Lowest projected P2 for the plan, and for the ladder as proposed. */
  minP2: Dec;
  proposed: { minP2: Dec; safe: boolean };
  horizonSamples: number;
}

export interface P2ProjectionInput {
  /** The book without Ballast's orders. */
  book: LevelBook;
  /** Ballast's proposed asks, best-first; the solve keeps its shape and shifts it. */
  ladder: readonly Level[];
  index: Dec;
  /** Current basis history, oldest first; a full window is required. */
  basis: readonly Dec[];
  /**
   * Every sample in the window came from a synced book (no L3 gap or resync inside it). Strike's
   * engine keeps, and restores across restarts, a full history; a partial one does not match it.
   */
  basisGapFree: boolean;
  /** Fitted mark parameters: P2's mid definition and window. */
  params: MarkParams;
  market: MarketShape;
  /**
   * Projected P2 must stay ≥ max long trigger × (1 + b_liq), i.e. `liquidationFloor(...)
   * .liquidationTarget`; null when no long has a trigger.
   */
  target: Dec | null;
  /** A live long is fragile (see `fragileLongs`). */
  fragileLong: boolean;
  /** L1 search range in ticks, e.g. [ceil(max(F, index·(1 + 38 bps))), best ask − 5 bps]. */
  minL1Ticks: bigint;
  maxL1Ticks: bigint;
}

/**
 * Solves Section 5's P2 constraint. Ballast's asks feed P2 through the basis samples' mid, so the
 * governor wants the cheapest L1, and the most depth there, that keeps the projected P2 above the
 * liquidation target for the whole MA horizon. Stands down when P2 uses the top-of-book mid and a
 * fragile long exists (any improving ask lowers P2), when the basis history is not a full,
 * gap-free window, when P2 is already below target, or when no L1 in range is safe.
 *
 * Partial fills: a fill that leaves the ask side still able to fill the impact notional can only
 * raise the impact ask (the cheapest liquidity went), but one that leaves it short makes the
 * impact ask fall back to the index (prices.md), which can be lower. With the house asks intact,
 * every partly taken state of Ballast's ladder therefore has a P2 at least min(P2 with the full
 * ladder, P2 without Ballast). Requiring both to be safe makes safety monotone in size, which the
 * depth search relies on. (A sweep that also exhausts the house asks reaches the same state
 * without Ballast.)
 */
export function projectP2(input: P2ProjectionInput): P2Plan | P2StandDown {
  const first = input.ladder[0];
  if (!first) return { ok: false, reason: "empty-ladder", detail: "no proposed asks" };
  if (input.fragileLong && input.params.mid === "top") {
    return {
      ok: false,
      reason: "fragile-long-top-mid",
      detail: "a fragile long exists and P2 uses the top-of-book mid",
    };
  }
  const n = input.params.basisWindow;
  if (!input.basisGapFree || input.basis.length < n) {
    return {
      ok: false,
      reason: "basis-history-incomplete",
      detail: `${Math.min(input.basis.length, n)}/${n} samples${input.basisGapFree ? "" : ", not gap-free"}`,
    };
  }
  const nowMs = 0;
  const minPath = (ladder: readonly Level[]): Dec => {
    const asks = mergeLevels(input.book.asks, ladder, "ask");
    const top = bookTop({ bids: input.book.bids, asks }, input.market, nowMs);
    const next = basisSample(top, input.index, input.params.mid);
    return projectP2Path(input.basis, next, input.index, n).reduce(min);
  };
  const safe = (p: Dec) => input.target === null || p.gte(input.target);
  const shift = (l1: bigint): Level[] =>
    input.ladder.map((l) => ({ px: l.px - first.px + l1, qty: l.qty }));

  const proposedMin = minPath(input.ladder);
  const current = projectP2Path(input.basis, ZERO, input.index, n)[0];
  if (input.target && current?.lt(input.target)) {
    return {
      ok: false,
      reason: "p2-below-target",
      detail: `P2 ${current.toFixed()} is already below the target ${input.target.toFixed()}`,
    };
  }
  const withoutBallast = minPath([]);
  if (!safe(withoutBallast)) {
    return {
      ok: false,
      reason: "p2-below-target",
      detail: `without Ballast's asks the projected P2 falls to ${withoutBallast.toFixed()}, below the target; a fill that takes the ladder returns the book there`,
    };
  }

  let l1: bigint | null = null;
  let planMin = proposedMin;
  for (let px = input.minL1Ticks; px <= input.maxL1Ticks; px++) {
    const m = minPath(shift(px));
    if (safe(m)) {
      l1 = px;
      planMin = m;
      break;
    }
  }
  if (l1 === null) {
    return {
      ok: false,
      reason: "infeasible",
      detail: "no L1 in range keeps the projected P2 at or above the target",
    };
  }

  // Largest size at L1 (other levels as proposed) that stays safe, up to the impact window.
  const l1Px = input.market.tick.fromUnits(l1);
  const cap = input.market.step.ceilUnits(div(input.market.impactNotional, l1Px));
  const rest = shift(l1).slice(1);
  const okAt = (q: bigint) => safe(minPath([{ px: l1 as bigint, qty: q }, ...rest]));
  let lo = 0n;
  let hi = cap;
  if (okAt(cap)) lo = cap;
  else {
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (okAt(mid)) lo = mid;
      else hi = mid;
    }
  }
  return {
    ok: true,
    l1Ticks: l1,
    maxDepthSteps: lo,
    maxDepthNotional: mul(l1Px, input.market.step.fromUnits(lo)),
    depthCapped: lo === cap,
    minP2: planMin,
    proposed: { minP2: proposedMin, safe: safe(proposedMin) },
    horizonSamples: n,
  };
}

export const P2_BLIND_MAX_NOTIONAL = dec(300);

export interface P2BlindPlan {
  ok: true;
  /** L1 ≥ max(F, mark), on the tick grid. */
  minL1Ticks: bigint;
  maxTotalNotional: Dec;
  ladderNotional: Dec;
}

/**
 * Pre-D6 "P2-blind mode": total Ballast asks ≤ $300, L1 ≥ max(F, mark), and stand down while
 * any live long's tier-consistent trigger is ≥ index × (1 − b_liq). `ok: true` means the proposed
 * ladder is admissible as it stands; any failed limit is a stand-down.
 */
export function p2BlindMode(input: {
  floorTicks: bigint;
  mark: Dec;
  index: Dec;
  positions: readonly FloorPosition[];
  tiers: readonly MarginTier[];
  bLiqBps: Dec;
  ladder: readonly Level[];
  tick: Grid;
  step: Grid;
}): P2BlindPlan | P2StandDown {
  if (input.ladder.length === 0) {
    return { ok: false, reason: "empty-ladder", detail: "no proposed asks" };
  }
  const fragile = fragileLongs(input.positions, input.tiers, input.index, input.bLiqBps);
  if (fragile.length > 0) {
    return {
      ok: false,
      reason: "blind-fragile-long",
      detail: `${fragile.length} live long(s) with a trigger ≥ index × (1 − b_liq)`,
    };
  }
  const markTicks = input.tick.ceilUnits(input.mark);
  const minL1Ticks = maxBig(input.floorTicks, markTicks);
  const ladderNotional = sum(
    input.ladder.map((l) => mul(input.tick.fromUnits(l.px), input.step.fromUnits(l.qty))),
  );
  if (ladderNotional.gt(P2_BLIND_MAX_NOTIONAL)) {
    return {
      ok: false,
      reason: "blind-ladder-too-large",
      detail: `ladder $${ladderNotional.toFixed()} > $${P2_BLIND_MAX_NOTIONAL.toFixed()}`,
    };
  }
  const lowest = input.ladder.reduce((m, l) => minBig(m, l.px), input.ladder[0]?.px ?? 0n);
  if (lowest < minL1Ticks) {
    return {
      ok: false,
      reason: "blind-l1-below-floor",
      detail: `lowest ask ${lowest} ticks < max(F, mark) ${minL1Ticks} ticks`,
    };
  }
  return { ok: true, minL1Ticks, maxTotalNotional: P2_BLIND_MAX_NOTIONAL, ladderNotional };
}
