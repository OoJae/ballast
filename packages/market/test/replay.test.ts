import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dec,
  findL3Bootstrap,
  fitMarkReplica,
  floorIncidence,
  listSegmentFiles,
  type PositionsSnapshot,
  parseMarginTiers,
  premiumSamplesFromReplay,
  type RawMarginTier,
  type RecordLine,
  type ReplayResult,
  readRecordings,
  replay,
  validateFunding,
} from "../src/index.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/** Writes `<root>/<day>/<HH>/<file>` with one JSON line per record (optionally gzipped). */
function recordingRoot(files: Record<string, unknown[] | string>): string {
  const root = mkdtempSync(join(tmpdir(), "ballast-rec-"));
  temps.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    const text =
      typeof content === "string" ? content : content.map((l) => `${JSON.stringify(l)}\n`).join("");
    writeFileSync(path, rel.endsWith(".gz") ? gzipSync(text) : text);
  }
  return root;
}

const H = Date.parse("2026-10-23T05:00:00Z");
const rec = (r: number, k: string, d: unknown) => ({ r, k, d });

describe("recordings reader", () => {
  const root = recordingRoot({
    "2026-10-23/05/price.0.jsonl.gz": [
      rec(H + 2, "markPriceUpdate", { n: 2 }),
      rec(H + 5, "trade", { n: 5 }),
    ],
    "2026-10-23/05/price.1.jsonl": [rec(H + 9, "trade", { n: 9 })],
    // Same segment raw and gzipped (mid-compression): read once, from the raw file.
    "2026-10-23/05/rest.0.jsonl": [rec(H + 1, "time", { n: 1 }), rec(H + 6, "time", { n: 6 })],
    "2026-10-23/05/rest.0.jsonl.gz": [rec(H + 1, "time", { n: 1 }), rec(H + 6, "time", { n: 6 })],
    "2026-10-23/05/rest.0.jsonl.gz.tmp": "garbage",
    // An open segment whose last line is still being written.
    "2026-10-23/06/l3.0.jsonl": `${JSON.stringify(rec(H + 3_600_001, "update", { n: 11 }))}\n{"r":${H + 3_600_002},"k":"upd`,
    "2026-10-23/05/l3.0.jsonl": [
      rec(H + 3, "update", { n: 3 }),
      rec(H + 4, "snapshot", { symbol: "X-USD" }),
    ],
  });

  it("lists segments by stream, hour and part, preferring raw over gzip", () => {
    const files = listSegmentFiles(root);
    expect(files.map((f) => `${f.stream}/${f.hour}/${f.part}/${f.gz ? "gz" : "raw"}`)).toEqual([
      "l3/2026-10-23T05/0/raw",
      "l3/2026-10-23T06/0/raw",
      "price/2026-10-23T05/0/gz",
      "price/2026-10-23T05/1/raw",
      "rest/2026-10-23T05/0/raw",
    ]);
    expect(listSegmentFiles(root, { streams: ["rest"] }).length).toBe(1);
    expect(listSegmentFiles(root, { fromMs: H + 3_600_000 }).map((f) => f.hour)).toEqual([
      "2026-10-23T06",
    ]);
  });

  it("merges every stream in receive-time order and skips a partial trailing line", async () => {
    const stats = { lines: 0, badLines: 0 };
    const out: RecordLine[] = [];
    for await (const r of readRecordings(root, {}, stats)) out.push(r);
    expect(out.map((r) => (r.d as { n?: number }).n ?? "snap")).toEqual([
      1,
      2,
      3,
      "snap",
      5,
      6,
      9,
      11,
    ]);
    expect(out.map((r) => r.stream).slice(0, 3)).toEqual(["rest", "price", "l3"]);
    expect(stats.badLines).toBe(1);
  });

  it("filters by receive-time window", async () => {
    const out: number[] = [];
    for await (const r of readRecordings(root, { fromMs: H + 3, toMs: H + 9 })) out.push(r.r - H);
    expect(out).toEqual([3, 4, 5, 6]);
  });

  it("survives the recorder sealing a raw segment between listing and reading it", async () => {
    const r2 = recordingRoot({
      "2026-10-23/05/rest.0.jsonl.gz": [rec(H + 1, "time", { n: 1 }), rec(H + 2, "time", { n: 2 })],
      "2026-10-23/06/rest.0.jsonl": [
        rec(H + 3_600_001, "time", { n: 3 }),
        rec(H + 3_600_002, "time", { n: 4 }),
      ],
    });
    const it = readRecordings(r2);
    const head = await it.next();
    expect(head.done ? null : (head.value.d as { n: number }).n).toBe(1);
    // The recorder's seal: the .gz is renamed into place, then the raw file deleted.
    const raw = join(r2, "2026-10-23/06/rest.0.jsonl");
    writeFileSync(`${raw}.gz`, gzipSync(readFileSync(raw)));
    rmSync(raw);
    const rest: number[] = [];
    for (;;) {
      const n = await it.next();
      if (n.done) break;
      rest.push((n.value.d as { n: number }).n);
    }
    expect(rest).toEqual([2, 3, 4]);
  });

  it("finds the latest hour an L3 replay can bootstrap from", async () => {
    expect(await findL3Bootstrap(root, H + 3_600_500, ["X-USD"])).toBe(H);
    expect(await findL3Bootstrap(root, H + 3, ["X-USD"])).toBeNull();
    expect(await findL3Bootstrap(root, H + 3_600_500, ["X-USD", "Y-USD"])).toBeNull();
  });
});

const SYM = "TEST-USD";
const markets = {
  [SYM]: {
    symbol: SYM,
    quote_prec: 8,
    base_prec: 8,
    order_tick_price: "0.0001",
    order_limit_step_size: "1",
    order_min_notional: "10",
    impact_notional: "1000",
    margin_tiers: [
      {
        max_notional: "100000",
        max_leverage: 20,
        maintenance_margin_rate: "0.01",
        maintenance_amount: "0",
      },
    ],
  },
};
const snap = (seq: number, ts: number, asks: [string, string, string][]) => ({
  type: "l3_snapshot",
  symbol: SYM,
  last_sequence: seq,
  timestamp: ts,
  bids: [{ price: "0.9900", orders: [{ order_id: "B1", size: "5000" }] }],
  asks: asks.map(([price, order_id, size]) => ({ price, orders: [{ order_id, size }] })),
});
const upd = (seq: number, ts: number, u: Record<string, unknown>) => ({
  type: "l3_update",
  symbol: SYM,
  sequence: seq,
  timestamp: ts,
  ...u,
});

describe("replay: gap-aware L3 rebuilds", () => {
  const t0 = H;
  const root = recordingRoot({
    "2026-10-23/05/rest.0.jsonl": [rec(t0, "markets", markets)],
    "2026-10-23/05/l3.0.jsonl": [
      rec(t0 + 1, "snapshot", snap(10, t0 + 1, [["1.0100", "A1", "3000"]])),
      rec(
        t0 + 1_000,
        "update",
        upd(11, t0 + 1_000, {
          action: "open",
          order_id: "A2",
          side: "sell",
          price: "1.0200",
          remaining_size: "4000",
          delta_size: "4000",
        }),
      ),
      // Taker buy: fills Ballast's A1, then A2.
      rec(
        t0 + 2_000,
        "update",
        upd(12, t0 + 2_000, {
          action: "full_fill",
          order_id: "A1",
          taker_order_id: "T1",
          side: "sell",
          price: "1.0100",
          delta_size: "-3000",
          remaining_size: "0",
          trade_id: 1,
        }),
      ),
      rec(
        t0 + 2_000,
        "update",
        upd(13, t0 + 2_000, {
          action: "partial_fill",
          order_id: "A2",
          taker_order_id: "T1",
          side: "sell",
          price: "1.0200",
          delta_size: "-1000",
          remaining_size: "3000",
          trade_id: 2,
        }),
      ),
      // A sequence gap: the book can no longer be trusted until the next snapshot.
      rec(
        t0 + 5_000,
        "update",
        upd(15, t0 + 5_000, {
          action: "cancel",
          order_id: "A2",
          side: "sell",
          price: "1.0200",
          delta_size: "-3000",
          remaining_size: "0",
        }),
      ),
      rec(t0 + 9_000, "rebuild", { symbol: SYM, reason: "gap", detail: "expected 14, got 15" }),
      // Received before the snapshot that it postdates: buffered, then applied on top of it.
      rec(
        t0 + 9_500,
        "update",
        upd(21, t0 + 9_500, {
          action: "open",
          order_id: "A3",
          side: "sell",
          price: "1.0300",
          remaining_size: "100",
          delta_size: "100",
        }),
      ),
      rec(t0 + 10_000, "snapshot", snap(20, t0 + 10_000, [["1.0200", "A4", "2000"]])),
      rec(
        t0 + 20_000,
        "update",
        upd(22, t0 + 20_000, {
          action: "cancel",
          order_id: "A4",
          side: "sell",
          price: "1.0200",
          delta_size: "-2000",
          remaining_size: "0",
        }),
      ),
    ],
  });

  it("re-bootstraps after a gap, samples only while synced, and prices the taker buy", async () => {
    const res = await replay({
      root,
      symbols: [SYM],
      fromMs: t0,
      toMs: t0 + 30_000,
      ballastIds: new Set(["A1"]),
      armed: () => true,
    });
    const r = res.symbols.get(SYM);
    if (!r) throw new Error("no symbol");
    expect(r.stats).toMatchObject({
      snapshots: 2,
      rebuilds: 1,
      breaks: 1,
      l3Updates: 6,
      takerBuys: 1,
    });
    // Synced over [t0+1, t0+5000) and [t0+10000, t0+20000]: health samples at whole seconds.
    expect(r.stats.healthSamples).toBe(4 + 11);
    expect(r.stats.unsyncedMs).toBe(4_500);
    expect(r.health.report().armed.ms).toBe(15_000);
    // Book grid entries exist only while synced (none in the gap).
    expect(r.books.some((b) => b.tMs > t0 + 5_000 && b.tMs < t0 + 10_000)).toBe(false);
    // After the second snapshot, A3 (seq 21) was carried in: best ask 1.02 until A4 is cancelled.
    const after = r.books.find((b) => b.tMs === t0 + 15_000);
    expect(after?.bestAsk?.toFixed()).toBe("1.02");
    const last = r.books.at(-1);
    expect(last?.bestAsk?.toFixed()).toBe("1.03");
    // The taker bought 4,000: 3,000 from Ballast at 1.01, 1,000 at 1.02. Without Ballast it pays
    // 1.02 for all of it: savings = (1.02 − 1.0125) × 4,000 = $30.
    expect(r.savings.length).toBe(1);
    expect(r.savings[0]?.savingsUsd?.toFixed()).toBe("30");
    expect(r.trades.map((t) => t.px.toFixed())).toEqual(["1.01", "1.02"]);
  });
});

describe("replay: live positions and floor incidence", () => {
  const root = recordingRoot({
    "2026-10-23/05/rest.0.jsonl": [
      rec(H, "markets", markets),
      rec(H + 1_000, "live-positions", {
        updated_at: H,
        positions: [{ symbol: SYM, size: "1", liquidation_price: "0.5" }],
      }),
      // No updated_at: the snapshot's age is unknown, so it must count as stale.
      rec(H + 2_000, "live-positions", { positions: [] }),
    ],
  });
  it("stores an unknown snapshot time as −∞ (always stale)", async () => {
    const res = await replay({ root, symbols: [SYM], fromMs: H, toMs: H + 10_000 });
    const pos = res.symbols.get(SYM)?.positions ?? [];
    expect(pos.map((p) => p.updatedAtMs)).toEqual([H, Number.NEGATIVE_INFINITY]);
    expect(pos[0]?.positions.length).toBe(1);
  });

  it("counts fragile and stale ticks with tier-consistent triggers, aggregate only", () => {
    const tiers = parseMarginTiers(
      (
        JSON.parse(readFileSync(new URL("./fixtures/markets.json", import.meta.url), "utf8")) as {
          markets: Record<string, { margin_tiers: RawMarginTier[] }>;
        }
      ).markets["NIGHT-USD"]?.margin_tiers ?? [],
    );
    const row = (size: string, entry: string, lp: string) => ({
      symbol: "NIGHT-USD",
      size,
      entry_price: entry,
      mark_price: "0.0384",
      leverage: 10,
      margin_mode: "cross",
      isolated_margin: "0",
      liquidation_price: lp,
    });
    // The recorded-style cross long: served LP 0.0307000196 (tier 1), real trigger ~0.0307758.
    const cross = row("131000", "0.0384", "0.0307000195733020151");
    const snaps: PositionsSnapshot[] = [
      { recvMs: 10_000, updatedAtMs: 9_000, positions: [cross, row("-5", "0.04", "0.05")] },
      { recvMs: 2_000_000, updatedAtMs: Number.NEGATIVE_INFINITY, positions: [] },
    ];
    const tick = (tMs: number, index: string) => ({ tMs, index: dec(index) });
    // The index at which the served LP is not fragile but the real trigger is (b = 10 bps).
    const ticks = [
      tick(5_000, "0.0310"), // before any snapshot: stale
      tick(20_000, "0.0308"), // fragile only by the tier-consistent trigger
      tick(30_000, "0.0320"), // safe
      tick(9_000 + 15 * 60_000 + 1, "0.0320"), // stale by age
      tick(2_000_001, "0.0308"), // unknown age: stale; no longs
    ];
    const inc = floorIncidence(ticks, snaps, tiers, dec(10));
    expect(inc).toMatchObject({
      ticks: 5,
      fragile: 1,
      stale: 3,
      longStates: 1,
      tierAdjustedStates: 1,
    });
    expect(inc.maxTierUpliftBps?.toDecimalPlaces(1).toFixed()).toBe("24.7");
  });
});

describe("replay over a recorded fixture (NIGHT-USD and ADA-USD, 60 s)", () => {
  const root = fileURLToPath(new URL("./fixtures/rec", import.meta.url));
  const fromMs = 1_792_716_885_000;
  let res: ReplayResult;
  beforeAll(async () => {
    res = await replay({ root, symbols: ["NIGHT-USD", "ADA-USD"], fromMs, toMs: fromMs + 60_000 });
  });

  for (const symbol of ["NIGHT-USD", "ADA-USD"]) {
    it(`${symbol}: rebuilds the book gap-free and samples Book Health every second`, () => {
      const r = res.symbols.get(symbol);
      if (!r) throw new Error("missing");
      expect(r.spec?.symbol).toBe(symbol);
      expect(r.stats.snapshots).toBe(1);
      expect(r.stats.breaks).toBe(0);
      expect(r.stats.l3Updates).toBeGreaterThan(1_000);
      expect(r.stats.healthSamples).toBeGreaterThanOrEqual(55);
      expect(r.ticks.length).toBeGreaterThanOrEqual(55);
      const rep = r.health.report().unarmed;
      expect(rep.ms).toBe(r.stats.healthSamples * 1_000);
      expect(Number(rep.actual.spreadBps?.mean)).toBeGreaterThan(0);
      expect(rep.actual).toEqual(rep.counterfactual);
    });

    it(`${symbol}: the rebuilt book reproduces Strike's own premium samples`, () => {
      const r = res.symbols.get(symbol);
      if (!r) throw new Error("missing");
      const v = validateFunding(r.premiumRecords, premiumSamplesFromReplay(r));
      expect(v.rateFromAverage.exact).toBe(v.rateFromAverage.checked);
      const fb = v.fromBook;
      if (!fb) throw new Error("no book comparison");
      expect(fb.compared).toBeGreaterThanOrEqual(8);
      // Every sample is within what the stream index's 8-dp rounding alone explains.
      expect(fb.withinIndexRounding).toBe(fb.compared);
      expect(fb.unexplained).toEqual([]);
    });

    it(`${symbol}: the mark replica fits the fixture`, () => {
      const r = res.symbols.get(symbol);
      if (!r?.spec) throw new Error("missing");
      const fit = fitMarkReplica(
        {
          symbol,
          market: r.spec,
          ticks: r.ticks,
          books: r.books,
          gridMs: res.gridMs,
          trades: r.trades,
          initialLast: null,
          settled: new Map(),
        },
        { hypotheses: [{ mid: "impact", basisWindow: 20, bookLagMs: 1_000 }] },
      );
      expect(fit.evaluated).toBeGreaterThan(20);
      expect(fit.all?.p50.lte(1)).toBe(true);
    });
  }
});
