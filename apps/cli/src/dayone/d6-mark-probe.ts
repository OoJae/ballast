/**
 * D6 (plan section 11): validate the mark replica, identify P2's mid, then one $10 probe fill.
 *
 *   pnpm exec tsx apps/cli/src/dayone/d6-mark-probe.ts [--dry-run] [--recordings data/recordings]
 *   BALLAST_ARM=1 pnpm exec tsx apps/cli/src/dayone/d6-mark-probe.ts --live --yes-i-approve \
 *     --eligible-host --account <holder #0 id> --key <sealed key file> --recordings data/recordings
 *
 * The 24 h of 1 s capture is the recorder's job (it has run since M0); this script fits the
 * replica on those recordings (read-only, also in a dry run) and runs the live probe.
 */
import { pathToFileURL } from "node:url";
import {
  bookTop,
  DOCUMENTED_MARK_PARAMS,
  dec,
  fitMarkReplicaJoint,
  levelsFromL3,
  listSegmentFiles,
  type MarkFitResult,
  type MarkParams,
  MarkReplica,
  type MarkSeries,
  predictMark,
  replay,
  statsJson,
} from "@ballast/market";
import { L3Feed, ReconnectingSocket } from "@ballast/strike-client";
import {
  type DayOneArgs,
  type DayOnePlan,
  type LiveContext,
  markPlusBps,
  maxTicks,
  nightState,
  probeId,
  requireOpt,
  runDayOne,
  tenDollarAsk,
} from "./m6-kit.js";

export const PLAN: DayOnePlan = {
  id: "D6",
  title:
    "Mark replica: fit P1/P2/P3 on 24 h of recordings, then a $10 probe fill on a holder #0 ask ≥ F",
  network: "strike-mainnet",
  prerequisites: [
    "the recorder has captured ≥ 24 h of NIGHT-USD (mark, index, L3, trades) at 1 s (M0)",
    "holder #0's account and sealed key; a human probe in a separate master family (as in D3)",
  ],
  steps: [
    "re-read live positions and compute F (tier-aware, b_liq = 10 bps + 2 × replica p99)",
    "fit the mark replica on the last --hours of recordings (default 24): best hypothesis, held-out p50/p99, P2's mid (impact vs top) on P2 ticks",
    "live: subscribe to /ws/l3 and markprice@1s; warm the replica for --warmup-s (default 120)",
    "rest one post-only ask ≈ $10.5 at max(F, ceil(mark), best bid + 1 tick); predict the next mark after it is lifted",
    "PRINT the instruction for the human probe to lift it; record the first published mark after the fill",
    "cancel anything left (cancel-all NIGHT-USD)",
  ],
  pass: "Replica error < 0.5 bps; post-fill mark matches the prediction; P2's mid definition known",
  fallback: "Stay in P2-blind mode (Section 5); widen b_liq to cover p99; ask Shan for the formula",
  exposure:
    "one ≈ $10.5 NIGHT short closed by the probe's own trade (labelled a probe, excluded from KPIs)",
  options: {
    "--recordings": "recordings root for the fit (read-only; runs in a dry run too)",
    "--hours": "hours of recordings to fit (default 24)",
    "--account": "holder #0 account id (live)",
    "--key": "holder #0 sealed key (live)",
    "--warmup-s": "seconds of live replica warm-up before the probe (default 120)",
    "--wait-min": "minutes to wait for the probe (default 10)",
  },
};

export interface FitSummary {
  hours: number;
  ticks: number;
  best: unknown;
  heldOut: unknown;
  p2Mid: { impact: unknown; top: unknown; known: string | null };
  params: MarkParams;
}

/** Read-only replay of the recordings → the replica fit (as `pnpm book-health` does). */
export async function fitFromRecordings(root: string, hours: number): Promise<FitSummary | null> {
  const files = listSegmentFiles(root);
  if (files.length === 0) return null;
  const last = Math.max(...files.map((f) => f.hourStartMs)) + 3_600_000;
  const toMs = last;
  const fromMs = toMs - hours * 3_600_000;
  const result = await replay({ root, symbols: ["NIGHT-USD"], fromMs, toMs });
  const series: MarkSeries[] = [];
  for (const r of result.symbols.values()) {
    if (!r.spec) continue;
    series.push({
      symbol: r.symbol,
      market: r.spec,
      ticks: r.ticks,
      books: r.books,
      gridMs: result.gridMs,
      trades: r.trades,
      initialLast: null,
      settled: new Map(),
    });
  }
  if (series.length === 0) return null;
  const [fit] = fitMarkReplicaJoint(series) as MarkFitResult[];
  if (!fit) return null;
  const impact = statsJson(fit.p2Ticks.impact);
  const top = statsJson(fit.p2Ticks.top);
  const p50 = (x: Record<string, number | string> | null) => (x ? Number(x.p50) : Number.NaN);
  const known =
    Number.isFinite(p50(impact)) && Number.isFinite(p50(top)) && p50(impact) !== p50(top)
      ? p50(impact) < p50(top)
        ? "impact"
        : "top"
      : null;
  return {
    hours,
    ticks: fit.ticks,
    best: fit.best,
    heldOut: statsJson(fit.heldOut),
    p2Mid: { impact, top, known },
    params: fit.params,
  };
}

export async function dryRun(args: DayOneArgs): Promise<Record<string, unknown>> {
  const root = args.opts.recordings;
  const fit = root ? await fitFromRecordings(root, Number(args.opts.hours ?? "24")) : null;
  return {
    fit:
      fit ?? (root ? "no NIGHT-USD recordings in range" : "pass --recordings to fit (read-only)"),
    probe:
      "holder #0 post-only ask ≈ $10.5 at max(F, ceil(mark), best bid + 1 tick), lifted by a human probe",
  };
}

export async function live(ctx: LiveContext, args: DayOneArgs) {
  const accountId = requireOpt(args, "account", PLAN);
  const root = requireOpt(args, "recordings", PLAN);
  const fit = await fitFromRecordings(root, Number(args.opts.hours ?? "24"));
  const params = fit?.params ?? DOCUMENTED_MARK_PARAMS;
  const signer = ctx.signer(requireOpt(args, "key", PLAN));
  const maker = ctx.client(signer, accountId);
  const tap = await ctx.tap(signer, accountId);
  const s = await nightState(ctx);
  const spec = s.market.spec;
  const replica = new MarkReplica(params, spec);
  const marks: { E: number; mark: string; index: string }[] = [];
  let lastTick: { index: string; T: number } | null = null;
  const feed = new L3Feed({
    url: `${ctx.ws}/ws/l3`,
    userAgent: ctx.userAgent,
    symbols: [s.market.symbol],
    fetchSnapshot: (sym) => ctx.reads.l3Snapshot(sym),
    onUpdate: (u) => {
      if ((u.action === "partial_fill" || u.action === "full_fill") && u.price)
        replica.onTrade(u.price);
    },
  });
  const book = () => feed.books.get(s.market.symbol);
  const price = new ReconnectingSocket({
    url: `${ctx.ws}/ws/price`,
    userAgent: ctx.userAgent,
    onOpen: (sock) => {
      sock.send({
        method: "SUBSCRIBE",
        params: [`${s.market.symbol.toLowerCase()}@markprice@1s`],
        id: 1,
      });
    },
    onMessage: (m) => {
      const d = m as Record<string, unknown> | null;
      if (d?.e !== "markPriceUpdate" || d.s !== s.market.symbol) return;
      marks.push({ E: Number(d.E), mark: String(d.p), index: String(d.i) });
      lastTick = { index: String(d.i), T: Number(d.T) };
      const b = book();
      if (b?.synced) {
        const top = bookTop(levelsFromL3(b, spec), spec, Number(d.E));
        replica.addBasis(top, dec(String(d.i)));
        replica.cycle(Number(d.E), dec(String(d.i)), Number(d.T), top);
      }
    },
  });
  feed.start();
  price.start();
  try {
    await ctx.sleep(Number(args.opts["warmup-s"] ?? "120") * 1_000);
    const px = maxTicks(s.floorTicks, markPlusBps(s, 0), (s.bestBidTicks ?? 0n) + 1n);
    const ask = tenDollarAsk(s.market, probeId("d6", 1, ctx.now()), px);
    await maker.replaceBatch({ replacements: [{ new_order: ask }] });
    await ctx.sleep(1_500);
    const b = book();
    const tick = lastTick as { index: string; T: number } | null;
    const prediction =
      b && tick
        ? predictMark(
            replica.snapshot(),
            levelsFromL3(b, spec),
            { nowMs: ctx.now() + 1_000, index: dec(tick.index), nextFundingMs: tick.T },
            spec,
            params,
            { side: "ask", qtySteps: s.market.step.toUnits(ask.size) },
          )
        : null;
    ctx.log(
      `HUMAN PROBE: from the probe master, buy ${ask.size} NIGHT-USD at ${ask.price}, limit IOC, now.`,
    );
    const fill = await tap.waitFor(
      (ev) => ev.kind === "fill" && ev.data.c === ask.client_order_id,
      Number(args.opts["wait-min"] ?? "10") * 60_000,
    );
    const fillE = fill && fill.kind === "fill" ? fill.data.T : null;
    await ctx.sleep(2_500);
    const published = fillE === null ? undefined : marks.find((x) => x.E > fillE);
    await maker.cancelAll({ symbol: s.market.symbol });
    const predicted = prediction?.after?.mark ?? null;
    const errBps =
      predicted && published
        ? predicted.minus(dec(published.mark)).abs().div(dec(published.mark)).times(10_000)
        : null;
    const heldOutP50 = fit
      ? Number((fit.heldOut as Record<string, number> | null)?.p50 ?? Number.NaN)
      : Number.NaN;
    const pass =
      fit !== null &&
      heldOutP50 < 0.5 &&
      (errBps?.lessThan(0.5) ?? false) &&
      fit.p2Mid.known !== null;
    return {
      pass,
      evidence: {
        fit,
        floorTicks: s.floorTicks.toString(),
        ask: { price: ask.price, size: ask.size },
        predictedMark: predicted?.toFixed() ?? null,
        publishedAfterFill: published ?? null,
        errorBps: errBps?.toFixed(4) ?? null,
        probeLabel: "PROBE: exclude this trade id from KPIs",
      },
    };
  } finally {
    feed.stop();
    price.stop();
  }
}

export const main = (argv: readonly string[], env?: NodeJS.ProcessEnv, out?: (s: string) => void) =>
  runDayOne(PLAN, { dryRun, live }, argv, env, out);

if (
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).then(
    (r) => process.exit(r.pass === false ? 1 : 0),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    },
  );
}
