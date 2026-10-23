import { hourKey } from "@ballast/evidence";
import {
  BookHealthAggregator,
  type BookHealthReport,
  type HealthSample,
  levelsFromL3,
  type MarketSpec,
  type ReplayStats,
  replay,
  type TakerBuy,
} from "@ballast/market";
import { decToNumber, frameOf, unitsToNumber } from "./frames.js";
import { HOUR_MS, type Ledger, ledgerKey, readLedger, sealedRange } from "./ledger.js";
import { FrameList, SeriesStore } from "./stores.js";

const HEALTH_SAMPLE_MS = 1_000;

export interface RecordingIndexOptions {
  root: string;
  symbols: readonly string[];
  /** Ballast's L3 order ids (from the evidence chain once quoting starts); empty before. */
  ballastIds?: () => ReadonlySet<string>;
  armed?: (symbol: string, tMs: number) => boolean;
  /** Archive frame cadence for the judge's scrubber (default 5 s). */
  archiveFrameMs?: number;
  /** How many sealed hours keep archive frames (default 24); older hours keep series only. */
  archiveHours?: number;
  /** How many of the latest sealed hours keep 1 s frames for playback (default 1). */
  fineHours?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}

export interface PeriodAgg {
  key: string;
  fromMs: number;
  toMs: number;
  agg: BookHealthAggregator;
}

export interface SymbolIndex {
  symbol: string;
  spec: MarketSpec | null;
  report: BookHealthReport;
  stats: ReplayStats;
  days: PeriodAgg[];
  hours: PeriodAgg[];
  series: SeriesStore;
  archive: FrameList;
  fine: FrameList;
  takerBuys: { tMs: number; usd: number }[];
  /** Aggregate counts only; no row of a live-positions snapshot is kept. */
  positions: { longs: number; shorts: number; atMs: number } | null;
}

export interface IndexSnapshot {
  key: string;
  builtAt: number;
  buildMs: number;
  fromMs: number;
  toMs: number;
  ledger: Ledger;
  lines: number;
  badLines: number;
  symbols: Map<string, SymbolIndex>;
}

/**
 * One replay over every sealed (Merkle-rooted) hour of the recordings, with @ballast/market's
 * `replay()`. It yields the whole-window Book Health, per-day and per-hour aggregates, a 1 s
 * series per symbol, and book frames for the judge's scrubber and the replayed hero book.
 * Rebuilt whenever a new hour is rooted; only sealed bytes are ever read.
 */
export class RecordingIndex {
  current: IndexSnapshot | null = null;
  private building: Promise<IndexSnapshot | null> | null = null;

  constructor(private readonly opts: RecordingIndexOptions) {}

  get archiveFrameMs(): number {
    return this.opts.archiveFrameMs ?? 5_000;
  }

  /** Rebuilds if a new hour was rooted since the last build. Concurrent calls share one build. */
  refresh(): Promise<IndexSnapshot | null> {
    if (this.building) return this.building;
    const ledger = readLedger(this.opts.root);
    if (this.current && this.current.key === ledgerKey(ledger)) {
      return Promise.resolve(this.current);
    }
    this.building = this.build(ledger)
      .then((snap) => {
        if (snap) this.current = snap;
        return this.current;
      })
      .catch((err: unknown) => {
        this.opts.onError?.(err);
        return this.current;
      })
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  private async build(ledger: Ledger): Promise<IndexSnapshot | null> {
    const range = sealedRange(ledger.roots);
    if (!range) return null;
    const now = this.opts.now ?? Date.now;
    const started = now();
    const ids = this.opts.ballastIds?.() ?? new Set<string>();
    const archiveMs = this.archiveFrameMs;
    const fineFrom = range.toMs - (this.opts.fineHours ?? 1) * HOUR_MS;
    const archiveFrom = range.toMs - (this.opts.archiveHours ?? 24) * HOUR_MS;
    const rootOf = new Map(ledger.roots.map((r) => [r.hour, r.root]));

    const out = new Map<string, Omit<SymbolIndex, "report" | "stats" | "spec" | "positions">>();
    const hourAggs = new Map<string, Map<string, PeriodAgg>>();
    const dayAggs = new Map<string, Map<string, PeriodAgg>>();
    for (const symbol of this.opts.symbols) {
      out.set(symbol, {
        symbol,
        days: [],
        hours: [],
        series: new SeriesStore(),
        archive: new FrameList(archiveMs),
        fine: new FrameList(HEALTH_SAMPLE_MS),
        takerBuys: [],
      });
      hourAggs.set(symbol, new Map());
      dayAggs.set(symbol, new Map());
    }
    const period = (m: Map<string, PeriodAgg>, key: string, fromMs: number, toMs: number) => {
      let p = m.get(key);
      if (!p) {
        p = {
          key,
          fromMs: Math.max(fromMs, range.fromMs),
          toMs: Math.min(toMs, range.toMs),
          agg: new BookHealthAggregator(),
        };
        m.set(key, p);
      }
      return p;
    };

    const onSample = (s: HealthSample) => {
      const x = out.get(s.symbol);
      if (!x) return;
      const a = s.pair.actual;
      const c = s.pair.counterfactual;
      x.series.add(s.tMs, {
        bestBid: decToNumber(a.bestBid),
        bestAsk: decToNumber(a.bestAsk),
        mid: decToNumber(a.mid),
        ref: decToNumber(a.ref),
        spreadBps: decToNumber(a.spreadBps),
        cfSpreadBps: decToNumber(c.spreadBps),
        askDepth05: decToNumber(a.depthUsd?.ask["0.5%"]),
        bidDepth05: decToNumber(a.depthUsd?.bid["0.5%"]),
        // Exit depth excludes Ballast's own asks.
        askDepth2: decToNumber(c.depthUsd?.ask["2%"]),
      });
      const hour = hourKey(s.tMs);
      const hStart = Date.parse(`${hour}:00:00Z`);
      period(
        hourAggs.get(s.symbol) as Map<string, PeriodAgg>,
        hour,
        hStart,
        hStart + HOUR_MS,
      ).agg.add(s.pair, HEALTH_SAMPLE_MS, s.armed);
      const day = hour.slice(0, 10);
      const dStart = Date.parse(`${day}T00:00:00Z`);
      period(
        dayAggs.get(s.symbol) as Map<string, PeriodAgg>,
        day,
        dStart,
        dStart + 24 * HOUR_MS,
      ).agg.add(s.pair, HEALTH_SAMPLE_MS, s.armed);
      const fine = s.tMs >= fineFrom;
      const archived = s.tMs >= archiveFrom && s.tMs % archiveMs === 0;
      if (!fine && !archived) return;
      const frame = frameOf({
        symbol: s.symbol,
        tMs: s.tMs,
        sequence: s.book.lastSequence,
        spec: s.spec,
        levels: s.levels,
        cfLevels: s.pair.ballastOrders > 0 ? levelsFromL3(s.book, s.spec, ids) : null,
        pair: s.pair,
        source: { kind: "replay", hour, ...(rootOf.has(hour) ? { root: rootOf.get(hour) } : {}) },
      });
      if (fine) x.fine.push(frame);
      if (archived) x.archive.push(frame);
    };

    const specs = new Map<string, MarketSpec>();
    const onTakerBuy = (symbol: string, b: TakerBuy) => {
      const spec = specs.get(symbol);
      if (!spec) return;
      let usd = 0;
      for (const f of b.fills) {
        usd += unitsToNumber(f.px, spec.tick) * unitsToNumber(f.qty, spec.step);
      }
      out.get(symbol)?.takerBuys.push({ tMs: b.tMs, usd });
    };

    const res = await replay({
      root: this.opts.root,
      symbols: this.opts.symbols,
      fromMs: range.fromMs,
      toMs: range.toMs,
      ballastIds: ids,
      ...(this.opts.armed ? { armed: this.opts.armed } : {}),
      healthSampleMs: HEALTH_SAMPLE_MS,
      // No receive-time slack: records past the last rooted hour are not sealed yet.
      slackMs: 0,
      onHealthSample: (s) => {
        specs.set(s.symbol, s.spec);
        onSample(s);
      },
      onTakerBuy,
    });

    const symbols = new Map<string, SymbolIndex>();
    for (const [symbol, x] of out) {
      const r = res.symbols.get(symbol);
      if (!r) continue;
      const snap = r.positions.filter((p) => p.recvMs < range.toMs).at(-1);
      const sorted = (m: Map<string, PeriodAgg> | undefined) =>
        [...(m?.values() ?? [])].sort((p, q) => p.fromMs - q.fromMs);
      symbols.set(symbol, {
        ...x,
        spec: r.spec,
        report: r.health.report(),
        stats: r.stats,
        days: sorted(dayAggs.get(symbol)),
        hours: sorted(hourAggs.get(symbol)),
        positions: snap
          ? {
              longs: snap.positions.filter((p) => isLong(p.size)).length,
              shorts: snap.positions.filter((p) => p.size.trim().startsWith("-")).length,
              atMs: Number.isFinite(snap.updatedAtMs) ? snap.updatedAtMs : snap.recvMs,
            }
          : null,
      });
    }
    return {
      key: ledgerKey(ledger),
      builtAt: now(),
      buildMs: now() - started,
      fromMs: range.fromMs,
      toMs: range.toMs,
      ledger,
      lines: res.read.lines,
      badLines: res.read.badLines,
      symbols,
    };
  }
}

function isLong(size: string): boolean {
  const s = size.trim();
  return !s.startsWith("-") && /[1-9]/.test(s);
}
