/**
 * D3 (plan section 11): does a builder fee apply to a maker fill?
 *
 *   pnpm exec tsx apps/cli/src/dayone/d3-builder-fee-on-maker.ts [--dry-run]
 *   BALLAST_ARM=1 pnpm exec tsx apps/cli/src/dayone/d3-builder-fee-on-maker.ts --live \
 *     --yes-i-approve --eligible-host --account <holder #0 id> --key <sealed key file> \
 *     [--builder-account <id> --builder-key <sealed key file>] [--wait-min 10]
 *
 * The probe that lifts the ask is a human acting in the Strike app from a SEPARATE master
 * family (self-trade prevention expires makers inside one family). The keeper's signer can never
 * send that taker buy: every Ballast buy is a reduce-only exit (invariants 4 and 6).
 */
import { pathToFileURL } from "node:url";
import { engineMarket, REFERENCE_MARKETS } from "@ballast/engine";
import { dec } from "@ballast/market";
import type { CreateOrderBody } from "@ballast/strike-client";
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
  id: "D3",
  title: "Mainnet: builder fee on a maker fill (holder #0 ask lifted by a separate-family probe)",
  network: "strike-mainnet",
  prerequisites: [
    "D2 passed (attribution shows on resting orders)",
    "holder #0's account and sealed key; optionally the builder payout account and its key",
    "a probe master account in a different master family, funded with ≈ $15, logged in to the Strike app by a human",
  ],
  steps: [
    "read NIGHT-USD rules, mark and live positions; F = liquidation-aware floor",
    "price = max(F, ceil(mark), best bid + 1 tick); one post-only ask ≈ $10.5 with X-Builder-Fee-Bps: 10",
    "record the builder account's /v2/balances (when its key is given)",
    "PRINT the instruction for the human probe: buy exactly that size at that price, limit IOC, from the probe master",
    "wait (up to --wait-min minutes) for the maker's fill on the user stream; record `builder_fee`, fee and trade id",
    "record the builder account's /v2/balances again; cancel anything left (cancel-all NIGHT-USD)",
  ],
  pass: "builder_fee is non-zero on the maker's ORDER_TRADE_UPDATE, and the builder account balance increases",
  fallback: "Builder fees apply to exits only, or are dropped before any revenue claim",
  exposure:
    "one ≈ $10.5 NIGHT short, closed by the probe's own trade; label the trade id a probe (excluded from KPIs)",
  options: {
    "--account": "holder #0 account id (required for --live)",
    "--key": "holder #0 sealed key (required for --live)",
    "--builder-account": "the builder payout account id (to see its balance move)",
    "--builder-key": "its sealed key (signed GET /v2/balances)",
    "--wait-min": "minutes to wait for the probe's fill (default 10)",
  },
};

export function dryRunBodies() {
  const m = engineMarket(REFERENCE_MARKETS["NIGHT-USD"]);
  const px = m.tick.ceilUnits(dec("0.03835"));
  return {
    note: "illustrative mark 0.03835 and no fragile long; the live run computes F first",
    header: { "X-Builder-Fee-Bps": "10" },
    makerAsk: { replacements: [{ new_order: tenDollarAsk(m, probeId("d3", 1, 0), px) }] },
    humanProbe: "buy <size> NIGHT-USD at <price>, limit IOC, from the probe master (Strike app)",
    cancelAll: { symbol: "NIGHT-USD" },
  };
}

interface BalanceRow {
  asset: string;
  walletBalance: string;
}

export async function live(ctx: LiveContext, args: DayOneArgs) {
  const accountId = requireOpt(args, "account", PLAN);
  const waitMin = Number(args.opts["wait-min"] ?? "10");
  const signer = ctx.signer(requireOpt(args, "key", PLAN));
  const maker = ctx.client(signer, accountId, 10);
  const tap = await ctx.tap(signer, accountId);
  const builderAccount = args.opts["builder-account"];
  const builderKey = args.opts["builder-key"];
  const builder =
    builderAccount && builderKey ? ctx.client(ctx.signer(builderKey), builderAccount) : null;
  const balance = async () =>
    builder
      ? ((await builder.get<BalanceRow[]>("/v2/balances"))?.[0]?.walletBalance ?? null)
      : null;

  const s = await nightState(ctx);
  const px = maxTicks(s.floorTicks, markPlusBps(s, 0), (s.bestBidTicks ?? 0n) + 1n);
  const ask: CreateOrderBody = tenDollarAsk(s.market, probeId("d3", 1, ctx.now()), px);
  const before = await balance();
  await maker.replaceBatch({ replacements: [{ new_order: ask }] }, { builderFeeBps: 10 });
  ctx.log(
    `HUMAN PROBE: from the probe master (another family), buy ${ask.size} NIGHT-USD at ${ask.price}, limit IOC, now.`,
  );
  const fill = await tap.waitFor(
    (ev) => ev.kind === "fill" && ev.data.c === ask.client_order_id,
    waitMin * 60_000,
  );
  await ctx.sleep(2_000);
  const after = await balance();
  await maker.cancelAll({ symbol: s.market.symbol });
  const data = fill && fill.kind === "fill" ? fill.data : null;
  const builderFee = data?.builder_fee ?? null;
  const feeNonZero = builderFee !== null && /[1-9]/.test(builderFee);
  const balanceUp = before !== null && after !== null ? dec(after).greaterThan(dec(before)) : null;
  return {
    pass: feeNonZero && balanceUp === true,
    evidence: {
      accountId,
      price: ask.price,
      size: ask.size,
      floorTicks: s.floorTicks.toString(),
      fill: data
        ? {
            tradeId: data.t.toString(),
            maker: data.m,
            qty: data.l,
            px: data.L,
            fee: data.n,
            builderFee,
          }
        : null,
      builderBalance: { before, after, increased: balanceUp },
      probeLabel: "PROBE: exclude this trade id from KPIs",
    },
  };
}

export const main = (argv: readonly string[], env?: NodeJS.ProcessEnv, out?: (s: string) => void) =>
  runDayOne(PLAN, { dryRun: () => dryRunBodies(), live }, argv, env, out);

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
