import { L3Book, type L3Snapshot, type L3Status, type L3Update } from "@ballast/strike-client/l3";
import { type Level, type LevelBook, levelsFromL3, protectImpact } from "./book.js";
import {
  BookHealthAggregator,
  type BookHealthPair,
  countOrders,
  healthPairOfLevels,
  realizedSavings,
  type Savings,
  type TakerBuy,
} from "./book-health.js";
import { BPS, type Dec, dec, div, roundHalfEven } from "./decimal.js";
import { type FloorPosition, longTriggerPrice, positionsStale } from "./floor.js";
import {
  type BookPremiumSample,
  type PremiumIndexRecord,
  premium,
  slotStartOf,
} from "./funding-replica.js";
import { type BookSample, bookTop, type MarkTick, type TradePrint } from "./mark-replica.js";
import { type MarketSpec, marketSpec, type StrikeMarketPayload } from "./market.js";
import type { MarginTier } from "./math/marginTiers.js";
import { findL3Bootstrap, type ReadStats, readRecordings } from "./recordings.js";

/** The recorder's minimized live-position row. */
export interface RecordedPosition {
  symbol: string;
  size: string;
  entry_price: string;
  mark_price: string;
  leverage: number;
  margin_mode: string;
  isolated_margin: string;
  liquidation_price: string;
  is_vault?: boolean;
}

export interface PositionsSnapshot {
  recvMs: number;
  /** The snapshot's `updated_at`; −∞ when it was missing, so its age reads as stale. */
  updatedAtMs: number;
  positions: RecordedPosition[];
}

/** A recorded row as the floor reads it. */
export function floorPosition(p: RecordedPosition): FloorPosition {
  return {
    size: p.size,
    entryPrice: p.entry_price,
    markPrice: p.mark_price,
    liquidationPrice: p.liquidation_price,
  };
}

/** How often the floor's inputs were fragile or stale over a series of ticks. Aggregate only. */
export interface FloorIncidence {
  ticks: number;
  /** Ticks where some live long's tier-consistent trigger was ≥ index × (1 − b_liq). */
  fragile: number;
  /** Ticks with no snapshot yet, or one stale by `positionsStale` (unknown ages included). */
  stale: number;
  /** Distinct long states (size, entry, served LP) seen, and how many trigger above the served LP. */
  longStates: number;
  tierAdjustedStates: number;
  /** Largest trigger uplift over a positive served LP, in bps of it. */
  maxTierUpliftBps: Dec | null;
}

/**
 * Fragile-long and stale-positions incidence: each tick is judged against the latest snapshot
 * received at or before it. Individual liquidation prices never leave this function.
 */
export function floorIncidence(
  ticks: readonly Pick<MarkTick, "tMs" | "index">[],
  snapshots: readonly PositionsSnapshot[],
  tiers: readonly MarginTier[],
  bLiq: Dec,
  staleAfterMs?: number,
): FloorIncidence {
  // Per distinct state: the uplift in bps over a positive served LP; null for a served "0".
  const states = new Map<string, Dec | null>();
  const maxTrigger: (Dec | null)[] = snapshots.map((snap) => {
    let best: Dec | null = null;
    for (const row of snap.positions) {
      const trigger = longTriggerPrice(floorPosition(row), tiers);
      if (!trigger) continue;
      if (!best || trigger.gt(best)) best = trigger;
      const served = dec(row.liquidation_price);
      const uplift = served.gt(0) ? trigger.minus(served).times(BPS).div(served) : null;
      states.set(`${row.size}|${row.entry_price}|${row.liquidation_price}`, uplift);
    }
    return best;
  });
  const factor = dec(1).minus(bLiq.div(BPS));
  let fragile = 0;
  let stale = 0;
  let si = -1;
  for (const t of ticks) {
    while (si + 1 < snapshots.length && (snapshots[si + 1]?.recvMs ?? 0) <= t.tMs) si += 1;
    const snap = snapshots[si];
    if (!snap || positionsStale(t.tMs - snap.updatedAtMs, staleAfterMs)) stale += 1;
    const m = maxTrigger[si];
    if (snap && m?.gte(t.index.times(factor))) fragile += 1;
  }
  const all = [...states.values()];
  const uplifts = all.filter((u): u is Dec => u?.gt(0) ?? false);
  return {
    ticks: ticks.length,
    fragile,
    stale,
    longStates: states.size,
    tierAdjustedStates: uplifts.length + all.filter((u) => u === null).length,
    maxTierUpliftBps: uplifts.reduce<Dec | null>((a, u) => (a?.gte(u) ? a : u), null),
  };
}

export interface ReplayOptions {
  root: string;
  symbols: readonly string[];
  /** Engine-time window [fromMs, toMs) for Book Health; the replica series cover it too. */
  fromMs: number;
  toMs: number;
  /** Ballast's order ids; empty for the "before" book. */
  ballastIds?: ReadonlySet<string>;
  armed?: (symbol: string, tMs: number) => boolean;
  /** Book Health sampling period in engine time (default 1 s). */
  healthSampleMs?: number;
  /** Replica book grid (default 500 ms). */
  gridMs?: number;
  /** Extra receive-time read past `toMs`, for records that arrive late (default 10 s). */
  slackMs?: number;
  onProgress?: (lines: number, recvMs: number) => void;
  /**
   * Called for every Book Health sample in the window with the exact book it was measured on,
   * so consumers (the public API's replay frames) see the same state the aggregate does.
   */
  onHealthSample?: (sample: HealthSample) => void;
  /** Called for every taker buy in the window (the maker fills it took, in L3 order). */
  onTakerBuy?: (symbol: string, buy: TakerBuy) => void;
}

export interface HealthSample {
  symbol: string;
  /** Engine time of the sample (a multiple of `healthSampleMs`). */
  tMs: number;
  spec: MarketSpec;
  /** The live replay book; read it synchronously and never mutate it. */
  book: Readonly<L3Book>;
  levels: LevelBook;
  pair: BookHealthPair;
  armed: boolean;
}

export interface ReplayStats {
  l3Updates: number;
  snapshots: number;
  rebuilds: number;
  /** Updates that broke the sequence (gap, clear, unknown order) and forced a re-bootstrap. */
  breaks: number;
  /** Book Health time lost to an unsynced book, in ms. */
  unsyncedMs: number;
  healthSamples: number;
  takerBuys: number;
}

export interface SymbolReplay {
  symbol: string;
  spec: MarketSpec | null;
  health: BookHealthAggregator;
  /** On the replica grid, only while synced. */
  books: BookSample[];
  ticks: MarkTick[];
  trades: TradePrint[];
  premiumRecords: PremiumIndexRecord[];
  positions: PositionsSnapshot[];
  /** Taker buys that touched a Ballast order. */
  savings: Savings[];
  stats: ReplayStats;
}

export interface ReplayResult {
  bootstrapFromMs: number;
  fromMs: number;
  toMs: number;
  gridMs: number;
  symbols: Map<string, SymbolReplay>;
  read: ReadStats;
}

/**
 * An L3 book that survives the recorder's own reconnects. Updates received between a
 * resubscribe's ack and its snapshot may already be applied to the old book; they are replayed
 * on top of the snapshot when newer than it.
 */
export class ReplayBook {
  readonly book: L3Book;
  private recent: L3Update[] = [];
  private buffered = 0;

  constructor(symbol: string) {
    this.book = new L3Book(symbol);
  }

  get synced(): boolean {
    return this.book.synced;
  }

  reset(): void {
    this.book.reset();
    this.recent = [];
    this.buffered = 0;
  }

  update(u: L3Update): L3Status {
    if (!this.book.synced) {
      // A feed that never re-snapshots must not grow without bound.
      if (++this.buffered > 1_000_000) this.reset();
      return this.book.onUpdate(u);
    }
    const st = this.book.onUpdate(u);
    if (st.ok) {
      this.recent.push(u);
      if (this.recent.length > 20_000) this.recent.splice(0, 10_000);
      return st;
    }
    this.reset();
    if (st.reason !== "clear") this.book.onUpdate(u);
    return st;
  }

  snapshot(s: L3Snapshot): L3Status {
    const carry = this.book.synced ? this.recent.filter((u) => u.sequence > s.last_sequence) : [];
    this.recent = [];
    this.buffered = 0;
    let st = this.book.applySnapshot(s);
    for (const u of carry) {
      if (!st.ok) break;
      st = this.book.onUpdate(u);
    }
    if (!st.ok) this.reset();
    return st;
  }
}

interface SymbolState {
  out: SymbolReplay;
  book: ReplayBook;
  /** Engine time the book state is known through (last update/snapshot timestamp). */
  clockMs: number;
  nextGridMs: number;
  nextHealthMs: number;
  dirty: boolean;
  levels: LevelBook | null;
  pair: BookHealthPair | null;
  sample: Omit<BookSample, "tMs"> | null;
  lastUpdateMs: number | null;
  taker: (TakerBuy & { cfAsks: Level[] }) | null;
  tradeIds: Set<number>;
}

/**
 * Replays recordings: rebuilds each symbol's L3 book from snapshot + update sequences (a rebuild
 * record, a sequence break or a socket close re-bootstraps from the next snapshot), samples Book
 * Health on an engine-time grid, and collects the series the mark and funding replicas fit on.
 */
export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const gridMs = opts.gridMs ?? 500;
  const healthMs = opts.healthSampleMs ?? 1_000;
  const ballast = opts.ballastIds ?? new Set<string>();
  const armed = opts.armed ?? (() => false);
  const bootstrap = (await findL3Bootstrap(opts.root, opts.fromMs, opts.symbols)) ?? opts.fromMs;

  const states = new Map<string, SymbolState>();
  for (const symbol of opts.symbols) {
    states.set(symbol, {
      out: {
        symbol,
        spec: null,
        health: new BookHealthAggregator(),
        books: [],
        ticks: [],
        trades: [],
        premiumRecords: [],
        positions: [],
        savings: [],
        stats: {
          l3Updates: 0,
          snapshots: 0,
          rebuilds: 0,
          breaks: 0,
          unsyncedMs: 0,
          healthSamples: 0,
          takerBuys: 0,
        },
      },
      book: new ReplayBook(symbol),
      clockMs: Number.NEGATIVE_INFINITY,
      nextGridMs: Number.NEGATIVE_INFINITY,
      nextHealthMs: Number.NEGATIVE_INFINITY,
      dirty: true,
      levels: null,
      pair: null,
      sample: null,
      lastUpdateMs: null,
      taker: null,
      tradeIds: new Set(),
    });
  }

  const resetAll = () => {
    for (const st of states.values()) {
      finishTaker(st);
      st.book.reset();
      st.dirty = true;
    }
  };

  const finishTaker = (st: SymbolState) => {
    const t = st.taker;
    st.taker = null;
    const spec = st.out.spec;
    if (!t || !spec || t.tMs < opts.fromMs || t.tMs >= opts.toMs) return;
    st.out.stats.takerBuys += 1;
    const s = realizedSavings(t, t.cfAsks, ballast, spec);
    if (s.touchedBallast) st.out.savings.push(s);
    opts.onTakerBuy?.(st.out.symbol, { takerOrderId: t.takerOrderId, tMs: t.tMs, fills: t.fills });
  };

  /** Emits grid and health samples for engine times strictly before `t`, from the current book. */
  const advance = (st: SymbolState, t: number) => {
    const spec = st.out.spec;
    if (!st.book.synced || !spec) {
      if (Number.isFinite(st.nextHealthMs)) {
        const from = Math.max(st.nextHealthMs, opts.fromMs);
        const to = Math.min(t, opts.toMs);
        if (to > from) st.out.stats.unsyncedMs += to - from;
      }
      st.nextGridMs = Math.max(st.nextGridMs, ceilTo(t, gridMs));
      st.nextHealthMs = Math.max(st.nextHealthMs, ceilTo(t, healthMs));
      return;
    }
    for (;;) {
      const next = Math.min(st.nextGridMs, st.nextHealthMs);
      if (!(next < t)) return;
      if (st.dirty || !st.levels || !st.sample) {
        st.levels = levelsFromL3(st.book.book, spec);
        st.sample = bookTop(st.levels, spec, st.lastUpdateMs ?? st.clockMs);
        st.pair = null;
        st.dirty = false;
      }
      if (st.nextGridMs === next) {
        st.out.books.push({ tMs: next, ...st.sample });
        st.nextGridMs += gridMs;
      }
      if (st.nextHealthMs === next) {
        if (next >= opts.fromMs && next < opts.toMs) {
          st.pair ??= healthPair(st, spec, ballast);
          const isArmed = armed(st.out.symbol, next);
          st.out.health.add(st.pair, healthMs, isArmed);
          st.out.stats.healthSamples += 1;
          opts.onHealthSample?.({
            symbol: st.out.symbol,
            tMs: next,
            spec,
            book: st.book.book,
            levels: st.levels,
            pair: st.pair,
            armed: isArmed,
          });
        }
        st.nextHealthMs += healthMs;
      }
    }
  };

  const read: ReadStats = { lines: 0, badLines: 0 };
  let n = 0;
  for await (const rec of readRecordings(
    opts.root,
    { fromMs: bootstrap, toMs: opts.toMs + (opts.slackMs ?? 10_000) },
    read,
  )) {
    n += 1;
    if (opts.onProgress && n % 200_000 === 0) opts.onProgress(n, rec.r);
    const d = rec.d as Record<string, unknown>;
    if (rec.stream === "l3") {
      if (rec.k === "update") {
        const u = d as unknown as L3Update;
        const st = states.get(u.symbol);
        if (!st) continue;
        st.out.stats.l3Updates += 1;
        advance(st, u.timestamp);
        onL3Update(st, u, ballast, finishTaker);
      } else if (rec.k === "snapshot") {
        const s = d as unknown as L3Snapshot;
        const st = states.get(s.symbol);
        if (!st) continue;
        finishTaker(st);
        advance(st, s.timestamp);
        st.out.stats.snapshots += 1;
        if (!st.book.snapshot(s).ok) st.out.stats.breaks += 1;
        st.clockMs = Math.max(st.clockMs, s.timestamp);
        st.nextGridMs = ceilTo(st.clockMs, gridMs);
        st.nextHealthMs = ceilTo(st.clockMs, healthMs);
        st.dirty = true;
      } else if (rec.k === "rebuild") {
        const st = states.get(String(d.symbol));
        if (!st) continue;
        finishTaker(st);
        st.out.stats.rebuilds += 1;
        st.book.reset();
        st.dirty = true;
      }
    } else if (rec.stream === "meta" && rec.k === "l3-socket") {
      if (d.state === "closed" || d.state === "stopped") resetAll();
    } else if (rec.stream === "price" && rec.k === "markPriceUpdate") {
      const st = states.get(String(d.s));
      if (!st || typeof d.E !== "number") continue;
      st.out.ticks.push({
        tMs: d.E,
        mark: dec(String(d.p)),
        index: dec(String(d.i)),
        rate: dec(String(d.r)),
        nextFundingMs: Number(d.T),
      });
    } else if (rec.stream === "rest") {
      onRest(rec.k, rec.r, d, states);
    }
  }
  for (const st of states.values()) {
    finishTaker(st);
    // The book is known through the last update's engine time; sample up to it, not beyond.
    if (st.book.synced && Number.isFinite(st.clockMs)) advance(st, st.clockMs + 1);
    st.out.trades.sort((a, b) => a.tMs - b.tMs);
    st.out.ticks.sort((a, b) => a.tMs - b.tMs);
  }
  return {
    bootstrapFromMs: bootstrap,
    fromMs: opts.fromMs,
    toMs: opts.toMs,
    gridMs,
    symbols: new Map([...states].map(([k, v]) => [k, v.out])),
    read,
  };
}

function healthPair(
  st: SymbolState,
  spec: MarketSpec,
  ballast: ReadonlySet<string>,
): BookHealthPair {
  const n = countOrders(st.book.book, ballast);
  const cf = n === 0 ? null : levelsFromL3(st.book.book, spec, ballast);
  return healthPairOfLevels(st.levels as LevelBook, cf, spec, n);
}

function onL3Update(
  st: SymbolState,
  u: L3Update,
  ballast: ReadonlySet<string>,
  finishTaker: (st: SymbolState) => void,
): void {
  const spec = st.out.spec;
  const fill = u.action === "partial_fill" || u.action === "full_fill";
  if (!fill || st.taker?.takerOrderId !== u.taker_order_id) finishTaker(st);
  if (fill && u.price && u.trade_id !== undefined && !st.tradeIds.has(u.trade_id)) {
    st.tradeIds.add(u.trade_id);
    st.out.trades.push({ tMs: u.timestamp, px: dec(u.price) });
  }
  // A taker buy fills resting asks (maker side "sell"); its first fill freezes the
  // counterfactual book: the asks just before the trade, without Ballast.
  if (fill && spec && st.book.synced && u.side === "sell" && u.taker_order_id && u.price) {
    if (!st.taker) {
      st.taker = {
        takerOrderId: u.taker_order_id,
        tMs: u.timestamp,
        fills: [],
        cfAsks: levelsFromL3(st.book.book, spec, ballast).asks,
      };
    }
    const size = (u.delta_size ?? "0").replace(/^-/, "");
    st.taker.fills.push({
      orderId: u.order_id ?? "",
      px: spec.tick.toUnits(u.price),
      qty: spec.step.toUnits(size),
    });
  }
  const res = st.book.update(u);
  if (!res.ok) st.out.stats.breaks += 1;
  st.clockMs = Math.max(st.clockMs, u.timestamp);
  st.lastUpdateMs = u.timestamp;
  st.dirty = true;
}

function onRest(
  kind: string,
  recvMs: number,
  d: Record<string, unknown>,
  states: Map<string, SymbolState>,
): void {
  if (kind === "markets") {
    for (const [symbol, m] of Object.entries(d)) {
      const st = states.get(symbol);
      if (st && m) st.out.spec = marketSpec(m as StrikeMarketPayload);
      if (st) st.dirty = true;
    }
  } else if (kind === "premium-index") {
    const st = states.get(String(d.symbol));
    if (st) st.out.premiumRecords.push({ ...(d as unknown as PremiumIndexRecord), recvMs });
  } else if (kind === "live-positions") {
    const rows = (d.positions ?? []) as RecordedPosition[];
    // An unknown snapshot time must read as infinitely old (stale), never as fresh.
    const at = typeof d.updated_at === "number" ? d.updated_at : Number.NaN;
    for (const st of states.values()) {
      st.out.positions.push({
        recvMs,
        updatedAtMs: Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY,
        positions: rows.filter((p) => p.symbol === st.out.symbol),
      });
    }
  } else if (kind === "trades") {
    const st = states.get(String(d.symbol));
    if (!st) return;
    for (const t of (d.trades ?? []) as { id: number; price: string; time: number }[]) {
      if (st.tradeIds.has(t.id)) continue;
      st.tradeIds.add(t.id);
      st.out.trades.push({ tMs: t.time, px: dec(t.price) });
    }
  }
}

const ceilTo = (t: number, step: number): number => Math.ceil(t / step) * step;

/**
 * Measured on the recordings: slot s's premium sample matches the L3 book as of s − 1 s (p99
 * error 0.001 bps at 1 s, against 4.7–6.3 bps at 0 s and 2–3 bps at 1.5 s); most of the ~1% it
 * misses match the book as of the cycle's own time instead.
 * VERIFY: undocumented; prices.md says only that the sampler takes "the newest eligible
 * historical book", at or before the index and at most 10 s older.
 */
export const PREMIUM_BOOK_LAG_MS = 1_000;

/**
 * Premium samples the funding replica would take, one per 5-second slot: the book as of
 * `slot − lagMs` against the index of the slot's first price-engine cycle (the tick published in
 * the slot's first second). The stream rounds that index to quote_prec; a premium-index poll
 * received in the same cycle (and rounding to it) supplies full precision. Each sample also
 * carries the premium against the book as of the cycle's own time: the engine samples "the newest
 * eligible historical book", and on the recordings that newer book explains most of the samples
 * the 1 s-lagged one misses.
 */
export function premiumSamplesFromReplay(
  r: Pick<SymbolReplay, "books" | "ticks" | "premiumRecords" | "spec">,
  opts: { lagMs?: number; gridMs?: number } = {},
): Map<number, BookPremiumSample> {
  const lag = opts.lagMs ?? PREMIUM_BOOK_LAG_MS;
  const gridMs = opts.gridMs ?? 500;
  const quotePrec = r.spec?.quotePrec ?? 8;
  const halfUlp = div(dec(1).div(dec(10).pow(quotePrec)), 2);
  const polls = [...r.premiumRecords].sort((a, b) => a.recvMs - b.recvMs);
  const out = new Map<number, BookPremiumSample>();
  let bi = -1;
  let ci = -1;
  let pi = 0;
  for (const tick of r.ticks) {
    const slot = slotStartOf(tick.tMs);
    if (out.has(slot) || tick.tMs - slot >= 1_000) continue;
    const at = slot - lag;
    while (bi + 1 < r.books.length && (r.books[bi + 1] as BookSample).tMs <= at) bi += 1;
    const book = r.books[bi];
    // No grid entry at `at` means the book was not synced then.
    if (!book || at - book.tMs >= 2 * gridMs) continue;
    // A poll shows a cycle's full-precision index from ~0.6 s before that cycle's tick arrives
    // until ~0.4 s after (measured: every exact match fell inside this window).
    while (pi < polls.length && (polls[pi] as PremiumIndexRecord).recvMs < tick.tMs - 600) pi += 1;
    let full: Dec | undefined;
    for (
      let j = pi;
      j < polls.length && (polls[j] as PremiumIndexRecord).recvMs < tick.tMs + 400;
      j++
    ) {
      const x = dec((polls[j] as PremiumIndexRecord).indexPrice);
      if (roundHalfEven(x, quotePrec).eq(tick.index)) full = x;
    }
    const index = full ?? tick.index;
    const ib = protectImpact(book.impactBid, index);
    const ia = protectImpact(book.impactAsk, index);
    while (ci + 1 < r.books.length && (r.books[ci + 1] as BookSample).tMs <= tick.tMs) ci += 1;
    const cb = r.books[ci];
    const cycleBook =
      cb && tick.tMs - cb.tMs < 2 * gridMs && cb !== book
        ? premium(protectImpact(cb.impactBid, index), protectImpact(cb.impactAsk, index), index)
        : undefined;
    out.set(slot, {
      slotStartMs: slot,
      impactBid: ib,
      impactAsk: ia,
      index,
      premium: premium(ib, ia, index),
      // A same-cycle poll can still belong to a neighbouring cycle that rounds alike, so even a
      // "full-precision" index is only trusted to the stream's rounding.
      indexHalfUlp: halfUlp,
      ...(cycleBook ? { cycleBookPremium: cycleBook } : {}),
    });
  }
  return out;
}
