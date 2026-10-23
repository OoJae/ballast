import { ClockNotSyncedError, type ServerClock } from "./clock.js";
import { backoffMs } from "./http.js";
import { parseJsonExact, stringifyJsonExact } from "./json.js";
import type {
  BatchOrdersBody,
  CancelAllBody,
  CancelOrderBody,
  CreateOrderBody,
  LeverageBody,
  MarginModeBody,
  ReplaceBatchBody,
} from "./orders.js";
import type { RateLimiter } from "./rate.js";
import { checkRoute, type RouteCheck, type SignerProfile } from "./routes.js";
import type { ApiWalletSigner } from "./sign.js";
import type {
  BatchOrdersResponse,
  CancelAllResponse,
  CancelOrderResponse,
  CreateOrderResponse,
  LeverageResponse,
  MarginModeResponse,
  OpenOrdersResponse,
  PositionsResponse,
  ReplaceBatchResponse,
  StrikeOrder,
  SymbolSettingsResponse,
} from "./types.js";

/** Strike answered with a non-2xx status. `code` is the `{"error": ...}` text. */
export class StrikeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: string,
    readonly method: string,
    readonly path: string,
    readonly failedIndex?: number,
  ) {
    super(`${method} ${path} -> HTTP ${status}: ${code || body.slice(0, 200)}`);
    this.name = "StrikeApiError";
  }
}

/** Refused locally before signing: no nonce was used and nothing reached Strike. */
export class StrikeRefusedError extends Error {
  constructor(
    readonly kind: "route" | "rate" | "builder-fee" | "clock" | "holder-proof",
    readonly reason: string,
    readonly retryAfterMs?: number,
  ) {
    super(`refused (${kind}): ${reason}`);
    this.name = "StrikeRefusedError";
  }
}

/**
 * The request may or may not have reached Strike (timeout, reset). For a write the outcome is
 * unknown: treat the create as pending and resolve it via the silent-drop lookup, never resend.
 */
export class StrikeTransportError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly write: boolean,
    readonly cause: unknown,
  ) {
    super(`${method} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "StrikeTransportError";
  }
}

export type SignedClientAlarm =
  | { kind: "nonce-replay"; method: string; path: string }
  | { kind: "key-invalid"; method: string; path: string; error: string }
  | { kind: "clock-resync-failed"; error: string };

export interface BuilderFeeConfig {
  /** Holder-approved maximum, already ≤ min(policy, approved); never above Strike's 100. */
  capBps: number;
  /** Sent on entry orders when the caller does not pass one. */
  defaultBps?: number;
}

export interface SignedClientOptions {
  baseUrl: string;
  /** Cloudflare rejects default user agents; this goes on every request. */
  userAgent: string;
  signer: ApiWalletSigner;
  clock: ServerClock;
  profile: SignerProfile;
  rate: RateLimiter;
  /** Rate-limit key; one SignedClient per Strike account. */
  account: string;
  builderFee?: BuilderFeeConfig;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxGetRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  onAlarm?: (alarm: SignedClientAlarm) => void;
  /** How many sent create client ids to remember; a repeat is refused before signing. */
  sentClientIdCapacity?: number;
}

export interface WriteOptions {
  /** Overrides the default builder fee on an order route. */
  builderFeeBps?: number;
  /**
   * Marks entry-side creates as exits too. Reduce-only creates and buys are exits whatever this
   * says; exits carry no builder fee, so the header is omitted (Strike then charges 0).
   */
  exit?: boolean;
}

const RETRYABLE_GET = new Set([408, 425, 429, 500, 502, 503, 504]);
const BUILDER_FEE_HEADER = "X-Builder-Fee-Bps";

export type Query = Record<string, string | number | bigint | undefined>;

function buildPath(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Signed REST client for one account. Every request is checked against the route allowlist
 * and the rate budget, then signed with server time − 1 s and a fresh UUIDv4 nonce.
 * Writes are sent exactly once: Strike consumes the nonce even when the request fails, writes are
 * asynchronous (201 = sequenced), and there is no idempotency, so a retry could double-place.
 */
export class SignedClient {
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Create client ids already handed to fetch, oldest first (bounded). */
  private readonly sentIds = new Set<string>();

  constructor(private readonly opts: SignedClientOptions) {
    this.doFetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const fee = opts.builderFee;
    if (fee) {
      if (!Number.isInteger(fee.capBps) || fee.capBps < 0 || fee.capBps > 100) {
        throw new RangeError("builder fee cap must be an integer 0-100 bps");
      }
      if (fee.defaultBps !== undefined) this.checkFee(fee.defaultBps);
    }
  }

  get account(): string {
    return this.opts.account;
  }

  get profile(): SignerProfile {
    return this.opts.profile;
  }

  private checkFee(bps: number): number {
    const cap = this.opts.builderFee?.capBps;
    if (cap === undefined) {
      throw new StrikeRefusedError("builder-fee", "no builder fee is configured");
    }
    if (!Number.isInteger(bps) || bps < 0 || bps > cap) {
      throw new StrikeRefusedError("builder-fee", `builder fee ${bps} bps is outside 0-${cap}`);
    }
    return bps;
  }

  /**
   * The header applies to every order in the request, so exit status comes from the checked
   * body: a request whose creates are all exits sends none, and one mixing entries and exits
   * may not carry a fee (split it). Plan section 5: entries ≤ the approved cap, exits 0.
   */
  private feeHeader(route: RouteCheck & { ok: true }, wo: WriteOptions): string | undefined {
    const noFee = (why: string): undefined => {
      if (wo.builderFeeBps !== undefined && wo.builderFeeBps !== 0) {
        throw new StrikeRefusedError("builder-fee", why);
      }
      return undefined;
    };
    if (!route.builderFeeRoute) {
      if (wo.builderFeeBps !== undefined) {
        throw new StrikeRefusedError("builder-fee", `${route.route} is not an order route`);
      }
      return undefined;
    }
    const creates = route.cost.creates;
    if (creates === 0) return noFee("a request without creates carries no builder fee");
    if (wo.exit || route.exitCreates === creates) return noFee("exits carry no builder fee");
    const bps = wo.builderFeeBps ?? this.opts.builderFee?.defaultBps;
    if (route.exitCreates > 0 && bps !== undefined && bps !== 0) {
      throw new StrikeRefusedError(
        "builder-fee",
        "the fee header would apply to the request's exits too: send entries and exits apart",
      );
    }
    return bps === undefined || bps === 0 ? undefined : String(this.checkFee(bps));
  }

  /** Strike does not check client id uniqueness on creates, so a repeat would double-place. */
  private checkUnsent(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.sentIds.has(id)) {
        throw new StrikeRefusedError("route", `client_order_id ${id} was already sent`);
      }
    }
  }

  private markSent(ids: readonly string[]): void {
    const cap = this.opts.sentClientIdCapacity ?? 500_000;
    for (const id of ids) this.sentIds.add(id);
    for (const id of this.sentIds) {
      if (this.sentIds.size <= cap) break;
      this.sentIds.delete(id);
    }
  }

  private resyncClock(): Promise<void> {
    return this.opts.clock.sync().then(
      () => undefined,
      (err: unknown) =>
        this.opts.onAlarm?.({
          kind: "clock-resync-failed",
          error: err instanceof Error ? err.message : String(err),
        }),
    );
  }

  private timestamp(): number {
    try {
      return this.opts.clock.signingTimestampSec();
    } catch (err) {
      if (err instanceof ClockNotSyncedError) throw new StrikeRefusedError("clock", err.message);
      throw err;
    }
  }

  /** The URL fetch will request, refusing any path that URL parsing would rewrite. */
  private wire(pathWithQuery: string): URL {
    const url = new URL(pathWithQuery, this.opts.baseUrl);
    // The signature covers url.pathname + url.search, so they must equal what was checked.
    if (url.pathname + url.search !== pathWithQuery) {
      throw new StrikeRefusedError("route", `path changes on the wire: ${pathWithQuery}`);
    }
    return url;
  }

  private send(
    method: string,
    url: URL,
    body: Buffer | undefined,
    timestampSec: number,
    extra: Record<string, string>,
  ): Promise<Response> {
    const { headers } = this.opts.signer.signRest({
      method,
      pathWithQuery: url.pathname + url.search,
      body,
      timestampSec,
    });
    return this.doFetch(url, {
      method,
      headers: {
        ...headers,
        ...extra,
        "User-Agent": this.opts.userAgent,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
    });
  }

  private async fail(res: Response, method: string, path: string): Promise<never> {
    const text = await res.text();
    let code = "";
    let failedIndex: number | undefined;
    try {
      const j = JSON.parse(text) as { error?: unknown; failed_index?: unknown };
      if (typeof j.error === "string") code = j.error;
      if (typeof j.failed_index === "number") failedIndex = j.failed_index;
    } catch {}
    if (res.status === 429) this.opts.rate.record429();
    if (res.status === 401) {
      if (code === "signature expired or invalid timestamp") {
        void this.resyncClock();
      } else if (code === "request already processed" || code === "nonce already used") {
        // Every request carries a fresh UUIDv4, so a replay means a bug, not bad luck.
        this.opts.onAlarm?.({ kind: "nonce-replay", method, path });
      } else if (code === "authentication failed" || code === "wallet expired or revoked") {
        this.opts.onAlarm?.({ kind: "key-invalid", method, path, error: code });
      }
    }
    throw new StrikeApiError(res.status, code, text, method, path, failedIndex);
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    return (text ? parseJsonExact(text) : undefined) as T;
  }

  /** Signed GET of the account's own data. Each attempt is re-signed with a fresh nonce. */
  async get<T>(path: string, query?: Query): Promise<T> {
    const pathWithQuery = buildPath(path, query);
    const url = this.wire(pathWithQuery);
    const route = checkRoute(this.opts.profile, "GET", pathWithQuery, undefined);
    if (!route.ok) throw new StrikeRefusedError("route", route.reason);
    const maxRetries = this.opts.maxGetRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.send("GET", url, undefined, this.timestamp(), {});
      } catch (err) {
        if (err instanceof StrikeRefusedError) throw err;
        if (attempt >= maxRetries) throw new StrikeTransportError("GET", pathWithQuery, false, err);
        await this.sleep(backoffMs(attempt));
        continue;
      }
      if (res.ok) return this.parse<T>(res);
      try {
        await this.fail(res, "GET", pathWithQuery);
      } catch (err) {
        const expired =
          err instanceof StrikeApiError &&
          err.status === 401 &&
          err.code === "signature expired or invalid timestamp";
        const retryable =
          err instanceof StrikeApiError && (RETRYABLE_GET.has(err.status) || expired);
        if (!retryable || attempt >= maxRetries) throw err;
        if (expired) await this.resyncClock();
        await this.sleep(backoffMs(attempt));
      }
    }
  }

  /**
   * One signed write, sent once. The body is serialized exactly once; the route check runs on
   * the parsed form of those bytes, the signature hashes them, and fetch sends them.
   */
  async write<T>(
    method: "POST" | "DELETE",
    path: string,
    body: unknown,
    wo: WriteOptions = {},
  ): Promise<T> {
    const text = stringifyJsonExact(body);
    const bytes = Buffer.from(text, "utf8");
    const url = this.wire(path);
    const route = checkRoute(this.opts.profile, method, path, parseJsonExact(text));
    if (!route.ok) throw new StrikeRefusedError("route", route.reason);
    this.checkUnsent(route.clientOrderIds);
    const fee = this.feeHeader(route, wo);
    const timestampSec = this.timestamp();
    // The budget is spent last, so a request refused for any other reason costs nothing.
    const rate = this.opts.rate.acquire({
      account: this.opts.account,
      rateClass: route.cost.rateClass,
      ops: route.cost.ops,
      replaceBatch: route.cost.replaceBatch,
    });
    if (!rate.ok) throw new StrikeRefusedError("rate", rate.reason, rate.retryAfterMs);
    // From here the request may reach Strike, so its creates count as sent whatever happens.
    this.markSent(route.clientOrderIds);
    let res: Response;
    try {
      res = await this.send(
        method,
        url,
        bytes,
        timestampSec,
        fee === undefined ? {} : { [BUILDER_FEE_HEADER]: fee },
      );
    } catch (err) {
      throw new StrikeTransportError(method, path, true, err);
    }
    if (!res.ok) await this.fail(res, method, path);
    return this.parse<T>(res);
  }

  placeBatch(body: BatchOrdersBody, wo?: WriteOptions): Promise<BatchOrdersResponse> {
    return this.write("POST", "/v2/orders/batch", body, wo);
  }

  replaceBatch(body: ReplaceBatchBody, wo?: WriteOptions): Promise<ReplaceBatchResponse> {
    return this.write("POST", "/v2/order/replace-batch", body, wo);
  }

  /** Reduce-only IOC buy-back; always an exit, so never a builder fee. */
  placeBuyBack(body: CreateOrderBody): Promise<CreateOrderResponse> {
    return this.write("POST", "/v2/order", body);
  }

  cancelOrder(body: CancelOrderBody): Promise<CancelOrderResponse> {
    return this.write("DELETE", "/v2/order/cancel", body);
  }

  cancelAll(body: CancelAllBody): Promise<CancelAllResponse> {
    return this.write("DELETE", "/v2/order/cancel-all", body);
  }

  setLeverage(body: LeverageBody): Promise<LeverageResponse> {
    return this.write("POST", "/v2/leverage", body);
  }

  /** Refused silently while the symbol has active orders: confirm with symbols(). */
  setMarginMode(body: MarginModeBody): Promise<MarginModeResponse> {
    return this.write("POST", "/v2/marginMode", body);
  }

  getOrder(
    symbol: string,
    ref: { clientOrderId: string } | { orderId: bigint },
  ): Promise<StrikeOrder> {
    return this.get(
      "/v2/order",
      "clientOrderId" in ref
        ? { symbol, client_order_id: ref.clientOrderId }
        : { symbol, order_id: ref.orderId },
    );
  }

  async openOrders(symbol?: string): Promise<OpenOrdersResponse> {
    const r = await this.get<Partial<OpenOrdersResponse> | null>("/v2/openOrders", { symbol });
    const orders = r?.orders ?? [];
    return { orders, count: r?.count ?? orders.length };
  }

  async positions(symbol?: string): Promise<PositionsResponse> {
    const r = await this.get<Partial<PositionsResponse> | null>("/v2/positions", { symbol });
    const positions = r?.positions ?? [];
    return { positions, count: r?.count ?? positions.length };
  }

  symbols(): Promise<SymbolSettingsResponse> {
    return this.get("/v2/symbols");
  }
}
