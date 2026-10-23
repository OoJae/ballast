import type { L3Book } from "@ballast/strike-client";
import {
  depthWithin,
  type GridSpec,
  type Level,
  type LevelBook,
  levelsFromL3,
  midPx,
  walkNotional,
  walkQuantity,
} from "./book.js";
import { add, BPS, type Dec, dec, div, mul, sub, ZERO } from "./decimal.js";

export const DEPTH_BANDS = ["0.5%", "1%", "2%"] as const;
export type DepthBand = (typeof DEPTH_BANDS)[number];
const BAND_FRACTION: Record<DepthBand, Dec> = {
  "0.5%": dec("0.005"),
  "1%": dec("0.01"),
  "2%": dec("0.02"),
};

export const SLIPPAGE_SIZES = ["1000", "10000", "25000"] as const;
export type SlippageSize = (typeof SLIPPAGE_SIZES)[number];

export interface BookHealth {
  bestBid: Dec | null;
  bestAsk: Dec | null;
  /** This book's own mid. */
  mid: Dec | null;
  /**
   * The price spread, depth bands and slippage are measured against. In an actual/counterfactual
   * pair both books share one: the counterfactual (non-Ballast) mid, so Ballast's own quotes
   * cannot move the yardstick they are judged by.
   */
  ref: Dec | null;
  /** (ask − bid) / ref in bps; null unless both sides exist. */
  spreadBps: Dec | null;
  /** USD resting within ±band of ref, per side; null without a ref. */
  depthUsd: { bid: Record<DepthBand, Dec>; ask: Record<DepthBand, Dec> } | null;
  /**
   * VWAP of a market order of that USD size vs ref, in bps (buys walk asks, sells walk bids);
   * null when the side cannot fill it.
   */
  slippageBps: {
    buy: Record<SlippageSize, Dec | null>;
    sell: Record<SlippageSize, Dec | null>;
  } | null;
  /** The same orders' absolute VWAPs, comparable across books whatever their mids. */
  vwap: {
    buy: Record<SlippageSize, Dec | null>;
    sell: Record<SlippageSize, Dec | null>;
  } | null;
}

export interface BookHealthPair {
  actual: BookHealth;
  /** The same book with Ballast's orders removed. */
  counterfactual: BookHealth;
  ballastOrders: number;
}

/** Book Health of one aggregated book against `ref` (default: its own mid). */
export function measureLevels(
  book: LevelBook,
  spec: GridSpec,
  ref: Dec | null = midPx(book, spec.tick),
): BookHealth {
  const b = book.bids[0];
  const a = book.asks[0];
  const bestBid = b ? spec.tick.fromUnits(b.px) : null;
  const bestAsk = a ? spec.tick.fromUnits(a.px) : null;
  const mid = midPx(book, spec.tick);
  if (!ref) {
    return {
      bestBid,
      bestAsk,
      mid,
      ref,
      spreadBps: null,
      depthUsd: null,
      slippageBps: null,
      vwap: null,
    };
  }
  const depth = (levels: Level[], side: "bid" | "ask") =>
    Object.fromEntries(
      DEPTH_BANDS.map((band) => [band, depthWithin(levels, side, ref, BAND_FRACTION[band], spec)]),
    ) as Record<DepthBand, Dec>;
  const walks = (levels: Level[]) =>
    Object.fromEntries(
      SLIPPAGE_SIZES.map((size) => [size, walkNotional(levels, dec(size), spec)?.vwap ?? null]),
    ) as Record<SlippageSize, Dec | null>;
  const slip = (vwaps: Record<SlippageSize, Dec | null>, buy: boolean) =>
    Object.fromEntries(
      SLIPPAGE_SIZES.map((size) => {
        const v = vwaps[size];
        return [size, v ? div(mul(buy ? sub(v, ref) : sub(ref, v), BPS), ref) : null];
      }),
    ) as Record<SlippageSize, Dec | null>;
  const buy = walks(book.asks);
  const sell = walks(book.bids);
  return {
    bestBid,
    bestAsk,
    mid,
    ref,
    spreadBps: bestBid && bestAsk ? div(mul(sub(bestAsk, bestBid), BPS), ref) : null,
    depthUsd: { bid: depth(book.bids, "bid"), ask: depth(book.asks, "ask") },
    slippageBps: { buy: slip(buy, true), sell: slip(sell, false) },
    vwap: { buy, sell },
  };
}

/**
 * Actual vs counterfactual from aggregated books, both measured against the counterfactual mid
 * (or, when the counterfactual book is one-sided, the actual mid). `counterfactual` null means
 * Ballast has no orders in the book.
 */
export function healthPairOfLevels(
  actual: LevelBook,
  counterfactual: LevelBook | null,
  spec: GridSpec,
  ballastOrders = 0,
): BookHealthPair {
  if (!counterfactual) {
    const h = measureLevels(actual, spec);
    return { actual: h, counterfactual: h, ballastOrders };
  }
  const ref = midPx(counterfactual, spec.tick) ?? midPx(actual, spec.tick);
  return {
    actual: measureLevels(actual, spec, ref),
    counterfactual: measureLevels(counterfactual, spec, ref),
    ballastOrders,
  };
}

/** Book Health of an L3 book, actual and counterfactual (Ballast's orders removed). */
export function measureBook(
  book: Pick<L3Book, "bids" | "asks">,
  ballastIds: ReadonlySet<string>,
  spec: GridSpec,
): BookHealthPair {
  const ballastOrders = countOrders(book, ballastIds);
  const actual = levelsFromL3(book, spec);
  const cf = ballastOrders === 0 ? null : levelsFromL3(book, spec, ballastIds);
  return healthPairOfLevels(actual, cf, spec, ballastOrders);
}

/** How many of `ids` rest in an L3 book. */
export function countOrders(book: Pick<L3Book, "bids" | "asks">, ids: ReadonlySet<string>): number {
  if (ids.size === 0) return 0;
  let n = 0;
  for (const side of [book.bids, book.asks]) {
    for (const q of side.values()) for (const o of q) if (ids.has(o.id)) n += 1;
  }
  return n;
}

/** Time-weighted mean of a metric that may be undefined part of the time. */
class TimeWeighted {
  private weighted = ZERO;
  definedMs = 0;
  totalMs = 0;

  add(x: Dec | null, dtMs: number): void {
    this.totalMs += dtMs;
    if (x === null) return;
    this.definedMs += dtMs;
    this.weighted = add(this.weighted, mul(x, dtMs));
  }

  mean(): Dec | null {
    return this.definedMs === 0 ? null : div(this.weighted, this.definedMs);
  }
}

export interface MetricSummary {
  /** Time-weighted mean over the time the metric was defined. */
  mean: string | null;
  /** Share of time the metric was defined (e.g. a $25K buy could be filled). */
  coverage: number;
}

export interface BookHealthSide {
  ms: number;
  actual: Record<string, MetricSummary>;
  counterfactual: Record<string, MetricSummary>;
}

export interface BookHealthReport {
  armed: BookHealthSide;
  unarmed: BookHealthSide;
}

function flatten(h: BookHealth): [string, Dec | null][] {
  const out: [string, Dec | null][] = [["spreadBps", h.spreadBps]];
  for (const side of ["bid", "ask"] as const) {
    for (const band of DEPTH_BANDS)
      out.push([`depthUsd.${side}.${band}`, h.depthUsd?.[side][band] ?? null]);
  }
  for (const dir of ["buy", "sell"] as const) {
    for (const size of SLIPPAGE_SIZES) {
      out.push([`slippageBps.${dir}.${size}`, h.slippageBps?.[dir][size] ?? null]);
      out.push([`vwap.${dir}.${size}`, h.vwap?.[dir][size] ?? null]);
    }
  }
  return out;
}

/** Σ metric·Δt / Σ Δt, split armed vs unarmed and actual vs counterfactual. */
export class BookHealthAggregator {
  private readonly acc = {
    armed: {
      actual: new Map<string, TimeWeighted>(),
      counterfactual: new Map<string, TimeWeighted>(),
    },
    unarmed: {
      actual: new Map<string, TimeWeighted>(),
      counterfactual: new Map<string, TimeWeighted>(),
    },
  };
  private readonly ms = { armed: 0, unarmed: 0 };

  add(pair: BookHealthPair, dtMs: number, armed: boolean): void {
    if (!Number.isSafeInteger(dtMs) || dtMs <= 0) return;
    const key = armed ? "armed" : "unarmed";
    this.ms[key] += dtMs;
    for (const view of ["actual", "counterfactual"] as const) {
      const map = this.acc[key][view];
      for (const [name, value] of flatten(pair[view])) {
        let tw = map.get(name);
        if (!tw) {
          tw = new TimeWeighted();
          map.set(name, tw);
        }
        tw.add(value, dtMs);
      }
    }
  }

  report(dp = 4): BookHealthReport {
    const side = (key: "armed" | "unarmed"): BookHealthSide => {
      const view = (m: Map<string, TimeWeighted>) =>
        Object.fromEntries(
          [...m].map(([name, tw]) => [
            name,
            {
              mean: tw.mean()?.toDecimalPlaces(dp).toFixed() ?? null,
              coverage: tw.totalMs === 0 ? 0 : tw.definedMs / tw.totalMs,
            },
          ]),
        );
      return {
        ms: this.ms[key],
        actual: view(this.acc[key].actual),
        counterfactual: view(this.acc[key].counterfactual),
      };
    };
    return { armed: side("armed"), unarmed: side("unarmed") };
  }
}

/** One taker buy as L3 shows it: the maker orders it filled, in sequence. */
export interface TakerBuy {
  takerOrderId: string;
  tMs: number;
  fills: { orderId: string; px: bigint; qty: bigint }[];
}

export interface Savings {
  takerOrderId: string;
  tMs: number;
  qty: Dec;
  actualVwap: Dec;
  /** Re-matched FIFO by size against the pre-trade book without Ballast; null if too thin. */
  counterfactualVwap: Dec | null;
  /** (counterfactual VWAP − actual VWAP) × size, in USD. */
  savingsUsd: Dec | null;
  touchedBallast: boolean;
}

/**
 * Realized savings of one taker buy: what the same size would have cost on the book without
 * Ballast (the asks resting just before the trade, Ballast removed), minus what it cost.
 */
export function realizedSavings(
  buy: TakerBuy,
  counterfactualAsks: readonly Level[],
  ballastIds: ReadonlySet<string>,
  spec: GridSpec,
): Savings {
  let qtySteps = 0n;
  let cost = ZERO;
  for (const f of buy.fills) {
    qtySteps += f.qty;
    cost = add(cost, mul(spec.tick.fromUnits(f.px), spec.step.fromUnits(f.qty)));
  }
  const qty = spec.step.fromUnits(qtySteps);
  if (qtySteps === 0n) throw new Error("realizedSavings: taker buy without fills");
  const actualVwap = div(cost, qty);
  const cf = walkQuantity(counterfactualAsks, qtySteps, spec);
  return {
    takerOrderId: buy.takerOrderId,
    tMs: buy.tMs,
    qty,
    actualVwap,
    counterfactualVwap: cf?.vwap ?? null,
    savingsUsd: cf ? mul(sub(cf.vwap, actualVwap), qty) : null,
    touchedBallast: buy.fills.some((f) => ballastIds.has(f.orderId)),
  };
}
