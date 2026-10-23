import {
  add,
  BPS,
  type Dec,
  type DecInput,
  dec,
  type Grid,
  max,
  maxBig,
  mul,
  ONE,
} from "./decimal.js";
import { type MarginTier, tierIndexByNotional } from "./math/marginTiers.js";
import type { ErrorStats } from "./stats.js";

/** The live-position fields the floor reads (the recorder's minimized row has them all). */
export interface FloorPosition {
  size: DecInput;
  entryPrice: DecInput;
  /** The mark the row was served at: it fixes the tier the served LP was computed in. */
  markPrice: DecInput;
  /** Served liquidation price; "0" (or ≤ 0) means none in the current tier. */
  liquidationPrice: DecInput;
}

export interface FloorInput {
  positions: readonly FloorPosition[];
  /** The market's margin tiers: a long's real trigger depends on the tier in force at it. */
  tiers: readonly MarginTier[];
  /** Age of the live-positions snapshot (now − its `updated_at`); NaN or negative is stale. */
  positionsAgeMs: number;
  mark: Dec;
  /** The mark replica's p99 error in bps. */
  replicaP99Bps: Dec;
  tick: Grid;
  /** Fixed part of b_liq in bps (default 10). */
  baseBps?: DecInput;
  /** Positions older than this also require F ≥ mark (default 15 min). */
  staleAfterMs?: number;
}

export interface LiquidationFloor {
  /** F on the tick grid, rounded up. 0 means no constraint. */
  ticks: bigint;
  px: Dec;
  bLiqBps: Dec;
  /** Highest tier-consistent long trigger (see `longTriggerPrice`). */
  maxLongLp: Dec | null;
  /** maxLongLp × (1 + b_liq), unrounded: the level projected P2 must stay at or above. */
  liquidationTarget: Dec | null;
  longs: number;
  /** Longs whose real trigger sits above their served LP because of a lower tier. */
  tierAdjusted: number;
  stale: boolean;
  binding: "liquidation" | "mark" | "none";
}

export const FLOOR_BASE_BPS = dec(10);
export const POSITIONS_STALE_MS = 15 * 60_000;

/** b_liq = 10 bps + 2 × the replica's p99 error. */
export function bLiqBps(replicaP99Bps: DecInput, baseBps: DecInput = FLOOR_BASE_BPS): Dec {
  return add(baseBps, mul(2, replicaP99Bps));
}

/**
 * b_liq from a mark fit, on the worse of the held-out and whole-series p99 (in-sample error
 * understates it). Null without a fit or held-out ticks: no b_liq can be claimed then.
 */
export function bLiqFromFit(
  fit: { all: ErrorStats | null; heldOut: ErrorStats | null } | null,
): Dec | null {
  if (!fit?.heldOut || !fit.all) return null;
  return bLiqBps(max(fit.heldOut.p99, fit.all.p99));
}

/** Unknown (NaN), negative (bad timestamp or skew) and infinite ages count as stale. */
export function positionsStale(ageMs: number, staleAfterMs = POSITIONS_STALE_MS): boolean {
  return !Number.isFinite(ageMs) || ageMs < 0 || ageMs > staleAfterMs;
}

/**
 * The mark at which a long is really liquidated. The served LP uses the tier at the served mark,
 * but the tier is re-evaluated as the mark moves (margin-tiers.md), and MM(notional) =
 * max_i(notional × MMR_i − MA_i) is convex, so a long whose notional drops into a lower tier
 * meets its maintenance margin above the served LP. With W′ = W + TU − TM backed out of the
 * served LP, each tier's line gives LP_i = (entry − (W′ + MA_i)/size)/(1 − MMR_i), and margin
 * balance stays above MM exactly while the mark is above max_i LP_i. TU and TM belong to other
 * symbols, so W′ does not move with this mark.
 *
 * A served "0" says only that the current tier has no trigger (W′ ≥ entry × size − MA_t); every
 * other tier's trigger is then at most (MA_t − MA_i)/(size × (1 − MMR_i)), used as a bound.
 * Shorts and empty positions return null. Unrounded, at full intermediate precision.
 */
export function longTriggerPrice(p: FloorPosition, tiers: readonly MarginTier[]): Dec | null {
  const size = dec(p.size);
  if (!size.gt(0)) return null;
  // VERIFY: that the served LP used the tier at the row's own mark_price is golden-checked on
  // every recorded isolated row; cross rows cannot be checked (the wallet balance is not served).
  const t = tiers[tierIndexByNotional(tiers, dec(p.markPrice).times(size))];
  if (!t) throw new Error("margin tiers: empty schedule");
  const served = dec(p.liquidationPrice);
  let best: Dec | null = null;
  if (served.gt(0)) {
    const w = dec(p.entryPrice)
      .minus(served.times(ONE.minus(t.mmr)))
      .times(size)
      .minus(t.ma);
    best = served;
    for (const ti of tiers) {
      const lp = dec(p.entryPrice).minus(w.plus(ti.ma).div(size)).div(ONE.minus(ti.mmr));
      if (lp.gt(best)) best = lp;
    }
    return best;
  }
  for (const ti of tiers) {
    const bound = t.ma.minus(ti.ma).div(size.times(ONE.minus(ti.mmr)));
    if (bound.gt(0) && (best === null || bound.gt(best))) best = bound;
  }
  return best;
}

/**
 * F = max over live longs of trigger × (1 + b_liq), rounded up to the tick grid, where the
 * trigger is tier-consistent (`longTriggerPrice`); when the positions are stale (or their age is
 * unknown), also F ≥ mark. Longs without any trigger are ignored. Under the median model a fill
 * at p ≥ F leaves mark′ ≥ min(mark, F), so no Ballast fill can be the trade that liquidates a long.
 */
export function liquidationFloor(input: FloorInput): LiquidationFloor {
  const b = bLiqBps(input.replicaP99Bps, input.baseBps ?? FLOOR_BASE_BPS);
  if (b.lt(0)) throw new RangeError("b_liq must be ≥ 0");
  let maxLp: Dec | null = null;
  let longs = 0;
  let tierAdjusted = 0;
  for (const p of input.positions) {
    const lp = longTriggerPrice(p, input.tiers);
    if (!lp) continue;
    longs += 1;
    if (!lp.eq(dec(p.liquidationPrice))) tierAdjusted += 1;
    maxLp = maxLp ? max(maxLp, lp) : lp;
  }
  const stale = positionsStale(input.positionsAgeMs, input.staleAfterMs);
  // Exact (unrounded) product: rounding to 19 digits first could land a hair below LP × (1 + b).
  const target = maxLp ? exactPlusBps(maxLp, b) : null;
  const fromLp = target ? input.tick.ceilUnits(target) : 0n;
  const fromMark = stale ? input.tick.ceilUnits(input.mark) : 0n;
  const ticks = maxBig(fromLp, fromMark);
  const binding = ticks === 0n ? "none" : fromLp >= fromMark ? "liquidation" : "mark";
  return {
    ticks,
    px: input.tick.fromUnits(ticks),
    bLiqBps: b,
    maxLongLp: maxLp,
    liquidationTarget: target,
    longs,
    tierAdjusted,
    stale,
    binding,
  };
}

/**
 * A long is fragile when its tier-consistent trigger sits within b_liq below the index:
 * trigger ≥ index × (1 − b_liq). Longs without a trigger never are.
 */
export function fragileLongs(
  positions: readonly FloorPosition[],
  tiers: readonly MarginTier[],
  index: Dec,
  bLiq: Dec,
): FloorPosition[] {
  const bound = exactPlusBps(index, bLiq.neg());
  return positions.filter((p) => longTriggerPrice(p, tiers)?.gte(bound) ?? false);
}

function exactPlusBps(x: Dec, bps: Dec): Dec {
  return x.times(ONE.plus(bps.div(BPS)));
}
