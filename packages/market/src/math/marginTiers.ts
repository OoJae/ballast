import { add, clamp, type Dec, dec, mul, sub, ZERO } from "../decimal.js";

/** One tier as `/v2/markets` serves it (strings except `max_leverage`). */
export interface RawMarginTier {
  max_notional: string;
  max_leverage: number;
  maintenance_margin_rate: string;
  maintenance_amount?: string;
}

export interface MarginTier {
  maxNotional: Dec;
  maxLeverage: number;
  mmr: Dec;
  /** Maintenance Amount, always re-derived: the engine ignores supplied values. */
  ma: Dec;
}

/**
 * Parses and validates a tier schedule (strike-calculations): ascending `max_notional`,
 * non-increasing `max_leverage`, non-decreasing MMR with 0 < MMR < 1. MA is derived as
 * MA[0] = 0, MA[i] = MA[i−1] + max_notional[i−1] × (MMR[i] − MMR[i−1]).
 */
export function parseMarginTiers(raw: readonly RawMarginTier[]): MarginTier[] {
  if (raw.length === 0) throw new Error("margin tiers: empty schedule");
  const tiers: MarginTier[] = [];
  for (const [i, t] of raw.entries()) {
    const maxNotional = dec(t.max_notional);
    const mmr = dec(t.maintenance_margin_rate);
    if (!Number.isSafeInteger(t.max_leverage) || t.max_leverage <= 0) {
      throw new Error(`margin tiers: tier ${i} has invalid max_leverage ${t.max_leverage}`);
    }
    if (mmr.lte(0) || mmr.gte(1)) throw new Error(`margin tiers: tier ${i} MMR outside (0, 1)`);
    const prev = tiers[i - 1];
    if (prev) {
      if (maxNotional.lte(prev.maxNotional))
        throw new Error("margin tiers: max_notional not ascending");
      if (t.max_leverage > prev.maxLeverage)
        throw new Error("margin tiers: max_leverage increases");
      if (mmr.lt(prev.mmr)) throw new Error("margin tiers: MMR decreases");
    }
    const ma = prev ? add(prev.ma, mul(prev.maxNotional, sub(mmr, prev.mmr))) : ZERO;
    tiers.push({ maxNotional, maxLeverage: t.max_leverage, mmr, ma });
  }
  return tiers;
}

/**
 * Tier used for MM and liquidation price: the first tier with notional ≤ max_notional (a
 * boundary stays in the lower tier); above the last tier, the last tier.
 */
export function tierIndexByNotional(tiers: readonly MarginTier[], notional: Dec): number {
  for (const [i, t] of tiers.entries()) if (notional.lte(t.maxNotional)) return i;
  return tiers.length - 1;
}

/** Tier used for size limits: the highest index whose max_leverage still allows `leverage`. */
export function tierIndexByLeverage(tiers: readonly MarginTier[], leverage: number): number {
  const top = maxLeverage(tiers);
  if (!Number.isSafeInteger(leverage) || leverage <= 0 || leverage > top) {
    throw new RangeError(`leverage ${leverage} outside 1..${top}`);
  }
  let idx = 0;
  for (const [i, t] of tiers.entries()) if (leverage <= t.maxLeverage) idx = i;
  return idx;
}

export function maxLeverage(tiers: readonly MarginTier[]): number {
  const first = tiers[0];
  if (!first) throw new Error("margin tiers: empty schedule");
  return first.maxLeverage;
}

/** Largest position notional allowed at `leverage`. */
export function maxPositionNotional(tiers: readonly MarginTier[], leverage: number): Dec {
  const t = tiers[tierIndexByLeverage(tiers, leverage)];
  if (!t) throw new Error("unreachable");
  return t.maxNotional;
}

/** Impact Notional = $50 × clamp(tier-0 max leverage, 20, 50) (prices.md, funding-rates.md). */
export function impactNotional(tiers: readonly MarginTier[]): Dec {
  return mul(50, clamp(dec(maxLeverage(tiers)), dec(20), dec(50)));
}
