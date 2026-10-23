import { ReconnectingSocket, type SocketInfo, type SocketState } from "./ws.js";

export interface L3Order {
  id: string;
  size: string;
}

export interface L3Snapshot {
  type: "l3_snapshot";
  symbol: string;
  last_sequence: number;
  timestamp: number;
  bids: { price: string; orders: { order_id: string; size: string }[] }[];
  asks: { price: string; orders: { order_id: string; size: string }[] }[];
}

export interface L3Update {
  type: "l3_update";
  symbol: string;
  action: "open" | "modify" | "cancel" | "partial_fill" | "full_fill" | "clear";
  order_id?: string;
  taker_order_id?: string;
  side?: "buy" | "sell";
  price?: string;
  delta_size?: string;
  remaining_size?: string;
  sequence: number;
  trade_id?: number;
  timestamp: number;
}

export type L3Status =
  | { ok: true }
  | {
      ok: false;
      reason: "gap" | "clear" | "unknown_order" | "bad_update";
      detail?: string;
    };

const OK: L3Status = { ok: true };

/**
 * Canonical price key. A snapshot level carries its first order's spelling while each update
 * carries its own ("72247.30" vs "72247.3"), so levels must be keyed without trailing zeros.
 */
export function canonicalPrice(p: string): string {
  return p.includes(".") ? p.replace(/0+$/, "").replace(/\.$/, "") : p;
}

export function isZeroSize(s: string): boolean {
  return /^0*(\.0*)?$/.test(s);
}

/**
 * Order-by-order book for one symbol, maintained exactly as strike-orderbook specifies.
 * Updates buffer until a snapshot is applied, and every update must advance `sequence` by
 * exactly 1. A gap, a `clear` or an unknown order id means the book can no longer be trusted:
 * the caller must re-bootstrap.
 */
export class L3Book {
  readonly bids = new Map<string, L3Order[]>();
  readonly asks = new Map<string, L3Order[]>();
  lastSequence = -1;
  synced = false;
  private buffer: L3Update[] = [];

  constructor(readonly symbol: string) {}

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.lastSequence = -1;
    this.synced = false;
    this.buffer = [];
  }

  onUpdate(u: L3Update): L3Status {
    if (!this.synced) {
      this.buffer.push(u);
      return OK;
    }
    return this.apply(u);
  }

  applySnapshot(s: L3Snapshot): L3Status {
    this.bids.clear();
    this.asks.clear();
    for (const [side, levels] of [
      [this.bids, s.bids],
      [this.asks, s.asks],
    ] as const) {
      for (const lvl of levels) {
        side.set(
          canonicalPrice(lvl.price),
          lvl.orders.map((o) => ({ id: o.order_id, size: o.size })),
        );
      }
    }
    this.lastSequence = s.last_sequence;
    this.synced = true;
    const buffered = this.buffer;
    this.buffer = [];
    for (const u of buffered) {
      if (u.sequence <= this.lastSequence) continue;
      const st = this.apply(u);
      if (!st.ok) return st;
    }
    return OK;
  }

  bestBid(): string | undefined {
    return extreme(this.bids, (a, b) => a > b);
  }

  bestAsk(): string | undefined {
    return extreme(this.asks, (a, b) => a < b);
  }

  orderCount(): number {
    let n = 0;
    for (const q of this.bids.values()) n += q.length;
    for (const q of this.asks.values()) n += q.length;
    return n;
  }

  private apply(u: L3Update): L3Status {
    // Sequences are per-symbol and monotone, so anything at or below lastSequence is already in
    // the book: an update still queued on the socket when the snapshot landed. Only a jump
    // forward is a gap.
    if (u.sequence <= this.lastSequence) return OK;
    if (u.sequence !== this.lastSequence + 1) {
      return {
        ok: false,
        reason: "gap",
        detail: `expected ${this.lastSequence + 1}, got ${u.sequence}`,
      };
    }
    this.lastSequence = u.sequence;
    if (u.action === "clear") return { ok: false, reason: "clear" };
    const { side, price, order_id: id, remaining_size: remaining } = u;
    if ((side !== "buy" && side !== "sell") || !price || !id || remaining === undefined) {
      return { ok: false, reason: "bad_update", detail: `action ${u.action} missing fields` };
    }
    const book = side === "buy" ? this.bids : this.asks;
    const key = canonicalPrice(price);
    const queue = book.get(key) ?? [];
    if (u.action === "open") {
      queue.push({ id, size: remaining });
    } else {
      const i = queue.findIndex((o) => o.id === id);
      const order = queue[i];
      if (!order) return { ok: false, reason: "unknown_order", detail: `${u.action} ${id}` };
      if (isZeroSize(remaining)) queue.splice(i, 1);
      else order.size = remaining;
    }
    if (queue.length > 0) book.set(key, queue);
    else book.delete(key);
    return OK;
  }
}

function extreme(
  side: Map<string, L3Order[]>,
  better: (a: number, b: number) => boolean,
): string | undefined {
  let best: string | undefined;
  let bestN = 0;
  for (const p of side.keys()) {
    const n = Number(p);
    if (best === undefined || better(n, bestN)) {
      best = p;
      bestN = n;
    }
  }
  return best;
}

export interface L3FeedOptions {
  url: string;
  userAgent: string;
  /** At most 10: Strike allows 10 subscriptions per L3 connection. */
  symbols: string[];
  fetchSnapshot: (symbol: string) => Promise<L3Snapshot>;
  onUpdate?: (u: L3Update, recvMs: number) => void;
  onSnapshot?: (s: L3Snapshot, recvMs: number) => void;
  onRebuild?: (symbol: string, reason: string, detail: string | undefined, recvMs: number) => void;
  onControl?: (msg: unknown, recvMs: number) => void;
  onStateChange?: (state: SocketState, info: SocketInfo) => void;
  now?: () => number;
  maxBackoffMs?: number;
  /** Minimum spacing between re-bootstraps of one symbol, so a persistent fault cannot spin. */
  rebuildCooldownMs?: number;
}

/**
 * Gap-free L3 feed for up to 10 symbols on one connection. Per symbol:
 * SUBSCRIBE → ack → REST snapshot → apply buffered updates. A gap, clear, unknown order or failed
 * snapshot re-bootstraps that symbol alone (UNSUBSCRIBE + SUBSCRIBE). A socket close resets
 * every book, and the reconnect resubscribes everything.
 */
export class L3Feed {
  readonly books = new Map<string, L3Book>();
  private readonly socket: ReconnectingSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { symbol: string; method: "SUBSCRIBE" | "UNSUBSCRIBE" }
  >();
  private readonly generation = new Map<string, number>();
  private readonly lastRebuild = new Map<string, number>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();

  constructor(private readonly opts: L3FeedOptions) {
    if (opts.symbols.length > 10) throw new Error("L3Feed: at most 10 symbols per connection");
    for (const s of opts.symbols) this.books.set(s, new L3Book(s));
    this.socket = new ReconnectingSocket({
      url: opts.url,
      userAgent: opts.userAgent,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.maxBackoffMs !== undefined ? { maxBackoffMs: opts.maxBackoffMs } : {}),
      onOpen: () => {
        for (const s of this.opts.symbols) this.subscribe(s);
      },
      onMessage: (m, t) => this.onMessage(m, t),
      onStateChange: (state, info) => {
        if (state === "closed" || state === "stopped") {
          for (const b of this.books.values()) b.reset();
          for (const s of this.opts.symbols) this.bump(s);
          this.pending.clear();
        }
        this.opts.onStateChange?.(state, info);
      },
    });
  }

  start(): void {
    this.socket.start();
  }

  stop(): void {
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    this.socket.stop();
  }

  get lastSeen(): number {
    return this.socket.lastSeen;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private bump(symbol: string): number {
    const g = (this.generation.get(symbol) ?? 0) + 1;
    this.generation.set(symbol, g);
    return g;
  }

  private subscribe(symbol: string): void {
    this.books.get(symbol)?.reset();
    this.bump(symbol);
    const id = this.nextId++;
    this.pending.set(id, { symbol, method: "SUBSCRIBE" });
    this.socket.send({ method: "SUBSCRIBE", params: [`${symbol.toLowerCase()}@l3`], id });
  }

  private rebuild(symbol: string, reason: string, detail: string | undefined): void {
    this.opts.onRebuild?.(symbol, reason, detail, this.now());
    this.books.get(symbol)?.reset();
    const gen = this.bump(symbol);
    const since = this.now() - (this.lastRebuild.get(symbol) ?? 0);
    const wait = Math.max(0, (this.opts.rebuildCooldownMs ?? 2_000) - since);
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (this.generation.get(symbol) !== gen || !this.socket.isOpen) return;
      this.lastRebuild.set(symbol, this.now());
      const id = this.nextId++;
      this.pending.set(id, { symbol, method: "UNSUBSCRIBE" });
      this.socket.send({ method: "UNSUBSCRIBE", params: [`${symbol.toLowerCase()}@l3`], id });
      this.subscribe(symbol);
    }, wait);
    this.retryTimers.add(timer);
  }

  private onMessage(msg: unknown, recvMs: number): void {
    if (isObject(msg) && msg.type === "l3_update") {
      const u = msg as unknown as L3Update;
      this.opts.onUpdate?.(u, recvMs);
      const book = this.books.get(u.symbol);
      if (!book) return;
      const st = book.onUpdate(u);
      if (!st.ok) this.rebuild(u.symbol, st.reason, st.detail);
      return;
    }
    this.opts.onControl?.(msg, recvMs);
    if (!isObject(msg) || typeof msg.id !== "number") return;
    const req = this.pending.get(msg.id);
    if (!req) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      this.rebuild(req.symbol, "subscribe_error", JSON.stringify(msg.error));
      return;
    }
    if (req.method === "SUBSCRIBE") void this.bootstrap(req.symbol);
  }

  private async bootstrap(symbol: string): Promise<void> {
    const gen = this.generation.get(symbol);
    let snap: L3Snapshot;
    try {
      snap = await this.opts.fetchSnapshot(symbol);
    } catch (err) {
      if (this.generation.get(symbol) === gen) {
        this.rebuild(symbol, "snapshot_failed", err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (this.generation.get(symbol) !== gen) return;
    this.opts.onSnapshot?.(snap, this.now());
    const book = this.books.get(symbol);
    if (!book) return;
    const st = book.applySnapshot(snap);
    if (!st.ok) this.rebuild(symbol, st.reason, st.detail);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
