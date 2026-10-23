import { fmt, mulFixed, toFixed } from "./util.js";

/**
 * A small matching engine with the Strike behaviours Ballast depends on (strike-trading,
 * trade-api.yaml): asynchronous processing after the API answers, silent drops, replace-batch
 * abort semantics, post-only rejects without sliding, expire-maker self-trade prevention within
 * a master family, reduce-only clamping and the silent margin-mode refusal.
 */

export interface MarketSpec {
  symbol: string;
  tickSize: string;
  stepSize: string;
  minSize: string;
  minNotional: string;
  maxLeverage: number;
}

export type Side = "buy" | "sell";
export type FakeOrderStatus = "pending" | "open" | "filled" | "canceled" | "rejected" | "expired";

export const ORDER_TYPES = [
  "limit",
  "market",
  "stop",
  "stop_limit",
  "take_profit",
  "take_profit_limit",
  "trailing_stop_market",
] as const;

const STREAM_TYPE: Record<string, string> = {
  limit: "LIMIT",
  market: "MARKET",
  stop: "STOP_MARKET",
  stop_limit: "STOP",
  take_profit: "TAKE_PROFIT_MARKET",
  take_profit_limit: "TAKE_PROFIT",
  trailing_stop_market: "TRAILING_STOP_MARKET",
};

const STREAM_STATUS: Record<FakeOrderStatus, string> = {
  pending: "NEW",
  open: "OPEN",
  filled: "FILLED",
  canceled: "CANCELED",
  rejected: "REJECTED",
  expired: "EXPIRED",
};

/** A create as the API accepted it; fields are unvalidated until the engine runs. */
export interface CreateInput {
  client_order_id: string;
  symbol: string;
  side?: unknown;
  type?: unknown;
  size?: unknown;
  price?: unknown;
  time_in_force?: unknown;
  post_only?: unknown;
  reduce_only?: unknown;
}

export interface FakeAccount {
  id: string;
  publicKeyHex: string;
  /** Master-account family: self-trade prevention expires makers within it. */
  family: string;
  approvedBuilderFeeBps: number;
  leverage: Map<string, number>;
  marginMode: Map<string, "cross" | "isolated">;
  positions: Map<string, FakePosition>;
}

export interface FakePosition {
  id: number;
  size: bigint;
  entry: bigint;
  seq: number;
  openedAt: number;
  /** Last change (fill or direct set): served as update_timestamp. */
  updatedAt: number;
}

export interface FakeOrder {
  id: bigint;
  clientOrderId: string;
  /** Empty for scripted market participants (they get no events). */
  accountId: string;
  family: string;
  symbol: string;
  side: Side;
  type: string;
  price: bigint;
  size: bigint;
  filled: bigint;
  tif: "GTC" | "IOC" | "FOK";
  postOnly: boolean;
  reduceOnly: boolean;
  status: FakeOrderStatus;
  closeReason: string;
  createdAt: number;
  updatedAt: number;
  builderFeeBps?: number;
}

export type Emit = (accountId: string, message: Record<string, unknown>) => void;

export interface CreateResult {
  ok: boolean;
  code?: string;
  /** The create never became an order (silent drop). */
  dropped?: boolean;
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

const MAKER_FAMILY = "__market_maker__";
const TAKER_FAMILY = "__market_taker__";

export class FakeEngine {
  readonly markets = new Map<string, MarketSpec>();
  readonly accounts = new Map<string, FakeAccount>();
  readonly accountsByKey = new Map<string, FakeAccount>();
  /** Every order the engine ever accepted (live and history). */
  readonly orders = new Map<bigint, FakeOrder>();
  private readonly books = new Map<string, { bids: FakeOrder[]; asks: FakeOrder[] }>();
  private nextOrderId: bigint;
  private nextTradeId = 18_000;
  private nextPositionId = 3_000;
  private nextFillId = 36_000;
  /** Engine rejects to inject by client order id (margin, etc.). */
  readonly forcedRejects = new Map<string, string>();

  constructor(
    private readonly now: () => number,
    private readonly emit: Emit,
    firstOrderId: bigint,
  ) {
    this.nextOrderId = firstOrderId;
  }

  addMarket(m: MarketSpec): void {
    this.markets.set(m.symbol, m);
    this.books.set(m.symbol, { bids: [], asks: [] });
  }

  book(symbol: string): { bids: FakeOrder[]; asks: FakeOrder[] } {
    const b = this.books.get(symbol);
    if (!b) throw new Error(`no market ${symbol}`);
    return b;
  }

  workingOrders(accountId: string, symbol?: string): FakeOrder[] {
    return [...this.orders.values()]
      .filter(
        (o) =>
          o.accountId === accountId &&
          (o.status === "open" || o.status === "pending") &&
          (symbol === undefined || o.symbol === symbol),
      )
      .sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  findByClientId(accountId: string, clientOrderId: string): FakeOrder | undefined {
    let found: FakeOrder | undefined;
    for (const o of this.orders.values()) {
      if (o.accountId === accountId && o.clientOrderId === clientOrderId) {
        if (!found || o.id > found.id) found = o;
      }
    }
    return found;
  }

  // ---- events -------------------------------------------------------------------------------

  private orderEvent(o: FakeOrder, x: string, extra: Record<string, unknown> = {}): void {
    if (!o.accountId) return;
    const t = this.now();
    this.emit(o.accountId, {
      e: "ORDER_TRADE_UPDATE",
      E: t,
      data: {
        s: o.symbol,
        c: o.clientOrderId,
        S: o.side.toUpperCase(),
        o: STREAM_TYPE[o.type] ?? o.type.toUpperCase(),
        ot: STREAM_TYPE[o.type] ?? o.type.toUpperCase(),
        f: o.tif,
        q: fmt(o.size),
        p: fmt(o.price),
        ap: "",
        sp: "0",
        x,
        X: STREAM_STATUS[o.status],
        i: o.id,
        cr: o.closeReason,
        l: "",
        z: fmt(o.filled),
        L: "",
        N: "",
        n: "",
        ott: t,
        t: 0,
        b: "",
        a: "",
        m: false,
        R: o.reduceOnly,
        wt: "",
        ps: "",
        cp: false,
        rp: "",
        act: "",
        E: t,
        T: t,
        ...extra,
      },
    });
  }

  private positionEvent(acct: FakeAccount, symbol: string, p: FakePosition, kind: string): void {
    const t = this.now();
    this.emit(acct.id, {
      e: "ACCOUNT_UPDATE",
      E: t,
      data: {
        e: kind,
        B: [{ a: "USDT", wb: "10000", cw: "10000", bc: "0" }],
        P: [
          {
            s: symbol,
            pa: fmt(p.size),
            ep: fmt(p.entry),
            mt: acct.marginMode.get(symbol) ?? "cross",
            ib: "0",
            ps: p.size > 0n ? "LONG" : p.size < 0n ? "SHORT" : "BOTH",
            i: p.id,
            position_id: String(p.id),
            position_seq: p.seq,
            leverage: acct.leverage.get(symbol) ?? 10,
            funding_total: "0",
            account_id: acct.id,
          },
        ],
        r: "",
        E: t,
        T: t,
      },
    });
  }

  emitLeverage(acct: FakeAccount, symbol: string, leverage: number, requestId: string): void {
    this.emit(acct.id, {
      e: "ACCOUNT_UPDATE",
      E: this.now(),
      data: {
        event_type: "LEVERAGE_UPDATED",
        event_data: {
          request_id: requestId,
          account_id: acct.id,
          symbol,
          leverage,
          timestamp: this.now(),
        },
      },
    });
  }

  // ---- creates ------------------------------------------------------------------------------

  /** Checks that apply nothing in a replace-batch when they fail. */
  staticReject(input: CreateInput): string | undefined {
    const m = this.markets.get(input.symbol);
    if (!m) return "invalid_symbol";
    const size = toFixed(input.size);
    if (size === undefined || size <= 0n) return "order_less_than_min_size";
    const step = toFixed(m.stepSize) as bigint;
    const min = toFixed(m.minSize) as bigint;
    if (size < min) return "order_less_than_min_size";
    if ((size - min) % step !== 0n) return "order_size_not_multiple_of_step";
    if (input.type === "limit") {
      const price = toFixed(input.price);
      if (price === undefined || price <= 0n) return "order_price_out_of_limit";
      if (price % (toFixed(m.tickSize) as bigint) !== 0n) return "order_price_not_multiple_of_tick";
      if (
        input.reduce_only !== true &&
        mulFixed(price, size) < (toFixed(m.minNotional) as bigint)
      ) {
        return "order_less_than_min_notional";
      }
    }
    return undefined;
  }

  // VERIFY: the docs say a batch item missing side/type is dropped silently; an item with a
  // present but invalid value ("SELL") is treated the same way here, which is unconfirmed.
  /** Silent-drop conditions: no order, no event, and GET /v2/order answers 404. */
  silentlyDropped(input: CreateInput): boolean {
    if (!this.markets.has(input.symbol)) return true;
    const sideOk = input.side === "buy" || input.side === "sell";
    const typeOk = (ORDER_TYPES as readonly unknown[]).includes(input.type);
    return !sideOk || !typeOk;
  }

  private newOrder(
    acct: FakeAccount | undefined,
    input: CreateInput,
    feeBps?: number,
    family = MAKER_FAMILY,
  ): FakeOrder {
    const t = this.now();
    const tif = input.time_in_force;
    const o: FakeOrder = {
      id: this.nextOrderId++,
      clientOrderId: input.client_order_id,
      accountId: acct?.id ?? "",
      family: acct?.family ?? family,
      symbol: input.symbol,
      side: input.side as Side,
      type: input.type as string,
      price: toFixed(input.price) ?? 0n,
      size: toFixed(input.size) ?? 0n,
      filled: 0n,
      tif: tif === "IOC" || tif === "FOK" ? tif : "GTC",
      postOnly: input.post_only === true,
      reduceOnly: input.reduce_only === true,
      status: "pending",
      closeReason: "",
      createdAt: t,
      updatedAt: t,
      ...(feeBps !== undefined ? { builderFeeBps: feeBps } : {}),
    };
    this.orders.set(o.id, o);
    return o;
  }

  private reject(o: FakeOrder, code: string): CreateResult {
    o.status = "rejected";
    o.closeReason = code;
    o.updatedAt = this.now();
    this.orderEvent(o, "REJECTED");
    return { ok: false, code };
  }

  /** Publish a create as rejected without running it (replace-batch static failure). */
  publishRejected(acct: FakeAccount, input: CreateInput, code: string, feeBps?: number): void {
    this.reject(this.newOrder(acct, input, feeBps), code);
  }

  private crosses(taker: FakeOrder, makerPrice: bigint): boolean {
    if (taker.type === "market") return true;
    return taker.side === "buy" ? makerPrice <= taker.price : makerPrice >= taker.price;
  }

  /** Run one create through the engine. `acct` undefined = scripted market participant. */
  create(
    acct: FakeAccount | undefined,
    input: CreateInput,
    feeBps?: number,
    family?: string,
  ): CreateResult {
    if (this.silentlyDropped(input)) return { ok: false, dropped: true };
    const o = this.newOrder(acct, input, feeBps, family);
    const st = this.staticReject(input);
    if (st) return this.reject(o, st);
    const forced = this.forcedRejects.get(o.clientOrderId);
    if (forced) return this.reject(o, forced);

    if (o.reduceOnly && acct) {
      const pos = acct.positions.get(o.symbol)?.size ?? 0n;
      if (pos === 0n) return this.reject(o, "no_open_position");
      if ((o.side === "buy" && pos > 0n) || (o.side === "sell" && pos < 0n)) {
        return this.reject(o, "order_increase_position");
      }
      const abs = pos < 0n ? -pos : pos;
      if (o.size > abs) o.size = abs;
    }

    const book = this.book(o.symbol);
    const opposite = o.side === "buy" ? book.asks : book.bids;
    const best = opposite[0];
    // VERIFY: the post-only check here counts the caller's own family's orders as crossable.
    if (o.postOnly && best && this.crosses(o, best.price)) {
      // Rejected, never slid to a non-crossing price.
      return this.reject(o, "order_would_match_immediately");
    }
    if (o.tif === "FOK") {
      let available = 0n;
      for (const m of opposite) {
        if (!this.crosses(o, m.price)) break;
        if (m.family !== o.family) available += m.size - m.filled;
      }
      if (available < o.size) {
        o.status = "expired";
        o.updatedAt = this.now();
        this.orderEvent(o, "EXPIRED");
        return { ok: true };
      }
    }

    this.orderEvent(o, "NEW");
    while (o.filled < o.size && opposite.length > 0) {
      const maker = opposite[0] as FakeOrder;
      if (!this.crosses(o, maker.price)) break;
      opposite.shift();
      if (maker.family === o.family) {
        maker.status = "expired";
        maker.closeReason = "order_expired_in_match";
        maker.updatedAt = this.now();
        this.orderEvent(maker, "EXPIRED");
        continue;
      }
      const qty = minBig(o.size - o.filled, maker.size - maker.filled);
      this.trade(maker, o, qty);
      if (maker.filled < maker.size) opposite.unshift(maker);
    }

    if (o.filled === o.size) return { ok: true };
    if (o.type === "market") {
      o.status = "canceled";
    } else if (o.tif === "IOC" || o.tif === "FOK") {
      o.status = "expired";
    } else {
      o.status = "open";
      const same = o.side === "buy" ? book.bids : book.asks;
      same.push(o);
      same.sort((a, b) => {
        if (a.price !== b.price)
          return o.side === "buy" ? (a.price > b.price ? -1 : 1) : a.price < b.price ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      });
      o.updatedAt = this.now();
      this.orderEvent(o, "TRADE");
      return { ok: true };
    }
    o.updatedAt = this.now();
    this.orderEvent(o, o.status === "canceled" ? "CANCELED" : "EXPIRED");
    return { ok: true };
  }

  private trade(maker: FakeOrder, taker: FakeOrder, qty: bigint): void {
    const price = maker.price;
    const tradeId = this.nextTradeId++;
    for (const [o, isMaker] of [
      [maker, true],
      [taker, false],
    ] as const) {
      o.filled += qty;
      o.status = o.filled === o.size ? "filled" : "open";
      o.updatedAt = this.now();
      const acct = this.accounts.get(o.accountId);
      if (!acct) continue;
      const before = this.applyFill(acct, o.symbol, o.side, qty, price);
      const pos = acct.positions.get(o.symbol) as FakePosition;
      const notional = mulFixed(qty, price);
      const fee = isMaker ? 0n : (notional * 5n) / 10_000n;
      const builderFee =
        o.builderFeeBps !== undefined ? (notional * BigInt(o.builderFeeBps)) / 10_000n : 0n;
      const t = this.now();
      this.emit(acct.id, {
        e: "ORDER_TRADE_UPDATE",
        E: t,
        data: {
          s: o.symbol,
          c: o.clientOrderId,
          S: o.side.toUpperCase(),
          o: STREAM_TYPE[o.type],
          ot: STREAM_TYPE[o.type],
          f: o.tif,
          q: fmt(o.size),
          p: fmt(o.price),
          ap: "",
          sp: "0",
          x: "TRADE",
          X: STREAM_STATUS[o.status],
          i: o.id,
          cr: "",
          l: fmt(qty),
          z: fmt(o.filled),
          L: fmt(price),
          N: "USDT",
          n: fmt(fee),
          ott: t,
          t: tradeId,
          b: "",
          a: "",
          m: isMaker,
          R: o.reduceOnly,
          wt: "",
          ps: "BOTH",
          cp: false,
          rp: "0",
          act: "",
          E: t,
          T: t,
          account_id: acct.id,
          fill_id: String(this.nextFillId++),
          position_id: String(pos.id),
          position_seq: pos.seq,
          position_context: {
            known: true,
            size: fmt(before.size),
            entry_price: fmt(before.entry),
            margin_mode: acct.marginMode.get(o.symbol) ?? "cross",
            leverage: acct.leverage.get(o.symbol) ?? 10,
            funding: "0",
            open_timestamp: before.openedAt,
          },
          builder_fee: fmt(builderFee),
          order_id: o.id.toString(),
          trade_id: String(tradeId),
        },
      });
      this.orderEvent(o, "TRADE");
      const kind =
        before.size === 0n
          ? "POSITION_OPENED"
          : pos.size === 0n
            ? "POSITION_CLOSED"
            : "POSITION_UPDATE";
      this.positionEvent(acct, o.symbol, pos, kind);
    }
  }

  private applyFill(
    acct: FakeAccount,
    symbol: string,
    side: Side,
    qty: bigint,
    price: bigint,
  ): FakePosition {
    const existing = acct.positions.get(symbol);
    const before: FakePosition = existing
      ? { ...existing }
      : { id: 0, size: 0n, entry: 0n, seq: 0, openedAt: 0, updatedAt: 0 };
    const signed = side === "buy" ? qty : -qty;
    let pos = existing;
    if (!pos || pos.size === 0n) {
      pos = {
        id: this.nextPositionId++,
        size: 0n,
        entry: price,
        seq: 0,
        openedAt: this.now(),
        updatedAt: this.now(),
      };
      acct.positions.set(symbol, pos);
    }
    const next = pos.size + signed;
    if (pos.size === 0n || pos.size > 0n === signed > 0n) {
      const absOld = pos.size < 0n ? -pos.size : pos.size;
      const absNew = next < 0n ? -next : next;
      pos.entry = absNew === 0n ? 0n : (absOld * pos.entry + qty * price) / absNew;
    } else if (next > 0n !== pos.size > 0n && next !== 0n) {
      pos.entry = price;
    }
    pos.size = next;
    pos.seq += 1;
    pos.updatedAt = this.now();
    return before;
  }

  cancel(acct: FakeAccount, orderId: bigint): void {
    const o = this.orders.get(orderId);
    // Unknown or closed ids are dropped by the engine without an event.
    if (!o || o.accountId !== acct.id || (o.status !== "open" && o.status !== "pending")) return;
    const book = this.book(o.symbol);
    const side = o.side === "buy" ? book.bids : book.asks;
    const i = side.indexOf(o);
    if (i >= 0) side.splice(i, 1);
    o.status = "canceled";
    o.updatedAt = this.now();
    this.orderEvent(o, "CANCELED");
  }

  cancelAll(acct: FakeAccount, symbol?: string): void {
    for (const o of this.workingOrders(acct.id, symbol)) this.cancel(acct, o.id);
  }

  /**
   * replace-batch: a static failure applies nothing; any other reject stops the remaining
   * creates, as documented, EXCEPT a post-only cross. On testnet (D1, 2026-10-23, two runs) a
   * rejected post-only cross mid-batch did not stop the creates after it.
   */
  replaceBatch(
    acct: FakeAccount,
    items: { cancel?: { order_id: bigint }; new_order?: CreateInput }[],
    feeBps?: number,
  ): void {
    const creates = items.flatMap((i) => (i.new_order ? [i.new_order] : []));
    if (creates.some((c) => this.silentlyDropped(c))) return;
    // VERIFY: with several statically invalid creates, only the first is published as rejected.
    for (const c of creates) {
      const code = this.staticReject(c);
      if (code) {
        this.publishRejected(acct, c, code, feeBps);
        return;
      }
    }
    for (const i of items) if (i.cancel) this.cancel(acct, i.cancel.order_id);
    for (const c of creates) {
      const r = this.create(acct, c, feeBps);
      const continues =
        r.code === "conditional_order_triggers_immediately" ||
        r.code === "order_would_match_immediately";
      if (!r.ok && !continues) return;
    }
  }

  setMarginMode(acct: FakeAccount, symbol: string, mode: "cross" | "isolated"): void {
    // The engine refuses while orders are active, and the command has no request_id: no event.
    if (this.workingOrders(acct.id, symbol).length > 0) return;
    acct.marginMode.set(symbol, mode);
  }

  /** Scripted liquidity from outside every account family. */
  restMarketOrder(symbol: string, side: Side, price: string, size: string): FakeOrder {
    const id = `mkt-${this.nextOrderId}`;
    this.create(undefined, {
      client_order_id: id,
      symbol,
      side,
      type: "limit",
      size,
      price,
    });
    const o = [...this.orders.values()].find((x) => x.clientOrderId === id);
    if (!o) throw new Error("scripted order was not created");
    return o;
  }

  /** A scripted outside taker (no events of its own); crosses whatever rests. */
  marketTake(symbol: string, side: Side, size: string, price?: string): void {
    this.create(
      undefined,
      {
        client_order_id: `taker-${this.nextOrderId}`,
        symbol,
        side,
        type: price === undefined ? "market" : "limit",
        size,
        ...(price !== undefined ? { price, time_in_force: "IOC" } : {}),
      },
      undefined,
      TAKER_FAMILY,
    );
  }

  /** Set a position directly (e.g. a short to buy back reduce-only). */
  setPosition(acct: FakeAccount, symbol: string, size: string, entry: string): void {
    const s = toFixed(size) ?? 0n;
    acct.positions.set(symbol, {
      id: this.nextPositionId++,
      size: s,
      entry: toFixed(entry) ?? 0n,
      seq: 1,
      openedAt: this.now(),
      updatedAt: this.now(),
    });
  }
}
