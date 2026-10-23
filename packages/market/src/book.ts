import type { L3Book, L3Order } from "@ballast/strike-client";
import { add, type Dec, div, type Grid, minBig, mul, sub, ZERO } from "./decimal.js";

/** One aggregated price level in integer units: `px` in ticks, `qty` in size steps. */
export interface Level {
  px: bigint;
  qty: bigint;
}

/** Aggregated book, each side best-first (bids descending, asks ascending). */
export interface LevelBook {
  bids: Level[];
  asks: Level[];
}

export interface GridSpec {
  tick: Grid;
  step: Grid;
}

export type BookSide = "bid" | "ask";

const unitCache = new WeakMap<Grid, Map<string, bigint>>();

/** Cached exact conversion: L3 books repeat the same price and size strings constantly. */
function units(grid: Grid, s: string): bigint {
  let cache = unitCache.get(grid);
  if (!cache) {
    cache = new Map();
    unitCache.set(grid, cache);
  }
  let v = cache.get(s);
  if (v === undefined) {
    v = grid.toUnits(s);
    if (cache.size > 200_000) cache.clear();
    cache.set(s, v);
  }
  return v;
}

function sideFromL3(
  side: ReadonlyMap<string, readonly L3Order[]>,
  spec: GridSpec,
  exclude: ReadonlySet<string> | undefined,
  descending: boolean,
): Level[] {
  const out: Level[] = [];
  for (const [price, queue] of side) {
    let qty = 0n;
    for (const o of queue) {
      if (exclude?.has(o.id)) continue;
      qty += units(spec.step, o.size);
    }
    if (qty > 0n) out.push({ px: units(spec.tick, price), qty });
  }
  return out.sort((a, b) => (descending ? cmpBig(b.px, a.px) : cmpBig(a.px, b.px)));
}

/** Aggregates an L3 book, optionally without some orders (the counterfactual book). */
export function levelsFromL3(
  book: Pick<L3Book, "bids" | "asks">,
  spec: GridSpec,
  exclude?: ReadonlySet<string>,
): LevelBook {
  return {
    bids: sideFromL3(book.bids, spec, exclude, true),
    asks: sideFromL3(book.asks, spec, exclude, false),
  };
}

/** From `[price, qty]` pairs such as `/price/v2/depth`. Nonpositive levels are dropped. */
export function levelsFromPairs(
  bids: readonly (readonly [string, string])[],
  asks: readonly (readonly [string, string])[],
  spec: GridSpec,
): LevelBook {
  const conv = (pairs: readonly (readonly [string, string])[], descending: boolean) =>
    pairs
      .map(([p, q]) => ({ px: units(spec.tick, p), qty: units(spec.step, q) }))
      .filter((l) => l.px > 0n && l.qty > 0n)
      .sort((a, b) => (descending ? cmpBig(b.px, a.px) : cmpBig(a.px, b.px)));
  return { bids: conv(bids, true), asks: conv(asks, false) };
}

/** Merges extra levels (e.g. a proposed ladder) into one side, keeping best-first order. */
export function mergeLevels(levels: readonly Level[], extra: readonly Level[], side: BookSide) {
  const byPx = new Map<bigint, bigint>();
  for (const l of [...levels, ...extra]) byPx.set(l.px, (byPx.get(l.px) ?? 0n) + l.qty);
  return [...byPx]
    .filter(([, q]) => q > 0n)
    .map(([px, qty]) => ({ px, qty }))
    .sort((a, b) => (side === "bid" ? cmpBig(b.px, a.px) : cmpBig(a.px, b.px)));
}

export function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function midPx(book: LevelBook, tick: Grid): Dec | null {
  const b = book.bids[0];
  const a = book.asks[0];
  if (!b || !a) return null;
  return div(tick.fromUnits(b.px + a.px), 2);
}

export interface Walk {
  /** Base quantity taken (fractional at the final level for a notional walk). */
  qty: Dec;
  /** Quote spent. */
  cost: Dec;
  vwap: Dec;
  /** Levels touched. */
  levels: number;
  /** Price of the last level touched, in ticks. */
  lastPx: bigint;
}

/**
 * Walks one side best-first until `notional` of quote is spent, taking only the required part of
 * the final level: total qty = Σq_i (i < k) + (N − Σp_i·q_i) / p_k, price = N / total qty
 * (prices.md "Impact Price"). Null when the side (or its first `maxLevels` levels) cannot fill it.
 */
export function walkNotional(
  levels: readonly Level[],
  notional: Dec,
  spec: GridSpec,
  maxLevels = Number.POSITIVE_INFINITY,
): Walk | null {
  if (notional.lte(0)) return null;
  let before = ZERO;
  let qty = ZERO;
  for (let i = 0; i < levels.length && i < maxLevels; i++) {
    const l = levels[i] as Level;
    const p = spec.tick.fromUnits(l.px);
    const cum = add(before, mul(p, spec.step.fromUnits(l.qty)));
    if (cum.gte(notional)) {
      const total = add(qty, div(sub(notional, before), p));
      return {
        qty: total,
        cost: notional,
        vwap: div(notional, total),
        levels: i + 1,
        lastPx: l.px,
      };
    }
    before = cum;
    qty = add(qty, spec.step.fromUnits(l.qty));
  }
  return null;
}

/** Walks one side best-first for an exact quantity in steps. Null when the side is too thin. */
export function walkQuantity(
  levels: readonly Level[],
  qtySteps: bigint,
  spec: GridSpec,
): Walk | null {
  if (qtySteps <= 0n) return null;
  let left = qtySteps;
  let cost = ZERO;
  for (const [i, l] of levels.entries()) {
    const take = minBig(l.qty, left);
    cost = add(cost, mul(spec.tick.fromUnits(l.px), spec.step.fromUnits(take)));
    left -= take;
    if (left === 0n) {
      const qty = spec.step.fromUnits(qtySteps);
      return { qty, cost, vwap: div(cost, qty), levels: i + 1, lastPx: l.px };
    }
  }
  return null;
}

/**
 * A taker sweep: removes up to `qtySteps` from one side best-first, never past `limitPx`.
 * Returns the remaining side and the fills taken.
 */
export function consume(
  levels: readonly Level[],
  side: BookSide,
  qtySteps: bigint,
  limitPx?: bigint,
): { rest: Level[]; fills: Level[] } {
  const rest: Level[] = [];
  const fills: Level[] = [];
  let left = qtySteps;
  for (const l of levels) {
    const outside = limitPx !== undefined && (side === "ask" ? l.px > limitPx : l.px < limitPx);
    if (left === 0n || outside) {
      rest.push({ ...l });
      continue;
    }
    const take = minBig(l.qty, left);
    left -= take;
    fills.push({ px: l.px, qty: take });
    if (l.qty > take) rest.push({ px: l.px, qty: l.qty - take });
  }
  return { rest, fills };
}

/** Impact price on the first 50 levels (prices.md); null when the side cannot fill the notional. */
export function impactPrice(levels: readonly Level[], notional: Dec, spec: GridSpec): Dec | null {
  return walkNotional(levels, notional, spec, 50)?.vwap ?? null;
}

/** Falls back to the reference R when an impact side is missing, ≤ 0, or outside [0.8R, 1.2R]. */
export function protectImpact(ip: Dec | null, ref: Dec): Dec {
  if (!ip || ip.lte(0) || ip.lt(mul("0.8", ref)) || ip.gt(mul("1.2", ref))) return ref;
  return ip;
}

/** Quote notional resting within ±fraction of `mid` on one side (bids ≥ mid(1−f), asks ≤ mid(1+f)). */
export function depthWithin(
  levels: readonly Level[],
  side: BookSide,
  mid: Dec,
  fraction: Dec,
  spec: GridSpec,
): Dec {
  const bound = side === "bid" ? mul(mid, sub(1, fraction)) : mul(mid, add(1, fraction));
  let total = ZERO;
  for (const l of levels) {
    const p = spec.tick.fromUnits(l.px);
    if (side === "bid" ? p.lt(bound) : p.gt(bound)) break;
    total = add(total, mul(p, spec.step.fromUnits(l.qty)));
  }
  return total;
}
