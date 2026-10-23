import type { GridSpec } from "@ballast/market";
import type { L3Book } from "@ballast/strike-client";
import { frameFromBook } from "./frames.js";
import type { RecordingIndex } from "./recording-index.js";
import type { FrameList } from "./stores.js";
import type { BookFrame } from "./types.js";

export type FrameListener = (frame: BookFrame) => void;

/** Where `/api/book` and `/api/stream` get the current book from. */
export interface BookSource {
  readonly kind: "replay" | "live";
  current(symbol: string): BookFrame | null;
  subscribe(symbol: string, fn: FrameListener): () => void;
  start(): void;
  stop(): void;
}

interface Timers {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
}

const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

abstract class TickingSource {
  protected readonly frames = new Map<string, BookFrame>();
  private readonly listeners = new Map<string, Set<FrameListener>>();
  private handle: unknown = null;

  constructor(
    protected readonly symbols: readonly string[],
    private readonly tickMs: number,
    private readonly timers: Timers,
  ) {}

  protected abstract next(symbol: string): BookFrame | null;

  current(symbol: string): BookFrame | null {
    return this.frames.get(symbol) ?? this.next(symbol);
  }

  subscribe(symbol: string, fn: FrameListener): () => void {
    let set = this.listeners.get(symbol);
    if (!set) {
      set = new Set();
      this.listeners.set(symbol, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  /** One step: every symbol whose frame changed is published. Public for tests. */
  tick(): void {
    for (const symbol of this.symbols) {
      const f = this.next(symbol);
      if (!f) continue;
      const prev = this.frames.get(symbol);
      if (prev && prev.tMs === f.tMs && prev.sequence === f.sequence) continue;
      this.frames.set(symbol, f);
      for (const fn of this.listeners.get(symbol) ?? []) {
        try {
          fn(f);
        } catch {
          // A broken subscriber must not stop the others.
        }
      }
    }
  }

  start(): void {
    if (this.handle !== null) return;
    this.tick();
    this.handle = this.timers.setInterval(() => this.tick(), this.tickMs);
  }

  stop(): void {
    if (this.handle !== null) this.timers.clearInterval(this.handle);
    this.handle = null;
  }
}

/**
 * The default source: the latest sealed hour, played back at recorded speed in a loop. Wall
 * time maps onto recorded time as `start + (now mod length)`, so every API instance and every
 * restart shows the same recorded instant. Nothing is fetched from Strike.
 */
export class ReplayBookSource extends TickingSource implements BookSource {
  readonly kind = "replay" as const;

  constructor(
    private readonly index: RecordingIndex,
    symbols: readonly string[],
    private readonly opts: { now?: () => number; tickMs?: number; timers?: Timers } = {},
  ) {
    super(symbols, opts.tickMs ?? 1_000, opts.timers ?? realTimers);
  }

  /** The recorded time playing now, or null before the index exists. */
  playhead(symbol: string): { tMs: number; list: FrameList } | null {
    const idx = this.index.current?.symbols.get(symbol);
    if (!idx) return null;
    const list = idx.fine.frames.length > 0 ? idx.fine : idx.archive;
    const ext = list.extent;
    if (!ext) return null;
    const len = ext.toMs - ext.fromMs;
    const now = (this.opts.now ?? Date.now)();
    return { tMs: ext.fromMs + (((now % len) + len) % len), list };
  }

  protected next(symbol: string): BookFrame | null {
    const p = this.playhead(symbol);
    if (!p) return null;
    // Across a recorded gap, keep showing the last frame before it.
    return p.list.at(p.tMs, Number.POSITIVE_INFINITY);
  }
}

/** The subset of L3Feed the live source reads: gap-checked books it keeps up to date. */
export interface FeedLike {
  readonly books: ReadonlyMap<string, Pick<L3Book, "bids" | "asks" | "lastSequence" | "synced">>;
  start(): void;
  stop(): void;
}

/**
 * The live source, enabled only by `BOOK_SOURCE=live`: an L3Feed's books, measured every tick.
 * It reads public L3 only; a book that is not synced (gap, rebuild, dead socket) publishes
 * nothing rather than a stale or partial book.
 */
export class LiveBookSource extends TickingSource implements BookSource {
  readonly kind = "live" as const;

  constructor(
    private readonly feed: FeedLike,
    symbols: readonly string[],
    private readonly opts: {
      spec: (symbol: string) => GridSpec | null;
      ballastIds?: () => ReadonlySet<string>;
      now?: () => number;
      tickMs?: number;
      timers?: Timers;
    },
  ) {
    super(symbols, opts.tickMs ?? 1_000, opts.timers ?? realTimers);
  }

  protected next(symbol: string): BookFrame | null {
    const book = this.feed.books.get(symbol);
    const spec = this.opts.spec(symbol);
    if (!book?.synced || !spec) return null;
    const ids = this.opts.ballastIds?.() ?? new Set<string>();
    const now = (this.opts.now ?? Date.now)();
    return frameFromBook(symbol, book, spec, ids, now, { kind: "live" });
  }

  override current(symbol: string): BookFrame | null {
    const book = this.feed.books.get(symbol);
    // Never serve the last frame of a book that has since lost sync.
    if (!book?.synced) return null;
    return super.current(symbol);
  }

  override start(): void {
    this.feed.start();
    super.start();
  }

  override stop(): void {
    super.stop();
    this.feed.stop();
  }
}
