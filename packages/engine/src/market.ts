import {
  ceilTicks,
  floorTicks,
  type MicroUsd,
  maxBigint,
  microUsd,
  type NotionalRate,
  notionalRate,
  type RefPrice,
  refPrice,
  type Steps,
  steps,
  type Ticks,
  toSteps,
} from "@ballast/core";
import { Grid, type MarketSpec, marketSpec, type StrikeMarketPayload } from "@ballast/market";

/** `/v2/markets` rule fields the static admission checks read (strike-trading "CloseReason"). */
export interface StrikeMarketRules extends StrikeMarketPayload {
  order_min_price?: string;
  order_max_price?: string;
  order_limit_price_bound?: string;
  order_limit_min_size?: string;
  order_limit_max_size?: string;
  order_market_min_size?: string;
  status?: string;
}

/** A market's admission rules in integer units, converted once from `/v2/markets`. */
export interface EngineMarket {
  symbol: string;
  spec: MarketSpec;
  tick: Grid;
  step: Grid;
  rate: NotionalRate;
  minPriceTicks: Ticks;
  maxPriceTicks: Ticks;
  minSizeSteps: Steps;
  /** 0 rejects every limit order (strike-trading: "a max size of 0 rejects every order"). */
  maxSizeSteps: Steps;
  strikeMinNotional: MicroUsd;
  /** `order_limit_price_bound` in bps of mark (Strike: 500), rounded toward tighter. */
  strikePriceBoundBps: bigint;
  /** Ballast's own tighter limits (plan section 5, static rules). */
  ballastMinNotional: MicroUsd;
  ballastPriceBandBps: bigint;
  trading: boolean;
}

/** Notional ≥ $10.50 against Strike's $10, and ±4.5% of mark against Strike's 5%. */
export const BALLAST_MIN_NOTIONAL = microUsd(10_500_000n);
export const BALLAST_PRICE_BAND_BPS = 450n;

const MICRO_USD = new Grid("0.000001");
const ONE_BPS = new Grid("0.0001");

function required(m: StrikeMarketRules, key: keyof StrikeMarketRules): string {
  const v = m[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${m.symbol}: /v2/markets field ${String(key)} is missing; refusing to quote`);
  }
  return v;
}

/**
 * Builds the integer rules. Every field the static checks need must be served: a missing one
 * throws rather than defaulting, so a schema drift stops quoting instead of loosening a check.
 * Bounds are rounded toward the stricter side when they are not on the grid.
 */
export function engineMarket(m: StrikeMarketRules): EngineMarket {
  const spec = marketSpec(m);
  const { tick, step } = spec;
  // VERIFY: strike-trading says `order_market_min_size` applies to every order type, limit
  // included; /v2/markets also serves `order_limit_min_size`. Both are enforced (FRICTION).
  const minSize = [required(m, "order_limit_min_size"), required(m, "order_market_min_size")]
    .map((s) => step.ceilUnits(s))
    .reduce(maxBigint);
  return {
    symbol: m.symbol,
    spec,
    tick,
    step,
    rate: notionalRate(tick, step),
    minPriceTicks: ceilTicks(tick, required(m, "order_min_price")),
    maxPriceTicks: floorTicks(tick, required(m, "order_max_price")),
    minSizeSteps: steps(minSize),
    maxSizeSteps: toSteps(step, required(m, "order_limit_max_size")),
    strikeMinNotional: microUsd(MICRO_USD.ceilUnits(m.order_min_notional)),
    strikePriceBoundBps: ONE_BPS.floorUnits(required(m, "order_limit_price_bound")),
    ballastMinNotional: BALLAST_MIN_NOTIONAL,
    ballastPriceBandBps: BALLAST_PRICE_BAND_BPS,
    trading: m.status === undefined || m.status === "trading",
  };
}

/** A reference price (index, mark) for this market as an exact fraction of a tick. */
export const marketRef = (m: Pick<EngineMarket, "tick">, price: string): RefPrice =>
  refPrice(m.tick, price);
