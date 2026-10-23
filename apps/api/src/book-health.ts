import { type BookHealthReport, type ReplayStats, replay } from "@ballast/market";
import { hourStartMs } from "./ledger.js";
import type { IndexSnapshot, RecordingIndex } from "./recording-index.js";
import type { BookHealthResponse, DailyBookHealthResponse, HourProvenance } from "./types.js";

export class NotReadyError extends Error {
  constructor() {
    super("no sealed recording hours are indexed yet");
    this.name = "NotReadyError";
  }
}

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

export interface BookHealthServiceOptions {
  root: string;
  symbols: readonly string[];
  ballastIds?: () => ReadonlySet<string>;
  armed?: (symbol: string, tMs: number) => boolean;
  /** Longest custom window a replay will run for (default 7 days). */
  maxWindowMs?: number;
  /** Custom windows kept (default 32). */
  cacheSize?: number;
  /** Status of the last independent re-hash of the recordings (null: not checked yet). */
  verified?: () => boolean | null;
  now?: () => number;
}

interface WindowResult {
  computedAt: number;
  lines: number;
  badLines: number;
  bySymbol: Map<string, { report: BookHealthReport; stats: ReplayStats }>;
}

const SEC = 1_000;

/**
 * Book Health for any window of sealed recordings, computed with @ballast/market's `replay()`
 * exactly as `pnpm book-health` does. The whole sealed window and its days and hours come from
 * the background index; any other window is replayed on demand (one at a time) and cached.
 */
export class BookHealthService {
  private readonly cache = new Map<string, WindowResult>();
  private readonly inflight = new Map<string, Promise<WindowResult>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly index: RecordingIndex,
    private readonly opts: BookHealthServiceOptions,
  ) {}

  private snapshot(): IndexSnapshot {
    const s = this.index.current;
    if (!s) throw new NotReadyError();
    return s;
  }

  private provenance(s: IndexSnapshot, fromMs: number, toMs: number) {
    const hours: HourProvenance[] = s.ledger.roots
      .filter((r) => {
        const h = hourStartMs(r.hour);
        return h + 3_600_000 > fromMs && h < toMs;
      })
      .map((r) => ({ hour: r.hour, root: r.root }));
    return { hours, verified: this.opts.verified?.() ?? null };
  }

  /** Clamps a requested window to the sealed range, on whole seconds. */
  resolveWindow(fromMs?: number, toMs?: number): { fromMs: number; toMs: number } {
    const s = this.snapshot();
    const from = Math.max(s.fromMs, Math.floor((fromMs ?? s.fromMs) / SEC) * SEC);
    const to = Math.min(s.toMs, Math.ceil((toMs ?? s.toMs) / SEC) * SEC);
    if (!(to > from)) {
      throw new BadRequestError("window is empty after clamping to the sealed recordings");
    }
    if (to - from > (this.opts.maxWindowMs ?? 7 * 86_400_000)) {
      throw new BadRequestError("window is longer than the replay limit");
    }
    return { fromMs: from, toMs: to };
  }

  async window(symbol: string, fromMs?: number, toMs?: number): Promise<BookHealthResponse> {
    const s = this.snapshot();
    const w = this.resolveWindow(fromMs, toMs);
    const idx = s.symbols.get(symbol);
    if (!idx) throw new BadRequestError(`unknown symbol ${symbol}`);
    if (w.fromMs === s.fromMs && w.toMs === s.toMs) {
      return {
        symbol,
        ...w,
        sealedThroughMs: s.toMs,
        method: "index",
        computedAt: s.builtAt,
        report: idx.report,
        stats: idx.stats,
        lines: s.lines,
        badLines: s.badLines,
        provenance: this.provenance(s, w.fromMs, w.toMs),
      };
    }
    const res = await this.replayWindow(s.key, w.fromMs, w.toMs, s.toMs);
    const r = res.bySymbol.get(symbol);
    if (!r) throw new BadRequestError(`unknown symbol ${symbol}`);
    return {
      symbol,
      ...w,
      sealedThroughMs: s.toMs,
      method: "replay",
      computedAt: res.computedAt,
      report: r.report,
      stats: r.stats,
      lines: res.lines,
      badLines: res.badLines,
      provenance: this.provenance(s, w.fromMs, w.toMs),
    };
  }

  daily(symbol: string): DailyBookHealthResponse {
    const s = this.snapshot();
    const idx = s.symbols.get(symbol);
    if (!idx) throw new BadRequestError(`unknown symbol ${symbol}`);
    return {
      symbol,
      sealedThroughMs: s.toMs,
      days: idx.days.map((d) => ({
        key: d.key,
        fromMs: d.fromMs,
        toMs: d.toMs,
        report: d.agg.report(),
        hours: idx.hours
          .filter((h) => h.key.startsWith(d.key))
          .map((h) => ({ key: h.key, fromMs: h.fromMs, toMs: h.toMs, report: h.agg.report() })),
      })),
      provenance: this.provenance(s, s.fromMs, s.toMs),
    };
  }

  private replayWindow(
    indexKey: string,
    fromMs: number,
    toMs: number,
    sealedToMs: number,
  ): Promise<WindowResult> {
    // Sealed bytes never change, but a new root can extend what "sealed" means for open ends.
    const key = `${indexKey}|${fromMs}|${toMs}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const run = this.queue.then(() => this.compute(fromMs, toMs, sealedToMs));
    this.queue = run.catch(() => {});
    const p = run
      .then((r) => {
        this.cache.set(key, r);
        while (this.cache.size > (this.opts.cacheSize ?? 32)) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cache.delete(oldest);
        }
        return r;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async compute(fromMs: number, toMs: number, sealedToMs: number): Promise<WindowResult> {
    const res = await replay({
      root: this.opts.root,
      symbols: this.opts.symbols,
      fromMs,
      toMs,
      ballastIds: this.opts.ballastIds?.() ?? new Set<string>(),
      ...(this.opts.armed ? { armed: this.opts.armed } : {}),
      // Late records may be read past `toMs`, but never past the last sealed hour.
      slackMs: Math.max(0, Math.min(10_000, sealedToMs - toMs)),
    });
    return {
      computedAt: (this.opts.now ?? Date.now)(),
      lines: res.read.lines,
      badLines: res.read.badLines,
      bySymbol: new Map(
        [...res.symbols].map(([sym, r]) => [sym, { report: r.health.report(), stats: r.stats }]),
      ),
    };
  }
}
