import { performance } from "node:perf_hooks";
import {
  addDec,
  cmpDec,
  type Dec,
  decToString,
  isDecimalString,
  maxDec,
  minDec,
  parseDec,
  subDec,
  ZERO,
} from "./decimal.js";
import { toOrderId } from "./json.js";
import type { CreateOutcome } from "./silent-drop.js";
import type {
  OpenOrdersResponse,
  PositionsResponse,
  StrikeOrder,
  StrikePosition,
} from "./types.js";
import {
  type OrderTradeUpdate,
  type StreamPosition,
  TERMINAL_STREAM_STATUSES,
  type UserStreamEvent,
} from "./userstream.js";

/**
 * Per-account orders and position from REST snapshots plus user-stream deltas, built to stay
 * fail-closed when events are dropped or reordered (the stream is best effort, no replay).
 *
 * Capacity (invariant 1) needs an upper bound on short + resting asks + pending creates. Each
 * sell order contributes what may still become short and is not yet visible in the held
 * position report:
 *   accounted = fills the held position provably reflects (a listing's `Filled`, or fills the
 *               held report covers)
 *   live order:     size − accounted     (unknown and unconfirmed orders count as resting)
 *   terminal order: max(0, z − accounted)
 * A lost fill or position event therefore leaves the quantity counted as resting; it never
 * vanishes. Buys only ever reduce the short, so they are ignored until a position report shows
 * the reduction. With every event delivered, in any order, the estimate is exact.
 *
 * No server-clock estimate is involved, and fill times are never compared with position times
 * (strike-userstream's own example stamps a fill …150 and its position update …250). Decisions
 * use only:
 * - Strike's like-for-like data: a fill's cumulative `z` against a listing's `Filled`, its `T`
 *   against that row's `EventTimestamp`, position update `T` against the row's
 *   `update_timestamp`, and position_seq watermarks;
 * - local elapsed time (a monotonic clock): an event applied at least `lagMs` before a REST
 *   request was sent happened at least that long before Strike served it.
 */

// VERIFY: assumptions (FRICTION 2026-10-23):
// - Strike's internal propagation (a fill reaching order state, position state and the REST read
//   models) takes less than lagMs (default 1 s; the docs' example shows ~100 ms);
// - a fill update's `z` is the order's cumulative filled size including that fill, or else
//   `EventTimestamp` advances on every fill (the listing baseline cut needs either);
// - position update `T` and position `update_timestamp` are stamped by one clock, monotone per
//   account and symbol.

export type TrackedStatus =
  | "sent"
  | "pending"
  | "open"
  | "untriggered"
  | "unknown"
  | "filled"
  | "canceled"
  | "rejected"
  | "expired"
  | "dropped"
  | "not-sent";

const TERMINAL: ReadonlySet<TrackedStatus> = new Set([
  "filled",
  "canceled",
  "rejected",
  "expired",
  "dropped",
  "not-sent",
]);

/** Terminal states Strike itself reported (dropped / not-sent are only our inference). */
const SERVER_TERMINAL: ReadonlySet<TrackedStatus> = new Set([
  "filled",
  "canceled",
  "rejected",
  "expired",
]);

const RANK: Record<TrackedStatus, number> = {
  sent: 0,
  unknown: 0,
  pending: 1,
  untriggered: 1,
  open: 2,
  filled: 3,
  canceled: 3,
  rejected: 3,
  expired: 3,
  dropped: 3,
  "not-sent": 3,
};

const NEVER = Number.NEGATIVE_INFINITY;

interface FillRecord {
  size: Dec;
  T: number;
  /** The order's cumulative filled size after this fill, when the update carried it. */
  z?: Dec;
  positionId?: string;
  positionSeq?: number;
  /** Local time the fill was applied. */
  appliedAt: number;
}

export interface TrackedOrder {
  /** Client id, or `#<order id>` when Strike sent none. */
  key: string;
  clientOrderId: string;
  /** Exact engine id: replace-batch cancel legs need it. */
  orderId?: bigint;
  symbol: string;
  side: "buy" | "sell";
  /** ZERO while unknown (a fill whose order snapshot was unavailable). */
  size: Dec;
  price?: string;
  status: TrackedStatus;
  /** Largest cumulative filled size seen. */
  z: Dec;
  /** `Filled` in the last listing, which that snapshot's position read reflects. */
  baseline: Dec;
  /** That listing row's EventTimestamp; NEVER while no baseline is held. */
  baselineEventMs: number;
  fills: Map<string, FillRecord>;
  /** Strike time of the last applied status (event T or REST EventTimestamp). */
  lastT: number;
  /** Local time of the first Strike sighting (an event, a listing or a REST answer). */
  firstSeenAt?: number;
  /** Local time a Strike-reported terminal status was applied. */
  terminalAt?: number;
}

interface RestReport {
  kind: "rest";
  size: Dec;
  hasRows: boolean;
  /** Max update_timestamp of the symbol's rows (undefined when flat or not served). */
  updatedMs?: number;
  /** Max EventTimestamp of the symbol's listed orders. */
  listedMs: number;
  /** Fills and terminal statuses applied at or before this local time are in the position. */
  coveredBefore: number;
  /** A stream report must be later than this (Strike position time) to replace the snapshot. */
  notAfterMs: number;
}

interface StreamReport {
  kind: "stream";
  size: Dec;
  positionId: string;
  seq: number;
  T: number;
}

type PositionReport = RestReport | StreamReport;

export interface Exposure {
  /** max(0, −position) from the held report. */
  shortQty: string;
  /** Live sells: size − accounted, including unconfirmed creates. */
  restingAskQty: string;
  /** Unconfirmed creates (status "sent"), already inside restingAskQty. */
  pendingCreateQty: string;
  /** Terminal sells whose fills the held position does not show yet. */
  unaccountedFillQty: string;
  /** shortQty + restingAskQty + unaccountedFillQty. */
  total: string;
  /** Orders whose size is unknown: the caller must not create while any exist. */
  unknownOrders: number;
  /** True when `total` is a proven upper bound (no order of unknown size). */
  upperBound: boolean;
  /** Live orders without a `bal_` client id (manual activity pauses the account). */
  foreignOrders: number;
}

/** One REST resync, timed on the reconciler's own clock (rec.now()); resyncAccount fills it in. */
export interface Snapshot {
  /** Restrict the snapshot to one symbol (both REST calls were filtered by it). */
  symbol?: string;
  openOrders: readonly StrikeOrder[];
  positions: readonly StrikePosition[];
  /** Just before GET /v2/openOrders was sent. */
  ordersRequestedAt: number;
  /** When GET /v2/openOrders answered. */
  ordersReceivedAt: number;
  /** Just before GET /v2/positions was sent: at least lagMs after ordersReceivedAt. */
  positionsRequestedAt: number;
}

export interface ReconcilerOptions {
  /** When set, position rows for any other account are ignored. */
  accountId?: string;
  /** Bound on Strike's internal propagation delay (VERIFY above). */
  lagMs?: number;
  /** Local monotonic milliseconds (default performance.now); never Strike's clock. */
  now?: () => number;
  onAnomaly?: (anomaly: { kind: string; detail: string }) => void;
}

function sideOf(s: string): "buy" | "sell" {
  return s === "BUY" || s === "buy" ? "buy" : "sell";
}

function dec(text: string | undefined): Dec | undefined {
  return text && isDecimalString(text) ? parseDec(text) : undefined;
}

function validMs(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function streamStatus(x: string): TrackedStatus | undefined {
  switch (x) {
    case "NEW":
      return "pending";
    case "OPEN":
      return "open";
    case "FILLED":
      return "filled";
    case "CANCELED":
      return "canceled";
    case "REJECTED":
      return "rejected";
    case "EXPIRED":
      return "expired";
    default:
      return undefined;
  }
}

const REST_TERMINAL: ReadonlySet<string> = new Set(["filled", "canceled", "rejected", "expired"]);

function restStatus(s: string): TrackedStatus {
  return s === "open" || s === "pending" || s === "untriggered" ? s : "unknown";
}

export class AccountReconciler {
  private readonly byKey = new Map<string, TrackedOrder>();
  private readonly byId = new Map<bigint, TrackedOrder>();
  private readonly held = new Map<string, PositionReport>();
  /** Latest stream report T per symbol, kept across snapshots (staleness tightening only). */
  private readonly lastStreamT = new Map<string, number>();
  /** Closed positions per symbol: id → the closing report's seq and T. */
  private readonly closed = new Map<string, Map<string, { seq: number; T: number }>>();
  /** Keys a snapshot retired, with a cutoff: older events for them are stale echoes. */
  private readonly retired = new Map<string, number>();
  private lastTrade = 0n;
  private lastSnapshotAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly opts: ReconcilerOptions = {}) {}

  /** The local clock snapshots are timed with. */
  now(): number {
    return (this.opts.now ?? (() => performance.now()))();
  }

  get lagMs(): number {
    return this.opts.lagMs ?? 1_000;
  }

  get lastTradeId(): bigint {
    return this.lastTrade;
  }

  orders(symbol?: string): TrackedOrder[] {
    return [...this.byKey.values()].filter((o) => symbol === undefined || o.symbol === symbol);
  }

  order(clientOrderId: string): TrackedOrder | undefined {
    return this.byKey.get(clientOrderId);
  }

  /** Signed position size per the held report ("0" when none is known). */
  position(symbol: string): string {
    const h = this.held.get(symbol);
    return h ? decToString(h.size) : "0";
  }

  private anomaly(kind: string, detail: string): void {
    this.opts.onAnomaly?.({ kind, detail });
  }

  private index(o: TrackedOrder): void {
    this.byKey.set(o.key, o);
    if (o.orderId !== undefined) this.byId.set(o.orderId, o);
  }

  private retire(o: TrackedOrder, cutoffMs: number): void {
    this.byKey.delete(o.key);
    if (o.orderId !== undefined && this.byId.get(o.orderId) === o) this.byId.delete(o.orderId);
    this.retired.set(o.key, cutoffMs);
    if (o.orderId !== undefined) this.retired.set(`#${o.orderId}`, cutoffMs);
    while (this.retired.size > 10_000) {
      const first = this.retired.keys().next().value;
      if (first === undefined) break;
      this.retired.delete(first);
    }
  }

  private seen(o: TrackedOrder, at: number): void {
    if (o.firstSeenAt === undefined) o.firstSeenAt = at;
  }

  private setStatus(o: TrackedOrder, status: TrackedStatus, atMs: number, at: number): void {
    o.status = status;
    o.lastT = Math.max(o.lastT, atMs);
    if (SERVER_TERMINAL.has(status)) o.terminalAt = at;
  }

  /**
   * A `#id` placeholder (a fill seen before the order's client id was known) is folded into the
   * named order once an event or listing ties the two together.
   */
  private adopt(into: TrackedOrder, id: bigint): void {
    const from = this.byId.get(id);
    if (!from || from === into || from.key !== `#${id}`) return;
    if (into.orderId !== undefined && into.orderId !== id) return;
    for (const [k, f] of from.fills) if (!into.fills.has(k)) into.fills.set(k, f);
    into.z = maxDec(into.z, from.z);
    if (cmpDec(into.size, ZERO) === 0) into.size = from.size;
    into.lastT = Math.max(into.lastT, from.lastT);
    if (from.firstSeenAt !== undefined) {
      into.firstSeenAt = Math.min(into.firstSeenAt ?? from.firstSeenAt, from.firstSeenAt);
    }
    if (into.baselineEventMs === NEVER && from.baselineEventMs !== NEVER) {
      into.baseline = from.baseline;
      into.baselineEventMs = from.baselineEventMs;
    }
    if (TERMINAL.has(from.status) && !TERMINAL.has(into.status)) {
      into.status = from.status;
      if (from.terminalAt !== undefined) into.terminalAt = from.terminalAt;
    }
    this.byKey.delete(from.key);
    into.orderId = id;
    this.byId.set(id, into);
  }

  /** Call before sending a create; it counts as resting from this moment. */
  registerCreate(p: {
    clientOrderId: string;
    symbol: string;
    side: "buy" | "sell";
    size: string;
    price?: string;
  }): void {
    if (this.byKey.has(p.clientOrderId)) throw new Error(`duplicate create ${p.clientOrderId}`);
    this.index({
      key: p.clientOrderId,
      clientOrderId: p.clientOrderId,
      symbol: p.symbol,
      side: p.side,
      size: parseDec(p.size),
      ...(p.price !== undefined ? { price: p.price } : {}),
      status: "sent",
      z: ZERO,
      baseline: ZERO,
      baselineEventMs: NEVER,
      fills: new Map(),
      lastT: NEVER,
    });
  }

  /** Feed PendingCreates outcomes in: a 404 or a definite 4xx ends the create. */
  onCreateOutcome(clientOrderId: string, outcome: CreateOutcome): void {
    const at = this.now();
    const o = this.byKey.get(clientOrderId);
    if (o?.status !== "sent") return;
    if (outcome.kind === "dropped") {
      o.status = "dropped";
      return;
    }
    if (outcome.kind === "not-sent") {
      o.status = "not-sent";
      return;
    }
    if (o.orderId === undefined) {
      this.adopt(o, outcome.orderId);
      o.orderId = outcome.orderId;
      this.byId.set(outcome.orderId, o);
    }
    this.seen(o, at);
    if (outcome.via === "rest") {
      const r = outcome.order;
      // A REST answer may already be terminal (filled before any event arrived): keep its z.
      o.z = maxDec(o.z, parseDec(r.Filled));
      const status = REST_TERMINAL.has(r.Status)
        ? (r.Status as TrackedStatus)
        : restStatus(r.Status);
      this.setStatus(o, status, r.EventTimestamp, at);
    }
  }

  apply(event: UserStreamEvent): void {
    if (event.kind === "order" || event.kind === "fill") this.applyOrderUpdate(event.data);
    else if (event.kind === "position") {
      for (const p of event.positions) this.applyStreamPosition(p, event.T);
    }
  }

  applyOrderUpdate(u: OrderTradeUpdate): void {
    const at = this.now();
    const byClient = u.c ? this.byKey.get(u.c) : undefined;
    if (byClient && u.i > 0n) this.adopt(byClient, u.i);
    let o = byClient ?? (u.i > 0n ? this.byId.get(u.i) : undefined);
    if (!o) {
      if (!u.c && u.i === 0n) {
        this.anomaly("unattributable-update", JSON.stringify({ s: u.s, X: u.X }));
        return;
      }
      const cutoff = this.retired.get(u.c || `#${u.i}`) ?? this.retired.get(`#${u.i}`);
      // The order ended before a snapshot whose position read reflects all of it: a stale echo.
      if (cutoff !== undefined && u.T < cutoff) return;
      o = {
        key: u.c || `#${u.i}`,
        clientOrderId: u.c,
        symbol: u.s,
        side: sideOf(u.S),
        size: dec(u.q) ?? ZERO,
        ...(u.p ? { price: u.p } : {}),
        status: "unknown",
        z: ZERO,
        baseline: ZERO,
        baselineEventMs: NEVER,
        fills: new Map(),
        lastT: NEVER,
      };
      this.index(o);
    }
    if (u.i > 0n && o.orderId === undefined) {
      o.orderId = u.i;
      this.byId.set(u.i, o);
    }
    this.seen(o, at);
    if (o.status === "dropped" || o.status === "not-sent") {
      // Declared absent, yet the engine has it: it is live again, and that is worth an alarm.
      this.anomaly("late-event", `${o.key} was ${o.status}, got ${u.X}`);
      o.status = "unknown";
    }
    const q = dec(u.q);
    if (q && cmpDec(o.size, ZERO) === 0) o.size = q;
    const z = dec(u.z);
    if (z) o.z = maxDec(o.z, z);

    if (u.t > 0n) {
      if (u.t > this.lastTrade) this.lastTrade = u.t;
      const size = dec(u.l);
      if (size) {
        o.fills.set(u.trade_id ?? u.t.toString(), {
          size,
          T: u.T,
          ...(z ? { z } : {}),
          ...(u.position_id !== undefined ? { positionId: u.position_id } : {}),
          ...(u.position_seq !== undefined ? { positionSeq: u.position_seq } : {}),
          appliedAt: at,
        });
      }
    }

    const next = streamStatus(u.X);
    if (!next) return;
    if (TERMINAL.has(o.status)) return;
    if (
      TERMINAL_STREAM_STATUSES.has(u.X) ||
      u.T > o.lastT ||
      (u.T === o.lastT && RANK[next] >= RANK[o.status])
    ) {
      this.setStatus(o, next, u.T, at);
    }
  }

  private offer(symbol: string, report: StreamReport): void {
    this.lastStreamT.set(symbol, Math.max(this.lastStreamT.get(symbol) ?? NEVER, report.T));
    if (cmpDec(report.size, ZERO) === 0 && report.positionId) {
      const m = this.closed.get(symbol) ?? new Map<string, { seq: number; T: number }>();
      this.closed.set(symbol, m);
      const prev = m.get(report.positionId);
      if (!prev || report.seq > prev.seq)
        m.set(report.positionId, { seq: report.seq, T: report.T });
      while (m.size > 64) m.delete(m.keys().next().value as string);
    }
    const h = this.held.get(symbol);
    let accept: boolean;
    if (!h) accept = true;
    else if (h.kind === "rest") {
      // Newer than the snapshot only if later than the row's last update (same clock: position
      // update times). With no row the snapshot was flat, so even an older report cannot shrink
      // the estimate (a short is never negative); notAfterMs only rejects known-stale ones.
      const newer = h.hasRows ? h.updatedMs !== undefined && report.T > h.updatedMs : true;
      accept = newer && report.T > h.notAfterMs;
    } else {
      accept = report.positionId === h.positionId ? report.seq > h.seq : report.T > h.T;
    }
    if (accept) this.held.set(symbol, report);
  }

  applyStreamPosition(p: StreamPosition, T: number): void {
    if (this.opts.accountId && p.account_id && p.account_id !== this.opts.accountId) return;
    const size = dec(p.pa);
    if (!size) return;
    const positionId = p.position_id ?? (p.i !== undefined ? String(p.i) : "");
    this.offer(p.s, {
      kind: "stream",
      size,
      positionId,
      // Without a watermark the report can never be ordered against fills: count them all.
      seq: p.position_seq ?? Number.NEGATIVE_INFINITY,
      T,
    });
  }

  // VERIFY: a fill update's position_seq is read as the position's fill watermark after that fill,
  // the same counter ACCOUNT_UPDATE carries (both are 22 in the strike-userstream example), and
  // position_id is the same id on both. If not, fills are never "reflected" and exposure only
  // over-counts until the next REST resync (FRICTION 2026-10-23).
  private reflected(symbol: string, f: FillRecord): boolean {
    const h = this.held.get(symbol);
    if (!h) return false;
    if (h.kind === "rest") return f.appliedAt <= h.coveredBefore;
    if (f.positionId === undefined || f.positionSeq === undefined) return false;
    if (f.positionId === h.positionId) return f.positionSeq <= h.seq;
    // A fill on an earlier position life: covered once that life's close report (with a seq at
    // or past the fill) precedes the held report.
    const c = this.closed.get(symbol)?.get(f.positionId);
    return c !== undefined && f.positionSeq <= c.seq && c.T < h.T;
  }

  /** The fill is not inside the order's listed `Filled` (both tests must agree). */
  private afterBaseline(o: TrackedOrder, f: FillRecord): boolean {
    if (o.baselineEventMs === NEVER) return true;
    if (!(f.T > o.baselineEventMs)) return false;
    return f.z !== undefined ? cmpDec(f.z, o.baseline) > 0 : cmpDec(o.baseline, ZERO) === 0;
  }

  /** The listing baseline plus later fills the held position provably reflects. */
  private accounted(o: TrackedOrder, cap: Dec): Dec {
    let after = ZERO;
    for (const f of o.fills.values()) {
      if (this.afterBaseline(o, f) && this.reflected(o.symbol, f)) after = addDec(after, f.size);
    }
    return minDec(cap, addDec(o.baseline, after));
  }

  /** A terminal order every fill of which the held REST position provably contains. */
  private restCovers(o: TrackedOrder): boolean {
    const h = this.held.get(o.symbol);
    if (h?.kind !== "rest" || !SERVER_TERMINAL.has(o.status)) return false;
    // Terminal before the positions request by lagMs: every fill of it reached the position.
    return o.terminalAt !== undefined && o.terminalAt <= h.coveredBefore;
  }

  /** What `o` may still add to the short beyond the held position report. */
  private contribution(o: TrackedOrder): Dec {
    let recorded = ZERO;
    for (const f of o.fills.values()) recorded = addDec(recorded, f.size);
    const filled = maxDec(o.z, recorded);
    // Unknown size: the recorded fills are a floor, so they count until a report shows them.
    const size = maxDec(o.size, filled);
    const acc = this.accounted(o, size);
    if (TERMINAL.has(o.status)) {
      if (this.restCovers(o)) return ZERO;
      const left = subDec(filled, acc);
      return cmpDec(left, ZERO) > 0 ? left : ZERO;
    }
    const left = subDec(size, acc);
    return cmpDec(left, ZERO) > 0 ? left : ZERO;
  }

  exposure(symbol: string): Exposure {
    const h = this.held.get(symbol);
    const short = h && cmpDec(h.size, ZERO) < 0 ? subDec(ZERO, h.size) : ZERO;
    let resting = ZERO;
    let pending = ZERO;
    let unaccounted = ZERO;
    let unknownOrders = 0;
    let foreignOrders = 0;
    for (const o of this.byKey.values()) {
      if (o.symbol !== symbol) continue;
      const live = !TERMINAL.has(o.status);
      if (live && cmpDec(o.size, ZERO) === 0) unknownOrders += 1;
      if (live && !o.clientOrderId.startsWith("bal_")) foreignOrders += 1;
      if (o.side !== "sell") continue;
      const c = this.contribution(o);
      if (live) {
        resting = addDec(resting, c);
        if (o.status === "sent") pending = addDec(pending, o.size);
      } else unaccounted = addDec(unaccounted, c);
    }
    return {
      shortQty: decToString(short),
      restingAskQty: decToString(resting),
      pendingCreateQty: decToString(pending),
      unaccountedFillQty: decToString(unaccounted),
      total: decToString(addDec(addDec(short, resting), unaccounted)),
      unknownOrders,
      upperBound: unknownOrders === 0,
      foreignOrders,
    };
  }

  /** Exact numeric ids of live orders, for replace-batch cancel legs. */
  cancelLegs(symbol: string): { order_id: bigint; symbol: string }[] {
    const out: { order_id: bigint; symbol: string }[] = [];
    for (const o of this.byKey.values()) {
      if (o.symbol === symbol && !TERMINAL.has(o.status) && o.orderId !== undefined) {
        out.push({ order_id: o.orderId, symbol });
      }
    }
    return out.sort((a, b) => (a.order_id < b.order_id ? -1 : a.order_id > b.order_id ? 1 : 0));
  }

  /**
   * Replace local state with REST truth. openOrders is read first and positions at least lagMs
   * after it answered, so every fill in a listing's `Filled` has reached the position read.
   */
  applySnapshot(s: Snapshot): void {
    // Resyncs must not overlap: an older listing applied after a newer one could forget an
    // order the older position read never saw fill.
    if (s.ordersRequestedAt < this.lastSnapshotAt) {
      this.anomaly("overlapping-snapshot", `requested ${s.ordersRequestedAt}, ignored`);
      return;
    }
    this.lastSnapshotAt = s.positionsRequestedAt;
    const inScope = (symbol: string) => s.symbol === undefined || s.symbol === symbol;
    const lag = this.lagMs;
    // Without the settle gap a listing's Filled may be ahead of the position: no baselines.
    const baselines = s.positionsRequestedAt - s.ordersReceivedAt >= lag;
    const coveredBefore = s.positionsRequestedAt - lag;
    const existedBefore = s.ordersRequestedAt - lag;

    const symbols = new Set<string>();
    for (const o of this.byKey.values()) if (inScope(o.symbol)) symbols.add(o.symbol);
    for (const k of this.held.keys()) if (inScope(k)) symbols.add(k);
    const rows = new Map<string, { size: Dec; updatedMs?: number; timed: boolean }>();
    for (const p of s.positions) {
      if (this.opts.accountId && p.account_id && p.account_id !== this.opts.accountId) continue;
      if (!inScope(p.symbol)) continue;
      symbols.add(p.symbol);
      const prev = rows.get(p.symbol);
      const updated = validMs(p.update_timestamp);
      // Every row must carry its time for the symbol's report to be ordered at all.
      const timed = updated !== undefined && (prev?.timed ?? true);
      rows.set(p.symbol, {
        size: addDec(prev?.size ?? ZERO, parseDec(p.size)),
        timed,
        ...(timed ? { updatedMs: Math.max(updated as number, prev?.updatedMs ?? NEVER) } : {}),
      });
    }
    const listedMs = new Map<string, number>();
    for (const r of s.openOrders) {
      if (!inScope(r.Symbol)) continue;
      const t = validMs(r.EventTimestamp);
      if (t !== undefined) listedMs.set(r.Symbol, Math.max(listedMs.get(r.Symbol) ?? NEVER, t));
    }
    const reports = new Map<string, RestReport>();
    for (const sym of symbols) {
      const row = rows.get(sym);
      const prev = this.held.get(sym);
      const report: RestReport = {
        kind: "rest",
        size: row?.size ?? ZERO,
        hasRows: row !== undefined,
        ...(row?.updatedMs !== undefined ? { updatedMs: row.updatedMs } : {}),
        listedMs: listedMs.get(sym) ?? NEVER,
        coveredBefore,
        // Reports up to the newest one seen before this snapshot are older than it.
        notAfterMs: Math.max(
          this.lastStreamT.get(sym) ?? NEVER,
          prev?.kind === "rest" ? prev.notAfterMs : NEVER,
        ),
      };
      reports.set(sym, report);
      this.held.set(sym, report);
    }

    const listed = new Set<TrackedOrder>();
    for (const r of s.openOrders) {
      if (!inScope(r.Symbol)) continue;
      const id = toOrderId(r.ID);
      const byClient = r.ClientOrderID ? this.byKey.get(r.ClientOrderID) : undefined;
      if (byClient && id !== undefined) this.adopt(byClient, id);
      let o = byClient ?? (id !== undefined ? this.byId.get(id) : undefined);
      if (!o) {
        o = {
          key: r.ClientOrderID || `#${id}`,
          clientOrderId: r.ClientOrderID,
          symbol: r.Symbol,
          side: sideOf(r.Side),
          size: parseDec(r.Size),
          price: r.Price,
          status: "unknown",
          z: ZERO,
          baseline: ZERO,
          baselineEventMs: NEVER,
          fills: new Map(),
          lastT: NEVER,
        };
      }
      if (id !== undefined && o.orderId === undefined) o.orderId = id;
      o.size = parseDec(r.Size);
      o.price = r.Price;
      const filled = parseDec(r.Filled);
      o.z = maxDec(o.z, filled);
      if (baselines) {
        o.baseline = filled;
        // A row without its time cannot cut fills: none of them counts as after the baseline.
        o.baselineEventMs = validMs(r.EventTimestamp) ?? Number.POSITIVE_INFINITY;
      } else {
        o.baseline = ZERO;
        o.baselineEventMs = NEVER;
      }
      this.seen(o, s.ordersReceivedAt);
      if (o.status === "dropped" || o.status === "not-sent") {
        this.anomaly("late-event", `${o.key} was ${o.status} but is listed in openOrders`);
        o.status = "unknown";
      }
      // A terminal stream status is newer than this listing (the order was live at the read).
      if (!TERMINAL.has(o.status)) {
        o.status = restStatus(r.Status);
        o.lastT = Math.max(o.lastT, r.EventTimestamp);
      }
      this.index(o);
      listed.add(o);
    }

    for (const o of [...this.byKey.values()]) {
      if (!inScope(o.symbol) || listed.has(o)) continue;
      // Unconfirmed creates stay until PendingCreates resolves them (unknown counts as resting).
      if (o.status === "sent") continue;
      if (o.status === "dropped" || o.status === "not-sent") {
        // Never seen by Strike: nothing to retire, and a late event must be counted afresh.
        this.byKey.delete(o.key);
        continue;
      }
      const h = reports.get(o.symbol);
      // Seen lagMs before the listing was requested and absent from it: it ended before the
      // read, and the later positions read reflects all of its fills.
      const ended =
        (o.firstSeenAt !== undefined && o.firstSeenAt <= existedBefore) ||
        (h !== undefined && this.restCovers(o));
      if (!ended) continue;
      this.retire(o, Math.max(o.lastT + 1, h?.listedMs ?? NEVER));
    }
  }
}

export interface ResyncOptions {
  symbol?: string;
  /** Wait between openOrders answering and the positions request (default rec.lagMs). */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The REST half of a resync: openOrders, a settle wait, then positions (see applySnapshot). */
export async function resyncAccount(
  rec: AccountReconciler,
  client: {
    openOrders(symbol?: string): Promise<OpenOrdersResponse>;
    positions(symbol?: string): Promise<PositionsResponse>;
  },
  opts: ResyncOptions = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const settle = opts.settleMs ?? rec.lagMs;
  const ordersRequestedAt = rec.now();
  const oo = await client.openOrders(opts.symbol);
  const ordersReceivedAt = rec.now();
  // A timer may fire a little early; one top-up, and applySnapshot re-checks the gap anyway.
  for (let i = 0, left = settle; i < 2 && left > 0; i++) {
    await sleep(left);
    left = ordersReceivedAt + settle - rec.now();
  }
  const positionsRequestedAt = rec.now();
  const pos = await client.positions(opts.symbol);
  rec.applySnapshot({
    ...(opts.symbol !== undefined ? { symbol: opts.symbol } : {}),
    openOrders: oo.orders,
    positions: pos.positions,
    ordersRequestedAt,
    ordersReceivedAt,
    positionsRequestedAt,
  });
}
