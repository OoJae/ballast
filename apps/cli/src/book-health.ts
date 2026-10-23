import { writeFileSync } from "node:fs";
import {
  bLiqFromFit,
  dec,
  FUNDING_INTERVAL_MS,
  type FundingValidation,
  fitMarkReplicaJoint,
  floorIncidence,
  listSegmentFiles,
  type MarkFitResult,
  type MarkSeries,
  type MetricSummary,
  premiumSamplesFromReplay,
  replay,
  type SymbolReplay,
  statsJson,
  validateFunding,
} from "@ballast/market";
import { parseBookHealthArgs } from "./book-health-args.js";

/**
 * "Before" Book Health from the recorder's data: the book Ballast will be measured against, plus
 * the mark and funding replicas' error statistics. Reads local files only; no network.
 *
 *   pnpm book-health -- --root data/recordings [--from ISO] [--to ISO] [--symbols A,B] [--json f]
 */
const {
  root,
  symbols,
  fromMs,
  toMs,
  json: jsonPath,
} = parseBookHealthArgs(process.argv.slice(2), {
  nowMs: Date.now(),
  firstHourMs: (dir) =>
    listSegmentFiles(dir)
      .map((f) => f.hourStartMs)
      .sort((a, b) => a - b)[0],
});

const started = Date.now();
const result = await replay({
  root,
  symbols,
  fromMs,
  toMs,
  onProgress: (n, r) => process.stderr.write(`  ${n} lines, at ${new Date(r).toISOString()}\n`),
});
const iso = (ms: number | undefined) =>
  ms !== undefined && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
const round = (x: number) => Math.round(x * 10_000) / 10_000;

const replays = [...result.symbols.values()];
const funding = new Map<string, FundingValidation>();
const series: MarkSeries[] = [];
for (const r of replays) {
  const v = validateFunding(
    r.premiumRecords,
    premiumSamplesFromReplay(r, { gridMs: result.gridMs }),
  );
  funding.set(r.symbol, v);
  if (!r.spec) continue;
  const inWindow = r.ticks.filter((t) => t.tMs >= fromMs && t.tMs < toMs);
  const first = inWindow[0]?.tMs ?? fromMs;
  series.push({
    symbol: r.symbol,
    market: r.spec,
    // Two minutes before the window warm the basis history up.
    ticks: r.ticks.filter((t) => t.tMs >= first - 120_000 && t.tMs < toMs),
    books: r.books,
    gridMs: result.gridMs,
    trades: r.trades,
    initialLast: null,
    settled: new Map(
      v.settlements.map((s) => [s.windowStartMs, { rate: s.rate, complete: s.complete }]),
    ),
  });
}
const fits = new Map<string, MarkFitResult>(
  (series.length ? fitMarkReplicaJoint(series) : []).map((f) => [f.symbol, f]),
);

function analyse(r: SymbolReplay) {
  const f = funding.get(r.symbol) as FundingValidation;
  const mark = fits.get(r.symbol) ?? null;
  const inWindow = r.ticks.filter((t) => t.tMs >= fromMs && t.tMs < toMs);
  // b_liq needs a held-out error; without one it is unknown and so is the fragile share.
  const bLiq = bLiqFromFit(mark);
  // Only aggregates are reported; individual liquidation prices never leave floorIncidence.
  const inc = r.spec ? floorIncidence(inWindow, r.positions, r.spec.tiers, bLiq ?? dec(0)) : null;
  const share = (x: number) => (inWindow.length ? round(x / inWindow.length) : null);
  return {
    symbol: r.symbol,
    window: { from: iso(inWindow[0]?.tMs), to: iso(inWindow.at(-1)?.tMs) },
    bookHealth: r.health.report(),
    replay: r.stats,
    realizedSavings: {
      takerBuys: r.stats.takerBuys,
      touchedBallast: r.savings.length,
      totalUsd: r.savings.reduce((a, s) => a + Number(s.savingsUsd ?? 0), 0),
    },
    markReplica: mark && {
      best: mark.best,
      evaluatedTicks: mark.evaluated,
      errBps: {
        all: statsJson(mark.all),
        train: statsJson(mark.train),
        heldOut: statsJson(mark.heldOut),
      },
      legShare: Object.fromEntries(Object.entries(mark.legShare).map(([k, v]) => [k, round(v)])),
      p2MidTest: { impact: statsJson(mark.p2Ticks.impact), top: statsJson(mark.p2Ticks.top) },
      prevFundingRates: mark.prevFundingRates.map((p) => ({
        windowStart: iso(p.windowStartMs),
        rate: p.rate,
        source: p.source,
      })),
      topHypotheses: mark.hypotheses
        .slice(0, 5)
        .map((h) => ({ ...h.hypothesis, trainErrBps: statsJson(h.train) })),
    },
    fundingReplica: {
      rateFromAverage: f.rateFromAverage,
      averageFromSamples: f.averageFromSamples,
      settlements: f.settlements.map((s) => ({
        windowStart: iso(s.windowStartMs),
        settledAt: iso(s.windowStartMs + FUNDING_INTERVAL_MS),
        rate: s.rate.toFixed(),
        samples: s.count,
        complete: s.complete,
      })),
      fromBook: f.fromBook && {
        compared: f.fromBook.compared,
        exact: f.fromBook.exact,
        premiumErrBps: statsJson(f.fromBook.errBps, 6),
        withinIndexRounding: f.fromBook.withinIndexRounding,
        rateErrBps: statsJson(f.fromBook.rateErrBps, 6),
        explainedByCycleBook: f.fromBook.explainedByCycleBook,
        outOfBound: f.fromBook.unexplained.map((u) => ({
          slot: iso(u.slotStartMs),
          errBps: u.errBps.toDecimalPlaces(4).toFixed(),
          cycleBookErrBps: u.cycleBookErrBps?.toDecimalPlaces(4).toFixed() ?? null,
          explainedByCycleBook: u.explainedByCycleBook,
          index: u.index.toFixed(),
          impliedIndex: u.impliedIndex?.toDecimalPlaces(10).toFixed() ?? null,
          indexOffBps:
            u.impliedIndex
              ?.minus(u.index)
              .times(10_000)
              .div(u.index)
              .toDecimalPlaces(2)
              .toFixed() ?? null,
        })),
      },
    },
    floorInputs: {
      bLiqBps: bLiq?.toDecimalPlaces(4).toFixed() ?? null,
      bLiqFrom: mark?.heldOut ? "max(heldOut.p99, all.p99)" : null,
      fragileLongShare: bLiq && inc ? share(inc.fragile) : null,
      stalePositionsShare: inc ? share(inc.stale) : null,
      positionSnapshots: r.positions.length,
      longStates: inc?.longStates ?? null,
      lowerTierTriggerStates: inc?.tierAdjustedStates ?? null,
      maxTierUpliftBps: inc?.maxTierUpliftBps?.toDecimalPlaces(2).toFixed() ?? null,
    },
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  root,
  window: { from: iso(fromMs), to: iso(toMs) },
  bootstrapFrom: iso(result.bootstrapFromMs),
  lines: result.read.lines,
  badLines: result.read.badLines,
  elapsedMs: Date.now() - started,
  symbols: replays.map(analyse),
};

const json = JSON.stringify(report, null, 2);
if (jsonPath) writeFileSync(jsonPath, `${json}\n`);
process.stdout.write(`${json}\n\n`);

const fmt = (x: MetricSummary | undefined, dollars = false) => {
  if (!x || x.mean === null) return "n/a";
  const v = Number(x.mean).toLocaleString("en-US", { maximumFractionDigits: dollars ? 0 : 1 });
  return x.coverage < 0.999 ? `${v} (${Math.round(x.coverage * 100)}%)` : v;
};
const rows: string[][] = [];
for (const s of report.symbols) {
  const a = s.bookHealth.unarmed.actual;
  const e = s.markReplica?.errBps.all;
  const h = s.markReplica?.errBps.heldOut;
  const fb = s.fundingReplica;
  const fl = s.floorInputs;
  rows.push(
    [`${s.symbol}  ${s.window.from ?? "?"} → ${s.window.to ?? "?"}`, "", ""],
    ["  spread bps", fmt(a.spreadBps), ""],
    ...(["0.5%", "1%", "2%"] as const).map((b) => [
      `  depth ±${b} USD (bid | ask)`,
      fmt(a[`depthUsd.bid.${b}`], true),
      fmt(a[`depthUsd.ask.${b}`], true),
    ]),
    ...(["1000", "10000", "25000"] as const).map((z) => [
      `  slippage $${Number(z) / 1000}K bps (buy | sell)`,
      fmt(a[`slippageBps.buy.${z}`]),
      fmt(a[`slippageBps.sell.${z}`]),
    ]),
    ["  mark replica error bps, held out (p50 | p99)", `${h?.p50 ?? "n/a"}`, `${h?.p99 ?? "n/a"}`],
    ["  mark replica error bps, all ticks (p50 | p99)", `${e?.p50 ?? "n/a"}`, `${e?.p99 ?? "n/a"}`],
    [
      "  funding exact (rate←avg | avg←samples)",
      `${fb.rateFromAverage.exact}/${fb.rateFromAverage.checked}`,
      `${fb.averageFromSamples.exact}/${fb.averageFromSamples.checked}`,
    ],
    [
      "  premium←book error bps (p50 | p99)",
      `${fb.fromBook?.premiumErrBps?.p50 ?? "n/a"}`,
      `${fb.fromBook?.premiumErrBps?.p99 ?? "n/a"}`,
    ],
    [
      "  premium←book in rounding bound | by cycle-time book | unexplained",
      `${fb.fromBook?.withinIndexRounding ?? "n/a"}/${fb.fromBook?.compared ?? "n/a"}`,
      fb.fromBook
        ? `${fb.fromBook.explainedByCycleBook} | ${fb.fromBook.outOfBound.length - fb.fromBook.explainedByCycleBook}`
        : "n/a",
    ],
    ["  fragile-long share | b_liq bps", `${fl.fragileLongShare ?? "n/a"}`, fl.bLiqBps ?? "n/a"],
    [
      "  long states with a lower-tier trigger | max bps",
      `${fl.lowerTierTriggerStates ?? "n/a"}/${fl.longStates ?? "n/a"}`,
      fl.maxTierUpliftBps ?? "n/a",
    ],
  );
}
const w0 = Math.max(...rows.map((r) => (r[0] ?? "").length));
const w1 = Math.max(...rows.map((r) => (r[1] ?? "").length));
for (const r of rows) {
  process.stdout.write(`${(r[0] ?? "").padEnd(w0)}  ${(r[1] ?? "").padStart(w1)}  ${r[2] ?? ""}\n`);
}
process.stdout.write(
  '\nTime-weighted over the window; "(n%)" = share of time the metric was defined (e.g. the side could fill the size). Unarmed: no Ballast orders, so actual = counterfactual.\n',
);
