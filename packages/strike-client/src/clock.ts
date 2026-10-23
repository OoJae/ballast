import type { PublicHttp } from "./http.js";

/** One `GET /v2/time` round trip, in local milliseconds around the server's reading. */
export interface TimeSample {
  sentMs: number;
  serverMs: number;
  receivedMs: number;
}

/**
 * Offset (server − local) per sample, assuming the server read its clock halfway through the
 * round trip, then the median across samples so one slow or asymmetric trip cannot skew it.
 */
export function medianOffsetMs(samples: readonly TimeSample[]): number {
  if (samples.length === 0) throw new Error("medianOffsetMs: no samples");
  const offsets = samples
    .map((s) => s.serverMs - (s.sentMs + s.receivedMs) / 2)
    .sort((a, b) => a - b);
  const mid = offsets.length >> 1;
  const median =
    offsets.length % 2 === 1
      ? (offsets[mid] as number)
      : ((offsets[mid - 1] as number) + (offsets[mid] as number)) / 2;
  // Rounding down biases signing time early, which the server accepts; late is rejected.
  return Math.floor(median);
}

/**
 * Worst-case error of an offset estimate. Each sample brackets the true offset: the server read
 * its clock somewhere between send and receive, so offset ∈ [server − received, server − sent].
 * serverTime is whole milliseconds, hence the extra 1 ms.
 */
export function offsetUncertaintyMs(samples: readonly TimeSample[], offsetMs: number): number {
  if (samples.length === 0) throw new Error("offsetUncertaintyMs: no samples");
  let lo = Number.NEGATIVE_INFINITY;
  let hi = Number.POSITIVE_INFINITY;
  for (const s of samples) {
    lo = Math.max(lo, s.serverMs - s.receivedMs);
    hi = Math.min(hi, s.serverMs - s.sentMs);
  }
  return Math.max(Math.abs(offsetMs - lo), Math.abs(hi - offsetMs)) + 1;
}

export interface ServerClockOptions {
  /**
   * Must read `GET /v2/time` on the API host. Never `/price/v2/exchangeInfo.serverTime`: it is a
   * cache-fill time and was measured 78–195 minutes stale (FRICTION 2026-10-23).
   */
  fetchServerTimeMs: () => Promise<number>;
  now?: () => number;
  /** Round trips per sync. */
  samples?: number;
  /** Strike's skills recommend periodic resync; the plan uses 5 minutes. */
  resyncIntervalMs?: number;
  onSync?: (info: { offsetMs: number; uncertaintyMs: number; samples: TimeSample[] }) => void;
  /** A periodic resync failed (the previous offset stays in use). */
  onError?: (err: unknown) => void;
}

export class ClockNotSyncedError extends Error {
  constructor() {
    super("ServerClock has not synced with GET /v2/time yet");
    this.name = "ClockNotSyncedError";
  }
}

/**
 * Local estimate of Strike's clock. REST signatures use whole seconds and are rejected when even
 * 1 s in the future, so signing time is floor(server-now in seconds) − 1.
 */
export class ServerClock {
  private offset: number | undefined;
  private uncertainty = Number.POSITIVE_INFINITY;
  private lastSyncMs: number | undefined;
  private inFlight: Promise<number> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: ServerClockOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  get synced(): boolean {
    return this.offset !== undefined;
  }

  get offsetMs(): number {
    if (this.offset === undefined) throw new ClockNotSyncedError();
    return this.offset;
  }

  get lastSyncedAtMs(): number | undefined {
    return this.lastSyncMs;
  }

  /** Worst-case error of the current offset at the last sync (Infinity before one). */
  get uncertaintyMs(): number {
    return this.uncertainty;
  }

  /** Local milliseconds since the last successful sync (Infinity before one). */
  ageMs(): number {
    return this.lastSyncMs === undefined ? Number.POSITIVE_INFINITY : this.now() - this.lastSyncMs;
  }

  /** Concurrent callers share one sync. */
  sync(): Promise<number> {
    if (!this.inFlight) {
      this.inFlight = this.runSync().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async runSync(): Promise<number> {
    const n = Math.max(1, this.opts.samples ?? 5);
    const samples: TimeSample[] = [];
    for (let i = 0; i < n; i++) {
      const sentMs = this.now();
      const serverMs = await this.opts.fetchServerTimeMs();
      const receivedMs = this.now();
      if (!Number.isFinite(serverMs) || serverMs <= 0) {
        throw new Error(`GET /v2/time returned an invalid serverTime: ${serverMs}`);
      }
      samples.push({ sentMs, serverMs, receivedMs });
    }
    const offsetMs = medianOffsetMs(samples);
    const uncertaintyMs = offsetUncertaintyMs(samples, offsetMs);
    this.offset = offsetMs;
    this.uncertainty = uncertaintyMs;
    this.lastSyncMs = this.now();
    this.opts.onSync?.({ offsetMs, uncertaintyMs, samples });
    return offsetMs;
  }

  serverNowMs(): number {
    return Math.floor(this.now() + this.offsetMs);
  }

  /** X-API-Wallet-Timestamp: whole seconds, one second behind the server. */
  signingTimestampSec(): number {
    return Math.floor(this.serverNowMs() / 1000) - 1;
  }

  /** session.logon timestamp: milliseconds (window: ≤ 30 s ahead, ≤ 3 min old), 1 s behind. */
  logonTimestampMs(): number {
    return this.serverNowMs() - 1000;
  }

  /** Call on a 401 "signature expired or invalid timestamp". */
  onSignatureExpired(): Promise<number> {
    return this.sync();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sync().catch((err) => this.opts.onError?.(err));
    }, this.opts.resyncIntervalMs ?? 300_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** The clock source: `GET /v2/time` on the API host, `serverTime` in milliseconds. */
export function apiTimeSource(http: PublicHttp): () => Promise<number> {
  return async () => (await http.getJson<{ serverTime: number }>("/v2/time")).serverTime;
}
