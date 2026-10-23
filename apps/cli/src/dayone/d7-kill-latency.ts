/**
 * D7 (plan section 11): kill latency. N × cancel-all {symbol}, each timed to CANCELED on the user
 * stream and to removal on L3; some trials fire a concurrent cancel-all as the watchdog would
 * (same key, CANCEL_ONLY client) to see nonce or 429 interference.
 *
 *   pnpm exec tsx apps/cli/src/dayone/d7-kill-latency.ts [--dry-run]
 *   BALLAST_ARM=1 pnpm exec tsx apps/cli/src/dayone/d7-kill-latency.ts --live --yes-i-approve \
 *     --eligible-host --account <id> --key <sealed key file> [--trials 100] [--concurrent-every 4]
 */
import { pathToFileURL } from "node:url";
import { engineMarket, matchOwnOrders, REFERENCE_MARKETS } from "@ballast/engine";
import { dec } from "@ballast/market";
import { latencyPercentiles } from "@ballast/ops";
import { L3Feed, StrikeApiError } from "@ballast/strike-client";
import { CancelOnlyClient } from "@ballast/strike-client/cancel-only";
import {
  type DayOneArgs,
  type DayOnePlan,
  isOrderEvent,
  type LiveContext,
  markPlusBps,
  nightState,
  probeId,
  requireOpt,
  runDayOne,
  tenDollarAsk,
} from "./m6-kit.js";

export const PLAN: DayOnePlan = {
  id: "D7",
  title: "Kill latency: 100 × cancel-all, timed to CANCELED on the stream and removal on L3",
  network: "strike-mainnet",
  prerequisites: [
    "an EU host that is not in a Strike-restricted jurisdiction (the keeper's host A)",
    "holder #0's account and sealed key; the watchdog uses the same key (CANCEL_ONLY client)",
  ],
  steps: [
    "subscribe /ws/l3 NIGHT-USD and log on /ws/user-api for the account",
    "per trial: rest one post-only ask ≈ $10.5 at ceil(mark × 1.04) via POST /v2/orders/batch (far from any fill); wait for OPEN and for it on L3",
    "t0 = send DELETE /v2/order/cancel-all {symbol: NIGHT-USD}; every --concurrent-every trials also fire the same cancel-all from a CANCEL_ONLY client with the same key",
    "record t(CANCELED on the stream) − t0 and t(removed from L3) − t0, and any 429 or nonce error",
    "repeat --trials times (default 100); publish p50 and p99",
  ],
  pass: "p50/p99 published; no nonce or 429 interference",
  fallback: "Raise the offset and requote thresholds; ask for DMA",
  exposure:
    "one ≈ $10.5 post-only ask 4% above mark at a time, for about a second per trial; 2 order ops per trial",
  options: {
    "--account": "account id (live)",
    "--key": "sealed key (live)",
    "--trials": "number of trials (default 100)",
    "--concurrent-every":
      "fire a concurrent watchdog cancel-all every k-th trial (default 4; 0 = never)",
    "--offset-bps": "ask offset over mark in bps (default 400, inside the 450 bps static band)",
  },
};

export function dryRunBodies(args: DayOneArgs) {
  const m = engineMarket(REFERENCE_MARKETS["NIGHT-USD"]);
  const px = m.tick.ceilUnits(dec("0.03835").times(1.04));
  return {
    trials: Number(args.opts.trials ?? "100"),
    perTrial: {
      create: { orders: [tenDollarAsk(m, probeId("d7", 1, 0), px)] },
      kill: { method: "DELETE", path: "/v2/order/cancel-all", body: { symbol: "NIGHT-USD" } },
    },
  };
}

interface Trial {
  n: number;
  concurrent: boolean;
  streamMs: number | null;
  l3Ms: number | null;
  errors: string[];
}

export async function live(ctx: LiveContext, args: DayOneArgs) {
  const accountId = requireOpt(args, "account", PLAN);
  const trials = Number(args.opts.trials ?? "100");
  const every = Number(args.opts["concurrent-every"] ?? "4");
  const offset = Number(args.opts["offset-bps"] ?? "400");
  if (!(offset >= 100 && offset <= 440)) throw new Error("--offset-bps must be within 100..440");
  const signer = ctx.signer(requireOpt(args, "key", PLAN));
  const client = ctx.client(signer, accountId);
  const watchdog = new CancelOnlyClient({
    baseUrl: ctx.api,
    userAgent: `${ctx.userAgent}-watchdog`,
    signer,
    clock: ctx.clock,
    rate: ctx.rate,
    account: accountId,
  });
  const tap = await ctx.tap(signer, accountId);
  const s = await nightState(ctx);
  const symbol = s.market.symbol;
  const feed = new L3Feed({
    url: `${ctx.ws}/ws/l3`,
    userAgent: ctx.userAgent,
    symbols: [symbol],
    fetchSnapshot: (sym) => ctx.reads.l3Snapshot(sym),
  });
  feed.start();
  const book = () => feed.books.get(symbol);
  const waitUntil = async (pred: () => boolean, ms: number) => {
    const end = ctx.now() + ms;
    while (ctx.now() < end) {
      if (pred()) return true;
      await ctx.sleep(5);
    }
    return pred();
  };
  const results: Trial[] = [];
  try {
    await waitUntil(() => book()?.synced === true, 15_000);
    for (let n = 1; n <= trials; n++) {
      const errors: string[] = [];
      const ask = tenDollarAsk(s.market, probeId("d7", n, ctx.now()), markPlusBps(s, offset));
      // orders/batch: replace-batch is spaced ≥ 2 s per account, which would pace the trials.
      await client.placeBatch({ orders: [ask] });
      await tap.waitFor(isOrderEvent(ask.client_order_id, "OPEN"), 10_000);
      let l3Id: string | undefined;
      await waitUntil(() => {
        const b = book();
        if (!b?.synced) return false;
        l3Id = matchOwnOrders(b.asks, [
          { key: "a", price: ask.price as string, size: ask.size },
        ]).get("a");
        return l3Id !== undefined;
      }, 10_000);
      const concurrent = every > 0 && n % every === 0;
      const t0 = ctx.now();
      const sends = [client.cancelAll({ symbol })];
      if (concurrent) sends.push(watchdog.cancelAll({ symbol }));
      const settled = await Promise.allSettled(sends);
      for (const r of settled) {
        if (r.status === "rejected") {
          const e = r.reason;
          errors.push(e instanceof StrikeApiError ? `HTTP ${e.status} ${e.code}` : String(e));
        }
      }
      const canceled = await tap.waitFor(isOrderEvent(ask.client_order_id, "CANCELED"), 10_000);
      const streamMs = canceled ? ctx.now() - t0 : null;
      const gone = await waitUntil(() => {
        const b = book();
        if (!b?.synced || l3Id === undefined) return false;
        for (const q of b.asks.values()) if (q.some((o) => o.id === l3Id)) return false;
        return true;
      }, 10_000);
      results.push({ n, concurrent, streamMs, l3Ms: gone ? ctx.now() - t0 : null, errors });
      await ctx.sleep(250);
    }
  } finally {
    feed.stop();
    await client.cancelAll({ symbol }).catch(() => {});
  }
  const ok = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
  const stream = latencyPercentiles(ok(results.map((r) => r.streamMs)));
  const l3 = latencyPercentiles(ok(results.map((r) => r.l3Ms)));
  const interference = results.filter((r) =>
    r.errors.some((e) => /429|nonce|already processed/.test(e)),
  );
  const unconfirmed = results.filter((r) => r.streamMs === null || r.l3Ms === null);
  return {
    pass: interference.length === 0 && unconfirmed.length === 0 && results.length === trials,
    evidence: {
      accountId,
      trials: results,
      stream,
      l3,
      interference: interference.length,
      unconfirmed: unconfirmed.length,
    },
  };
}

export const main = (argv: readonly string[], env?: NodeJS.ProcessEnv, out?: (s: string) => void) =>
  runDayOne(PLAN, { dryRun: dryRunBodies, live }, argv, env, out);

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
