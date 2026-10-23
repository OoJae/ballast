import type { ServerClock } from "./clock.js";
import { parseJsonExact, toOrderId } from "./json.js";
import type { ApiWalletSigner } from "./sign.js";
import { ReconnectingSocket, type SocketInfo } from "./ws.js";

/**
 * Typed `/ws/user-api` events, field names as strike-userstream documents them. The stream uses
 * Binance-style uppercase enums (BUY, LIMIT, STOP_MARKET), unlike REST.
 */

export type StreamOrderStatus =
  | "NEW"
  | "OPEN"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED"
  | "PARTIALLY_FILLED";

export const TERMINAL_STREAM_STATUSES: ReadonlySet<string> = new Set([
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
]);

export interface PositionContext {
  known: boolean;
  /** Signed position size before this fill. */
  size: string;
  entry_price: string;
  margin_mode: string;
  leverage: number;
  funding: string;
  open_timestamp: number;
}

/** `ORDER_TRADE_UPDATE.data`. Fill updates have t > 0; order updates have t = 0. */
export interface OrderTradeUpdate {
  s: string;
  /** Client order id ("" on a fill whose order snapshot was unavailable). */
  c: string;
  S: "BUY" | "SELL";
  o: string;
  ot: string;
  f: string;
  q: string;
  p: string;
  sp: string;
  x: string;
  X: StreamOrderStatus;
  /** Engine order id, exact. */
  i: bigint;
  /** Close reason, e.g. order_would_match_immediately, order_expired_in_match. */
  cr: string;
  z: string;
  l: string;
  L: string;
  n: string;
  N: string;
  /** Trade id, exact; 0n on order updates. */
  t: bigint;
  /** Fill was maker. */
  m: boolean;
  R: boolean;
  cp: boolean;
  rp: string;
  act: string;
  wt: string;
  ps: string;
  ott: number;
  T: number;
  E: number;
  account_id?: string;
  fill_id?: string;
  position_id?: string;
  position_seq?: number;
  position_context?: PositionContext;
  /** Charged separately from `n`. */
  builder_fee?: string;
  order_id?: string;
  trade_id?: string;
  lf?: string;
  closing_margin?: string;
}

export interface StreamBalance {
  a: string;
  wb: string;
  cw: string;
  bc: string;
}

export interface StreamPosition {
  s: string;
  /** Signed size, "0" when closed. */
  pa: string;
  ep: string;
  mt: "cross" | "isolated";
  ib: string;
  ps: "LONG" | "SHORT" | "BOTH";
  i?: number | bigint;
  position_id?: string;
  position_seq?: number;
  leverage?: number;
  funding_total?: string;
  account_id?: string;
}

export const POSITION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "POSITION_OPENED",
  "POSITION_UPDATE",
  "POSITION_CLOSED",
  "PARTIAL_LIQUIDATED",
  "FULLY_LIQUIDATED",
  "ADL",
]);

export const TRANSFER_EVENT_TYPES: ReadonlySet<string> = new Set([
  "DEPOSIT_PENDING",
  "DEPOSIT_FAILED",
  "WITHDRAWAL_SETTLED",
  "WITHDRAWAL_FAILED",
]);

export interface LeverageEventData {
  request_id?: string;
  account_id?: string;
  symbol?: string;
  leverage?: number;
  requested_leverage?: number;
  current_leverage?: number;
  error?: string;
  timestamp?: number;
}

export interface MarginEventData {
  request_id?: string;
  account_id?: string;
  symbol?: string;
  modify_type?: "add" | "remove";
  amount?: string;
  isolated_margin?: string;
  error?: string;
  timestamp?: number;
}

export type UserStreamEvent =
  | { kind: "order"; E: number; data: OrderTradeUpdate }
  | { kind: "fill"; E: number; data: OrderTradeUpdate }
  | { kind: "balance"; E: number; reason: string; variant: string; balances: StreamBalance[] }
  | { kind: "position"; E: number; variant: string; T: number; positions: StreamPosition[] }
  | { kind: "transfer"; E: number; variant: string; data: Record<string, unknown> }
  | { kind: "leverage"; E: number; ok: boolean; data: LeverageEventData }
  | { kind: "margin"; E: number; ok: boolean; data: MarginEventData }
  | { kind: "account-event"; E: number; eventType: string; data: Record<string, unknown> }
  | { kind: "strategy"; E: number; data: Record<string, unknown> }
  | { kind: "rfq"; E: number; data: Record<string, unknown> }
  | { kind: "error"; code: number; msg: string }
  | { kind: "unknown"; raw: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0;
}

function normalizeOrderUpdate(d: Record<string, unknown>): OrderTradeUpdate {
  return {
    ...(d as unknown as OrderTradeUpdate),
    i: toOrderId(d.i) ?? 0n,
    t: toOrderId(d.t) ?? 0n,
  };
}

/** Classify one parsed user-stream message (pure; the socket wrapper only routes). */
export function classifyUserMessage(msg: unknown): UserStreamEvent {
  if (!isRecord(msg)) return { kind: "unknown", raw: msg };
  const E = num(msg.E);
  if (msg.e === "error") {
    const err = isRecord(msg.error) ? msg.error : {};
    return { kind: "error", code: num(err.code), msg: String(err.msg ?? "") };
  }
  const data = isRecord(msg.data) ? msg.data : undefined;
  if (!data) return { kind: "unknown", raw: msg };
  switch (msg.e) {
    case "ORDER_TRADE_UPDATE": {
      const u = normalizeOrderUpdate(data);
      return { kind: u.t > 0n ? "fill" : "order", E, data: u };
    }
    case "ACCOUNT_UPDATE": {
      if (typeof data.event_type === "string") {
        const eventType = data.event_type;
        const eventData = isRecord(data.event_data) ? data.event_data : {};
        if (eventType === "LEVERAGE_UPDATED" || eventType === "LEVERAGE_UPDATE_FAILED") {
          return { kind: "leverage", E, ok: eventType === "LEVERAGE_UPDATED", data: eventData };
        }
        if (eventType === "MARGIN_UPDATED" || eventType === "MARGIN_UPDATE_FAILED") {
          return { kind: "margin", E, ok: eventType === "MARGIN_UPDATED", data: eventData };
        }
        // Internal transfers, staking, vault and credit events: passed through, never parsed.
        return { kind: "account-event", E, eventType, data: eventData };
      }
      const variant = String(data.e ?? "");
      if (POSITION_EVENT_TYPES.has(variant)) {
        return {
          kind: "position",
          E,
          variant,
          T: num(data.T),
          positions: (Array.isArray(data.P) ? data.P : []) as StreamPosition[],
        };
      }
      if (TRANSFER_EVENT_TYPES.has(variant)) return { kind: "transfer", E, variant, data };
      return {
        kind: "balance",
        E,
        variant,
        reason: String(data.r ?? ""),
        balances: (Array.isArray(data.B) ? data.B : []) as StreamBalance[],
      };
    }
    case "strategyUpdate":
      return { kind: "strategy", E, data };
    case "rfqUpdate":
      return { kind: "rfq", E, data };
    default:
      return { kind: "unknown", raw: msg };
  }
}

export type UserStreamAlarm =
  /**
   * Consecutive connections ended before the stream went live: a revoked key, a broken clock or
   * a refused subscribe, not bad luck.
   */
  | {
      kind: "handshake-failing";
      stage: "session.logon" | "subscribe";
      failedConnections: number;
      lastError: string;
    }
  | { kind: "clock-resync-failed"; error: string };

export type UserStreamState =
  | "connecting"
  | "logging-on"
  | "subscribing"
  | "live"
  | "closed"
  | "stopped";

export interface UserStreamOptions {
  /** `wss://<host>/ws/user-api` (API-wallet endpoint; `/ws/user` is the app's JWT endpoint). */
  url: string;
  userAgent: string;
  signer: ApiWalletSigner;
  /** Logon timestamps come from server time, like REST signatures. */
  clock: ServerClock;
  /** When set, a logon that binds to any other account stops the stream. */
  expectedAccountId?: string;
  onEvent: (event: UserStreamEvent, recvMs: number) => void;
  /**
   * Fired after every (re)subscribe. The stream has no replay and no snapshot, so the consumer
   * must reload REST state (openOrders, positions, balances, history/fill?since_trade_id).
   */
  onResyncNeeded: (info: { accountId: string; connection: number }) => void;
  onStateChange?: (state: UserStreamState, info: SocketInfo & { detail?: string }) => void;
  onFatal?: (reason: string) => void;
  /** Escalations for a human: the stream keeps retrying, but the account is dead meanwhile. */
  onAlarm?: (alarm: UserStreamAlarm) => void;
  /** Alarm after this many consecutive connections that never went live (then every as many). */
  alarmAfterFailedConnections?: number;
  now?: () => number;
  maxBackoffMs?: number;
  idleTimeoutMs?: number;
  /** Drop the socket when logon or subscribe is not answered within this long. */
  handshakeTimeoutMs?: number;
  /** Re-logon attempts on one socket after a 401 before dropping it. */
  maxLogonAttempts?: number;
}

// Balance and order-state updates carry no account id, so attribution needs one socket per
// account; two streams for one key in a process would be a wiring bug.
const activeKeys = new Set<string>();

/**
 * One authenticated `/ws/user-api` connection per account: session.logon (ms timestamp signed
 * as `session.logon:{ts}:{apiKey}`), then `subscribe userstream`, then live events.
 */
export class UserStream {
  private readonly socket: ReconnectingSocket;
  private nextId = 1;
  private logonId = 0;
  private subscribeId = 0;
  private logonAttempts = 0;
  private connections = 0;
  /** The current connection opened and has not gone live yet. */
  private awaitingLive = false;
  private failedConnections = 0;
  private lastHandshakeError = "";
  private stateValue: UserStreamState = "stopped";
  private boundAccount: string | undefined;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly opts: UserStreamOptions) {
    this.socket = new ReconnectingSocket({
      url: opts.url,
      userAgent: opts.userAgent,
      parse: parseJsonExact,
      manualBackoffReset: true,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.maxBackoffMs !== undefined ? { maxBackoffMs: opts.maxBackoffMs } : {}),
      ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
      onOpen: () => {
        this.connections += 1;
        this.logonAttempts = 0;
        this.awaitingLive = true;
        this.logon();
      },
      onMessage: (m, t) => this.onMessage(m, t),
      onStateChange: (state, info) => {
        if (state === "open") return;
        this.clearHandshake();
        if (state === "closed") this.onConnectionEnded(info);
        if (state === "connecting") this.setState("connecting", info);
        else this.setState(state === "stopped" ? "stopped" : "closed", info);
      },
    });
  }

  get state(): UserStreamState {
    return this.stateValue;
  }

  /** True only while logged on and subscribed; anything else is a dead stream (cancel). */
  get live(): boolean {
    return this.stateValue === "live";
  }

  get accountId(): string | undefined {
    return this.boundAccount;
  }

  get lastSeen(): number {
    return this.socket.lastSeen;
  }

  start(): void {
    if (this.running) return;
    const key = this.opts.signer.publicKeyHex;
    if (activeKeys.has(key)) throw new Error("a UserStream for this API wallet is already running");
    activeKeys.add(key);
    this.running = true;
    this.socket.start();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    activeKeys.delete(this.opts.signer.publicKeyHex);
    this.clearHandshake();
    this.socket.stop();
  }

  private setState(state: UserStreamState, info: SocketInfo & { detail?: string }): void {
    this.stateValue = state;
    this.opts.onStateChange?.(state, info);
  }

  private onConnectionEnded(info: SocketInfo): void {
    if (!this.awaitingLive) return;
    this.awaitingLive = false;
    this.failedConnections += 1;
    const every = Math.max(1, this.opts.alarmAfterFailedConnections ?? 3);
    if (this.failedConnections % every === 0) {
      this.opts.onAlarm?.({
        kind: "handshake-failing",
        stage: this.stateValue === "subscribing" ? "subscribe" : "session.logon",
        failedConnections: this.failedConnections,
        lastError:
          this.lastHandshakeError || info.error || info.reason || `close ${info.code ?? "?"}`,
      });
    }
    this.lastHandshakeError = "";
  }

  private armHandshake(what: string): void {
    this.clearHandshake();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      this.lastHandshakeError ||= `${what} not answered`;
      this.socket.drop(`${what} not answered`);
    }, this.opts.handshakeTimeoutMs ?? 10_000);
  }

  private clearHandshake(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private logon(): void {
    let params: ReturnType<ApiWalletSigner["signLogon"]>;
    try {
      params = this.opts.signer.signLogon(this.opts.clock.logonTimestampMs());
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.lastHandshakeError = `cannot sign logon: ${why}`;
      this.socket.drop(this.lastHandshakeError);
      return;
    }
    this.logonAttempts += 1;
    this.logonId = this.nextId++;
    this.setState("logging-on", { attempt: this.connections });
    this.armHandshake("session.logon");
    this.socket.send({ id: this.logonId, method: "session.logon", params });
  }

  private onMessage(msg: unknown, recvMs: number): void {
    if (isRecord(msg) && msg.id !== undefined && msg.e === undefined) {
      this.onReply(msg);
      return;
    }
    const event = classifyUserMessage(msg);
    if (event.kind === "error" && this.stateValue === "logging-on" && event.code === 401) {
      // Logon failures are uncorrelated 401s that leave the socket open; often clock skew.
      this.lastHandshakeError = `${event.code} ${event.msg}`;
      if (this.logonAttempts >= (this.opts.maxLogonAttempts ?? 3)) {
        this.clearHandshake();
        this.socket.drop(`session.logon failed: ${event.msg}`);
      } else {
        // The timer stays armed across the resync, so a hung sync still drops the socket.
        this.armHandshake("session.logon retry");
        const connection = this.connections;
        void this.opts.clock
          .sync()
          .catch((err: unknown) =>
            this.opts.onAlarm?.({
              kind: "clock-resync-failed",
              error: err instanceof Error ? err.message : String(err),
            }),
          )
          .then(() => {
            if (this.running && this.connections === connection && this.stateValue === "logging-on")
              this.logon();
          });
      }
    }
    this.opts.onEvent(event, recvMs);
  }

  private onReply(msg: Record<string, unknown>): void {
    if (msg.id === this.logonId && this.stateValue === "logging-on") {
      const result = isRecord(msg.result) ? msg.result : {};
      if (msg.status !== 200 || result.authenticated !== true) return;
      const account = String(result.account_id ?? "");
      if (this.opts.expectedAccountId && account !== this.opts.expectedAccountId) {
        this.opts.onFatal?.(`logon bound to ${account}, expected ${this.opts.expectedAccountId}`);
        this.stop();
        return;
      }
      this.boundAccount = account;
      this.subscribeId = this.nextId++;
      this.setState("subscribing", { attempt: this.connections });
      this.armHandshake("subscribe");
      this.socket.send({ method: "subscribe", channel: "userstream", id: this.subscribeId });
      return;
    }
    if (msg.id === this.subscribeId && this.stateValue === "subscribing" && msg.result === null) {
      this.clearHandshake();
      this.awaitingLive = false;
      this.failedConnections = 0;
      this.socket.markHealthy();
      this.setState("live", { attempt: this.connections });
      this.opts.onResyncNeeded({
        accountId: this.boundAccount ?? "",
        connection: this.connections,
      });
    }
  }
}
