import { ClockNotSyncedError, type ServerClock } from "./clock.js";
import { StrikeApiError, StrikeRefusedError, StrikeTransportError } from "./errors.js";
import { backoffMs } from "./http.js";
import { parseJsonExact, stringifyJsonExact } from "./json.js";
import type { RateLimiter } from "./rate.js";
import { checkRoute, type RouteCheck, type SignerProfile } from "./routes.js";
import type { ApiWalletSigner } from "./sign.js";

/**
 * The signing transport shared by the AUTONOMOUS client (signed-client.ts) and the watchdog's
 * cancel-only client (cancel-only.ts). It holds no order builders and no create methods: what a
 * subclass can send is whatever its profile's route allowlist admits, checked on the exact bytes.
 */
export type SignedClientAlarm =
  | { kind: "nonce-replay"; method: string; path: string }
  | { kind: "key-invalid"; method: string; path: string; error: string }
  | { kind: "clock-resync-failed"; error: string };

export interface TransportOptions {
  baseUrl: string;
  /** Cloudflare rejects default user agents; this goes on every request. */
  userAgent: string;
  signer: ApiWalletSigner;
  clock: ServerClock;
  profile: SignerProfile;
  rate: RateLimiter;
  /** Rate-limit key; one client per Strike account. */
  account: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxGetRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  onAlarm?: (alarm: SignedClientAlarm) => void;
}

const RETRYABLE_GET = new Set([408, 425, 429, 500, 502, 503, 504]);

export type Query = Record<string, string | number | bigint | undefined>;

export function buildPath(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** What a subclass adds to a checked write before it is signed (headers, sent-id bookkeeping). */
export interface WritePlan {
  headers: Record<string, string>;
  /** Called once the request may reach Strike (after the rate budget is spent). */
  onCommitted?: () => void;
}

/**
 * Every request is checked against the route allowlist and the rate budget, then signed with
 * server time − 1 s and a fresh UUIDv4 nonce. Writes are sent exactly once: Strike consumes the
 * nonce even when the request fails, writes are asynchronous (201 = sequenced), and there is no
 * idempotency, so a retry could double-place.
 */
export class SignedTransport {
  protected readonly doFetch: typeof fetch;
  protected readonly sleep: (ms: number) => Promise<void>;

  constructor(protected readonly topts: TransportOptions) {
    this.doFetch = topts.fetch ?? fetch;
    this.sleep = topts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get account(): string {
    return this.topts.account;
  }

  get profile(): SignerProfile {
    return this.topts.profile;
  }

  protected resyncClock(): Promise<void> {
    return this.topts.clock.sync().then(
      () => undefined,
      (err: unknown) =>
        this.topts.onAlarm?.({
          kind: "clock-resync-failed",
          error: err instanceof Error ? err.message : String(err),
        }),
    );
  }

  protected timestamp(): number {
    try {
      return this.topts.clock.signingTimestampSec();
    } catch (err) {
      if (err instanceof ClockNotSyncedError) throw new StrikeRefusedError("clock", err.message);
      throw err;
    }
  }

  /** The URL fetch will request, refusing any path that URL parsing would rewrite. */
  protected wire(pathWithQuery: string): URL {
    const url = new URL(pathWithQuery, this.topts.baseUrl);
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
    const { headers } = this.topts.signer.signRest({
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
        "User-Agent": this.topts.userAgent,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(this.topts.timeoutMs ?? 15_000),
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
    if (res.status === 429) this.topts.rate.record429();
    if (res.status === 401) {
      if (code === "signature expired or invalid timestamp") {
        void this.resyncClock();
      } else if (code === "request already processed" || code === "nonce already used") {
        // Every request carries a fresh UUIDv4, so a replay means a bug, not bad luck.
        this.topts.onAlarm?.({ kind: "nonce-replay", method, path });
      } else if (code === "authentication failed" || code === "wallet expired or revoked") {
        this.topts.onAlarm?.({ kind: "key-invalid", method, path, error: code });
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
    const route = checkRoute(this.topts.profile, "GET", pathWithQuery, undefined);
    if (!route.ok) throw new StrikeRefusedError("route", route.reason);
    const maxRetries = this.topts.maxGetRetries ?? 3;
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
   * the parsed form of those bytes, the signature hashes them, and fetch sends them. `prepare`
   * sees the passing route check and may refuse (throw) or add headers.
   */
  protected async sendWrite<T>(
    method: "POST" | "DELETE",
    path: string,
    body: unknown,
    prepare: (route: RouteCheck & { ok: true }) => WritePlan = () => ({ headers: {} }),
  ): Promise<T> {
    const text = stringifyJsonExact(body);
    const bytes = Buffer.from(text, "utf8");
    const url = this.wire(path);
    const route = checkRoute(this.topts.profile, method, path, parseJsonExact(text));
    if (!route.ok) throw new StrikeRefusedError("route", route.reason);
    const plan = prepare(route);
    const timestampSec = this.timestamp();
    // The budget is spent last, so a request refused for any other reason costs nothing.
    const rate = this.topts.rate.acquire({
      account: this.topts.account,
      rateClass: route.cost.rateClass,
      ops: route.cost.ops,
      replaceBatch: route.cost.replaceBatch,
    });
    if (!rate.ok) throw new StrikeRefusedError("rate", rate.reason, rate.retryAfterMs);
    // From here the request may reach Strike.
    plan.onCommitted?.();
    let res: Response;
    try {
      res = await this.send(method, url, bytes, timestampSec, plan.headers);
    } catch (err) {
      throw new StrikeTransportError(method, path, true, err);
    }
    if (!res.ok) await this.fail(res, method, path);
    return this.parse<T>(res);
  }
}
