import { createHash } from "node:crypto";
import type { WebSocket } from "ws";
import type { FakeEngine, FakeOrder, Side } from "./engine.js";
import { fmt, isRecord, toJson } from "./util.js";

/**
 * Strike's public market surfaces, derived from the fake engine's book so the daemons can be run
 * end to end without touching Strike: `/v2/l3/snapshot` + `/ws/l3` (strike-orderbook's bootstrap:
 * SUBSCRIBE → ack → snapshot → updates with sequence + 1), `/ws/price` `markPriceUpdate`
 * (mark `p`, index `i`, funding `r`, next funding `T`, as the recorder captures them),
 * `/v2/markets`, `/stat/v1/stats/live-positions` and the public vault-positions read.
 *
 * L3 updates are computed by diffing the engine book against what was last published, so every
 * route that moves the book (API writes, scripted market orders, takers) shows up on L3 in the
 * same order a subscriber would see: removals and fills first, then opens.
 */
export interface FakePrice {
  mark: string;
  index: string;
  rate?: string;
  nextFundingMs?: number;
}

interface PubOrder {
  side: Side;
  price: bigint;
  remaining: bigint;
}

interface L3State {
  seq: number;
  published: Map<bigint, PubOrder>;
  /** Skip a sequence number on the next update (a gap). */
  gapNext: boolean;
}

export interface L3Event {
  symbol: string;
  action: string;
  l3Id: string;
  atMs: number;
}

export class FakePublicMarket {
  /** `/v2/markets` payload, keyed by symbol (tests pass REFERENCE_MARKETS). */
  marketsPayload: Record<string, unknown> = {};
  /** `/stat/v1/stats/live-positions`; `updated_at` defaults to now on each read. */
  livePositions: { positions: unknown[]; updated_at?: number } = { positions: [] };
  /** Accounts that hold vault shares (Proof of Conduct must see them). */
  readonly vaultShares = new Set<string>();
  readonly prices = new Map<string, FakePrice>();
  /** Symbols whose price stream is silenced (an index stall). */
  readonly pricePaused = new Set<string>();
  /** Every L3 removal published, for cancel → L3-removal latency checks. */
  readonly l3Log: L3Event[] = [];
  private readonly l3 = new Map<string, L3State>();
  private readonly l3Sockets = new Map<WebSocket, Set<string>>();
  private readonly priceSockets = new Map<WebSocket, Set<string>>();

  constructor(
    private readonly engine: FakeEngine,
    private readonly now: () => number,
  ) {}

  /** Opaque, stable L3 id for an engine order (Strike's are 22-char base64url). */
  static l3Id(orderId: bigint): string {
    return createHash("sha256").update(`fake-l3:${orderId}`).digest("base64url").slice(0, 22);
  }

  private state(symbol: string): L3State {
    let s = this.l3.get(symbol);
    if (!s) {
      s = { seq: 10_000_000, published: new Map(), gapNext: false };
      this.l3.set(symbol, s);
    }
    return s;
  }

  private nextSeq(s: L3State): number {
    s.seq += s.gapNext ? 2 : 1;
    s.gapNext = false;
    return s.seq;
  }

  private send(symbol: string, msg: Record<string, unknown>): void {
    const text = toJson(msg);
    for (const [ws, subs] of this.l3Sockets) {
      if (subs.has(symbol) && ws.readyState === ws.OPEN) ws.send(text);
    }
  }

  /** Publish every book change since the last call, per symbol. */
  publishL3(): void {
    for (const symbol of this.engine.markets.keys()) {
      const s = this.state(symbol);
      const book = this.engine.book(symbol);
      const live = new Map<bigint, FakeOrder>();
      for (const o of [...book.bids, ...book.asks]) live.set(o.id, o);
      const t = this.now();
      const updates: Record<string, unknown>[] = [];
      for (const [id, p] of s.published) {
        const o = live.get(id);
        const order = this.engine.orders.get(id);
        if (!o) {
          const filled = order?.status === "filled";
          updates.push(this.update(symbol, filled ? "full_fill" : "cancel", id, p, 0n, t));
          s.published.delete(id);
          this.l3Log.push({
            symbol,
            action: filled ? "full_fill" : "cancel",
            l3Id: FakePublicMarket.l3Id(id),
            atMs: t,
          });
          continue;
        }
        const remaining = o.size - o.filled;
        if (remaining < p.remaining) {
          updates.push(this.update(symbol, "partial_fill", id, p, remaining, t));
          p.remaining = remaining;
        }
      }
      const fresh = [...live.values()]
        .filter((o) => !s.published.has(o.id))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const o of fresh) {
        const p: PubOrder = { side: o.side, price: o.price, remaining: o.size - o.filled };
        s.published.set(o.id, p);
        updates.push(this.update(symbol, "open", o.id, p, p.remaining, t));
      }
      for (const u of updates) {
        u.sequence = this.nextSeq(s);
        this.send(symbol, u);
      }
    }
  }

  private update(
    symbol: string,
    action: string,
    id: bigint,
    p: PubOrder,
    remaining: bigint,
    t: number,
  ): Record<string, unknown> {
    const delta = remaining - p.remaining;
    return {
      type: "l3_update",
      symbol,
      action,
      order_id: FakePublicMarket.l3Id(id),
      ...(action === "partial_fill" || action === "full_fill"
        ? { taker_order_id: "fake-taker" }
        : {}),
      side: p.side,
      price: fmt(p.price),
      delta_size: fmt(delta),
      remaining_size: fmt(remaining),
      sequence: 0,
      timestamp: t,
    };
  }

  /** The published book (consistent with the sequence), best-first. */
  snapshot(symbol: string): Record<string, unknown> {
    this.publishL3();
    const s = this.state(symbol);
    const sideOf = (side: Side) => {
      const levels = new Map<bigint, { order_id: string; size: string; id: bigint }[]>();
      for (const [id, p] of s.published) {
        if (p.side !== side) continue;
        const q = levels.get(p.price) ?? [];
        q.push({ order_id: FakePublicMarket.l3Id(id), size: fmt(p.remaining), id });
        levels.set(p.price, q);
      }
      return [...levels.entries()]
        .sort(([a], [b]) => (side === "buy" ? (a > b ? -1 : 1) : a < b ? -1 : 1))
        .map(([price, orders]) => ({
          price: fmt(price),
          orders: orders
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .map(({ order_id, size }) => ({ order_id, size })),
        }));
    };
    return {
      type: "l3_snapshot",
      symbol,
      last_sequence: s.seq,
      timestamp: this.now(),
      bids: sideOf("buy"),
      asks: sideOf("sell"),
    };
  }

  /** The next update skips a sequence number: subscribers must rebuild. */
  injectL3Gap(symbol: string): void {
    this.state(symbol).gapNext = true;
  }

  /** Publish an L3 `clear`: subscribers must rebuild. */
  injectL3Clear(symbol: string): void {
    const s = this.state(symbol);
    this.send(symbol, {
      type: "l3_update",
      symbol,
      action: "clear",
      sequence: this.nextSeq(s),
      timestamp: this.now(),
    });
  }

  dropL3Sockets(code = 1012): void {
    for (const ws of this.l3Sockets.keys()) ws.close(code, "fake drop");
  }

  setPrice(symbol: string, p: FakePrice): void {
    this.prices.set(symbol, p);
  }

  publishPrices(): void {
    const t = this.now();
    for (const [ws, subs] of this.priceSockets) {
      if (ws.readyState !== ws.OPEN) continue;
      for (const symbol of subs) {
        const p = this.prices.get(symbol);
        if (!p || this.pricePaused.has(symbol)) continue;
        ws.send(
          JSON.stringify({
            e: "markPriceUpdate",
            E: t,
            s: symbol,
            p: p.mark,
            i: p.index,
            r: p.rate ?? "0.0001",
            T: p.nextFundingMs ?? t - (t % 3_600_000) + 3_600_000,
          }),
        );
      }
    }
  }

  dropPriceSockets(code = 1012): void {
    for (const ws of this.priceSockets.keys()) ws.close(code, "fake drop");
  }

  /** Public GETs, or undefined when the path is not one of them. */
  route(method: string, url: URL): [number, unknown] | undefined {
    if (method !== "GET") return undefined;
    const q = url.searchParams;
    switch (url.pathname) {
      case "/v2/markets":
        return [200, { markets: this.marketsPayload }];
      case "/v2/l3/snapshot": {
        const symbol = q.get("symbol") ?? "";
        if (!this.engine.markets.has(symbol)) return [400, { error: "invalid symbol" }];
        return [200, this.snapshot(symbol)];
      }
      case "/stat/v1/stats/live-positions":
        return [
          200,
          {
            positions: this.livePositions.positions,
            updated_at: this.livePositions.updated_at ?? this.now(),
          },
        ];
      case "/price/v2/premiumIndex": {
        const symbol = q.get("symbol") ?? "";
        const p = this.prices.get(symbol);
        if (!p) return [200, {}];
        const t = this.now();
        return [
          200,
          {
            symbol,
            markPrice: p.mark,
            indexPrice: p.index,
            fundingRate: p.rate ?? "0.0001",
            nextFundingTime: p.nextFundingMs ?? t - (t % 3_600_000) + 3_600_000,
            time: t,
          },
        ];
      }
      case "/v2/vault/positions": {
        const account = q.get("account_id") ?? "";
        return [
          200,
          this.vaultShares.has(account)
            ? { positions: [{ vault_id: "fake-vault", shares: "1" }] }
            : { positions: null },
        ];
      }
      default:
        return undefined;
    }
  }

  onL3Socket(ws: WebSocket): void {
    const subs = new Set<string>();
    this.l3Sockets.set(ws, subs);
    ws.on("close", () => this.l3Sockets.delete(ws));
    ws.on("message", (raw) => this.onSubscribe(ws, subs, String(raw), "@l3"));
  }

  onPriceSocket(ws: WebSocket): void {
    const subs = new Set<string>();
    this.priceSockets.set(ws, subs);
    ws.on("close", () => this.priceSockets.delete(ws));
    ws.on("message", (raw) => this.onSubscribe(ws, subs, String(raw), "@markprice"));
  }

  /** `{"method":"SUBSCRIBE","params":["night-usd@l3"],"id":1}` (method is uppercase). */
  private onSubscribe(ws: WebSocket, subs: Set<string>, text: string, stream: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(msg) || !Array.isArray(msg.params)) return;
    const symbols = msg.params
      .filter((p): p is string => typeof p === "string" && p.includes(stream))
      .map((p) => (p.split("@")[0] ?? "").toUpperCase());
    if (msg.method === "SUBSCRIBE") {
      for (const s of symbols) subs.add(s);
      ws.send(JSON.stringify({ result: null, id: msg.id }));
    } else if (msg.method === "UNSUBSCRIBE") {
      for (const s of symbols) subs.delete(s);
      ws.send(JSON.stringify({ result: null, id: msg.id }));
    }
  }
}
