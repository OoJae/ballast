import type { BookFrame, SeriesResponse, TimeWindow } from "./types.js";

export const SERIES_FIELDS = [
  "bestBid",
  "bestAsk",
  "mid",
  "ref",
  "spreadBps",
  "cfSpreadBps",
  "askDepth05",
  "bidDepth05",
  "askDepth2",
] as const;
export type SeriesField = (typeof SERIES_FIELDS)[number];
export type SeriesPoint = Record<SeriesField, number | null>;

const HOUR_MS = 3_600_000;
const SEC = 1_000;

/**
 * One value per second per field, chunked by UTC hour into Float64Arrays (NaN = no sample, i.e.
 * the book was unsynced). About 260 KB per symbol-hour, so days fit comfortably in memory.
 */
export class SeriesStore {
  private readonly hours = new Map<number, Float64Array[]>();

  add(tMs: number, p: SeriesPoint): void {
    const h = Math.floor(tMs / HOUR_MS) * HOUR_MS;
    let cols = this.hours.get(h);
    if (!cols) {
      cols = SERIES_FIELDS.map(() => new Float64Array(3_600).fill(Number.NaN));
      this.hours.set(h, cols);
    }
    const i = Math.floor((tMs - h) / SEC);
    SERIES_FIELDS.forEach((f, k) => {
      const v = p[f];
      (cols[k] as Float64Array)[i] = v ?? Number.NaN;
    });
  }

  private value(tMs: number, k: number): number | null {
    const h = Math.floor(tMs / HOUR_MS) * HOUR_MS;
    const v = this.hours.get(h)?.[k]?.[Math.floor((tMs - h) / SEC)];
    return v === undefined || Number.isNaN(v) ? null : v;
  }

  /** Point samples every `stepMs` (a multiple of 1 s) over [fromMs, toMs). */
  query(symbol: string, fromMs: number, toMs: number, stepMs: number): SeriesResponse {
    const step = Math.max(SEC, Math.round(stepMs / SEC) * SEC);
    const start = Math.ceil(fromMs / step) * step;
    const out: SeriesResponse = {
      symbol,
      fromMs,
      toMs,
      stepMs: step,
      t: [],
      bestBid: [],
      bestAsk: [],
      mid: [],
      ref: [],
      spreadBps: [],
      cfSpreadBps: [],
      askDepth05: [],
      bidDepth05: [],
      askDepth2: [],
    };
    for (let t = start; t < toMs; t += step) {
      out.t.push(t);
      SERIES_FIELDS.forEach((f, k) => {
        out[f].push(this.value(t, k));
      });
    }
    return out;
  }

  /** First and last sampled second, or null when empty. */
  extent(): TimeWindow | null {
    const keys = [...this.hours.keys()].sort((a, b) => a - b);
    let first: number | null = null;
    let last: number | null = null;
    for (const h of keys) {
      const col = this.hours.get(h)?.[0];
      if (!col) continue;
      for (let i = 0; i < col.length; i++) {
        if (!Number.isNaN(col[i] as number)) {
          const t = h + i * SEC;
          if (first === null) first = t;
          last = t;
        }
      }
    }
    return first === null || last === null ? null : { fromMs: first, toMs: last + SEC };
  }
}

/** Frames sorted by time; lookups return the latest frame at or before a time. */
export class FrameList {
  readonly frames: BookFrame[] = [];

  constructor(readonly stepMs: number) {}

  push(f: BookFrame): void {
    const last = this.frames.at(-1);
    if (last && f.tMs <= last.tMs) return;
    this.frames.push(f);
  }

  /** Latest frame with tMs ≤ t, but no older than `maxAgeMs` (a gap means "no book"). */
  at(t: number, maxAgeMs = this.stepMs): BookFrame | null {
    let lo = 0;
    let hi = this.frames.length - 1;
    let best = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if ((this.frames[m] as BookFrame).tMs <= t) {
        best = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    const f = this.frames[best];
    return f && t - f.tMs < maxAgeMs ? f : null;
  }

  /** Contiguous stretches with a frame every `stepMs`. */
  windows(): TimeWindow[] {
    const out: TimeWindow[] = [];
    for (const f of this.frames) {
      const w = out.at(-1);
      if (w && f.tMs === w.toMs) w.toMs = f.tMs + this.stepMs;
      else out.push({ fromMs: f.tMs, toMs: f.tMs + this.stepMs });
    }
    return out;
  }

  get extent(): TimeWindow | null {
    const a = this.frames[0];
    const b = this.frames.at(-1);
    return a && b ? { fromMs: a.tMs, toMs: b.tMs + this.stepMs } : null;
  }
}
