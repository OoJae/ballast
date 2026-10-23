import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import {
  type CreateInput,
  type FakeAccount,
  FakeEngine,
  type FakeOrder,
  type MarketSpec,
  ORDER_TYPES,
} from "./engine.js";
import { FakePublicMarket } from "./public.js";
import { ed25519Verify, fmt, isRecord, parseJson, sha256, toFixed, toJson } from "./util.js";

export const DEFAULT_MARKETS: MarketSpec[] = [
  {
    symbol: "NIGHT-USD",
    tickSize: "0.000001",
    stepSize: "1",
    minSize: "1",
    minNotional: "10",
    maxLeverage: 10,
  },
  {
    symbol: "ADA-USD",
    tickSize: "0.00001",
    stepSize: "1",
    minSize: "1",
    minNotional: "10",
    maxLeverage: 10,
  },
  {
    symbol: "BTC-USD",
    tickSize: "0.1",
    stepSize: "0.00001",
    minSize: "0.00001",
    minNotional: "10",
    maxLeverage: 100,
  },
];

const RESERVED_PREFIXES = [
  "copy:",
  "liq_",
  "bankrupt_",
  "adl_",
  "if_transfer_",
  "if_adl_",
  "vault_wd_",
];
const NONCE_TTL_MS = 180_000;
const FEE_HEADER_ERROR =
  "invalid X-Builder-Fee-Bps header: must be an integer between 0 and 100 (basis points; 100 = 1%)";

export interface FakeStrikeOptions {
  markets?: MarketSpec[];
  /** Base clock (default Date.now); `skewMs` is added to give Strike its own clock. */
  now?: () => number;
  /** The engine runs this long after the API answers: 201 means sequenced, not done. */
  engineDelayMs?: number;
  /** Start ids past 2^53 to prove the client keeps engine ids exact. */
  firstOrderId?: bigint;
  builderCode?: string;
  /** Cadence of `markPriceUpdate` on `/ws/price` (Strike: 1 s). */
  priceIntervalMs?: number;
  /** How often book changes are diffed onto `/ws/l3`. */
  l3IntervalMs?: number;
}

export interface AddAccountOptions {
  publicKeyHex: string;
  accountId?: string;
  /** Master family for self-trade prevention (default: its own). */
  family?: string;
  approvedBuilderFeeBps?: number;
}

export interface RecordedRequest {
  method: string;
  /** The raw request target (path + query) as received. */
  target: string;
  headers: IncomingHttpHeaders;
  body: string;
  status: number;
  response: string;
}

export interface HttpFault {
  method?: string;
  path?: string;
  status: number;
  body?: unknown;
  times: number;
}

interface SocketState {
  accountId?: string;
  subscribed: boolean;
  userAgent?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly payload: Record<string, unknown>,
  ) {
    super(String(payload.error));
  }
}

function bad(error: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(400, { error, ...extra });
}

function binding(field: string, tag: string): HttpError {
  return bad(
    `Key: 'CreateOrderRequest.${field}' Error:Field validation for '${field}' failed on the '${tag}' tag`,
  );
}

/** The fake Strike API host: REST on node:http, the user stream on ws, an ephemeral port. */
export class FakeStrike {
  readonly engine: FakeEngine;
  /** Public market data derived from the engine book (L3, price stream, markets, positions). */
  readonly market: FakePublicMarket;
  /** USD wallet balance per account served by `GET /v2/balances` (default "1000"). */
  readonly balances = new Map<string, string>();
  readonly requests: RecordedRequest[] = [];
  readonly logons: { ok: boolean; accountId?: string; reason?: string; userAgent?: string }[] = [];
  /** Create commands received per client order id, across every route. */
  readonly createCommands = new Map<string, number>();
  skewMs = 0;
  engineDelayMs: number;
  /** Delay applied to every user-stream message (order is preserved). */
  eventDelayMs = 0;
  /** User-stream methods the fake receives but never answers (handshake timeouts). */
  readonly unansweredMethods = new Set<string>();
  baseUrl = "";
  wsUrl = "";
  /** `ws://host:port`, for `/ws/l3` and `/ws/price`. */
  wsOrigin = "";
  private eventFilter: ((accountId: string, msg: Record<string, unknown>) => boolean) | undefined;
  private readonly faults: HttpFault[] = [];
  private readonly nonces = new Map<string, number>();
  private held = false;
  private queue: (() => void)[] = [];
  private drainTimer: NodeJS.Timeout | null = null;
  private readonly sockets = new Map<WebSocket, SocketState>();
  private seq = 70_804_200;
  private http: Server | undefined;
  private wss: WebSocketServer | undefined;
  private wssL3: WebSocketServer | undefined;
  private wssPrice: WebSocketServer | undefined;
  private publicTimers: NodeJS.Timeout[] = [];

  constructor(private readonly opts: FakeStrikeOptions = {}) {
    this.engineDelayMs = opts.engineDelayMs ?? 5;
    this.engine = new FakeEngine(
      () => this.serverNow(),
      (accountId, msg) => this.emit(accountId, msg),
      opts.firstOrderId ?? 33_428_500n,
    );
    for (const m of opts.markets ?? DEFAULT_MARKETS) this.engine.addMarket(m);
    this.market = new FakePublicMarket(this.engine, () => this.serverNow());
  }

  serverNow(): number {
    return (this.opts.now ?? Date.now)() + this.skewMs;
  }

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws, req) => this.onSocket(ws, req));
    this.wssL3 = new WebSocketServer({ noServer: true });
    this.wssL3.on("connection", (ws) => this.market.onL3Socket(ws));
    this.wssPrice = new WebSocketServer({ noServer: true });
    this.wssPrice.on("connection", (ws) => this.market.onPriceSocket(ws));
    this.http = createServer((req, res) => {
      void this.onRequest(req, res);
    });
    this.http.on("upgrade", (req, socket, head) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const wss =
        path === "/ws/user-api"
          ? this.wss
          : path === "/ws/l3"
            ? this.wssL3
            : path === "/ws/price"
              ? this.wssPrice
              : undefined;
      if (!wss) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
    await new Promise<void>((r) => this.http?.listen(0, "127.0.0.1", () => r()));
    const { port } = this.http.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.wsUrl = `ws://127.0.0.1:${port}/ws/user-api`;
    this.wsOrigin = `ws://127.0.0.1:${port}`;
    const l3 = setInterval(() => this.market.publishL3(), this.opts.l3IntervalMs ?? 5);
    const price = setInterval(
      () => this.market.publishPrices(),
      this.opts.priceIntervalMs ?? 1_000,
    );
    l3.unref();
    price.unref();
    this.publicTimers.push(l3, price);
  }

  async stop(): Promise<void> {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    for (const t of this.publicTimers) clearInterval(t);
    this.publicTimers = [];
    for (const ws of this.sockets.keys()) ws.terminate();
    this.sockets.clear();
    for (const w of [this.wssL3, this.wssPrice]) {
      for (const ws of w?.clients ?? []) ws.terminate();
      await new Promise<void>((r) => (w ? w.close(() => r()) : r()));
    }
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    this.http?.closeAllConnections();
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
  }

  addAccount(o: AddAccountOptions): FakeAccount {
    const acct: FakeAccount = {
      id: o.accountId ?? randomUUID(),
      publicKeyHex: o.publicKeyHex,
      family: o.family ?? o.accountId ?? o.publicKeyHex,
      approvedBuilderFeeBps: o.approvedBuilderFeeBps ?? 10,
      leverage: new Map(),
      marginMode: new Map(),
      positions: new Map(),
    };
    this.engine.accounts.set(acct.id, acct);
    this.engine.accountsByKey.set(acct.publicKeyHex, acct);
    return acct;
  }

  // ---- fault injection ----------------------------------------------------------------------

  /** Answer the next `times` matching authenticated requests with `status` (after auth). */
  failNext(f: {
    method?: string;
    path?: string;
    status: number;
    body?: unknown;
    times?: number;
  }): void {
    this.faults.push({ ...f, times: f.times ?? 1 });
  }

  /** Remove every pending HTTP fault and the event filter. */
  clearFaults(): void {
    this.faults.length = 0;
    this.eventFilter = undefined;
  }

  /** Return true to drop a user-stream message. */
  setEventFilter(filter?: (accountId: string, msg: Record<string, unknown>) => boolean): void {
    this.eventFilter = filter;
  }

  /** Stop the engine: commands stay sequenced but unprocessed (GET /v2/order answers 404). */
  holdEngine(): void {
    this.held = true;
  }

  releaseEngine(): void {
    this.held = false;
    this.scheduleDrain();
  }

  /** Resolves once every sequenced command has run, so tests wait on work, not on the clock. */
  async idle(): Promise<void> {
    if (this.held) throw new Error("the engine is held: release it first");
    while (this.queue.length > 0 || this.drainTimer) await new Promise((r) => setTimeout(r, 1));
  }

  /** Close user sockets (all, or one account's), e.g. with 1012 "service restart". */
  dropUserSockets(accountId?: string, code = 1012): void {
    for (const [ws, st] of this.sockets) {
      if (accountId === undefined || st.accountId === accountId) ws.close(code, "fake drop");
    }
  }

  subscribedSockets(accountId: string): number {
    let n = 0;
    for (const st of this.sockets.values()) if (st.accountId === accountId && st.subscribed) n += 1;
    return n;
  }

  // ---- engine queue and events --------------------------------------------------------------

  private enqueue(fn: () => void): void {
    this.queue.push(fn);
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.held || this.drainTimer || this.queue.length === 0) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      while (!this.held && this.queue.length > 0) this.queue.shift()?.();
      this.market.publishL3();
    }, this.engineDelayMs);
  }

  private emit(accountId: string, msg: Record<string, unknown>): void {
    if (this.eventFilter?.(accountId, msg)) return;
    const text = toJson(msg);
    const deliver = () => {
      for (const [ws, st] of this.sockets) {
        if (st.accountId === accountId && st.subscribed && ws.readyState === ws.OPEN) ws.send(text);
      }
    };
    if (this.eventDelayMs > 0) setTimeout(deliver, this.eventDelayMs);
    else deliver();
  }

  private ids(): { sequence_id: number; message_id: string } {
    this.seq += 1;
    return { sequence_id: this.seq, message_id: `${this.serverNow()}-${this.seq % 10}` };
  }

  private countCreate(clientOrderId: string): void {
    this.createCommands.set(clientOrderId, (this.createCommands.get(clientOrderId) ?? 0) + 1);
  }

  // ---- REST ---------------------------------------------------------------------------------

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const method = req.method ?? "GET";
    const target = req.url ?? "/";
    let status = 200;
    let payload: unknown;
    try {
      [status, payload] = this.route(method, target, req.headers, body);
    } catch (err) {
      if (err instanceof HttpError) [status, payload] = [err.status, err.payload];
      else [status, payload] = [500, { error: String(err) }];
    }
    const text = toJson(payload);
    this.requests.push({
      method,
      target,
      headers: req.headers,
      body: body.toString("utf8"),
      status,
      response: text,
    });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(text);
  }

  private authenticate(
    method: string,
    target: string,
    h: IncomingHttpHeaders,
    body: Buffer,
  ): FakeAccount {
    const one = (k: string) => {
      const v = h[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const pub = one("x-api-wallet-public-key");
    const sig = one("x-api-wallet-signature");
    const ts = one("x-api-wallet-timestamp");
    const nonce = one("x-api-wallet-nonce");
    const deny = (error: string) => new HttpError(401, { error });
    if (!pub || !sig || !ts || !nonce) throw deny("missing API wallet authentication headers");
    if (nonce.length < 16 || nonce.length > 128) throw deny("invalid nonce format");
    if (!/^\d+$/.test(ts)) throw deny("invalid timestamp format");
    const now = this.serverNow();
    const nowSec = Math.floor(now / 1000);
    const t = Number(ts);
    if (t > nowSec || nowSec - t > 180) throw deny("signature expired or invalid timestamp");
    const acct = this.engine.accountsByKey.get(pub);
    const message = `${method}:${target}:${ts}:${nonce}:${sha256(body)}`;
    if (!acct || !ed25519Verify(pub, message, sig)) throw deny("authentication failed");
    for (const [k, exp] of this.nonces) if (exp <= now) this.nonces.delete(k);
    const nk = `${pub}:${nonce}`;
    // The nonce is consumed once the signature verifies, whatever happens next.
    if (this.nonces.has(nk)) throw deny("request already processed");
    this.nonces.set(nk, now + NONCE_TTL_MS);
    return acct;
  }

  private route(
    method: string,
    target: string,
    h: IncomingHttpHeaders,
    body: Buffer,
  ): [number, unknown] {
    const url = new URL(target, "http://x");
    const path = url.pathname;
    if (method === "GET" && path === "/v2/time") return [200, { serverTime: this.serverNow() }];
    if (method === "GET" && path === "/v2/ping") return [200, {}];
    const pub = this.market.route(method, url);
    if (pub) return pub;

    const acct = this.authenticate(method, target, h, body);
    const fault = this.faults.find(
      (f) => f.times > 0 && (!f.method || f.method === method) && (!f.path || f.path === path),
    );
    if (fault) {
      fault.times -= 1;
      const defaults: Record<number, string> = {
        429: "rate limit exceeded",
        503: "service unavailable",
      };
      return [fault.status, fault.body ?? { error: defaults[fault.status] ?? "injected fault" }];
    }

    const json = (): unknown => {
      if (body.length === 0) throw bad("EOF");
      try {
        return parseJson(body.toString("utf8"));
      } catch {
        throw bad("invalid character in request body");
      }
    };
    const key = `${method} ${path}`;
    switch (key) {
      case "POST /v2/order":
        return this.postOrder(acct, json(), h);
      case "POST /v2/orders/batch":
        return this.postBatch(acct, json(), h);
      case "POST /v2/order/replace-batch":
        return this.postReplaceBatch(acct, json(), h);
      case "DELETE /v2/order/cancel":
        return this.deleteCancel(acct, json());
      case "DELETE /v2/order/cancel-all":
        return this.deleteCancelAll(acct, json());
      case "POST /v2/leverage":
        return this.postLeverage(acct, json());
      case "POST /v2/marginMode":
        return this.postMarginMode(acct, json());
      case "GET /v2/order":
        return this.getOrder(acct, url.searchParams);
      case "GET /v2/openOrders": {
        const orders = this.engine.workingOrders(
          acct.id,
          url.searchParams.get("symbol") ?? undefined,
        );
        return [200, { orders: orders.map((o) => this.view(o)), count: orders.length }];
      }
      case "GET /v2/positions":
        return this.getPositions(acct, url.searchParams.get("symbol") ?? undefined);
      case "GET /v2/symbols":
        return [200, this.symbolSettings(acct)];
      case "GET /v2/balances":
        return [200, this.balanceRows(acct)];
      default:
        return [404, { error: "404 page not found" }];
    }
  }

  private feeBps(acct: FakeAccount, h: IncomingHttpHeaders): number | undefined {
    const raw = h["x-builder-fee-bps"];
    if (raw === undefined) return undefined;
    const text = Array.isArray(raw) ? raw[0] : raw;
    if (!text || !/^\d+$/.test(text) || Number(text) > 100) throw bad(FEE_HEADER_ERROR);
    const bps = Number(text);
    if (bps > acct.approvedBuilderFeeBps) {
      throw bad(
        `X-Builder-Fee-Bps ${bps} exceeds your approved max of ${acct.approvedBuilderFeeBps}`,
      );
    }
    return bps;
  }

  private reservedPrefix(id: unknown): void {
    if (typeof id !== "string") return;
    const p = RESERVED_PREFIXES.find((x) => id.startsWith(x));
    if (p) throw bad(`client_order_id must not start with reserved prefix "${p}"`);
  }

  /** Single creates bind strictly: required fields and case-sensitive enums. */
  private bindCreate(body: unknown): CreateInput {
    if (!isRecord(body)) throw bad("invalid request body");
    for (const [field, key] of [
      ["Symbol", "symbol"],
      ["Side", "side"],
      ["Type", "type"],
    ] as const) {
      if (body[key] === undefined || body[key] === "") throw binding(field, "required");
    }
    if (body.side !== "buy" && body.side !== "sell") throw binding("Side", "oneof");
    if (!(ORDER_TYPES as readonly unknown[]).includes(body.type)) throw binding("Type", "oneof");
    const tif = body.time_in_force;
    if (tif !== undefined && tif !== "GTC" && tif !== "IOC" && tif !== "FOK") {
      throw binding("TimeInForce", "oneof");
    }
    this.reservedPrefix(body.client_order_id);
    return this.asCreate(body);
  }

  private asCreate(o: Record<string, unknown>, symbol?: string): CreateInput {
    return {
      ...(o as Partial<CreateInput>),
      client_order_id: typeof o.client_order_id === "string" ? o.client_order_id : randomUUID(),
      symbol: typeof o.symbol === "string" ? o.symbol : (symbol ?? ""),
    };
  }

  private accepted(acct: FakeAccount, c: CreateInput): Record<string, unknown> {
    return {
      client_order_id: c.client_order_id,
      account_id: acct.id,
      symbol: c.symbol,
      status: "pending",
    };
  }

  private postOrder(acct: FakeAccount, body: unknown, h: IncomingHttpHeaders): [number, unknown] {
    const input = this.bindCreate(body);
    const fee = this.feeBps(acct, h);
    this.countCreate(input.client_order_id);
    this.enqueue(() => this.engine.create(acct, input, fee));
    return [201, { ...this.accepted(acct, input), ...this.ids() }];
  }

  private postBatch(acct: FakeAccount, body: unknown, h: IncomingHttpHeaders): [number, unknown] {
    if (!isRecord(body) || !Array.isArray(body.orders) || body.orders.length === 0) {
      throw bad(
        "Key: 'CreateBatchOrdersRequest.Orders' Error:Field validation for 'Orders' failed on the 'min' tag",
      );
    }
    for (const o of body.orders) if (isRecord(o)) this.reservedPrefix(o.client_order_id);
    const fee = this.feeBps(acct, h);
    const successful: unknown[] = [];
    const failed: unknown[] = [];
    for (const [index, raw] of body.orders.entries()) {
      if (!isRecord(raw) || typeof raw.symbol !== "string" || raw.symbol === "") {
        failed.push({ index, error: "invalid_symbol" });
        continue;
      }
      // Items are not field-validated at bind time: bad side/type is a silent engine drop.
      const input = this.asCreate(raw);
      this.countCreate(input.client_order_id);
      this.enqueue(() => this.engine.create(acct, input, fee));
      successful.push({ ...this.accepted(acct, input), ...this.ids() });
    }
    return [
      200,
      { successful: successful.length ? successful : null, failed: failed.length ? failed : null },
    ];
  }

  private postReplaceBatch(
    acct: FakeAccount,
    body: unknown,
    h: IncomingHttpHeaders,
  ): [number, unknown] {
    if (!isRecord(body) || !Array.isArray(body.replacements) || body.replacements.length === 0) {
      throw bad(
        "Key: 'ReplaceBatchOrdersRequest.Replacements' Error:Field validation for 'Replacements' failed on the 'min' tag",
      );
    }
    const fee = this.feeBps(acct, h);
    const items: { cancel?: { order_id: bigint; symbol: string }; new_order?: CreateInput }[] = [];
    let symbol: string | undefined;
    let ops = 0;
    const ids = new Set<string>();
    for (const [i, raw] of body.replacements.entries()) {
      if (!isRecord(raw) || (raw.cancel === undefined && raw.new_order === undefined)) {
        throw bad(`replacement at index ${i} must include cancel or new_order`, {
          failed_index: i,
        });
      }
      const item: (typeof items)[number] = {};
      for (const leg of ["cancel", "new_order"] as const) {
        const v = raw[leg];
        if (v === undefined) continue;
        if (!isRecord(v)) throw bad("invalid_symbol", { failed_index: i });
        const s = v.symbol;
        if (typeof s !== "string" || s === "") throw bad("invalid_symbol", { failed_index: i });
        if (symbol !== undefined && s !== symbol) {
          throw bad("mismatched_order_symbol", { failed_index: i });
        }
        symbol = s;
        ops += 1;
        if (leg === "cancel") {
          const id = v.order_id;
          if (typeof id !== "number" && typeof id !== "bigint") {
            throw bad("order_id_not_set", { failed_index: i });
          }
          item.cancel = { order_id: BigInt(id), symbol: s };
        } else {
          this.reservedPrefix(v.client_order_id);
          const c = this.asCreate(v);
          if (ids.has(c.client_order_id)) throw bad("duplicate_request_id");
          ids.add(c.client_order_id);
          item.new_order = c;
        }
      }
      items.push(item);
    }
    if (ops > 1000) throw bad("batch_replace_orders: total operations exceed 1000");
    for (const it of items) if (it.new_order) this.countCreate(it.new_order.client_order_id);
    this.enqueue(() => this.engine.replaceBatch(acct, items, fee));
    return [
      200,
      {
        ...this.ids(),
        results: items.map((it) => ({
          ...(it.cancel ? { cancel: it.cancel } : {}),
          ...(it.new_order ? { new_order: this.accepted(acct, it.new_order) } : {}),
        })),
      },
    ];
  }

  private deleteCancel(acct: FakeAccount, body: unknown): [number, unknown] {
    if (!isRecord(body) || typeof body.symbol !== "string") throw bad("invalid request body");
    const symbol = body.symbol;
    if (typeof body.client_order_id === "string" && body.client_order_id) {
      const o = this.engine
        .workingOrders(acct.id, symbol)
        .find((x) => x.clientOrderId === body.client_order_id);
      if (!o) throw new HttpError(404, { error: "order not found" });
      this.enqueue(() => this.engine.cancel(acct, o.id));
      return [200, { order_id: o.id, client_order_id: o.clientOrderId, symbol, ...this.ids() }];
    }
    const id = body.order_id;
    if (typeof id !== "number" && typeof id !== "bigint") {
      throw bad("either order_id or client_order_id parameter is required");
    }
    this.enqueue(() => this.engine.cancel(acct, BigInt(id)));
    return [200, { order_id: BigInt(id), symbol, ...this.ids() }];
  }

  private deleteCancelAll(acct: FakeAccount, body: unknown): [number, unknown] {
    if (!isRecord(body)) throw bad("invalid request body");
    const symbol = typeof body.symbol === "string" && body.symbol ? body.symbol : undefined;
    this.enqueue(() => this.engine.cancelAll(acct, symbol));
    return [
      200,
      { account_id: acct.id, ...(symbol ? { symbol } : {}), canceled_count: -1, ...this.ids() },
    ];
  }

  private postLeverage(acct: FakeAccount, body: unknown): [number, unknown] {
    if (!isRecord(body) || typeof body.symbol !== "string") throw bad("invalid symbol");
    const m = this.engine.markets.get(body.symbol);
    if (!m) throw bad("invalid symbol");
    const lev = body.leverage;
    if (typeof lev !== "number" || !Number.isInteger(lev) || lev < 1 || lev > 125) {
      throw bad(
        "Key: 'LeverageRequest.Leverage' Error:Field validation for 'Leverage' failed on the 'max' tag",
      );
    }
    if (lev > m.maxLeverage) {
      throw bad("leverage exceeds maximum allowed", {
        max_leverage: m.maxLeverage,
        requested: lev,
      });
    }
    const requestId = randomUUID();
    const symbol = body.symbol;
    this.enqueue(() => {
      acct.leverage.set(symbol, lev);
      this.engine.emitLeverage(acct, symbol, lev, requestId);
    });
    return [200, { leverage: lev, maxNotionalValue: "1000000", symbol, request_id: requestId }];
  }

  private postMarginMode(acct: FakeAccount, body: unknown): [number, unknown] {
    if (
      !isRecord(body) ||
      typeof body.symbol !== "string" ||
      !this.engine.markets.has(body.symbol)
    ) {
      throw bad("invalid symbol");
    }
    const mode = body.marginMode;
    if (mode !== "cross" && mode !== "isolated") {
      throw bad(
        "Key: 'MarginModeRequest.MarginMode' Error:Field validation for 'MarginMode' failed on the 'oneof' tag",
      );
    }
    const symbol = body.symbol;
    if ((acct.positions.get(symbol)?.size ?? 0n) !== 0n) {
      throw bad("cannot change margin mode while position is open");
    }
    this.enqueue(() => this.engine.setMarginMode(acct, symbol, mode));
    return [200, { marginMode: mode, symbol }];
  }

  private getOrder(acct: FakeAccount, q: URLSearchParams): [number, unknown] {
    const symbol = q.get("symbol");
    if (!symbol) throw bad("symbol parameter is required");
    const cid = q.get("client_order_id");
    const oid = q.get("order_id");
    if (!cid && !oid) throw bad("either order_id or client_order_id parameter is required");
    let o: FakeOrder | undefined;
    if (cid) o = this.engine.findByClientId(acct.id, cid);
    else {
      if (!/^\d+$/.test(oid ?? "")) throw bad("invalid order_id format");
      o = this.engine.orders.get(BigInt(oid as string));
      if (o && o.accountId !== acct.id) o = undefined;
    }
    if (!o || o.symbol !== symbol) throw new HttpError(404, { error: "order not found" });
    return [200, this.view(o)];
  }

  private getPositions(acct: FakeAccount, symbol?: string): [number, unknown] {
    const positions = [...acct.positions.entries()]
      .filter(([s, p]) => p.size !== 0n && (symbol === undefined || s === symbol))
      .map(([s, p]) => ({
        id: p.id,
        account_id: acct.id,
        margin_mode: acct.marginMode.get(s) ?? "cross",
        leverage: acct.leverage.get(s) ?? 10,
        size: fmt(p.size),
        entry_price: fmt(p.entry),
        iso_balance: "0",
        accumulated_funding_fees: "0",
        create_timestamp: p.openedAt,
        update_timestamp: p.updatedAt,
        symbol: s,
        upnl: "0",
        maintenance_margin: "0",
        bankruptcy_price: "0",
        liquidation_price: "0",
      }));
    return [200, { positions, count: positions.length }];
  }

  /** `/v2/balances`: one USDT row; maintenance margin is 1.5% of position notional at entry. */
  private balanceRows(acct: FakeAccount): Record<string, unknown>[] {
    const wallet = toFixed(this.balances.get(acct.id) ?? "1000") ?? 0n;
    let mm = 0n;
    for (const p of acct.positions.values()) {
      const abs = p.size < 0n ? -p.size : p.size;
      mm += (abs * p.entry * 15n) / (1000n * 10n ** 18n);
    }
    const w = fmt(wallet);
    return [
      {
        asset: "USDT",
        walletBalance: w,
        unrealizedPnl: "0",
        marginBalance: w,
        maintMargin: fmt(mm),
        initialMargin: "0",
        positionInitialMargin: "0",
        openOrderInitialMargin: "0",
        crossWalletBalance: w,
        crossUnPnl: "0",
        availableBalance: w,
        maxWithdrawAmount: w,
        marginAvailable: true,
        updateTime: this.serverNow(),
      },
    ];
  }

  private symbolSettings(acct: FakeAccount): Record<string, unknown> {
    const settings: Record<string, unknown> = {};
    for (const s of this.engine.markets.keys()) {
      settings[s] = {
        margin_mode: acct.marginMode.get(s) ?? "cross",
        leverage: acct.leverage.get(s) ?? 10,
      };
    }
    return { default_margin_mode: "cross", default_leverage: 10, symbol_settings: settings };
  }

  /** The PascalCase engine model GET /v2/order and /v2/openOrders serve. */
  view(o: FakeOrder): Record<string, unknown> {
    const builder =
      o.builderFeeBps !== undefined && (o.status === "open" || o.status === "pending");
    return {
      ID: o.id,
      ClientOrderID: o.clientOrderId,
      AccountID: o.accountId,
      Symbol: o.symbol,
      CloseReason: o.closeReason,
      Side: o.side,
      Status: o.status,
      Type: o.type,
      OriginType: "",
      AutoCloseType: "",
      TimeInForce: o.tif,
      WorkingType: "none",
      Size: fmt(o.size),
      Filled: fmt(o.filled),
      Price: fmt(o.price),
      StopPrice: "0",
      BoundPrice: "0",
      PostOnly: o.postOnly,
      ReduceOnly: o.reduceOnly,
      ClosePosition: false,
      PriceProtect: false,
      CreateTimestamp: o.createdAt,
      EntryTimestamp: o.createdAt,
      EventTimestamp: o.updatedAt,
      ...(builder
        ? { Builder: { Code: this.opts.builderCode ?? "ballast", FeeBps: o.builderFeeBps } }
        : {}),
    };
  }

  // ---- user stream --------------------------------------------------------------------------

  private onSocket(ws: WebSocket, req: IncomingMessage): void {
    const ua = req.headers["user-agent"];
    const st: SocketState = { subscribed: false, ...(ua ? { userAgent: ua } : {}) };
    this.sockets.set(ws, st);
    ws.on("close", () => this.sockets.delete(ws));
    ws.on("message", (raw) => this.onSocketMessage(ws, st, String(raw)));
  }

  private wsError(ws: WebSocket, code: number, msg: string): void {
    ws.send(JSON.stringify({ e: "error", E: this.serverNow(), error: { code, msg } }));
  }

  private onSocketMessage(ws: WebSocket, st: SocketState, text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      msg = undefined;
    }
    if (!isRecord(msg)) {
      this.wsError(ws, 400, "Invalid JSON format");
      return;
    }
    if (typeof msg.method === "string" && this.unansweredMethods.has(msg.method)) return;
    if (msg.method === "ping") ws.send(JSON.stringify({ method: "pong", id: msg.id }));
    else if (msg.method === "session.logon") this.logon(ws, st, msg);
    else if (msg.method === "subscribe") this.subscribe(ws, st, msg);
    else this.wsError(ws, 400, `Unknown method: ${String(msg.method)}`);
  }

  private subscribe(ws: WebSocket, st: SocketState, msg: Record<string, unknown>): void {
    if (!st.accountId) {
      this.wsError(
        ws,
        401,
        "Authentication required: use AUTH or session.logon before subscribing to user data streams",
      );
    } else if (msg.channel === undefined) {
      this.wsError(ws, 400, "Missing channel in subscribe request");
    } else if (msg.account_id !== undefined && msg.account_id !== st.accountId) {
      this.wsError(ws, 403, "Unauthorized: cannot subscribe to another account's data");
    } else {
      if (msg.channel === "userstream") st.subscribed = true;
      ws.send(JSON.stringify({ result: null, id: msg.id }));
    }
  }

  /** Why a logon fails, or undefined when it verifies (every failure is the same 401). */
  private logonFailure(p: Record<string, unknown>): string | undefined {
    const { apiKey, signature, timestamp } = p;
    if (typeof apiKey !== "string" || typeof signature !== "string") return "missing params";
    if (typeof timestamp !== "number" || !Number.isInteger(timestamp)) return "timestamp type";
    const now = this.serverNow();
    if (timestamp > now + 30_000 || timestamp < now - 180_000) return "timestamp window";
    const ok =
      this.engine.accountsByKey.has(apiKey) &&
      ed25519Verify(apiKey, `session.logon:${timestamp}:${apiKey}`, signature);
    return ok ? undefined : "signature";
  }

  private logon(ws: WebSocket, st: SocketState, msg: Record<string, unknown>): void {
    const p = isRecord(msg.params) ? msg.params : {};
    const ua = st.userAgent ? { userAgent: st.userAgent } : {};
    if (p.apiKey === undefined || p.signature === undefined || p.timestamp === undefined) {
      this.logons.push({ ok: false, reason: "missing params", ...ua });
      this.wsError(ws, 400, "Missing required parameters (apiKey, signature, timestamp)");
      return;
    }
    const reason = this.logonFailure(p);
    const acct = this.engine.accountsByKey.get(String(p.apiKey));
    if (reason || !acct) {
      this.logons.push({ ok: false, reason: reason ?? "signature", ...ua });
      this.wsError(ws, 401, "Authentication failed");
      return;
    }
    if (st.accountId && st.accountId !== acct.id) {
      this.wsError(ws, 403, "Connection is already authenticated as a different account");
      return;
    }
    st.accountId = acct.id;
    this.logons.push({ ok: true, accountId: acct.id, ...ua });
    ws.send(
      JSON.stringify({
        id: msg.id,
        status: 200,
        result: { authenticated: true, account_id: acct.id },
      }),
    );
  }
}
