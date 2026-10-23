import type { NotionalRate, Steps, Ticks } from "@ballast/core";
import { minBigint, steps, ticks } from "@ballast/core";
import type { Grid } from "@ballast/market";
import { canonicalPrice, type L3Order } from "@ballast/strike-client";

/**
 * The replay fill model (plan section 9):
 * - A Ballast order joins the tail of its price level when inserted: it is behind every house
 *   order resting there at that moment (`ahead`) and ahead of every later one. L3 ids are exact,
 *   so its queue place moves up exactly as those orders fill or cancel.
 * - A recorded taker order (its fills grouped by taker_order_id: max price, total size) is
 *   re-matched FIFO against the pre-trade book including Ballast. Same size is the primary case;
 *   same notional is the sensitivity run. No elasticity credit: no taker is invented.
 * - The house book keeps following the recording; only Ballast's fills are derived.
 */
export interface SimOrder {
  /** The engine's numeric order id. */
  id: bigint;
  clientOrderId: string;
  accountId: string;
  level: number;
  px: Ticks;
  /** Remaining size. */
  qty: Steps;
  /** House L3 order ids resting at this price when the order was inserted. */
  ahead: ReadonlySet<string>;
  /** Insertion order, for ties between Ballast orders at one price. */
  seq: number;
}

export interface TakerBuy {
  maxPx: Ticks;
  /** Same-size mode: steps to take. */
  qty: Steps;
  /** Same-notional mode: notional in (µUSD × rate.den) units, so it stays exact. */
  notionalScaled: bigint;
}

export interface BallastFill {
  order: SimOrder;
  qty: Steps;
  px: Ticks;
}

export interface Grids {
  tick: Grid;
  step: Grid;
  rate: NotionalRate;
}

const unitCache = new WeakMap<Grid, Map<string, bigint>>();
function units(grid: Grid, s: string): bigint {
  let m = unitCache.get(grid);
  if (!m) {
    m = new Map();
    unitCache.set(grid, m);
  }
  let v = m.get(s);
  if (v === undefined) {
    v = grid.toUnits(s);
    if (m.size > 100_000) m.clear();
    m.set(s, v);
  }
  return v;
}

/** The house orders an order inserted now at `px` would queue behind. */
export function aheadAt(
  asks: ReadonlyMap<string, readonly L3Order[]>,
  priceKey: string,
): Set<string> {
  return new Set((asks.get(canonicalPrice(priceKey)) ?? []).map((o) => o.id));
}

type QueueItem = { house: true; size: bigint } | { house: false; order: SimOrder };

/** One price level's FIFO queue: house orders in book order, Ballast orders at their places. */
function queueAt(house: readonly L3Order[], ballast: readonly SimOrder[], g: Grids): QueueItem[] {
  const anchored = new Map<number, SimOrder[]>();
  const index = new Map(house.map((o, i) => [o.id, i]));
  for (const b of [...ballast].sort((x, y) => x.seq - y.seq)) {
    let anchor = -1;
    for (const id of b.ahead) {
      const i = index.get(id);
      if (i !== undefined && i > anchor) anchor = i;
    }
    const list = anchored.get(anchor) ?? [];
    list.push(b);
    anchored.set(anchor, list);
  }
  const out: QueueItem[] = [];
  for (const b of anchored.get(-1) ?? []) out.push({ house: false, order: b });
  for (const [i, o] of house.entries()) {
    out.push({ house: true, size: units(g.step, o.size) });
    for (const b of anchored.get(i) ?? []) out.push({ house: false, order: b });
  }
  return out;
}

/**
 * Re-matches one taker buy FIFO against the house asks as they stood before it (plus Ballast's
 * asks), never past its max price. Returns only Ballast's fills.
 */
export function matchTakerBuy(
  houseAsks: ReadonlyMap<string, readonly L3Order[]>,
  ballast: readonly SimOrder[],
  taker: TakerBuy,
  mode: "size" | "notional",
  g: Grids,
): BallastFill[] {
  const byPx = new Map<bigint, { key: string | null; orders: SimOrder[] }>();
  for (const [key] of houseAsks) {
    const px = units(g.tick, key);
    if (px <= taker.maxPx) byPx.set(px, { key, orders: [] });
  }
  for (const b of ballast) {
    if (b.px > taker.maxPx || b.qty <= 0n) continue;
    const e = byPx.get(b.px) ?? { key: null, orders: [] };
    e.orders.push(b);
    byPx.set(b.px, e);
  }
  const fills: BallastFill[] = [];
  let leftQty: bigint = taker.qty;
  let leftScaled = taker.notionalScaled;
  const prices = [...byPx.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const px of prices) {
    const e = byPx.get(px);
    if (!e) continue;
    const perStep = px * g.rate.num;
    for (const item of queueAt(e.key ? (houseAsks.get(e.key) ?? []) : [], e.orders, g)) {
      const avail = item.house ? item.size : item.order.qty;
      let take: bigint;
      if (mode === "size") {
        take = minBigint(avail, leftQty);
        leftQty -= take;
      } else {
        const can = perStep > 0n ? leftScaled / perStep : 0n;
        take = minBigint(avail, can);
        leftScaled -= take * perStep;
      }
      if (!item.house && take > 0n)
        fills.push({ order: item.order, qty: steps(take), px: ticks(px) });
      if (mode === "size" ? leftQty === 0n : leftScaled < perStep) return fills;
    }
  }
  return fills;
}

/**
 * A recorded bid that opens at or above Ballast's ask would have traded with it instead of
 * resting: it takes Ballast's asks at or below its price, cheapest first.
 */
export function matchCrossingBid(
  ballast: readonly SimOrder[],
  bidPx: Ticks,
  qty: Steps,
): BallastFill[] {
  const fills: BallastFill[] = [];
  let left: bigint = qty;
  const eligible = ballast
    .filter((b) => b.px <= bidPx && b.qty > 0n)
    .sort((a, b) => (a.px < b.px ? -1 : a.px > b.px ? 1 : a.seq - b.seq));
  for (const b of eligible) {
    if (left === 0n) break;
    const take = minBigint(b.qty, left);
    left -= take;
    fills.push({ order: b, qty: steps(take), px: b.px });
  }
  return fills;
}
