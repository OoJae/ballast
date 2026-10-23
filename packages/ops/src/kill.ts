/**
 * Kill confirmation (invariant 11, plan section 5 kill path). `cancel-all` answers
 * `canceled_count: -1` (asynchronous), so a kill counts as done only when both:
 *  - the account's user stream (or a REST resync) shows no live Ballast order on the symbol, and
 *  - every Ballast order that was attributed on L3 is gone from the L3 book;
 * Step 2: not confirmed within 5 s → a second cancel-all with a new nonce plus per-order
 * cancels from /v2/openOrders, and a page. Not confirmed within 10 s → escalated (page again);
 * the tracker keeps watching until it is confirmed.
 *
 * Generic over where the confirmations come from, so the keeper and the watchdog (each with its
 * own stream and L3 view) share one implementation and one latency measure.
 */
export type KillStatus = "sent" | "confirmed" | "retried" | "escalated";

export interface KillProbe {
  /** No live Ballast order remains per the account's stream/REST view. */
  streamClear(): boolean;
  /** None of the orders attributed on L3 at send time is still in the book (book synced). */
  l3Clear(): boolean;
}

export interface Kill {
  key: string;
  accountId: string;
  symbol: string;
  trigger: string;
  reason: string;
  sentAtMs: number;
  /** Evidence DB row, when one was written. */
  dbId: number | null;
  probe: KillProbe;
  status: KillStatus;
  streamConfirmedMs: number | null;
  l3ConfirmedMs: number | null;
  retries: number;
}

export interface KillLatency {
  accountId: string;
  trigger: string;
  /** cancel sent → stream confirmation. */
  streamMs: number;
  /** cancel sent → L3 removal. */
  l3Ms: number;
}

export interface KillTrackerOptions {
  now?: () => number;
  retryAfterMs?: number;
  escalateAfterMs?: number;
  onConfirmed?: (k: Kill, latency: KillLatency) => void;
  /** Step 2: send a second cancel-all and per-order cancels. Errors are the callback's own. */
  onRetry?: (k: Kill) => void;
  onEscalate?: (k: Kill) => void;
}

export class KillTracker {
  private readonly open = new Map<string, Kill>();
  readonly latencies: KillLatency[] = [];

  constructor(private readonly opts: KillTrackerOptions = {}) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Track a cancel-all that was just sent. A newer kill for the same account replaces it. */
  track(k: Omit<Kill, "key" | "status" | "streamConfirmedMs" | "l3ConfirmedMs" | "retries">): Kill {
    const kill: Kill = {
      ...k,
      key: `${k.accountId}:${k.symbol}`,
      status: "sent",
      streamConfirmedMs: null,
      l3ConfirmedMs: null,
      retries: 0,
    };
    this.open.set(kill.key, kill);
    this.check();
    return kill;
  }

  /** The unconfirmed kill on an account, if any (callers do not stack cancel-alls on it). */
  pending(accountId: string, symbol: string): Kill | undefined {
    return this.open.get(`${accountId}:${symbol}`);
  }

  all(): Kill[] {
    return [...this.open.values()];
  }

  /** Re-evaluate every open kill; call on stream and L3 events and on each tick. */
  check(): void {
    const now = this.now();
    for (const k of [...this.open.values()]) {
      try {
        if (k.streamConfirmedMs === null && k.probe.streamClear()) k.streamConfirmedMs = now;
        if (k.l3ConfirmedMs === null && k.probe.l3Clear()) k.l3ConfirmedMs = now;
      } catch {
        // A probe that throws confirms nothing.
      }
      if (k.streamConfirmedMs !== null && k.l3ConfirmedMs !== null) {
        k.status = "confirmed";
        this.open.delete(k.key);
        const latency: KillLatency = {
          accountId: k.accountId,
          trigger: k.trigger,
          streamMs: k.streamConfirmedMs - k.sentAtMs,
          l3Ms: k.l3ConfirmedMs - k.sentAtMs,
        };
        this.latencies.push(latency);
        if (this.latencies.length > 10_000) this.latencies.shift();
        this.opts.onConfirmed?.(k, latency);
        continue;
      }
      const age = now - k.sentAtMs;
      if (k.status === "sent" && age >= (this.opts.retryAfterMs ?? 5_000)) {
        k.status = "retried";
        k.retries += 1;
        this.opts.onRetry?.(k);
      } else if (k.status === "retried" && age >= (this.opts.escalateAfterMs ?? 10_000)) {
        k.status = "escalated";
        this.opts.onEscalate?.(k);
      }
    }
  }
}

/** p50 / p99 of cancel → L3-removal latency, for the public kill-drill log. */
export function latencyPercentiles(xs: readonly number[]): { n: number; p50: number; p99: number } {
  if (xs.length === 0) return { n: 0, p50: Number.NaN, p99: Number.NaN };
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] as number;
  return { n: s.length, p50: at(0.5), p99: at(0.99) };
}
