/**
 * D2 (plan section 11): mainnet builder attribution on a resting ask.
 *
 *   pnpm exec tsx apps/cli/src/dayone/d2-builder-attribution.ts [--dry-run]
 *   BALLAST_ARM=1 pnpm exec tsx apps/cli/src/dayone/d2-builder-attribution.ts --live \
 *     --yes-i-approve --eligible-host --account <id> --key <sealed key file>
 */
import { pathToFileURL } from "node:url";
import { engineMarket, REFERENCE_MARKETS } from "@ballast/engine";
import { dec } from "@ballast/market";
import type { CreateOrderBody, SignedClient, StrikeOrder } from "@ballast/strike-client";
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
  id: "D2",
  title: "Mainnet: builder attribution on a $10 post-only NIGHT ask",
  network: "strike-mainnet",
  prerequisites: [
    "D0 done: builder code `ballast` registered and active in the Strike app (fee share ≥ 10 bps)",
    "holder #0's Strike master account with margin; its API wallet sealed under the host KEK",
    "the account approved a builder fee of at least 10 bps at Builder Connect",
  ],
  steps: [
    "GET /v2/markets (NIGHT-USD rules) and /price/v2/premiumIndex (mark)",
    "route A: POST /v2/order/replace-batch with one post-only ask ≈ $10.5 at ceil(mark × 1.04), header X-Builder-Fee-Bps: 10",
    "route B: POST /v2/orders/batch with one more such ask at ceil(mark × 1.041), same header",
    "wait for OPEN on the user stream for both",
    "public GET /v2/order?account_id=<id>&client_order_id=<id> (no key) and the signed GET for each",
    "DELETE /v2/order/cancel-all {symbol: NIGHT-USD}; confirm both CANCELED",
  ],
  pass: 'Public GET /v2/order?account_id&client_order_id shows Builder{Code:"Ballast",FeeBps:10}',
  fallback: "Test single vs batch routes; report to Strike; run fee 0 (attribution remains)",
  exposure: "two ≈ $10.5 post-only asks 4% above mark for a few seconds; no fill expected",
  options: {
    "--account": "holder #0 account id (required for --live)",
    "--key": "sealed Strike key file (required for --live)",
    "--fee-bps": "builder fee to attach (default 10)",
  },
};

export function dryRunBodies() {
  const m = engineMarket(REFERENCE_MARKETS["NIGHT-USD"]);
  const mark = dec("0.03835");
  const at = (bps: number) => m.tick.ceilUnits(mark.times(1 + bps / 10_000));
  return {
    note: "illustrative mark 0.03835; the live run reads the mark first",
    header: { "X-Builder-Fee-Bps": "10" },
    routeA: { replacements: [{ new_order: tenDollarAsk(m, probeId("d2", 1, 0), at(400)) }] },
    routeB: { orders: [tenDollarAsk(m, probeId("d2", 2, 0), at(410))] },
    cancelAll: { symbol: "NIGHT-USD" },
  };
}

interface Attribution {
  route: string;
  clientOrderId: string;
  status: string | null;
  publicBuilder: unknown;
  signedBuilder: unknown;
  publicError?: string;
  ok: boolean;
}

function builderOf(o: StrikeOrder | null): unknown {
  return (o as unknown as { Builder?: unknown } | null)?.Builder ?? null;
}

export async function live(ctx: LiveContext, args: DayOneArgs) {
  const accountId = requireOpt(args, "account", PLAN);
  const fee = Number(args.opts["fee-bps"] ?? "10");
  if (!Number.isInteger(fee) || fee < 0 || fee > 10) throw new Error("--fee-bps must be 0..10");
  const signer = ctx.signer(requireOpt(args, "key", PLAN));
  const client: SignedClient = ctx.client(signer, accountId, fee);
  const tap = await ctx.tap(signer, accountId);
  const s = await nightState(ctx);
  const a: CreateOrderBody = tenDollarAsk(
    s.market,
    probeId("d2", 1, ctx.now()),
    markPlusBps(s, 400),
  );
  const b: CreateOrderBody = tenDollarAsk(
    s.market,
    probeId("d2", 2, ctx.now()),
    markPlusBps(s, 410),
  );
  await client.replaceBatch({ replacements: [{ new_order: a }] }, { builderFeeBps: fee });
  await client.placeBatch({ orders: [b] }, { builderFeeBps: fee });
  const out: Attribution[] = [];
  for (const [route, o] of [
    ["replace-batch", a],
    ["orders/batch", b],
  ] as const) {
    const ev = await tap.waitFor(isOrderEvent(o.client_order_id, "OPEN"), 10_000);
    let pub: StrikeOrder | null = null;
    let publicError: string | undefined;
    try {
      // VERIFY: the FlexibleAuth public read (account_id selector, no key) serves Builder.
      pub = await ctx.http.getJson<StrikeOrder>("/v2/order", {
        symbol: s.market.symbol,
        account_id: accountId,
        client_order_id: o.client_order_id,
      });
    } catch (err) {
      publicError = err instanceof Error ? err.message : String(err);
    }
    const signed = await client.getOrder(s.market.symbol, { clientOrderId: o.client_order_id });
    const want = { Code: process.env.BALLAST_BUILDER_CODE ?? "Ballast", FeeBps: fee };
    const pb = builderOf(pub);
    out.push({
      route,
      clientOrderId: o.client_order_id,
      status: ev && (ev.kind === "order" || ev.kind === "fill") ? ev.data.X : null,
      publicBuilder: pb,
      signedBuilder: builderOf(signed),
      ...(publicError ? { publicError } : {}),
      ok: JSON.stringify(pb) === JSON.stringify(want),
    });
  }
  await client.cancelAll({ symbol: s.market.symbol });
  const canceled = await Promise.all(
    [a, b].map((o) => tap.waitFor(isOrderEvent(o.client_order_id, "CANCELED"), 10_000)),
  );
  return {
    pass: out.every((x) => x.ok),
    evidence: {
      accountId,
      feeBps: fee,
      mark: s.mark.toFixed(),
      attribution: out,
      cleanedUp: canceled.every((e) => e !== null),
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
