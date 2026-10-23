import { type Dec, dec, Grid } from "./decimal.js";
import {
  impactNotional,
  type MarginTier,
  parseMarginTiers,
  type RawMarginTier,
} from "./math/marginTiers.js";

/** The `/v2/markets` fields the market model reads. Unknown fields are tolerated. */
export interface StrikeMarketPayload {
  symbol: string;
  quote_prec: number;
  base_prec: number;
  order_tick_price: string;
  order_limit_step_size: string;
  order_min_notional: string;
  margin_tiers: RawMarginTier[];
  impact_notional?: string;
  liquidation_fee_rate?: string;
  liquidation_fee_retention_factor?: string;
  last_price?: string;
  mark_price?: string;
  index_price?: string;
}

export interface MarketSpec {
  symbol: string;
  /** Price grid (`order_tick_price`). */
  tick: Grid;
  /** Limit-order size grid (`order_limit_step_size`). */
  step: Grid;
  quotePrec: number;
  basePrec: number;
  minNotional: Dec;
  tiers: MarginTier[];
  /** Served `impact_notional` when present (what the price service uses), else the formula. */
  impactNotional: Dec;
  /** 50 × clamp(tier-0 max leverage, 20, 50); differs from `impactNotional` only if docs drift. */
  impactNotionalDerived: Dec;
}

export function marketSpec(m: StrikeMarketPayload): MarketSpec {
  if (!Number.isSafeInteger(m.quote_prec) || m.quote_prec < 0) {
    throw new Error(`${m.symbol}: invalid quote_prec`);
  }
  const tiers = parseMarginTiers(m.margin_tiers);
  const derived = impactNotional(tiers);
  const served = m.impact_notional === undefined ? undefined : dec(m.impact_notional);
  return {
    symbol: m.symbol,
    tick: new Grid(m.order_tick_price),
    step: new Grid(m.order_limit_step_size),
    quotePrec: m.quote_prec,
    basePrec: m.base_prec,
    minNotional: dec(m.order_min_notional),
    tiers,
    impactNotional: served ?? derived,
    impactNotionalDerived: derived,
  };
}
