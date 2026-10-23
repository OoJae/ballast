import {
  BPS,
  type MicroUsd,
  maxBigint,
  microUsd,
  minBigint,
  notionalCeil,
  notionalFloor,
  type QuotePolicy,
  quotePolicyHash,
  type RefPrice,
  refPlusBpsFloor,
  refPrice,
  type Steps,
  steps,
  ticks,
} from "@ballast/core";
import {
  armDecision,
  type BandState,
  capsFor,
  clientOrderId,
  committedSteps,
  DEFAULT_ARM_LIST,
  type EngineMarket,
  effectiveRBps,
  engineMarket,
  evaluateMarginBand,
  keeperStep,
  type MarketCaps,
  marginThresholds,
  parseClientOrderId,
  planRequote,
  type RequotePlan,
  type RestingOrder,
  type StrikeMarketRules,
  validateCreate,
} from "@ballast/engine";
import { checkGuard, type GuardInput, type GuardRequest } from "@ballast/guard";
import {
  basisSample,
  bookTop,
  crossProfile,
  type Dec,
  DOCUMENTED_MARK_PARAMS,
  dec,
  derivePosition,
  type FloorPosition,
  floorPosition,
  fragileLongs,
  type Level,
  type LevelBook,
  levelsFromL3,
  liquidationFloor,
  longTriggerPrice,
  type MarkParams,
  MarkReplica,
  marginRatio,
  mergeLevels,
  predictMark,
  projectP2Path,
  type RecordedPosition,
  type RecordLine,
  ReplayBook,
  windowStartOf,
} from "@ballast/market";
import {
  type L3Snapshot,
  type L3Update,
  RateLimiter,
  reduceOnlyBuyBack,
} from "@ballast/strike-client";
import {
  aheadAt,
  type BallastFill,
  matchCrossingBid,
  matchTakerBuy,
  type SimOrder,
} from "./fill-model.js";
import { Prng } from "./prng.js";

export interface SimAccountConfig {
  id: string;
  holder0: boolean;
  /** On-chain cover at the start, in the market's size steps (NIGHT units). */
  coverSteps: bigint;
  rBps: bigint;
  /** Margin deposited on Strike. */
  equityMicroUsd: bigint;
  maxShortMicroUsd: bigint | null;
  approvedBuilderBps: number;
}

/** A holder moves cover: visible in the mempool at `atMs` (Ogmios), confirmed by the next block. */
export interface CoverEvent {
  atMs: number;
  accountId: string;
  coverSteps: bigint;
  /** False: the spend is seen only once a block confirms it (no mempool signal). */
  mempool?: boolean;
}

export interface Perturbations {
  /** Koios answers this many blocks behind the tip. */
  koiosLagBlocks?: number;
  coverEvents?: readonly CoverEvent[];
  /** Strike answers 429 to a share (num/den) of requests in each window. */
  storm429?: readonly { fromMs: number; toMs: number; num: number; den: number }[];
  /** In the window, the `index`-th create of every replace-batch is rejected (post-only cross). */
  partialReject?: { fromMs: number; toMs: number; index: number };
}

export interface SimConfig {
  policy: QuotePolicy;
  accounts: readonly SimAccountConfig[];
  seed: number;
  takerMode?: "size" | "notional";
  /** The house lifts every Ballast ask below index × (1 + fairBps). */
  houseReaction?: { fairBps: bigint } | null;
  p2?: { mode: "blind" } | { mode: "replica"; params: MarkParams };
  replicaP99Bps?: string;
  /** The in-loop mark replica's parameters (default: the documented ones). */
  markParams?: MarkParams;
  perturbations?: Perturbations;
  /** Receive-time window the metrics count over; records before it only warm up state. */
  window?: { fromMs: number; toMs: number };
  blockMs?: number;
}

export interface Violations {
  cover: number;
  floor: number;
  p2: number;
  static: number;
  rate: number;
}

export interface SimReport {
  violations: Violations;
  fills: number;
  filledSteps: string;
  armedMs: number;
  armedHours: number;
  maxCombinedDrawdownMicroUsd: string;
  window: { fromMs: number; toMs: number };
  diagnostics: Record<string, number>;
  /** The first violations in detail (at most 50). */
  violationLog: string[];
}

interface Tick {
  r: number;
  E: number;
  index: Dec;
  indexStr: string;
  rate: Dec;
  nextFundingMs: number;
}

interface Acct {
  cfg: SimAccountConfig;
  /** Actual on-chain cover over time, ascending. */
  coverHistory: { atMs: number; cover: bigint }[];
  mempool: { coverAfter: bigint; atMs: number } | null;
  short: bigint;
  /** Sale notional of the open short (µUSD), for its average entry. */
  entryNotional: bigint;
  /** µUSD: sale proceeds − buy-back costs − builder fees. */
  cash: bigint;
  /** Index value of the paired coins when each unit was sold (µUSD). */
  basis: bigint;
  realized: bigint;
  fees: bigint;
  band: BandState;
  allowCreates: boolean;
  lossHoldUntil: number | null;
  day: number;
  dayStartValue: bigint | null;
  breached: boolean;
  lastRbMs: number | null;
}

interface Group {
  takerId: string;
  updates: L3Update[];
  maxPx: bigint;
  qty: bigint;
  notionalScaled: bigint;
}

const DAY_MS = 86_400_000;
const STALE_INDEX_MS = 3_000;
const STALE_COVER_MS = 60_000;
const HEARTBEAT_MS = 30_000;
const MAX_LOG = 50;
const HOLDER0_LOSS_STOP = 25_000_000n;

/**
 * A deterministic L3 replay simulator. Records (recorded or synthetic) are fed in receive-time
 * order; the keeper, the engine (`planRequote`) and the Guard run in the loop exactly as the
 * daemon will, against a simulated exchange with replace-batch and post-only semantics. The mark
 * replica runs on the simulated book (house + Ballast), so the floor and P2 are re-checked on
 * every simulated fill. Violations are measured independently of the Guard: a request the Guard
 * admits is still checked against the invariants it is meant to protect.
 */
export class Simulator {
  private readonly symbol: string;
  private readonly caps: MarketCaps;
  private readonly policy: QuotePolicy;
  private readonly takerMode: "size" | "notional";
  private readonly p2: NonNullable<SimConfig["p2"]>;
  private readonly p99: Dec;
  private readonly markParams: MarkParams;
  private readonly blockMs: number;
  private readonly lagMs: number;
  private readonly rng: Prng;
  private market: EngineMarket | null = null;
  private readonly book: ReplayBook;
  private replica: MarkReplica | null = null;
  private tick: Tick | null = null;
  private lastRate: Dec | null = null;
  private fundingWindow: number | null = null;
  private simMark: Dec | null = null;
  private positions: { rows: FloorPosition[]; updatedAtMs: number } | null = null;
  private syncedTicks = 0;
  private readonly orders = new Map<bigint, SimOrder>();
  private nextOrderId = 1n;
  private orderSeq = 0;
  private readonly accts: Acct[];
  private readonly limiter: RateLimiter;
  private readonly usedIds = new Set<string>();
  private seq = 0n;
  private group: Group | null = null;
  private now = Number.NEGATIVE_INFINITY;
  private startMs: number | null = null;
  private lastQuote: { index: Dec; atMs: number } | null = null;
  private dirty = true;
  private lastStandDown = false;
  private readonly pendingCover: CoverEvent[];
  private readonly sent: { at: number; ops: number }[] = [];
  private readonly v: Violations = { cover: 0, floor: 0, p2: 0, static: 0, rate: 0 };
  private readonly diag = new Map<string, number>();
  private readonly log: string[] = [];
  private fills = 0;
  private filledSteps = 0n;
  private armedMs = 0;
  private peak: bigint | null = null;
  private maxDrawdown = 0n;
  private first: number | null = null;
  private last: number | null = null;
  private readonly anchored = new Map<number, { policy: QuotePolicy; hash: string }>();

  constructor(private readonly cfg: SimConfig) {
    this.policy = cfg.policy;
    this.symbol = cfg.policy.market;
    const caps = capsFor(DEFAULT_ARM_LIST, this.symbol);
    if (!caps) throw new Error(`no caps for ${this.symbol}`);
    this.caps = caps;
    this.takerMode = cfg.takerMode ?? "size";
    this.p2 = cfg.p2 ?? { mode: "blind" };
    this.p99 = dec(cfg.replicaP99Bps ?? "0.77");
    this.markParams = cfg.markParams ?? DOCUMENTED_MARK_PARAMS;
    this.blockMs = cfg.blockMs ?? 20_000;
    this.lagMs = (cfg.perturbations?.koiosLagBlocks ?? 0) * this.blockMs;
    this.rng = new Prng(cfg.seed);
    this.book = new ReplayBook(this.symbol);
    this.limiter = new RateLimiter({ now: () => this.now });
    this.accts = [...cfg.accounts]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((c) => ({
        cfg: c,
        coverHistory: [{ atMs: Number.NEGATIVE_INFINITY, cover: c.coverSteps }],
        mempool: null,
        short: 0n,
        entryNotional: 0n,
        cash: 0n,
        basis: 0n,
        realized: 0n,
        fees: 0n,
        band: { quoting: true, lastBand: "ok" },
        allowCreates: false,
        lossHoldUntil: null,
        day: -1,
        dayStartValue: null,
        breached: false,
        lastRbMs: null,
      }));
    this.pendingCover = [...(cfg.perturbations?.coverEvents ?? [])].sort((a, b) => a.atMs - b.atMs);
  }

  // ---- record intake --------------------------------------------------------------------

  onRecord(rec: RecordLine): void {
    if (rec.r < this.now) return;
    const d = rec.d as Record<string, unknown>;
    const isL3 = rec.stream === "l3" && rec.k === "update" && d.symbol === this.symbol;
    const u = isL3 ? (d as unknown as L3Update) : null;
    if (this.group && this.breaksGroup(rec, u)) this.finishGroup();
    this.advance(rec.r);

    if (rec.stream === "l3") {
      if (rec.k === "update" && u) this.onL3Update(u);
      else if (rec.k === "snapshot" && d.symbol === this.symbol) {
        this.book.snapshot(d as unknown as L3Snapshot);
        this.bump("l3.snapshots");
        this.dirty = true;
      } else if (rec.k === "rebuild" && d.symbol === this.symbol) {
        this.book.reset();
      }
    } else if (rec.stream === "meta" && rec.k === "l3-socket") {
      if (d.state === "closed" || d.state === "stopped") this.book.reset();
    } else if (rec.stream === "price") {
      if (rec.k === "markPriceUpdate" && d.s === this.symbol && typeof d.E === "number") {
        this.onMarkTick(d);
      } else if (rec.k === "trade" && d.s === this.symbol && typeof d.p === "string") {
        this.replica?.onTrade(d.p);
      }
    } else if (rec.stream === "rest") {
      if (rec.k === "markets") this.onMarkets(d);
      else if (rec.k === "live-positions") this.onPositions(d);
    }
    if (this.inWindow(rec.r)) {
      this.first ??= rec.r;
      this.last = rec.r;
    }
  }

  finish(): SimReport {
    if (this.group) this.finishGroup();
    const diagnostics: Record<string, number> = {};
    for (const k of [...this.diag.keys()].sort()) diagnostics[k] = this.diag.get(k) ?? 0;
    return {
      violations: { ...this.v },
      fills: this.fills,
      filledSteps: this.filledSteps.toString(),
      armedMs: this.armedMs,
      armedHours: this.armedMs / 3_600_000,
      maxCombinedDrawdownMicroUsd: this.maxDrawdown.toString(),
      window: { fromMs: this.first ?? 0, toMs: this.last ?? 0 },
      diagnostics,
      violationLog: [...this.log],
    };
  }

  // ---- time -----------------------------------------------------------------------------

  private inWindow(t: number): boolean {
    const w = this.cfg.window;
    return !w || (t >= w.fromMs && t < w.toMs);
  }

  private advance(r: number): void {
    if (this.startMs === null) this.startMs = r;
    if (this.orders.size > 0 && Number.isFinite(this.now) && this.inWindow(r)) {
      this.armedMs += r - this.now;
    }
    this.now = r;
    while (this.pendingCover[0] && this.pendingCover[0].atMs <= r) {
      const ev = this.pendingCover.shift() as CoverEvent;
      this.applyCoverEvent(ev);
    }
    for (const a of this.accts) {
      // A confirmed block that the oracle has now seen clears the mempool flag.
      if (a.mempool && this.coverBlockTime() >= a.mempool.atMs) a.mempool = null;
      if (this.ordersOf(a).length > 0 && this.staleReasons().length > 0) this.enforce(a);
    }
  }

  private coverBlockTime(): number {
    return Math.floor((this.now - this.lagMs) / this.blockMs) * this.blockMs;
  }

  private actualCover(a: Acct, at: number): bigint {
    let c = a.coverHistory[0]?.cover ?? 0n;
    for (const h of a.coverHistory) {
      if (h.atMs <= at) c = h.cover;
      else break;
    }
    return c;
  }

  /** What Koios reports now: the cover as of the last block it has (lagged). */
  private observedCover(a: Acct): bigint {
    return this.actualCover(a, this.coverBlockTime());
  }

  private applyCoverEvent(ev: CoverEvent): void {
    const a = this.accts.find((x) => x.cfg.id === ev.accountId);
    if (!a) return;
    a.coverHistory.push({ atMs: ev.atMs, cover: ev.coverSteps });
    if (ev.mempool !== false) a.mempool = { coverAfter: ev.coverSteps, atMs: ev.atMs };
    this.bump("cover.events");
    this.dirty = true;
    this.enforce(a);
  }

  // ---- market data ----------------------------------------------------------------------

  private onMarkets(d: Record<string, unknown>): void {
    const m = d[this.symbol];
    if (!m) return;
    try {
      this.market = engineMarket(m as StrikeMarketRules);
      this.replica ??= new MarkReplica(this.markParams, this.market.spec);
    } catch {
      this.bump("markets.unusable");
    }
  }

  private onPositions(d: Record<string, unknown>): void {
    const rows = ((d.positions ?? []) as RecordedPosition[]).filter(
      (p) => p.symbol === this.symbol,
    );
    const at = typeof d.updated_at === "number" ? d.updated_at : Number.NEGATIVE_INFINITY;
    this.positions = { rows: rows.map(floorPosition), updatedAtMs: at };
    this.dirty = true;
    this.cycleEngine();
  }

  private onMarkTick(d: Record<string, unknown>): void {
    const E = d.E as number;
    const index = dec(String(d.i));
    this.tick = {
      r: this.now,
      E,
      index,
      indexStr: String(d.i),
      rate: dec(String(d.r)),
      nextFundingMs: Number(d.T),
    };
    // F_prev for P1: the last live estimate before each hourly boundary.
    const w = windowStartOf(E);
    if (this.fundingWindow !== null && w !== this.fundingWindow && this.replica) {
      this.replica.state.prevFundingRate = this.lastRate;
    }
    this.fundingWindow = w;
    this.lastRate = this.tick.rate;
    if (this.market && this.replica && this.book.synced) {
      const top = bookTop(this.combinedBook(), this.market.spec, E);
      this.replica.addBasis(top, index);
      this.simMark = this.replica.cycle(E, index, this.tick.nextFundingMs, top)?.mark ?? null;
      this.syncedTicks += 1;
    } else {
      this.syncedTicks = 0;
    }
    this.houseReact();
    this.cycleEngine();
    this.sampleDrawdown();
  }

  private onL3Update(u: L3Update): void {
    const fill = u.action === "partial_fill" || u.action === "full_fill";
    if (fill && u.side === "sell" && u.taker_order_id && u.price && this.market) {
      // A taker buy: buffer its fills, re-match them once the group ends.
      const px = this.market.tick.toUnits(u.price);
      const qty = this.market.step.toUnits((u.delta_size ?? "0").replace(/^-/, ""));
      if (!this.group) {
        this.group = {
          takerId: u.taker_order_id,
          updates: [],
          maxPx: px,
          qty: 0n,
          notionalScaled: 0n,
        };
      }
      this.group.updates.push(u);
      if (px > this.group.maxPx) this.group.maxPx = px;
      this.group.qty += qty;
      this.group.notionalScaled += qty * px * this.market.rate.num;
      return;
    }
    if (u.action === "open" && u.side === "buy" && u.price && this.market && this.orders.size > 0) {
      const px = ticks(this.market.tick.toUnits(u.price));
      const qty = steps(this.market.step.toUnits(u.remaining_size ?? "0"));
      const crossing = matchCrossingBid([...this.orders.values()], px, qty);
      if (crossing.length > 0) this.onFills(crossing, "crossing-bid");
    }
    this.applyBook(u);
    if (fill && u.price) this.replica?.onTrade(u.price);
  }

  /**
   * A taker's fills are contiguous in the symbol's L3 sequence but can be interleaved with other
   * streams in receive order; only this symbol's records (or a socket event) end the group.
   */
  private breaksGroup(rec: RecordLine, u: L3Update | null): boolean {
    if (u) return !this.continuesGroup(u);
    const d = rec.d as Record<string, unknown>;
    if (rec.stream === "l3") return d.symbol === this.symbol;
    if (rec.stream === "meta") return rec.k === "l3-socket";
    if (rec.stream === "price") return d.s === this.symbol;
    if (rec.stream === "rest") return rec.k === "markets" || rec.k === "live-positions";
    return false;
  }

  private continuesGroup(u: L3Update): boolean {
    const fill = u.action === "partial_fill" || u.action === "full_fill";
    return fill && u.side === "sell" && u.taker_order_id === this.group?.takerId;
  }

  private finishGroup(): void {
    const g = this.group;
    this.group = null;
    if (!g || !this.market) return;
    if (this.book.synced && this.orders.size > 0) {
      const fills = matchTakerBuy(
        this.book.book.asks,
        [...this.orders.values()],
        { maxPx: ticks(g.maxPx), qty: steps(g.qty), notionalScaled: g.notionalScaled },
        this.takerMode,
        { tick: this.market.tick, step: this.market.step, rate: this.market.rate },
      );
      if (fills.length > 0) this.onFills(fills, "taker");
    }
    for (const u of g.updates) {
      this.applyBook(u);
      if (u.price) this.replica?.onTrade(u.price);
    }
  }

  private applyBook(u: L3Update): void {
    const st = this.book.update(u);
    if (!st.ok) this.bump(`l3.break.${st.reason}`);
  }

  // ---- books ----------------------------------------------------------------------------

  private houseLevels(): LevelBook {
    if (!this.market || !this.book.synced) return { bids: [], asks: [] };
    return levelsFromL3(this.book.book, this.market.spec);
  }

  private ballastLevels(): Level[] {
    const m = new Map<bigint, bigint>();
    for (const o of this.orders.values()) m.set(o.px, (m.get(o.px) ?? 0n) + o.qty);
    return [...m].map(([px, qty]) => ({ px, qty }));
  }

  private combinedBook(house = this.houseLevels()): LevelBook {
    return { bids: house.bids, asks: mergeLevels(house.asks, this.ballastLevels(), "ask") };
  }

  private ordersOf(a: Acct): SimOrder[] {
    return [...this.orders.values()].filter((o) => o.accountId === a.cfg.id);
  }

  private markRef(): RefPrice | null {
    if (!this.market || !this.simMark) return null;
    return refPrice(this.market.tick, this.simMark.toFixed());
  }

  private indexRef(): RefPrice | null {
    if (!this.market || !this.tick) return null;
    return refPrice(this.market.tick, this.tick.index.toFixed());
  }

  // ---- fills and their checks -----------------------------------------------------------

  private onFills(fills: readonly BallastFill[], kind: string): void {
    if (!this.market) return;
    const m = this.market;
    const house = this.houseLevels();
    const index = this.indexRef();
    for (const f of fills) {
      const a = this.accts.find((x) => x.cfg.id === f.order.accountId);
      if (!a || f.qty <= 0n) continue;
      const before = this.combinedBook(house);
      this.checkFill(f, before, house);
      const proceeds = notionalFloor(f.px, f.qty, m.rate);
      const feeBps = this.builderFeeBps(a);
      const fee = (proceeds * feeBps) / BPS;
      a.short += f.qty;
      a.entryNotional += proceeds;
      a.cash += proceeds - fee;
      a.fees += fee;
      a.basis += index ? refValue(index, f.qty, m) : proceeds;
      f.order.qty = steps(f.order.qty - f.qty);
      if (f.order.qty <= 0n) this.orders.delete(f.order.id);
      if (this.inWindow(this.now)) {
        this.fills += 1;
        this.filledSteps += f.qty;
      }
      this.bump(`fills.${kind}`);
      this.dirty = true;
    }
    for (const a of this.accts) {
      this.enforce(a);
      this.checkCover(a);
    }
  }

  /** Invariants 5 and 6 at the moment of each simulated fill, independent of the Guard. */
  private checkFill(f: BallastFill, before: LevelBook, house: LevelBook): void {
    const m = this.market;
    const tick = this.tick;
    if (!m || !tick) return;
    const mark = this.simMark ?? tick.index;
    const pos = this.positions;
    const ageMs = pos ? this.now - pos.updatedAtMs : Number.NaN;
    const floor = liquidationFloor({
      positions: pos?.rows ?? [],
      tiers: m.spec.tiers,
      positionsAgeMs: ageMs,
      mark,
      replicaP99Bps: this.p99,
      tick: m.tick,
      baseBps: this.policy.pricing.liqBufferBps,
    });
    if (f.px < floor.ticks) {
      this.violate("floor", `fill at ${f.px} < F ${floor.ticks} (${floor.binding})`);
    }
    let trigger: Dec | null = null;
    for (const p of pos?.rows ?? []) {
      const t = longTriggerPrice(p, m.spec.tiers);
      if (t && (!trigger || t.gt(trigger))) trigger = t;
    }
    if (trigger && this.replica) {
      const p = predictMark(
        this.replica.snapshot(),
        before,
        { nowMs: tick.E, index: tick.index, nextFundingMs: tick.nextFundingMs },
        m.spec,
        this.markParams,
        { side: "ask", qtySteps: f.qty, limitPx: f.px },
      );
      if (p.before && p.after && p.before.mark.gt(trigger) && p.after.mark.lte(trigger)) {
        this.violate("floor", `fill at ${f.px} moves the mark to a long's trigger`);
      }
    }
    if (this.p2.mode === "blind") {
      const fragile = fragileLongs(pos?.rows ?? [], m.spec.tiers, tick.index, floor.bLiqBps);
      if (fragile.length > 0)
        this.violate("p2", `fill at ${f.px} while a long is fragile (P2-blind)`);
      let total = 0n;
      for (const o of this.orders.values()) total += notionalCeil(o.px, o.qty, m.rate);
      if (total > 300_000_000n) this.violate("p2", `Ballast asks ${total} µUSD > $300 (P2-blind)`);
    } else if (floor.liquidationTarget && this.replica) {
      const n = this.p2.params.basisWindow;
      const mid = this.p2.params.mid;
      const basis = this.replica.state.basis;
      const minAfter = (asks: Level[]) =>
        projectP2Path(
          basis,
          basisSample(bookTop({ bids: house.bids, asks }, m.spec, tick.E), tick.index, mid),
          tick.index,
          n,
        ).reduce((x, y) => (x.lt(y) ? x : y));
      const target = floor.liquidationTarget;
      const afterAsks = before.asks
        .map((l) => (l.px === f.px ? { px: l.px, qty: l.qty - f.qty } : l))
        .filter((l) => l.qty > 0n);
      if (minAfter(house.asks).gte(target) && minAfter(afterAsks).lt(target)) {
        this.violate("p2", `fill at ${f.px} projects P2 below the liquidation target`);
      }
    }
  }

  private checkCover(a: Acct): void {
    const cap = committedSteps(
      steps(this.actualCover(a, this.now)),
      effectiveRBps(a.cfg.rBps, this.policy),
    );
    let resting = 0n;
    for (const o of this.ordersOf(a)) resting += o.qty;
    const breach = a.short + resting > cap;
    if (breach && !a.breached) {
      this.violate("cover", `${a.cfg.id}: short ${a.short} + asks ${resting} > r × cover ${cap}`);
    }
    a.breached = breach;
  }

  private violate(kind: keyof Violations, detail: string): void {
    if (!this.inWindow(this.now)) return;
    this.v[kind] += 1;
    if (this.log.length < MAX_LOG) this.log.push(`${this.now} ${kind}: ${detail}`);
  }

  private bump(key: string, by = 1): void {
    this.diag.set(key, (this.diag.get(key) ?? 0) + by);
  }

  // ---- the house reaction ---------------------------------------------------------------

  private houseReact(): void {
    const h = this.cfg.houseReaction;
    const index = this.indexRef();
    if (!h || !index || this.orders.size === 0) return;
    const fair = refPlusBpsFloor(index, h.fairBps);
    const lifted = [...this.orders.values()]
      .filter((o) => o.px < fair)
      .map((o) => ({ order: o, qty: o.qty, px: o.px }));
    if (lifted.length > 0) this.onFills(lifted, "house");
  }

  // ---- keeper ---------------------------------------------------------------------------

  private staleReasons(): string[] {
    const out: string[] = [];
    if (!this.tick || this.now - this.tick.r > STALE_INDEX_MS) out.push("index/mark > 3 s");
    if (!this.book.synced) out.push("L3 not synced");
    if (this.now - this.coverBlockTime() > STALE_COVER_MS) out.push("cover > 60 s");
    return out;
  }

  private equity(a: Acct): bigint {
    return a.cfg.equityMicroUsd + a.realized - a.fees;
  }

  private marginRatioBps(a: Acct): bigint | null {
    const m = this.market;
    if (!m) return null;
    if (a.short === 0n) return 0n;
    const mark = this.simMark ?? this.tick?.index;
    if (!mark) return null;
    // Margin math runs in market's decimal model (the sim, not the engine or the Guard).
    const size = m.step.fromUnits(a.short);
    const entry = dec(a.entryNotional.toString()).div(1_000_000).div(size);
    const p = { size: size.neg(), entryPrice: entry, leverage: 2, marginMode: "cross" as const };
    const d = derivePosition(p, mark, m.spec.tiers, m.spec.quotePrec);
    const ratio = marginRatio(
      crossProfile(dec(this.equity(a).toString()).div(1_000_000), [{ p, d }]),
    );
    if (ratio === null) return null;
    return BigInt(ratio.times(10_000).toDecimalPlaces(0, 2).toFixed());
  }

  /** Combined MTM of Ballast's book: the short at mark plus the paired coins at index. */
  private combined(a: Acct): bigint {
    const m = this.market;
    const mark = this.markRef();
    const index = this.indexRef();
    if (!m || !mark || !index) return a.cash - a.basis;
    return (
      a.cash - refValue(mark, steps(a.short), m) + refValue(index, steps(a.short), m) - a.basis
    );
  }

  private lossStop(a: Acct): boolean {
    if (a.lossHoldUntil !== null && this.now < a.lossHoldUntil) return true;
    const day = Math.floor(this.now / DAY_MS);
    const value = this.combined(a);
    if (day !== a.day) {
      a.day = day;
      a.dayStartValue = value;
    }
    const loss = maxBigint(0n, (a.dayStartValue ?? value) - value);
    const m = this.market;
    const index = this.indexRef();
    let limit = HOLDER0_LOSS_STOP;
    if (!a.cfg.holder0) {
      if (!m || !index) return false;
      const committed = committedSteps(
        steps(this.observedCover(a)),
        effectiveRBps(a.cfg.rBps, this.policy),
      );
      limit = (BigInt(this.policy.risk.lossStopBpsOfCover) * refValue(index, committed, m)) / BPS;
    }
    if (loss >= limit) {
      a.lossHoldUntil = this.now + DAY_MS;
      this.bump("keeper.loss-stop");
      return true;
    }
    return false;
  }

  private enforce(a: Acct): void {
    const margin = evaluateMarginBand(
      this.marginRatioBps(a),
      marginThresholds(this.policy),
      a.band,
    );
    a.band = margin.nextState;
    const stale = this.staleReasons();
    const lossStop = this.lossStop(a);
    const r = effectiveRBps(a.cfg.rBps, this.policy);
    for (let pass = 0; pass < 3; pass++) {
      const resting = this.ordersOf(a).reduce((s, o) => s + o.qty, 0n);
      const k = keeperStep({
        symbol: this.symbol,
        shortSteps: steps(a.short),
        restingSteps: steps(resting),
        unknownOrders: 0,
        coverSteps: steps(this.observedCover(a)),
        rBps: r,
        mempoolSpend: a.mempool ? { coverAfterSteps: steps(a.mempool.coverAfter) } : null,
        stale,
        margin,
        lossStop,
      });
      a.allowCreates = k.allowCreates;
      if (k.actions.length === 0) break;
      let progressed = false;
      for (const act of k.actions) {
        if (act.kind === "cancel-all") progressed = this.cancelAll(a, act.reason) || progressed;
        else progressed = this.buyBack(a, act.qty) || progressed;
      }
      if (!progressed) break;
    }
    this.checkCover(a);
  }

  private cancelAll(a: Acct, reason: string): boolean {
    if (this.ordersOf(a).length === 0) return false;
    const req: GuardRequest = {
      method: "DELETE",
      path: "/v2/order/cancel-all",
      body: { symbol: this.symbol },
      builderFeeBps: 0,
    };
    if (!this.admitRiskReducing(a, req, "cancel", 1)) return false;
    for (const o of this.ordersOf(a)) this.orders.delete(o.id);
    this.bump("keeper.cancel-all");
    if (reason.startsWith("stale")) this.bump("keeper.cancel-all.stale");
    return true;
  }

  private buyBack(a: Acct, qty: Steps): boolean {
    const m = this.market;
    const mark = this.markRef();
    if (!m || !mark || qty <= 0n) return false;
    const cap = refPlusBpsFloor(mark, 400n);
    const id = clientOrderId({
      policyHash: this.anchor().hash,
      accountId: a.cfg.id,
      level: "x",
      seq: this.nextSeq(),
    });
    const body = reduceOnlyBuyBack({
      clientOrderId: id,
      symbol: this.symbol,
      size: m.step.fromUnits(qty).toFixed(),
      price: m.tick.fromUnits(cap).toFixed(),
    });
    const req: GuardRequest = { method: "POST", path: "/v2/order", body, builderFeeBps: 0 };
    if (!this.admitRiskReducing(a, req, "reduce", 1)) return false;
    this.usedIds.add(id);
    // IOC against the house asks only, never past the cap; the remainder simply expires.
    let left: bigint = qty;
    let cost = 0n;
    for (const l of this.houseLevels().asks) {
      if (left === 0n || l.px > cap) break;
      const take = minBigint(left, l.qty);
      cost += notionalCeil(ticks(l.px), steps(take), m.rate);
      left -= take;
    }
    const filled = qty - left;
    if (filled === 0n) {
      this.bump("keeper.buy-back.unfilled");
      return false;
    }
    const share = (x: bigint) => (x * filled) / a.short;
    const entryPart = share(a.entryNotional);
    a.basis -= share(a.basis);
    a.entryNotional -= entryPart;
    a.realized += entryPart - cost;
    a.cash -= cost;
    a.short -= filled;
    this.bump("keeper.buy-back");
    return true;
  }

  /** Cancels and buy-backs: the Guard's exempt path, the limiter, and a possible 429. */
  private admitRiskReducing(
    a: Acct,
    req: GuardRequest,
    rateClass: "cancel" | "reduce",
    ops: number,
  ): boolean {
    const g = checkGuard(this.guardInput(a, req, null, this.seq));
    if (g.decision !== "execute") {
      this.bump(`guard.blocked.risk-reducing`);
      return false;
    }
    const d = this.limiter.acquire({ account: a.cfg.id, rateClass, ops, replaceBatch: false });
    if (!d.ok) {
      this.bump(`rate.refused.${rateClass}`);
      return false;
    }
    if (this.storm()) {
      this.limiter.record429();
      this.bump(`exchange.429.${rateClass}`);
      return false;
    }
    return true;
  }

  private storm(): boolean {
    for (const s of this.cfg.perturbations?.storm429 ?? []) {
      if (this.now >= s.fromMs && this.now < s.toMs && this.rng.chance(s.num, s.den)) return true;
    }
    return false;
  }

  // ---- engine ---------------------------------------------------------------------------

  private nextSeq(): bigint {
    this.seq += 1n;
    return this.seq;
  }

  /** The policy, re-anchored to the replayed day: the Critic tests parameters, not dates. */
  private anchor(): { policy: QuotePolicy; hash: string; day: number } {
    const day = Math.max(0, Math.floor((this.now - (this.startMs ?? this.now)) / DAY_MS));
    let a = this.anchored.get(day);
    if (!a) {
      const from = (this.startMs ?? 0) + day * DAY_MS;
      const policy = { ...this.policy, validFromMs: from, validUntilMs: from + DAY_MS };
      a = { policy, hash: quotePolicyHash(policy) };
      this.anchored.set(day, a);
    }
    return { ...a, day };
  }

  private builderFeeBps(a: Acct): bigint {
    if (a.cfg.holder0) return 0n;
    const cap = minBigint(BigInt(this.policy.fees.entryBuilderBps), this.caps.maxEntryBuilderBps);
    return minBigint(cap, BigInt(Math.max(0, Math.trunc(a.cfg.approvedBuilderBps))));
  }

  /** Requote triggers (plan section 2): index move, a fill or cover change, F/P2, heartbeat. */
  private cycleEngine(): void {
    if (!this.market || !this.tick) return;
    for (const a of this.accts) this.enforce(a);
    const moved =
      !this.lastQuote ||
      this.tick.index
        .minus(this.lastQuote.index)
        .abs()
        .times(10_000)
        .gte(this.lastQuote.index.times(this.policy.requote.indexMoveBps));
    const heartbeat = !this.lastQuote || this.now - this.lastQuote.atMs >= HEARTBEAT_MS;
    const resting = this.orders.size > 0;
    if (!(this.dirty || moved || heartbeat || resting || this.lastStandDown)) return;
    this.requote(this.dirty || moved || heartbeat);
  }

  private requote(triggered: boolean): void {
    const m = this.market;
    const tick = this.tick;
    if (!m || !tick || !this.simMark || !this.book.synced) return;
    const anchor = this.anchor();
    const house = this.houseLevels();
    const pos = this.positions;
    const seq = this.nextSeq();
    const p2 =
      this.p2.mode === "blind"
        ? ({ mode: "blind" } as const)
        : {
            mode: "replica" as const,
            params: this.p2.params,
            basis: this.replica?.state.basis ?? [],
            basisGapFree: this.syncedTicks >= this.p2.params.basisWindow,
          };
    const plan = planRequote({
      market: m,
      caps: this.caps,
      policy: anchor.policy,
      policyHash: anchor.hash,
      book: house,
      index: tick.index,
      mark: this.simMark,
      positions: pos?.rows ?? [],
      positionsAgeMs: pos ? this.now - pos.updatedAtMs : Number.NaN,
      replicaP99Bps: this.p99,
      p2,
      accounts: this.accts.map((a) => ({
        id: a.cfg.id,
        holder0: a.cfg.holder0,
        coverSteps: steps(this.observedCover(a)),
        rBps: a.cfg.rBps,
        shortSteps: steps(a.short),
        resting: this.ordersOf(a).map(toResting),
        maxShortMicroUsd: a.cfg.maxShortMicroUsd === null ? null : microUsd(a.cfg.maxShortMicroUsd),
        lastReplaceBatchMs: a.lastRbMs,
        allowCreates: a.allowCreates,
      })),
      nowMs: this.now,
      seq,
    });
    this.lastStandDown = !plan.governor.ok;
    this.bump(plan.governor.ok ? "engine.armed" : `engine.stand-down.${plan.governor.reason}`);
    // Resting asks that now break invariant 5 (below F, or below the mark where L1 must clear
    // it) cannot wait out the 2 s replace-batch spacing: they are cancelled outright.
    const floorTicks = plan.governor.floor?.ticks ?? 0n;
    const mustClearMark = this.p2.mode === "blind" || (plan.governor.floor?.stale ?? true);
    const markTicks = mustClearMark ? m.tick.ceilUnits(this.simMark) : 0n;
    const unsafe = (a: Acct) =>
      !plan.governor.ok ||
      !a.allowCreates ||
      this.ordersOf(a).some((o) => o.px < floorTicks || o.px < markTicks);
    // Accounts shrinking their asks go first, so the aggregate and P2 caps are never overshot.
    const order = [...plan.accounts].sort((x, y) => {
      const delta = (p: (typeof plan.accounts)[number]) => {
        const a = this.accts.find((q) => q.cfg.id === p.accountId) as Acct;
        const now = this.ordersOf(a).reduce((s, o) => s + o.qty, 0n);
        return p.desired.reduce((s, d) => s + d.qty, 0n) - now;
      };
      const dx = delta(x);
      const dy = delta(y);
      return dx < dy ? -1 : dx > dy ? 1 : 0;
    });
    for (const p of order) {
      const a = this.accts.find((q) => q.cfg.id === p.accountId) as Acct;
      if (!triggered && !unsafe(a)) continue;
      if (p.diff.kind === "replace-batch") {
        const ok = this.sendReplaceBatch(
          a,
          p.diff.body,
          plan,
          seq,
          p.diff.creates.length,
          p.diff.cancels.length,
        );
        if (!ok && unsafe(a)) this.cancelAll(a, "requote blocked while orders are unsafe");
      } else if (p.diff.kind !== "none") {
        this.bump(`engine.diff.${p.diff.kind}`);
        if (unsafe(a)) this.cancelAll(a, `requote ${p.diff.kind} while orders are unsafe`);
      }
    }
    if (triggered) {
      this.lastQuote = { index: tick.index, atMs: this.now };
      this.dirty = false;
    }
  }

  private sendReplaceBatch(
    a: Acct,
    body: unknown,
    plan: RequotePlan,
    seq: bigint,
    creates: number,
    cancels: number,
  ): boolean {
    const req: GuardRequest = {
      method: "POST",
      path: "/v2/order/replace-batch",
      body,
      builderFeeBps: creates > 0 ? Number(this.builderFeeBps(a)) : 0,
    };
    const g = checkGuard(this.guardInput(a, req, plan, seq));
    if (g.decision !== "execute") {
      this.bump("guard.blocked");
      for (const v of g.violations) this.bump(`guard.blocked.${v.rule}`);
      return false;
    }
    const ops = creates + cancels;
    const d = this.limiter.acquire({
      account: a.cfg.id,
      rateClass: creates > 0 ? "create" : "cancel",
      ops,
      replaceBatch: true,
    });
    if (!d.ok) {
      this.bump(`rate.refused.${d.reason}`);
      return false;
    }
    if (this.storm()) {
      this.limiter.record429();
      this.bump("exchange.429.replace-batch");
      return false;
    }
    // Independent rate measurement of what actually reached the exchange.
    if (creates > 0) {
      if (a.lastRbMs !== null && this.now - a.lastRbMs < 2_000) {
        this.violate(
          "rate",
          `${a.cfg.id}: replace-batch ${this.now - a.lastRbMs} ms after the last`,
        );
      }
      while (this.sent[0] && this.sent[0].at <= this.now - 60_000) this.sent.shift();
      const used = this.sent.reduce((s, x) => s + x.ops, 0) + ops;
      if (used > 300) this.violate("rate", `${used} order ops in 60 s`);
      this.sent.push({ at: this.now, ops });
    }
    a.lastRbMs = this.now;
    this.applyReplaceBatch(
      a,
      body as {
        replacements: { cancel?: { order_id: bigint }; new_order?: Record<string, unknown> }[];
      },
    );
    return true;
  }

  /** Strike's replace-batch semantics on the simulated exchange. */
  private applyReplaceBatch(
    a: Acct,
    body: {
      replacements: { cancel?: { order_id: bigint }; new_order?: Record<string, unknown> }[];
    },
  ): void {
    const m = this.market;
    if (!m) return;
    const mark = this.markRef();
    const creates = body.replacements.flatMap((r) => (r.new_order ? [r.new_order] : []));
    for (const c of creates) {
      const v = validateCreate(
        m,
        { price: String(c.price), size: String(c.size), reduceOnly: c.reduce_only === true },
        mark,
        { rules: "strike" },
      );
      if (!v.ok) {
        this.violate(
          "static",
          `${String(c.client_order_id)} fails Strike's static rules: ${v.checks
            .filter((x) => !x.ok)
            .map((x) => x.id)
            .join(", ")}`,
        );
        this.bump("exchange.static-reject");
        return;
      }
    }
    for (const r of body.replacements) {
      if (!r.cancel) continue;
      const o = this.orders.get(r.cancel.order_id);
      if (o && o.accountId === a.cfg.id) this.orders.delete(o.id);
    }
    const pr = this.cfg.perturbations?.partialReject;
    const bestBid = this.houseLevels().bids[0]?.px ?? null;
    for (const [i, c] of creates.entries()) {
      const id = String(c.client_order_id);
      this.usedIds.add(id);
      const px = m.tick.toUnits(String(c.price));
      if (pr && this.now >= pr.fromMs && this.now < pr.toMs && i === pr.index) {
        this.bump("exchange.partial-reject");
        break;
      }
      if (bestBid !== null && px <= bestBid) {
        // Post-only would cross: rejected, and the batch stops here (far-to-near order).
        this.bump("exchange.post-only-reject");
        break;
      }
      const order: SimOrder = {
        id: this.nextOrderId++,
        clientOrderId: id,
        accountId: a.cfg.id,
        level: Number(parseClientOrderId(id)?.level ?? 0),
        px: ticks(px),
        qty: steps(m.step.toUnits(String(c.size))),
        ahead: aheadAt(this.book.book.asks, String(c.price)),
        seq: this.orderSeq++,
      };
      this.orders.set(order.id, order);
      this.bump("exchange.creates");
    }
  }

  private guardInput(
    a: Acct,
    request: GuardRequest,
    plan: RequotePlan | null,
    seq: bigint,
  ): GuardInput {
    const m = this.market as EngineMarket;
    const anchor = this.anchor();
    const mark = this.markRef();
    const index = this.indexRef();
    const house = this.houseLevels();
    const floor = plan?.governor.floor ?? null;
    const others = this.accts.filter((x) => x !== a);
    let othersExposure = 0n;
    let othersAsks = 0n;
    let othersL1 = 0n;
    const l1 = plan?.governor.ok ? plan.governor.l1 : null;
    for (const o of others) {
      if (mark) othersExposure += refCeilValue(mark, steps(o.short), m);
      for (const ord of this.ordersOf(o)) {
        const usd = notionalCeil(ord.px, ord.qty, m.rate);
        othersExposure += usd;
        othersAsks += usd;
        if (l1 !== null && ord.px === l1) othersL1 += ord.qty;
      }
    }
    const committed = committedSteps(
      steps(this.observedCover(a)),
      effectiveRBps(a.cfg.rBps, this.policy),
    );
    const margin = this.marginRatioBps(a);
    return {
      nowMs: this.now,
      request,
      profile: "AUTONOMOUS",
      flags: { dryRun: false, armed: true, mainnet: true },
      policy: {
        policy: anchor.policy,
        hash: anchor.hash,
        signatureValid: true,
        renewalsUsed: Math.min(anchor.day, 7),
      },
      critic: { verdict: "PASS", policyHash: anchor.hash, reportValid: true },
      market: {
        spec: m,
        caps: this.caps,
        allowlist: [this.symbol],
        arm: armDecision(DEFAULT_ARM_LIST, this.symbol, { index, mark }),
        index,
        mark,
        bestBidTicks: house.bids[0] ? ticks(house.bids[0].px) : null,
        bestAskTicks: house.asks[0] ? ticks(house.asks[0].px) : null,
        floor: floor
          ? {
              ticks: ticks(floor.ticks),
              bLiqMicroBps: BigInt(floor.bLiqBps.times(1_000_000).toDecimalPlaces(0, 1).toFixed()),
              replicaP99MicroBps: BigInt(this.p99.times(1_000_000).toDecimalPlaces(0, 0).toFixed()),
              positionsStale: floor.stale,
            }
          : null,
        p2: plan?.governor.ok ? plan.governor.p2 : null,
        others: {
          exposureMicroUsd: microUsd(othersExposure),
          askMicroUsd: microUsd(othersAsks),
          l1Steps: steps(othersL1),
        },
        exitDepthMicroUsd: plan?.exitDepth ?? microUsd(0n),
        recyclingOptIn: false,
      },
      data: {
        indexAgeMs: this.tick ? this.now - this.tick.r : Number.POSITIVE_INFINITY,
        markAgeMs: this.tick && this.simMark ? this.now - this.tick.r : Number.POSITIVE_INFINITY,
        l3Synced: this.book.synced,
        l3GapFree: this.book.synced,
        coverAgeMs: this.now - this.coverBlockTime(),
        // VERIFY-free modelling choice: the recorder polls /v2/markets every ~10 min while the
        // keeper refreshes every 60 s, so market rules are taken as fresh in replay.
        marketsAgeMs: 0,
        userStreamConnected: true,
      },
      // No CEX reference is recorded: "unavailable" passes only while the index is fresh.
      reference: { status: "unavailable", deviationBps: null },
      account: {
        id: a.cfg.id,
        holder0: a.cfg.holder0,
        stakeBinding: { bound: true, unique: true },
        foreignOrders: 0,
        foreignPositions: false,
        vaultShares: false,
        coverSteps: steps(this.observedCover(a)),
        rBps: a.cfg.rBps,
        shortSteps: steps(a.short),
        resting: this.ordersOf(a).map((o) => ({
          clientOrderId: o.clientOrderId,
          orderId: o.id,
          px: o.px,
          qty: o.qty,
        })),
        pendingSteps: steps(0n),
        unknownOrders: 0,
        exposureUpperBound: true,
        oldestUnconfirmedCreateAtMs: null,
        equityMicroUsd: microUsd(
          this.equity(a) + (mark ? a.entryNotional - refCeilValue(mark, steps(a.short), m) : 0n),
        ),
        marginRatioBps: margin,
        marginBand: a.band.lastBand,
        maxShortMicroUsd: a.cfg.maxShortMicroUsd === null ? null : microUsd(a.cfg.maxShortMicroUsd),
        approvedBuilderBps: a.cfg.approvedBuilderBps,
        lossTodayMicroUsd: microUsd(maxBigint(0n, (a.dayStartValue ?? 0n) - this.combined(a))),
        lossHoldUntilMs: a.lossHoldUntil,
        committedCoverMicroUsd: index ? refValue(index, committed, m) : microUsd(0n),
      },
      allocator: plan?.allocatorInput ?? null,
      rate: {
        usedInWindow: this.limiter.used(),
        windowCap: 300,
        cancelReserve: 60,
        lastReplaceBatchMs: a.lastRbMs,
        spacingMs: 2_000,
        pausedUntilMs: this.limiter.pausedUntil,
      },
      decisionSeq: seq,
      usedClientOrderIds: this.usedIds,
    };
  }

  private sampleDrawdown(): void {
    if (!this.inWindow(this.now)) return;
    let total = 0n;
    for (const a of this.accts) total += this.combined(a);
    if (this.peak === null || total > this.peak) this.peak = total;
    const dd = this.peak - total;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
  }
}

function toResting(o: SimOrder): RestingOrder {
  return { clientOrderId: o.clientOrderId, orderId: o.id, px: o.px, qty: o.qty, status: "open" };
}

/** qty × ref in µUSD, rounded down. */
function refValue(ref: RefPrice, qty: Steps, m: EngineMarket): MicroUsd {
  return microUsd((ref.num * qty * m.rate.num) / (ref.den * m.rate.den));
}

function refCeilValue(ref: RefPrice, qty: Steps, m: EngineMarket): MicroUsd {
  const n = ref.num * qty * m.rate.num;
  const d = ref.den * m.rate.den;
  return microUsd(n / d + (n % d === 0n ? 0n : 1n));
}
