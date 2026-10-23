import WebSocket from "ws";
import { parseFrame } from "./frames.js";

export type SocketState = "connecting" | "open" | "closed" | "stopped";

export interface SocketInfo {
  attempt: number;
  code?: number;
  reason?: string;
  error?: string;
}

export interface ReconnectingSocketOptions {
  url: string;
  userAgent: string;
  /** Runs on every (re)open: subscribe here, since server-side subscriptions die with the socket. */
  onOpen: (socket: ReconnectingSocket) => void;
  onMessage: (msg: unknown, recvMs: number) => void;
  onBadFrame?: (raw: string, recvMs: number) => void;
  onStateChange?: (state: SocketState, info: SocketInfo) => void;
  now?: () => number;
  maxBackoffMs?: number;
  /**
   * Terminate when nothing (message or ping) arrives for this long. Strike pings every 54 s and
   * drops clients that miss its 60 s pong deadline, so silence past ~75 s means a dead socket.
   */
  idleTimeoutMs?: number;
}

const MAX_CLIENT_MESSAGE_BYTES = 4096;

/**
 * WebSocket client that always reconnects (exponential backoff, capped), resubscribes via
 * onOpen, answers server pings (the `ws` library sends pongs automatically), and kills sockets
 * that go silent.
 */
export class ReconnectingSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastSeenMs = 0;
  private lastError: string | undefined;

  constructor(private readonly opts: ReconnectingSocketOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearIdle();
    const ws = this.ws;
    this.ws = null;
    ws?.removeAllListeners();
    ws?.on("error", () => {});
    ws?.terminate();
    this.opts.onStateChange?.("stopped", { attempt: this.attempt });
  }

  /** Returns false when the socket is not open (the message is dropped, not queued). */
  send(msg: unknown): boolean {
    const text = JSON.stringify(msg);
    if (Buffer.byteLength(text) > MAX_CLIENT_MESSAGE_BYTES) {
      throw new Error("Strike WebSocket client messages are limited to 4 KiB");
    }
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(text);
    return true;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get lastSeen(): number {
    return this.lastSeenMs;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private connect(): void {
    if (this.stopped) return;
    this.lastError = undefined;
    this.opts.onStateChange?.("connecting", { attempt: this.attempt });
    const ws = new WebSocket(this.opts.url, {
      headers: { "User-Agent": this.opts.userAgent },
      handshakeTimeout: 15_000,
      perMessageDeflate: true,
    });
    this.ws = ws;
    let receivedSinceOpen = false;

    ws.on("open", () => {
      this.touch();
      this.startIdleWatch(ws);
      this.opts.onStateChange?.("open", { attempt: this.attempt });
      this.opts.onOpen(this);
    });
    ws.on("message", (data: WebSocket.RawData) => {
      const recvMs = this.now();
      this.touch();
      if (!receivedSinceOpen) {
        receivedSinceOpen = true;
        this.attempt = 0;
      }
      const text = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data).toString("utf8");
      const { messages, errors } = parseFrame(text);
      for (const m of messages) this.opts.onMessage(m, recvMs);
      for (const e of errors) this.opts.onBadFrame?.(e, recvMs);
    });
    ws.on("ping", () => this.touch());
    ws.on("error", (err) => {
      this.lastError = err.message;
    });
    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearIdle();
      this.opts.onStateChange?.("closed", {
        attempt: this.attempt,
        code,
        reason: reason.toString(),
        ...(this.lastError ? { error: this.lastError } : {}),
      });
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(this.opts.maxBackoffMs ?? 30_000, 1_000 * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private touch(): void {
    this.lastSeenMs = this.now();
  }

  private startIdleWatch(ws: WebSocket): void {
    this.clearIdle();
    const idleMs = this.opts.idleTimeoutMs ?? 75_000;
    this.idleTimer = setInterval(
      () => {
        if (this.now() - this.lastSeenMs > idleMs) {
          this.lastError = `idle for more than ${idleMs} ms`;
          ws.terminate();
        }
      },
      Math.min(5_000, idleMs),
    );
  }

  private clearIdle(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }
}
