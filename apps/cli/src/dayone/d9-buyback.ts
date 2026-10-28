/**
 * D9, step 1 (plan section 11): close the account's NIGHT short before the withdrawal, with one
 * reduce-only IOC buy-back from Ballast's own signer (invariants 1 and 6: every buy reduces).
 *
 *   pnpm exec tsx apps/cli/src/dayone/d9-buyback.ts [--dry-run]
 *   BALLAST_ARM=1 pnpm exec tsx apps/cli/src/dayone/d9-buyback.ts --live --yes-i-approve \
 *     --eligible-host --account <id> --key <sealed key file> [--cap-bps 100]
 */
import { pathToFileURL } from "node:url";
import { engineMarket, REFERENCE_MARKETS } from "@ballast/engine";
import { dec } from "@ballast/market";
import { type CreateOrderBody, reduceOnlyBuyBack, type SignedClient } from "@ballast/strike-client";
import {
  type DayOneArgs,
  type DayOnePlan,
  type LiveContext,
  markPlusBps,
  nightState,
  probeId,
  requireOpt,
  runDayOne,
} from "./m6-kit.js";

export const PLAN: DayOnePlan = {
  id: "D9a",
  title: "Close the account's NIGHT-USD short: one reduce-only IOC buy-back",
  network: "strike-mainnet",
  prerequisites: [
    "the account holds a NIGHT-USD short (D3, and D6 if it ran); nothing else is open",
    "its API wallet sealed under the host KEK",
  ],
  steps: [
    "signed GET /v2/positions and /v2/openOrders: the position must be a short, and no order may rest",
    "public mark and top of book; cap = ceil(mark × (1 + --cap-bps))",
    "POST /v2/order: buy |short| NIGHT-USD, limit = cap, IOC, reduce_only (no bid ever rests)",
    "wait for a terminal status on the user stream, then re-read the position",
  ],
  pass: "The NIGHT-USD position is flat",
  fallback: "Report the residual; close it in Strike's app (reduce-only), then withdraw",
  exposure: "buys at most |short| at ≤ cap; it can only shrink the short",
  options: {
    "--account": "the account id (required for --live)",
    "--key": "sealed Strike key file (required for --live)",
    "--cap-bps": "price cap above mark in bps (default 100, at most 400 like the keeper)",
  },
};

const TERMINAL = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);

export function capBps(args: DayOneArgs): number {
  const bps = Number(args.opts["cap-bps"] ?? "100");
  if (!Number.isInteger(bps) || bps < 1 || bps > 400) throw new Error("--cap-bps must be 1..400");
  return bps;
}

export function dryRunBody(args: DayOneArgs) {
  const m = engineMarket(REFERENCE_MARKETS["NIGHT-USD"]);
  const mark = dec("0.0428");
  const cap = m.tick.ceilUnits(mark.times(dec(10_000 + capBps(args))).div(10_000));
  return {
    note: "illustrative mark 0.0428 and short 272; the live run reads both first",
    order: reduceOnlyBuyBack({
      clientOrderId: probeId("d9x", 1, 0),
      symbol: "NIGHT-USD",
      size: "272",
      price: m.tick.fromUnits(cap).toFixed(),
    }),
  };
}

async function nightShort(client: SignedClient): Promise<string | null> {
  const { positions } = await client.positions("NIGHT-USD");
  const p = positions.find((x) => x.symbol === "NIGHT-USD" && dec(x.size).abs().gt(0));
  return p ? p.size : null;
}

export async function live(ctx: LiveContext, args: DayOneArgs) {
  const accountId = requireOpt(args, "account", PLAN);
  const bps = capBps(args);
  const signer = ctx.signer(requireOpt(args, "key", PLAN));
  const client = ctx.client(signer, accountId, 0);
  const before = await nightShort(client);
  if (before === null) {
    ctx.log("no NIGHT-USD position: nothing to buy back");
    return { pass: true, evidence: { accountId, before: null, after: null } };
  }
  if (!dec(before).isNegative()) throw new Error(`position is long (${before}), not a short`);
  const open = await client.openOrders("NIGHT-USD");
  if ((open.orders ?? []).length > 0) {
    throw new Error(`${open.orders.length} order(s) rest on NIGHT-USD: cancel them first`);
  }
  const s = await nightState(ctx);
  const size = dec(before).abs().toFixed();
  const cap = s.market.tick.fromUnits(markPlusBps(s, bps)).toFixed();
  const tap = await ctx.tap(signer, accountId);
  const body: CreateOrderBody = reduceOnlyBuyBack({
    clientOrderId: probeId("d9x", 1, ctx.now()),
    symbol: s.market.symbol,
    size,
    price: cap,
  });
  ctx.log(
    `buy-back: ${size} NIGHT-USD, IOC, reduce-only, limit ${cap} (mark ${s.mark.toFixed()}, best ask ${
      s.bestAskTicks === null ? "none" : s.market.tick.fromUnits(s.bestAskTicks).toFixed()
    })`,
  );
  await client.placeBuyBack(body);
  const done = await tap.waitFor(
    (ev) =>
      (ev.kind === "order" || ev.kind === "fill") &&
      ev.data.c === body.client_order_id &&
      TERMINAL.has(ev.data.X),
    30_000,
  );
  // Unknown counts as resting (invariant 9): read the position either way, never resend blind.
  await ctx.sleep(1_500);
  const after = await nightShort(client);
  const fills = tap.events.flatMap(({ ev }) =>
    ev.kind === "fill" && ev.data.c === body.client_order_id ? [ev.data] : [],
  );
  tap.stop();
  ctx.log(
    `terminal: ${done ? (done.kind === "order" || done.kind === "fill" ? done.data.X : done.kind) : "none in 30 s"}; position after: ${after ?? "flat"}`,
  );
  return {
    pass: after === null,
    evidence: {
      accountId,
      before,
      order: { size, price: cap, capBps: bps },
      mark: s.mark.toFixed(),
      terminal: done && (done.kind === "order" || done.kind === "fill") ? done.data.X : null,
      fills,
      after,
    },
  };
}

export const main = (argv: readonly string[], env?: NodeJS.ProcessEnv, out?: (s: string) => void) =>
  runDayOne(PLAN, { dryRun: (args) => dryRunBody(args), live }, argv, env, out);

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
