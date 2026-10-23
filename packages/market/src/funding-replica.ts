import type { PremiumIndex } from "@ballast/strike-client";
import { type GridSpec, impactPrice, type LevelBook, protectImpact } from "./book.js";
import {
  add,
  BPS,
  clamp,
  type Dec,
  type DecInput,
  dec,
  div,
  max,
  mul,
  sub,
  ZERO,
} from "./decimal.js";
import { type ErrorStats, errorStats } from "./stats.js";

export const SLOT_MS = 5_000;
export const FUNDING_INTERVAL_MS = 3_600_000;
export const SLOTS_PER_WINDOW = FUNDING_INTERVAL_MS / SLOT_MS;

/** Market funding parameters, all on an 8-hour basis. */
export interface FundingParams {
  interestRate: Dec;
  dampener: Dec;
  multiplier: Dec;
  cap: Dec;
  floor: Dec;
}

// VERIFY: neither /price/v2/premiumIndex nor /v2/markets serves the funding cap and floor;
// funding-rates.md gives ±4% (8-hour basis) for both standard profiles.
export const DEFAULT_FUNDING_CAP = dec("0.04");
export const DEFAULT_FUNDING_FLOOR = dec("-0.04");

export function fundingParams(
  pi: Pick<PremiumIndex, "interestRate" | "interestRateDampener" | "fundingMultiplier">,
  cap: DecInput = DEFAULT_FUNDING_CAP,
  floor: DecInput = DEFAULT_FUNDING_FLOOR,
): FundingParams {
  return {
    interestRate: dec(pi.interestRate),
    dampener: dec(pi.interestRateDampener),
    multiplier: dec(pi.fundingMultiplier),
    cap: dec(cap),
    floor: dec(floor),
  };
}

/** Premium = [max(0, IB − X) − max(0, X − IA)] / X, with protected impact prices. */
export function premium(impactBid: Dec, impactAsk: Dec, index: Dec): Dec {
  return div(sub(max(ZERO, sub(impactBid, index)), max(ZERO, sub(index, impactAsk))), index);
}

/**
 * F8 = m·P + clamp(I − m·P, −m·D, +m·D), or m·P + I when D = 0 (an explicit branch: substituting
 * D = 0 into the clamp would add nothing), then clamped to [floor, cap].
 */
export function eightHourRate(avgPremium: Dec, p: FundingParams): Dec {
  const mp = mul(p.multiplier, avgPremium);
  let effective = p.interestRate;
  if (!p.dampener.isZero()) {
    const md = mul(p.multiplier, p.dampener);
    effective = clamp(sub(p.interestRate, mp), md.neg(), md);
  }
  return clamp(add(mp, effective), p.floor, p.cap);
}

export function hourlyFundingRate(avgPremium: Dec, p: FundingParams): Dec {
  return div(eightHourRate(avgPremium, p), 8);
}

export interface PremiumSample {
  slotStartMs: number;
  impactBid: Dec;
  impactAsk: Dec;
  index: Dec;
  premium: Dec;
}

/** A replica sample plus the index's rounding: half a unit of the last place, 0 if exact. */
export interface BookPremiumSample extends PremiumSample {
  indexHalfUlp: Dec;
  /**
   * The same index against the book as of the cycle's own time instead of ~1 s before the slot:
   * the engine takes "the newest eligible historical book", whose age varies.
   */
  cycleBookPremium?: Dec;
}

/** Protected impact prices and premium for one sample of `book` against index X. */
export function premiumSample(
  book: LevelBook,
  index: Dec,
  spec: GridSpec & { impactNotional: Dec },
  slotStartMs: number,
): PremiumSample {
  const impactBid = protectImpact(impactPrice(book.bids, spec.impactNotional, spec), index);
  const impactAsk = protectImpact(impactPrice(book.asks, spec.impactNotional, spec), index);
  return {
    slotStartMs,
    impactBid,
    impactAsk,
    index,
    premium: premium(impactBid, impactAsk, index),
  };
}

export const windowStartOf = (ms: number): number => ms - (ms % FUNDING_INTERVAL_MS);
export const slotStartOf = (ms: number): number => ms - (ms % SLOT_MS);

/**
 * One UTC-hour funding window: at most one premium per 5-second slot, equal weights, no
 * interpolation of missing slots.
 */
export class PremiumWindow {
  private readonly slots = new Map<number, Dec>();
  private total = ZERO;

  constructor(readonly startMs: number) {
    if (startMs % FUNDING_INTERVAL_MS !== 0) throw new Error("PremiumWindow: not an hour boundary");
  }

  get endMs(): number {
    return this.startMs + FUNDING_INTERVAL_MS;
  }

  get count(): number {
    return this.slots.size;
  }

  has(slotStartMs: number): boolean {
    return this.slots.has(slotStartOf(slotStartMs));
  }

  /** Commits a slot's sample. A slot outside the window or already sampled is ignored. */
  add(slotStartMs: number, value: Dec): boolean {
    if (slotStartMs < this.startMs || slotStartMs >= this.endMs) return false;
    const slot = slotStartOf(slotStartMs);
    if (this.slots.has(slot)) return false;
    this.slots.set(slot, value);
    this.total = add(this.total, value);
    return true;
  }

  average(): Dec {
    return this.count === 0 ? ZERO : div(this.total, this.count);
  }

  /** The live estimate: P = 0 before the first sample. */
  estimate(p: FundingParams): Dec {
    return hourlyFundingRate(this.average(), p);
  }

  /** The settlement rate, or null: an empty window publishes no funding payment. */
  settle(p: FundingParams): Dec | null {
    return this.count === 0 ? null : this.estimate(p);
  }
}

/** prices.md: the sampled book is at or before the index, at most 10 s earlier. */
export const PREMIUM_BOOK_MAX_AGE_MS = 10_000;

/** One price-engine cycle as the funding sampler sees it. */
export interface FundingCycle {
  nowMs: number;
  index: Dec;
  /** When that index was produced; it must fall in the current slot. */
  indexTsMs: number;
  /** The stored book snapshot and its timestamp. */
  book: LevelBook;
  bookTsMs: number;
}

export interface FundingSkips {
  /** No positive index. */
  noIndex: number;
  /** The index is from another slot (or has no valid timestamp). */
  indexOutsideSlot: number;
  /** The book is later than the index, or more than 10 s older. */
  bookMisaligned: number;
}

/**
 * Live funding replica: one premium per slot from the book and index, hourly settlement. Its
 * `prevFundingRate` is the F_prev the mark replica's P1 leg needs. A cycle is sampled only under
 * Strike's alignment rule (index from the current slot, book ≤ 10 s before it); ineligible cycles
 * are counted, and `missedSlots` lets the engine treat a starved window as stale.
 */
export class FundingReplica {
  private window: PremiumWindow | null = null;
  prevFundingRate: Dec | null = null;
  lastSettledWindowMs: number | null = null;
  readonly skips: FundingSkips = { noIndex: 0, indexOutsideSlot: 0, bookMisaligned: 0 };

  constructor(private params: FundingParams) {}

  setParams(p: FundingParams): void {
    this.params = p;
  }

  /**
   * Feeds one price-engine cycle; the first eligible cycle of each slot is sampled. Pass the book
   * as the engine stored it: on the recordings, the L3 book as of ~1 s before the slot.
   */
  onCycle(c: FundingCycle, spec: GridSpec & { impactNotional: Dec }): PremiumSample | null {
    this.roll(c.nowMs);
    const w = this.window as PremiumWindow;
    const slot = slotStartOf(c.nowMs);
    if (w.has(slot)) return null;
    if (c.index.lte(0)) {
      this.skips.noIndex += 1;
      return null;
    }
    if (!Number.isFinite(c.indexTsMs) || slotStartOf(c.indexTsMs) !== slot) {
      this.skips.indexOutsideSlot += 1;
      return null;
    }
    const lag = c.indexTsMs - c.bookTsMs;
    if (!Number.isFinite(lag) || lag < 0 || lag > PREMIUM_BOOK_MAX_AGE_MS) {
      this.skips.bookMisaligned += 1;
      return null;
    }
    const s = premiumSample(c.book, c.index, spec, slot);
    w.add(slot, s.premium);
    return s;
  }

  estimate(nowMs: number): Dec {
    this.roll(nowMs);
    return (this.window as PremiumWindow).estimate(this.params);
  }

  get count(): number {
    return this.window?.count ?? 0;
  }

  /** Slots of the current window that have fully elapsed without a sample. */
  missedSlots(nowMs: number): number {
    this.roll(nowMs);
    const w = this.window as PremiumWindow;
    const elapsed = Math.floor((nowMs - w.startMs) / SLOT_MS);
    const current = w.has(slotStartOf(nowMs)) ? 1 : 0;
    return Math.max(0, elapsed - (w.count - current));
  }

  private roll(nowMs: number): void {
    const start = windowStartOf(nowMs);
    if (this.window && this.window.startMs === start) return;
    if (this.window && this.window.startMs < start) {
      const settled = this.window.settle(this.params);
      if (settled) {
        this.prevFundingRate = settled;
        this.lastSettledWindowMs = this.window.startMs;
      }
    }
    this.window = new PremiumWindow(start);
  }
}

export interface PremiumIndexRecord extends PremiumIndex {
  recvMs: number;
}

export interface FundingSettlement {
  windowStartMs: number;
  /** Rate computed from the last recorded average of the window. */
  rate: Dec;
  count: number;
  /** All 720 slots were sampled, so this is the settled rate. */
  complete: boolean;
}

export interface FundingValidation {
  symbol: string;
  /** recorded averagePremiumIndex + params → our hourly rate vs recorded fundingRate. */
  rateFromAverage: { checked: number; exact: number; firstMismatch?: string };
  /** recorded latestPremiumIndex samples → our running average vs recorded averagePremiumIndex. */
  averageFromSamples: { windows: number; checked: number; exact: number };
  settlements: FundingSettlement[];
  /** Our premium samples (book + index) vs the recorded latestPremiumIndex of the same slot. */
  fromBook?: {
    compared: number;
    exact: number;
    /** |ours − recorded| in premium bps (1 bps = 0.0001). */
    errBps: ErrorStats | null;
    /**
     * Samples whose error is within what the index's rounding alone explains:
     * |Δpremium| ≤ (1 + premium) × ½ulp / X, the stream index being rounded to quote_prec.
     */
    withinIndexRounding: number;
    /** Hourly rate from our samples vs the recorded rate at the same count, in rate bps. */
    rateErrBps: ErrorStats | null;
    /** Of the samples outside that bound, those the cycle-time book reproduces within it. */
    explainedByCycleBook: number;
    /** Every sample outside the index-rounding bound, with its diagnosis. */
    unexplained: UnexplainedSample[];
  };
}

/** A from-book sample that misses the recorded one by more than index rounding allows. */
export interface UnexplainedSample {
  slotStartMs: number;
  errBps: Dec;
  ours: Dec;
  recorded: Dec;
  /** Error with the book as of the cycle's own time; within the bound means the book's age. */
  cycleBookErrBps: Dec | null;
  explainedByCycleBook: boolean;
  /** The index we used, and the index that would turn our impact prices into the recorded premium. */
  index: Dec;
  impliedIndex: Dec | null;
}

/**
 * The index X for which our (protected) impact prices give `recorded`: X = IB/(1 + P) when the
 * premium is positive, IA/(1 + P) when negative. Null at zero premium, where any X between the
 * impact prices fits.
 */
export function impliedIndex(
  s: Pick<PremiumSample, "impactBid" | "impactAsk">,
  recorded: Dec,
): Dec | null {
  if (recorded.isZero()) return null;
  return div(recorded.gt(0) ? s.impactBid : s.impactAsk, add(1, recorded));
}

/** Recorded sample → slot, valid only while no slot of the window has been skipped. */
function slotOfRecord(r: PremiumIndexRecord): number | null {
  const start = r.nextFundingTime - FUNDING_INTERVAL_MS;
  if (r.premiumIndexCount <= 0) return null;
  const elapsed = Math.floor((r.time - start) / SLOT_MS);
  if (r.premiumIndexCount < elapsed) return null;
  return start + (r.premiumIndexCount - 1) * SLOT_MS;
}

/**
 * Validates the funding chain on recorded `/price/v2/premiumIndex` polls for one symbol:
 * rate from average (must be exact), average from samples (exact when every sample of a
 * window was observed), and, given our own book samples, samples from the book.
 */
export function validateFunding(
  records: readonly PremiumIndexRecord[],
  bookSamples?: ReadonlyMap<number, BookPremiumSample>,
): FundingValidation {
  const symbol = records[0]?.symbol ?? "";
  const out: FundingValidation = {
    symbol,
    rateFromAverage: { checked: 0, exact: 0 },
    averageFromSamples: { windows: 0, checked: 0, exact: 0 },
    settlements: [],
  };
  const byWindow = new Map<number, PremiumIndexRecord[]>();
  for (const r of records) {
    const params = fundingParams(r);
    const ours = hourlyFundingRate(dec(r.averagePremiumIndex), params);
    out.rateFromAverage.checked += 1;
    if (ours.eq(dec(r.fundingRate))) out.rateFromAverage.exact += 1;
    else if (!out.rateFromAverage.firstMismatch) {
      out.rateFromAverage.firstMismatch = `${r.time}: ours ${ours.toFixed()} vs ${r.fundingRate}`;
    }
    const w = r.nextFundingTime - FUNDING_INTERVAL_MS;
    const list = byWindow.get(w);
    if (list) list.push(r);
    else byWindow.set(w, [r]);
  }

  const rateErr: Dec[] = [];
  const errAll: Dec[] = [];
  const unexplained: UnexplainedSample[] = [];
  let byCycleBook = 0;
  let withinRounding = 0;
  let compared = 0;
  let exactSamples = 0;
  for (const [start, rows] of [...byWindow].sort((a, b) => a[0] - b[0])) {
    const byCount = new Map<number, PremiumIndexRecord>();
    for (const r of rows)
      if (!byCount.has(r.premiumIndexCount)) byCount.set(r.premiumIndexCount, r);
    const last = rows.reduce((a, b) => (b.premiumIndexCount >= a.premiumIndexCount ? b : a));
    out.settlements.push({
      windowStartMs: start,
      rate: hourlyFundingRate(dec(last.averagePremiumIndex), fundingParams(last)),
      count: last.premiumIndexCount,
      complete: last.premiumIndexCount === SLOTS_PER_WINDOW,
    });

    // Average from samples needs the window from its first sample, with no count skipped.
    if (byCount.has(1)) {
      out.averageFromSamples.windows += 1;
      const w = new PremiumWindow(start);
      for (let c = 1; byCount.has(c); c++) {
        const r = byCount.get(c) as PremiumIndexRecord;
        w.add(start + (c - 1) * SLOT_MS, dec(r.latestPremiumIndex));
        out.averageFromSamples.checked += 1;
        if (w.average().eq(dec(r.averagePremiumIndex))) out.averageFromSamples.exact += 1;
      }
    }

    if (!bookSamples) continue;
    const ourSlots = [...bookSamples.keys()]
      .filter((slot) => slot >= start && slot < start + FUNDING_INTERVAL_MS)
      .sort((a, b) => a - b);
    const ours = new PremiumWindow(start);
    let next = 0;
    for (const r of [...byCount.values()].sort(
      (a, b) => a.premiumIndexCount - b.premiumIndexCount,
    )) {
      const slot = slotOfRecord(r);
      if (slot === null) continue;
      for (; next < ourSlots.length && (ourSlots[next] as number) <= slot; next++) {
        const at = ourSlots[next] as number;
        ours.add(at, (bookSamples.get(at) as PremiumSample).premium);
      }
      const s = bookSamples.get(slot);
      if (s) {
        const recorded = dec(r.latestPremiumIndex);
        const e = mul(sub(s.premium, recorded).abs(), BPS);
        const bound = div(mul(mul(add(1, recorded.abs()), s.indexHalfUlp), BPS), s.index);
        compared += 1;
        if (e.isZero()) exactSamples += 1;
        if (e.lte(bound)) withinRounding += 1;
        else {
          const alt = s.cycleBookPremium ? mul(sub(s.cycleBookPremium, recorded).abs(), BPS) : null;
          const explained = alt?.lte(bound) ?? false;
          if (explained) byCycleBook += 1;
          unexplained.push({
            slotStartMs: slot,
            errBps: e,
            ours: s.premium,
            recorded,
            cycleBookErrBps: alt,
            explainedByCycleBook: explained,
            index: s.index,
            impliedIndex: impliedIndex(s, recorded),
          });
        }
        errAll.push(e);
      }
      if (ours.count === r.premiumIndexCount) {
        const rate = hourlyFundingRate(ours.average(), fundingParams(r));
        rateErr.push(mul(sub(rate, dec(r.fundingRate)).abs(), BPS));
      }
    }
  }
  if (bookSamples) {
    out.fromBook = {
      compared,
      exact: exactSamples,
      errBps: errorStats(errAll),
      withinIndexRounding: withinRounding,
      rateErrBps: errorStats(rateErr),
      explainedByCycleBook: byCycleBook,
      unexplained,
    };
  }
  return out;
}
