import type { RateClass } from "./routes.js";

/**
 * Ballast's own order budget, far inside Strike's advertised 1,200 orders/min (enforcement
 * unverified). Plan section 5: ≤ 300 orders/min globally with 20% held back for cancels, one
 * replace-batch per account per 2 s, and creates paused 30 s after three 429s within 60 s.
 *
 * The budget is a token bucket whose tokens return exactly one window after they are spent
 * (a sliding-window bucket). A classic refill-rate bucket admits up to capacity + rate × window
 * in any window, i.e. 600/min here; this form guarantees ≤ 300 in every 60 s window.
 *
 * Accounting per request (D8 is unverified, see VERIFY below):
 * - orders/batch: one token per item.
 * - replace-batch: one token per operation, cancels + creates, the same unit Strike uses for its
 *   1,000-operation cap. A replace-batch with any create is a create; one with only cancel legs
 *   is a cancel.
 * - cancel and cancel-all: one token each (Strike counts cancel-all as one operation).
 * - reduce-only IOC buy-back: one token; it may use the cancel reserve and is not paused.
 * - leverage, margin mode and GETs: no order tokens.
 */
// VERIFY: D8 — how Strike counts replace-batch operations toward its orders/min limit (per
// operation, per request, or by weight) is undocumented; counting every operation is the
// conservative choice until measured on mainnet (FRICTION 2026-10-23).

export interface RateLimiterOptions {
  now?: () => number;
  ordersPerWindow?: number;
  /** Tokens creates may never take; cancels and reduce-only exits may. */
  cancelReserve?: number;
  windowMs?: number;
  replaceBatchSpacingMs?: number;
  pauseAfter429s?: number;
  pause429WindowMs?: number;
  pauseMs?: number;
}

export interface RateRequest {
  account: string;
  rateClass: RateClass;
  ops: number;
  replaceBatch: boolean;
}

export type RateDecision =
  | { ok: true; overBudget: boolean }
  | {
      ok: false;
      reason: "budget" | "replace-batch-spacing" | "paused-after-429";
      retryAfterMs: number;
    };

interface Spend {
  at: number;
  ops: number;
}

export class RateLimiter {
  private readonly spends: Spend[] = [];
  private readonly lastReplaceBatch = new Map<string, number>();
  private readonly recent429s: number[] = [];
  private pausedUntilMs = 0;
  private readonly cfg: Required<Omit<RateLimiterOptions, "now">>;

  constructor(private readonly opts: RateLimiterOptions = {}) {
    this.cfg = {
      ordersPerWindow: opts.ordersPerWindow ?? 300,
      cancelReserve: opts.cancelReserve ?? 60,
      windowMs: opts.windowMs ?? 60_000,
      replaceBatchSpacingMs: opts.replaceBatchSpacingMs ?? 2_000,
      pauseAfter429s: opts.pauseAfter429s ?? 3,
      pause429WindowMs: opts.pause429WindowMs ?? 60_000,
      pauseMs: opts.pauseMs ?? 30_000,
    };
    if (this.cfg.cancelReserve < 0 || this.cfg.cancelReserve >= this.cfg.ordersPerWindow) {
      throw new RangeError("cancelReserve must be within [0, ordersPerWindow)");
    }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private prune(now: number): void {
    while (this.spends.length > 0 && (this.spends[0] as Spend).at <= now - this.cfg.windowMs) {
      this.spends.shift();
    }
  }

  /** Order tokens spent in the current window. */
  used(): number {
    this.prune(this.now());
    let n = 0;
    for (const s of this.spends) n += s.ops;
    return n;
  }

  get pausedUntil(): number {
    return this.pausedUntilMs;
  }

  /** When enough tokens will have returned for `used + ops <= limit`. */
  private waitFor(now: number, limit: number, ops: number): number {
    if (ops > limit) return Number.POSITIVE_INFINITY;
    let used = this.used();
    for (const s of this.spends) {
      used -= s.ops;
      if (used + ops <= limit) return s.at + this.cfg.windowMs - now;
    }
    return 0;
  }

  /** Admit and record a request, or say why not. Nothing is recorded on refusal. */
  acquire(req: RateRequest): RateDecision {
    if (!Number.isInteger(req.ops) || req.ops < 0) throw new RangeError("ops must be >= 0");
    const now = this.now();
    this.prune(now);
    const used = this.used();
    const cap = this.cfg.ordersPerWindow;

    if (req.rateClass === "read" || req.rateClass === "config")
      return { ok: true, overBudget: false };

    if (req.rateClass === "cancel") {
      // Cancels are never refused locally: the kill path must not wait on our own budget.
      if (req.replaceBatch) this.lastReplaceBatch.set(req.account, now);
      this.spends.push({ at: now, ops: req.ops });
      return { ok: true, overBudget: used + req.ops > cap };
    }

    if (req.rateClass === "create" && now < this.pausedUntilMs) {
      return { ok: false, reason: "paused-after-429", retryAfterMs: this.pausedUntilMs - now };
    }
    if (req.replaceBatch) {
      const last = this.lastReplaceBatch.get(req.account);
      if (last !== undefined && now - last < this.cfg.replaceBatchSpacingMs) {
        return {
          ok: false,
          reason: "replace-batch-spacing",
          retryAfterMs: last + this.cfg.replaceBatchSpacingMs - now,
        };
      }
    }
    const limit = req.rateClass === "create" ? cap - this.cfg.cancelReserve : cap;
    if (used + req.ops > limit) {
      return { ok: false, reason: "budget", retryAfterMs: this.waitFor(now, limit, req.ops) };
    }
    if (req.replaceBatch) this.lastReplaceBatch.set(req.account, now);
    this.spends.push({ at: now, ops: req.ops });
    return { ok: true, overBudget: false };
  }

  /** Strike answered 429. Three within the window pause creates (not cancels) for pauseMs. */
  record429(): void {
    const now = this.now();
    this.recent429s.push(now);
    while (
      this.recent429s.length > 0 &&
      (this.recent429s[0] as number) <= now - this.cfg.pause429WindowMs
    ) {
      this.recent429s.shift();
    }
    if (this.recent429s.length >= this.cfg.pauseAfter429s) {
      this.pausedUntilMs = Math.max(this.pausedUntilMs, now + this.cfg.pauseMs);
      this.recent429s.length = 0;
    }
  }
}
