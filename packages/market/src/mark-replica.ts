import {
  type BookSide,
  consume,
  type GridSpec,
  impactPrice,
  type LevelBook,
  protectImpact,
} from "./book.js";
import {
  add,
  BPS,
  clamp,
  type Dec,
  type DecInput,
  dec,
  div,
  max,
  median3,
  mul,
  ONE,
  roundHalfEven,
  sub,
  sum,
  ZERO,
} from "./decimal.js";
import { FUNDING_INTERVAL_MS, windowStartOf } from "./funding-replica.js";
import { type ErrorStats, errorStats } from "./stats.js";

/** Which mid P2's basis samples use. The docs say the impact mid; "top" is the alternative. */
export type MidDefinition = "impact" | "top";

export interface MarkParams {
  /** δ, the spot/mark deviation limit. */
  deviation: Dec;
  /** τ, the snapshot age at which a deviant last price is replaced by the previous mark. */
  staleMs: number;
  /** P2 averages the latest up to this many basis samples. */
  basisWindow: number;
  mid: MidDefinition;
}

// VERIFY: δ = 5% and τ = 5 s are the docs' "reference values from the configuration template",
// explicitly not the live deployment's settings. The basis window is the documented "latest up to
// 60 samples, at most once per second"; fits on the recordings prefer a ~90 s span (60 samples
// ~1.5 s apart, or 90 per cycle), so `fitMarkReplica` estimates it rather than trusting it.
export const DOCUMENTED_MARK_PARAMS: MarkParams = {
  deviation: dec("0.05"),
  staleMs: 5_000,
  basisWindow: 60,
  mid: "impact",
};

/** Top of the price engine's stored book snapshot, plus its raw (unprotected) impact prices. */
export interface BookTop {
  bestBid: Dec | null;
  bestAsk: Dec | null;
  impactBid: Dec | null;
  impactAsk: Dec | null;
  /** Snapshot timestamp (ms), for the τ rule. */
  tsMs: number | null;
}

export function bookTop(
  book: LevelBook,
  spec: GridSpec & { impactNotional: Dec },
  tsMs: number,
): BookTop {
  const b = book.bids[0];
  const a = book.asks[0];
  return {
    bestBid: b ? spec.tick.fromUnits(b.px) : null,
    bestAsk: a ? spec.tick.fromUnits(a.px) : null,
    impactBid: impactPrice(book.bids, spec.impactNotional, spec),
    impactAsk: impactPrice(book.asks, spec.impactNotional, spec),
    tsMs,
  };
}

/**
 * basis_j = mid_j − Index_j. With the impact mid, each side is protected against index first;
 * a top-of-book mid needs both sides, and otherwise contributes zero (as a zero impact input does).
 */
export function basisSample(top: BookTop, index: Dec, mid: MidDefinition): Dec {
  if (index.lte(0)) return ZERO;
  if (mid === "impact") {
    const ib = protectImpact(top.impactBid, index);
    const ia = protectImpact(top.impactAsk, index);
    return sub(div(add(ib, ia), 2), index);
  }
  // VERIFY: undocumented alternative; a one-sided book contributes zero here.
  if (!top.bestBid || !top.bestAsk) return ZERO;
  return sub(div(add(top.bestBid, top.bestAsk), 2), index);
}

/** One price-engine cycle's inputs. */
export interface MarkCycle {
  nowMs: number;
  index: Dec;
  nextFundingMs: number;
  /** F_prev: the most recently settled hourly rate (null contributes zero). */
  prevFundingRate: Dec | null;
  top: BookTop;
  last: Dec | null;
  prevMark: Dec | null;
  /** Basis history, oldest first; only the latest `basisWindow` are used. */
  basis: readonly Dec[];
}

export type MarkLeg = "p1" | "p2" | "p3";

export interface MarkComponents {
  index: Dec;
  p1: Dec;
  p2: Dec;
  p3: Dec;
  lastAdj: Dec;
  candidate: Dec;
  /** Final mark, rounded half-even to quote_prec. */
  mark: Dec;
  median: MarkLeg;
  /** The candidate deviated more than δ from index, so the mark fell back to P2. */
  fallbackToP2: boolean;
}

const LEGS: readonly MarkLeg[] = ["p1", "p2", "p3"];

/**
 * Strike's mark construction (prices.md), with a positive index X:
 *   P1 = X × (1 + F_prev × t_remaining / 1 h)
 *   P2 = X + mean(latest ≤ n basis samples)
 *   P3 = median(bid, ask, adjusted last)   (missing bid → 0, missing ask → max(bid, last))
 *   mark = median(P1, P2, P3), or P2 when that deviates more than δ from X.
 * A zero index bounds P3 to M_prev × (1 ± δ) and uses it for every leg. No index → no mark.
 */
export function markFromCycle(
  c: MarkCycle,
  params: MarkParams,
  quotePrec: number,
): MarkComponents | null {
  const d = params.deviation;
  const prev = c.prevMark && !c.prevMark.isZero() ? c.prevMark : null;
  const bid = c.top.bestBid;
  const ask = c.top.bestAsk;

  let last = c.last;
  if (!bid && !ask && last && prev)
    last = clamp(last, mul(prev, sub(ONE, d)), mul(prev, add(ONE, d)));
  if (!last && prev) last = prev;

  if (c.index.lte(0)) {
    if (!prev) return null;
    const local = clamp(
      p3Of(bid, ask, last ?? ZERO),
      mul(prev, sub(ONE, d)),
      mul(prev, add(ONE, d)),
    );
    const mark = roundHalfEven(local, quotePrec);
    return {
      index: c.index,
      p1: local,
      p2: local,
      p3: local,
      lastAdj: last ?? ZERO,
      candidate: local,
      mark,
      median: "p3",
      fallbackToP2: false,
    };
  }

  const x = c.index;
  if (
    prev &&
    last &&
    c.top.tsMs !== null &&
    c.top.tsMs > 0 &&
    sub(last, prev).abs().gt(mul(d, prev)) &&
    c.nowMs - c.top.tsMs >= params.staleMs
  ) {
    last = prev;
  }
  // VERIFY: the docs do not say what P3 uses with neither a last trade nor a previous mark.
  const lastAdj = last ?? ZERO;

  const remaining = Math.max(0, c.nextFundingMs - c.nowMs);
  const p1 = c.prevFundingRate
    ? mul(x, add(ONE, mul(c.prevFundingRate, div(remaining, FUNDING_INTERVAL_MS))))
    : x;
  const window = c.basis.slice(-params.basisWindow);
  const p2 = window.length === 0 ? x : add(x, div(sum(window), window.length));
  const p3 = p3Of(bid, ask, lastAdj);

  const m = median3(p1, p2, p3);
  const fallbackToP2 = sub(m.value, x).abs().gt(mul(d, x));
  const candidate = m.value;
  const final = fallbackToP2 ? p2 : candidate;
  return {
    index: x,
    p1,
    p2,
    p3,
    lastAdj,
    candidate,
    mark: roundHalfEven(final, quotePrec),
    median: fallbackToP2 ? "p2" : (LEGS[m.which] as MarkLeg),
    fallbackToP2,
  };
}

function p3Of(bid: Dec | null, ask: Dec | null, last: Dec): Dec {
  const b = bid ?? ZERO;
  const a = ask ?? max(b, last);
  return median3(b, a, last).value;
}

/** Everything the replica carries between cycles. */
export interface MarkState {
  basis: Dec[];
  prevMark: Dec | null;
  last: Dec | null;
  prevFundingRate: Dec | null;
}

export interface MarketShape extends GridSpec {
  impactNotional: Dec;
  quotePrec: number;
}

/**
 * Stateful replica for live use: feed basis samples (at most one per second on book updates),
 * trades and cycles, and it reproduces each published mark.
 */
export class MarkReplica {
  readonly state: MarkState = { basis: [], prevMark: null, last: null, prevFundingRate: null };

  constructor(
    readonly params: MarkParams,
    readonly market: MarketShape,
  ) {}

  addBasis(top: BookTop, index: Dec): void {
    this.state.basis.push(basisSample(top, index, this.params.mid));
    if (this.state.basis.length > this.params.basisWindow) this.state.basis.shift();
  }

  onTrade(px: DecInput): void {
    this.state.last = dec(px);
  }

  cycle(nowMs: number, index: Dec, nextFundingMs: number, top: BookTop): MarkComponents | null {
    const out = markFromCycle(
      { nowMs, index, nextFundingMs, top, ...this.state, basis: this.state.basis },
      this.params,
      this.market.quotePrec,
    );
    if (out) this.state.prevMark = out.mark;
    return out;
  }

  snapshot(): MarkState {
    return { ...this.state, basis: [...this.state.basis] };
  }
}

/** A taker order sweeping one side of the book, e.g. a buy lifting Ballast's asks. */
export interface HypotheticalFill {
  /** The side of the book consumed: "ask" for a taker buy. */
  side: BookSide;
  qtySteps: bigint;
  /** Do not trade through this price (ticks). */
  limitPx?: bigint;
}

export interface MarkPrediction {
  /** Next mark with the book as it is. */
  before: MarkComponents | null;
  /** Next mark after the hypothetical fill (last price = its final fill price). */
  after: MarkComponents | null;
  /** The levels the fill would take, best-first. */
  fills: { px: bigint; qty: bigint }[];
}

/**
 * Predicts the next published mark, without and with a hypothetical fill. The fill changes the
 * book (and so P3 and the next basis sample) and the last price; P1 is unaffected.
 */
export function predictMark(
  state: MarkState,
  book: LevelBook,
  cycle: { nowMs: number; index: Dec; nextFundingMs: number },
  market: MarketShape,
  params: MarkParams,
  fill?: HypotheticalFill,
): MarkPrediction {
  const run = (b: LevelBook, last: Dec | null) => {
    const top = bookTop(b, market, cycle.nowMs);
    const basis = [...state.basis, basisSample(top, cycle.index, params.mid)];
    return markFromCycle(
      {
        ...cycle,
        prevFundingRate: state.prevFundingRate,
        top,
        last,
        prevMark: state.prevMark,
        basis,
      },
      params,
      market.quotePrec,
    );
  };
  const before = run(book, state.last);
  if (!fill) return { before, after: before, fills: [] };
  const taken = consume(
    fill.side === "ask" ? book.asks : book.bids,
    fill.side,
    fill.qtySteps,
    fill.limitPx,
  );
  const after: LevelBook =
    fill.side === "ask"
      ? { bids: book.bids, asks: taken.rest }
      : { bids: taken.rest, asks: book.asks };
  const lastFill = taken.fills[taken.fills.length - 1];
  const last = lastFill ? market.tick.fromUnits(lastFill.px) : state.last;
  return { before, after: run(after, last), fills: taken.fills };
}

/** One recorded `markPriceUpdate`. */
export interface MarkTick {
  tMs: number;
  mark: Dec;
  index: Dec;
  /** The live funding estimate `r`, used only as a fallback F_prev candidate. */
  rate: Dec;
  nextFundingMs: number;
}

/** The book as the price engine would have stored it at `tMs` (one entry per grid step). */
export interface BookSample extends BookTop {
  tMs: number;
}

export interface TradePrint {
  tMs: number;
  px: Dec;
}

/** What the fit consumes; built by the replay from L3, the price stream and premium polls. */
export interface MarkSeries {
  symbol: string;
  market: MarketShape;
  ticks: MarkTick[];
  /** Ascending, on a fixed grid of `gridMs`; gaps mean the book was not synced. */
  books: BookSample[];
  gridMs: number;
  trades: TradePrint[];
  initialLast: Dec | null;
  /** Settled hourly rates keyed by the start of the window they settled. */
  settled: Map<number, { rate: Dec; complete: boolean }>;
}

export interface MarkHypothesis {
  mid: MidDefinition;
  basisWindow: number;
  /** A cycle published at E uses the book (and last trade) as of E − bookLagMs. */
  bookLagMs: number;
  /**
   * Basis samples on their own engine clock, every this many ms, against the index current at
   * each sample. Omitted: one sample per published cycle, from that cycle's book and index.
   */
  sampleEveryMs?: number;
}

export interface MarkFitResult {
  symbol: string;
  best: MarkHypothesis;
  params: MarkParams;
  /** |predicted − published| / published in bps, after warm-up. */
  all: ErrorStats | null;
  train: ErrorStats | null;
  heldOut: ErrorStats | null;
  /** Share of evaluated ticks where each leg set the mark, under the best hypothesis. */
  legShare: Record<MarkLeg, number>;
  /** Error on the ticks where the best fit's median was P2, under each mid definition. */
  p2Ticks: { impact: ErrorStats | null; top: ErrorStats | null };
  hypotheses: { hypothesis: MarkHypothesis; train: ErrorStats | null }[];
  prevFundingRates: { windowStartMs: number; rate: string | null; source: string }[];
  ticks: number;
  evaluated: number;
}

/**
 * First stage of the search (structure: window, book lag, cycle vs own-clock sampling). The
 * second stage refines the lag and sampling clock around the winner; the mid definition is then
 * tested on P2 ticks.
 */
export const DEFAULT_HYPOTHESES: MarkHypothesis[] = [30, 45, 60, 90, 120].flatMap((basisWindow) =>
  [500, 1000, 1100, 1500].flatMap((bookLagMs) =>
    [0, 1500].map((every) => hypothesis("impact", basisWindow, bookLagMs, every)),
  ),
);

function hypothesis(
  mid: MidDefinition,
  basisWindow: number,
  bookLagMs: number,
  sampleEveryMs: number,
): MarkHypothesis {
  return sampleEveryMs > 0
    ? { mid, basisWindow, bookLagMs, sampleEveryMs }
    : { mid, basisWindow, bookLagMs };
}

const keyOf = (h: MarkHypothesis) =>
  `${h.mid}/${h.basisWindow}/${h.bookLagMs}/${h.sampleEveryMs ?? 0}`;

function refinements(h: MarkHypothesis): MarkHypothesis[] {
  return [h.bookLagMs - 100, h.bookLagMs, h.bookLagMs + 100]
    .filter((lag) => lag >= 0)
    .flatMap((lag) =>
      [0, 1000, 1250, 1500, 1750, 2000].map((every) =>
        hypothesis(h.mid, h.basisWindow, lag, every),
      ),
    );
}

interface SimTick {
  tMs: number;
  errBps: Dec;
  leg: MarkLeg;
}

/** Replays one hypothesis over the series, one-step-ahead (previous mark = the published one). */
function simulate(
  s: MarkSeries,
  h: MarkHypothesis,
  fPrev: (windowStartMs: number) => Dec | null,
  params: MarkParams,
): SimTick[] {
  const out: SimTick[] = [];
  const basis: Dec[] = [];
  const every = h.sampleEveryMs ?? 0;
  const books = s.books;
  const near = (b: BookSample | undefined, t: number) =>
    b !== undefined && t - b.tMs < s.gridMs * 2;
  let bi = -1;
  let si = -1;
  let ti = 0;
  let last = s.initialLast;
  let prevMark: Dec | null = null;
  let prevIndex: Dec | null = null;
  let nextSample = Number.NaN;
  for (const tick of s.ticks) {
    const at = tick.tMs - h.bookLagMs;
    while (bi + 1 < books.length && (books[bi + 1] as BookSample).tMs <= at) bi += 1;
    while (ti < s.trades.length && (s.trades[ti] as TradePrint).tMs <= at) {
      last = (s.trades[ti] as TradePrint).px;
      ti += 1;
    }
    const book = books[bi];
    // No grid entry near `at` means the book was not synced: restart the basis history.
    if (!book || !near(book, at)) {
      basis.length = 0;
      nextSample = Number.NaN;
      prevMark = tick.mark;
      prevIndex = tick.index;
      continue;
    }
    if (every > 0) {
      if (Number.isNaN(nextSample)) nextSample = at;
      for (; nextSample <= at; nextSample += every) {
        while (si + 1 < books.length && (books[si + 1] as BookSample).tMs <= nextSample) si += 1;
        const b = books[si];
        if (!near(b, nextSample)) continue;
        const x = nextSample < at ? (prevIndex ?? tick.index) : tick.index;
        basis.push(basisSample(b as BookSample, x, h.mid));
      }
    } else {
      basis.push(basisSample(book, tick.index, h.mid));
    }
    while (basis.length > h.basisWindow) basis.shift();
    prevIndex = tick.index;
    const c = markFromCycle(
      {
        nowMs: tick.tMs,
        index: tick.index,
        nextFundingMs: tick.nextFundingMs,
        prevFundingRate: fPrev(windowStartOf(tick.tMs)),
        top: book,
        last,
        prevMark,
        basis,
      },
      { ...params, basisWindow: h.basisWindow, mid: h.mid },
      s.market.quotePrec,
    );
    prevMark = tick.mark;
    if (!c || basis.length < h.basisWindow) continue;
    out.push({
      tMs: tick.tMs,
      errBps: div(mul(sub(c.mark, tick.mark).abs(), BPS), tick.mark),
      leg: c.median,
    });
  }
  return out;
}

const meanOf = (xs: readonly SimTick[]): Dec =>
  xs.length === 0 ? dec(Number.MAX_SAFE_INTEGER) : div(sum(xs.map((x) => x.errBps)), xs.length);

type FPrevChoice = { rate: Dec | null; source: string };

/** Per-series fitting context: train/held-out split and the F_prev choice per funding window. */
class SeriesFit {
  readonly split: number | undefined;
  readonly windows: number[];
  readonly chosen = new Map<number, FPrevChoice>();
  readonly candidates = new Map<number, FPrevChoice[]>();
  readonly fPrev = (w: number) => this.chosen.get(w)?.rate ?? null;

  constructor(
    readonly s: MarkSeries,
    readonly params: MarkParams,
    heldOutFraction: number,
  ) {
    const ticks = s.ticks;
    this.split = ticks[Math.floor(ticks.length * (1 - heldOutFraction))]?.tMs;
    this.windows = [...new Set(ticks.map((t) => windowStartOf(t.tMs)))].sort((a, b) => a - b);
    // F_prev per window: the recorded settlement when complete, else the best of a few candidates.
    // VERIFY: no public endpoint serves settled rates, so the first window after the recorder
    // starts has no exact F_prev.
    for (const w of this.windows) {
      const settled = s.settled.get(w - FUNDING_INTERVAL_MS);
      if (settled?.complete) {
        this.chosen.set(w, { rate: settled.rate, source: "settled" });
        continue;
      }
      const firstRate = ticks.find((t) => windowStartOf(t.tMs) === w)?.rate ?? null;
      const list: FPrevChoice[] = [];
      if (settled) list.push({ rate: settled.rate, source: "last-estimate" });
      if (firstRate) list.push({ rate: firstRate, source: "first-live-estimate" });
      list.push({ rate: null, source: "none" });
      this.candidates.set(w, list);
      this.chosen.set(w, list[0] as FPrevChoice);
    }
  }

  isTrain = (t: SimTick) => this.split === undefined || t.tMs < this.split;

  sim(h: MarkHypothesis): SimTick[] {
    return simulate(this.s, h, this.fPrev, this.params);
  }

  /** Picks each unknown window's F_prev by the error inside that window. */
  refineFPrev(h: MarkHypothesis): void {
    for (const [w, list] of this.candidates) {
      let pick = list[0] as FPrevChoice;
      let pickErr: Dec | null = null;
      for (const cand of list) {
        this.chosen.set(w, cand);
        const err = meanOf(this.sim(h).filter((t) => windowStartOf(t.tMs) === w));
        if (pickErr === null || err.lt(pickErr)) {
          pickErr = err;
          pick = cand;
        }
      }
      this.chosen.set(w, { rate: pick.rate, source: `fit:${pick.source}` });
    }
  }
}

export interface FitOptions {
  /** Stage-1 hypotheses (default DEFAULT_HYPOTHESES); stage 2 refines around the winner. */
  hypotheses?: MarkHypothesis[];
  refine?: boolean;
  heldOutFraction?: number;
  params?: MarkParams;
}

/**
 * Fits the replica's unknowns on recorded data: P2's basis window, sampling clock and mid
 * definition, the engine's book lag, and F_prev for windows whose previous settlement was not
 * recorded. One mechanism serves every market, so the structure is chosen jointly: the hypothesis
 * with the lowest mean error over the series' training halves (the first 1 − heldOutFraction of
 * each series' ticks); the rest is held out.
 */
export function fitMarkReplicaJoint(
  series: readonly MarkSeries[],
  opts: FitOptions = {},
): MarkFitResult[] {
  const params = opts.params ?? DOCUMENTED_MARK_PARAMS;
  const fits = series.map((s) => new SeriesFit(s, params, opts.heldOutFraction ?? 0.5));
  const scored = new Map<
    string,
    { hypothesis: MarkHypothesis; mean: Dec; train: (ErrorStats | null)[] }
  >();
  const score = (hs: readonly MarkHypothesis[]) => {
    for (const h of hs) {
      if (scored.has(keyOf(h))) continue;
      const sims = fits.map((f) => f.sim(h).filter(f.isTrain));
      const mean = div(sum(sims.map(meanOf)), Math.max(1, sims.length));
      scored.set(keyOf(h), {
        hypothesis: h,
        mean,
        train: sims.map((x) => errorStats(x.map((t) => t.errBps))),
      });
    }
  };
  const bestOf = () => {
    const best = [...scored.values()].sort((a, b) => a.mean.comparedTo(b.mean))[0];
    if (!best) throw new Error("fitMarkReplica: no hypotheses");
    return best.hypothesis;
  };
  score(opts.hypotheses ?? DEFAULT_HYPOTHESES);
  if (opts.refine ?? opts.hypotheses === undefined) {
    score(refinements(bestOf()));
    // The mid definition competes last, on the otherwise-best structure.
    const b = bestOf();
    score([{ ...b, mid: b.mid === "impact" ? "top" : "impact" }]);
  }
  const best = bestOf();
  const ranking = [...scored.values()].sort((a, b) => a.mean.comparedTo(b.mean));

  return fits.map((f, i) => {
    f.refineFPrev(best);
    const finalSim = f.sim(best);
    const legShare: Record<MarkLeg, number> = { p1: 0, p2: 0, p3: 0 };
    for (const t of finalSim) legShare[t.leg] += 1;
    for (const leg of LEGS) legShare[leg] = finalSim.length ? legShare[leg] / finalSim.length : 0;
    // Both mid definitions on the same ticks: those where the best fit says P2 set the mark.
    const p2Set = new Set(finalSim.filter((t) => t.leg === "p2").map((t) => t.tMs));
    const p2Of = (mid: MidDefinition) =>
      errorStats(
        f
          .sim({ ...best, mid })
          .filter((t) => p2Set.has(t.tMs))
          .map((t) => t.errBps),
      );
    return {
      symbol: f.s.symbol,
      best,
      params: { ...params, basisWindow: best.basisWindow, mid: best.mid },
      all: errorStats(finalSim.map((t) => t.errBps)),
      train: errorStats(finalSim.filter(f.isTrain).map((t) => t.errBps)),
      heldOut: errorStats(finalSim.filter((t) => !f.isTrain(t)).map((t) => t.errBps)),
      legShare,
      p2Ticks: { impact: p2Of("impact"), top: p2Of("top") },
      hypotheses: ranking.map((x) => ({ hypothesis: x.hypothesis, train: x.train[i] ?? null })),
      prevFundingRates: f.windows.map((w) => ({
        windowStartMs: w,
        rate: f.chosen.get(w)?.rate?.toFixed() ?? null,
        source: f.chosen.get(w)?.source ?? "none",
      })),
      ticks: f.s.ticks.length,
      evaluated: finalSim.length,
    };
  });
}

export function fitMarkReplica(s: MarkSeries, opts: FitOptions = {}): MarkFitResult {
  return fitMarkReplicaJoint([s], opts)[0] as MarkFitResult;
}
