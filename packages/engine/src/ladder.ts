import {
  type MicroUsd,
  maxBigint,
  microUsd,
  minBigint,
  minusBpsFloor,
  type NotionalRate,
  notionalCeil,
  plusBpsCeil,
  type RefPrice,
  refPlusBpsCeil,
  type Steps,
  steps,
  stepsWithin,
  type Ticks,
  ticks,
} from "@ballast/core";

/** L1/L2/L3 capacity rations (plan section 5): small buys get the improvement, sweeps go on. */
export const LEVEL_RATIONS = [
  microUsd(300_000_000n),
  microUsd(700_000_000n),
  microUsd(1_500_000_000n),
] as const;

export interface LadderLevel {
  /** 1-based level; L1 is the cheapest ask. */
  level: number;
  px: Ticks;
  /** Aggregate size for the level across all accounts. */
  qty: Steps;
  ration: MicroUsd;
}

export interface LadderInput {
  /** Liquidation-aware floor F in ticks (0 = no live long sets one). */
  floorTicks: Ticks;
  /** Cheapest L1 the P2 solve allows; omit before the solve. */
  p2SafeTicks?: Ticks | null;
  /** ceil(mark) when the floor must also clear the mark (P2-blind mode, stale positions). */
  markTicks?: Ticks | null;
  /** Best bid in the book without Ballast: a post-only ask must sit strictly above it. */
  bestBidTicks?: Ticks | null;
  index: RefPrice;
  /** max(policy, market) minimum offset over index. */
  minOffsetBps: bigint;
  /** L2.. offsets from L1, e.g. [10, 25]. */
  spacingBps: readonly bigint[];
  levels: number;
  /** Best ask in the book without Ballast; null when that side is empty. */
  bestAskTicks: Ticks | null;
  minImprovementBps: bigint;
  /** Per-level rations, near first; defaults to LEVEL_RATIONS with L1 from the policy refill. */
  rations: readonly MicroUsd[];
  rate: NotionalRate;
}

export type LadderStandDown = "no-reference-ask" | "no-improvement" | "bad-input";

export type LadderResult =
  | { ok: true; l1: Ticks; levels: LadderLevel[]; maxL1Ticks: Ticks }
  | { ok: false; reason: LadderStandDown; detail: string; l1?: Ticks };

/** The highest L1 that still improves the book: best non-Ballast ask − minImprovement. */
export function maxL1Ticks(bestAskTicks: Ticks, minImprovementBps: bigint): Ticks {
  return minusBpsFloor(bestAskTicks, minImprovementBps);
}

/**
 * L1 = ceil_tick(max(F, P2-safe, index × (1 + offset))), L(i+1) = ceil_tick(L1 × (1 + s_i)), and
 * L1 is at least one tick over the best bid, where a post-only ask can rest at all.
 * Armed only while L1 ≤ best non-Ballast ask − minImprovement; otherwise Ballast would not
 * improve the book and stands down. Sizes are the rations at each level's price.
 */
export function buildLadder(input: LadderInput): LadderResult {
  if (input.levels < 1 || input.levels > input.spacingBps.length + 1) {
    return { ok: false, reason: "bad-input", detail: "levels do not match the spacing" };
  }
  if (input.rations.length < input.levels) {
    return { ok: false, reason: "bad-input", detail: "a ration per level is required" };
  }
  if (input.index.num <= 0n) return { ok: false, reason: "bad-input", detail: "no index" };
  const fromIndex = refPlusBpsCeil(input.index, input.minOffsetBps);
  let l1 = maxBigint(input.floorTicks, fromIndex);
  if (input.p2SafeTicks) l1 = maxBigint(l1, input.p2SafeTicks);
  if (input.markTicks) l1 = maxBigint(l1, input.markTicks);
  if (input.bestBidTicks) l1 = maxBigint(l1, input.bestBidTicks + 1n);
  const l1t = ticks(l1);
  if (input.bestAskTicks === null) {
    return { ok: false, reason: "no-reference-ask", detail: "no non-Ballast ask", l1: l1t };
  }
  const cap = maxL1Ticks(input.bestAskTicks, input.minImprovementBps);
  if (l1t > cap) {
    return {
      ok: false,
      reason: "no-improvement",
      detail: `L1 ${l1t} > best ask ${input.bestAskTicks} − ${input.minImprovementBps} bps (${cap})`,
      l1: l1t,
    };
  }
  const levels: LadderLevel[] = [];
  for (let i = 0; i < input.levels; i++) {
    let px = i === 0 ? l1t : plusBpsCeil(l1t, input.spacingBps[i - 1] as bigint);
    const prev = levels[i - 1];
    if (prev && px <= prev.px) px = ticks(prev.px + 1n);
    const ration = input.rations[i] as MicroUsd;
    levels.push({ level: i + 1, px, qty: stepsWithin(ration, px, input.rate), ration });
  }
  return { ok: true, l1: l1t, levels, maxL1Ticks: cap };
}

/** Rations for a policy: L1 from its refill size, L2/L3 from the plan. */
export function policyRations(l1Refill: MicroUsd): MicroUsd[] {
  return [l1Refill, LEVEL_RATIONS[1], LEVEL_RATIONS[2]];
}

/**
 * Caps the ladder's total notional near-first (P2-blind mode: ≤ $300; the aggregate cap). Levels
 * that end up empty are dropped, so the result is still L1..Lk.
 */
export function capLadderNotional(
  levels: readonly LadderLevel[],
  budget: MicroUsd,
  rate: NotionalRate,
): LadderLevel[] {
  let left: bigint = budget;
  const out: LadderLevel[] = [];
  for (const l of levels) {
    if (left <= 0n) break;
    const qty = stepsWithin(microUsd(left), l.px, rate);
    const take = steps(minBigint(qty, l.qty));
    if (take <= 0n) break;
    out.push({ ...l, qty: take });
    left -= notionalCeil(l.px, take, rate);
  }
  return out;
}
