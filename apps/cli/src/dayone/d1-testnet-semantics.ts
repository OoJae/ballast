/**
 * D1 (plan section 11): testnet write semantics, the M1 exit gate.
 *
 *   pnpm exec tsx apps/cli/src/dayone/d1-testnet-semantics.ts [--dry-run]
 *   pnpm exec tsx apps/cli/src/dayone/d1-testnet-semantics.ts --live --yes-i-approve \
 *     --eligible-host --account <testnet account id> --key <sealed strike key file>
 *
 * Runs against api-v2-testnet.strikefinance.org only (testnet trades BTC, ETH and SOL).
 */
import { pathToFileURL } from "node:url";
import { Grid } from "@ballast/market";
import {
  type CreateOrderBody,
  type L3Snapshot,
  limitOrder,
  type ReplaceBatchBody,
  type SignedClient,
  StrikeApiError,
} from "@ballast/strike-client";
import {
  type DayOneArgs,
  type DayOnePlan,
  isOrderEvent,
  type LiveContext,
  probeId,
  requireOpt,
  runDayOne,
  type StreamTap,
} from "./m6-kit.js";

export const PLAN: DayOnePlan = {
  id: "D1",
  title: "Testnet: replace-batch and batch semantics, signing at /v2/time − 1 s",
  network: "strike-testnet",
  prerequisites: [
    "a testnet Strike account with a little collateral (no faucet is documented; FRICTION)",
    "its API wallet sealed under the host KEK (--key), and its account id (--account)",
    "this host attested eligible (not in a Strike-restricted jurisdiction)",
  ],
  steps: [
    "GET /v2/time ×5 and sign every request at server time − 1 s (ServerClock)",
    "GET /v2/markets and /v2/l3/snapshot for the symbol: tick, step, best bid and ask",
    "POST /v2/orders/batch: two post-only asks ≥ 4% above the best ask, each ≈ $10.5; expect OPEN for both",
    "POST /v2/order/replace-batch: cancel ask 1, create ask 3; expect CANCELED and OPEN",
    "(a) replace-batch [cancel ask 2, create an off-tick ask]: a static-rule failure",
    "(b) replace-batch [far ask, a post-only ask at the best bid (crosses), near ask] in that order",
    "(c) POST /v2/orders/batch with one item on an unknown symbol (BTCX-USD)",
    "DELETE /v2/order/cancel-all {symbol}; confirm GET /v2/openOrders is empty",
  ],
  pass: "(a) nothing applied, no cancels (ask 2 still OPEN, the off-tick create REJECTED). (b) earlier creates rest; later ones are skipped with no event (far OPEN, crossing REJECTED, near: no event and GET /v2/order 404). (c) no event within 2 s; GET /v2/order returns 404.",
  fallback:
    "If testnet collateral can't be obtained: the same tests on mainnet BTC-USD with $10 post-only orders 4% from mid (a separate, approved run). If semantics differ: cancel + batch as two commands, counting both old and new orders as resting until events arrive.",
  exposure:
    "testnet only; at most four resting post-only asks ≈ $10.5 each, 4-6% away from the book",
  options: {
    "--account": "testnet account id (required for --live)",
    "--key": "sealed Strike key file for that account (required for --live)",
    "--symbol": "testnet symbol, default BTC-USD",
  },
};

const SYMBOL_DEFAULT = "BTC-USD";

interface Rules {
  tick: Grid;
  step: Grid;
}

/** ≈ $10.5 at `px`: rounded up to the step. */
function sizeFor(rules: Rules, pxTicks: bigint): string {
  const px = rules.tick.fromUnits(pxTicks);
  return rules.step.fromUnits(rules.step.ceilUnits(px.pow(-1).times(10.5))).toFixed();
}

function ask(rules: Rules, cid: string, symbol: string, pxTicks: bigint): CreateOrderBody {
  return limitOrder({
    clientOrderId: cid,
    symbol,
    side: "sell",
    size: sizeFor(rules, pxTicks),
    price: rules.tick.fromUnits(pxTicks).toFixed(),
    postOnly: true,
  });
}

/** The would-send bodies for a dry run, on an illustrative BTC grid (tick 0.1, step 0.00001). */
export function dryRunBodies(symbol = SYMBOL_DEFAULT) {
  const rules: Rules = { tick: new Grid("0.1"), step: new Grid("0.00001") };
  const best = 1_000_000n; // illustrative: best ask 100,000.0
  const at = (bps: bigint) => (best * (10_000n + bps)) / 10_000n;
  const id = (n: number) => probeId("d1", n, 0);
  return {
    note: "illustrative prices on a BTC-like grid; the live run reads /v2/markets and L3 first",
    batch: { orders: [ask(rules, id(1), symbol, at(400n)), ask(rules, id(2), symbol, at(500n))] },
    replace: {
      replacements: [
        {
          cancel: { order_id: "<ask 1 id>", symbol },
          new_order: ask(rules, id(3), symbol, at(450n)),
        },
      ],
    },
    staticFailure: {
      replacements: [
        {
          cancel: { order_id: "<ask 2 id>", symbol },
          new_order: { ...ask(rules, id(4), symbol, at(470n)), price: "100470.05" },
        },
      ],
    },
    crossMidBatch: {
      replacements: [
        { new_order: ask(rules, id(5), symbol, at(600n)) },
        { new_order: { ...ask(rules, id(6), symbol, at(-100n)), price: "<best bid>" } },
        { new_order: ask(rules, id(7), symbol, at(410n)) },
      ],
    },
    unknownSymbol: { orders: [ask(rules, id(8), "BTCX-USD", at(400n))] },
    cancelAll: { symbol },
  };
}

async function lookup(client: SignedClient, symbol: string, cid: string): Promise<number> {
  try {
    await client.getOrder(symbol, { clientOrderId: cid });
    return 200;
  } catch (err) {
    if (err instanceof StrikeApiError) return err.status;
    throw err;
  }
}

async function statusOf(tap: StreamTap, cid: string, ms: number): Promise<string | null> {
  const ev = await tap.waitFor(isOrderEvent(cid), ms);
  if (!ev || (ev.kind !== "order" && ev.kind !== "fill")) return null;
  // Prefer a terminal or OPEN status if several arrived.
  const all = tap.events
    .map((e) => e.ev)
    .filter((e) => (e.kind === "order" || e.kind === "fill") && e.data.c === cid)
    .map((e) => (e.kind === "order" || e.kind === "fill" ? e.data.X : ""));
  return all.at(-1) ?? null;
}

export async function live(ctx: LiveContext, args: DayOneArgs) {
  const symbol = args.opts.symbol ?? SYMBOL_DEFAULT;
  const accountId = requireOpt(args, "account", PLAN);
  const signer = ctx.signer(requireOpt(args, "key", PLAN));
  const client = ctx.client(signer, accountId);
  const tap = await ctx.tap(signer, accountId);
  const { markets } = await ctx.reads.markets();
  const m = markets[symbol] as Record<string, string> | undefined;
  if (!m) throw new Error(`${symbol} is not listed on this host`);
  const rules: Rules = {
    tick: new Grid(m.order_tick_price as string),
    step: new Grid(m.order_limit_step_size as string),
  };
  // VERIFY: that testnet serves /v2/l3/snapshot for BTC-USD as mainnet does (FRICTION 2026-10-23).
  const snap: L3Snapshot = await ctx.reads.l3Snapshot(symbol);
  const bestAsk = snap.asks[0]?.price;
  const bestBid = snap.bids[0]?.price;
  if (!bestAsk || !bestBid) throw new Error("the book needs both sides for D1");
  const askT = rules.tick.toUnits(bestAsk);
  const bidT = rules.tick.toUnits(bestBid);
  const at = (bps: bigint) => (askT * (10_000n + bps) + 9_999n) / 10_000n;
  const n = { i: 0 };
  const id = () => probeId("d1", ++n.i, ctx.now());
  const results: Record<string, unknown> = { clockOffsetMs: ctx.clock.offsetMs, bestBid, bestAsk };

  // Base: two asks via orders/batch.
  const a1 = ask(rules, id(), symbol, at(400n));
  const a2 = ask(rules, id(), symbol, at(500n));
  const batch = await client.placeBatch({ orders: [a1, a2] });
  const base = {
    a1: await statusOf(tap, a1.client_order_id, 5_000),
    a2: await statusOf(tap, a2.client_order_id, 5_000),
  };
  results.base = { response: batch, ...base, ok: base.a1 === "OPEN" && base.a2 === "OPEN" };
  const idOf = async (cid: string) =>
    BigInt((await client.getOrder(symbol, { clientOrderId: cid })).ID);
  const a1Id = await idOf(a1.client_order_id);
  const a2Id = await idOf(a2.client_order_id);

  // replace-batch: cancel a1, create a3.
  const a3 = ask(rules, id(), symbol, at(450n));
  await client.replaceBatch({
    replacements: [{ cancel: { order_id: a1Id, symbol }, new_order: a3 }],
  });
  const a1Canceled =
    (await tap.waitFor(isOrderEvent(a1.client_order_id, "CANCELED"), 5_000)) !== null;
  const rb = { a1Canceled, a3: await statusOf(tap, a3.client_order_id, 5_000) };
  results.replace = { ...rb, ok: rb.a1Canceled && rb.a3 === "OPEN" };

  // (a) a static-rule failure: an off-tick price.
  // Half a tick off the grid: Strike's static rules reject it, so the whole command applies nothing.
  const offTick = {
    ...ask(rules, id(), symbol, at(470n)),
    price: rules.tick.fromUnits(at(470n)).plus(rules.tick.unit.div(2)).toFixed(),
  };
  const aBody: ReplaceBatchBody = {
    replacements: [{ cancel: { order_id: a2Id, symbol }, new_order: offTick }],
  };
  let aStatus: number | string = 200;
  try {
    await client.write("POST", "/v2/order/replace-batch", aBody);
  } catch (err) {
    aStatus = err instanceof StrikeApiError ? err.status : String(err);
  }
  await ctx.sleep(3_000);
  const a2Canceled = tap.events.some((e) => isOrderEvent(a2.client_order_id, "CANCELED")(e.ev));
  const offTickStatus = await statusOf(tap, offTick.client_order_id, 100);
  results.staticFailure = {
    httpStatus: aStatus,
    a2Canceled,
    offTickStatus,
    ok: !a2Canceled && offTickStatus !== "OPEN",
  };

  // (b) a post-only cross in the middle of a batch.
  const far = ask(rules, id(), symbol, at(600n));
  const cross = { ...ask(rules, id(), symbol, bidT), price: rules.tick.fromUnits(bidT).toFixed() };
  const near = ask(rules, id(), symbol, at(410n));
  await client.write("POST", "/v2/order/replace-batch", {
    replacements: [{ new_order: far }, { new_order: cross }, { new_order: near }],
  });
  const farS = await statusOf(tap, far.client_order_id, 5_000);
  const crossS = await statusOf(tap, cross.client_order_id, 5_000);
  const nearS = await statusOf(tap, near.client_order_id, 2_000);
  const nearLookup = await lookup(client, symbol, near.client_order_id);
  results.crossMidBatch = {
    far: farS,
    crossing: crossS,
    near: nearS,
    nearLookup,
    ok: farS === "OPEN" && crossS === "REJECTED" && nearS === null && nearLookup === 404,
  };

  // (c) an unknown-symbol batch item.
  const ghost = ask(rules, id(), symbol, at(400n));
  ghost.symbol = "BTCX-USD";
  const ghostRes = await client.placeBatch({ orders: [ghost] });
  const ghostEvent = await statusOf(tap, ghost.client_order_id, 2_000);
  const ghostLookup = await lookup(client, "BTCX-USD", ghost.client_order_id);
  results.unknownSymbol = {
    response: ghostRes,
    event: ghostEvent,
    lookup: ghostLookup,
    ok: ghostEvent === null && ghostLookup === 404,
  };

  await client.cancelAll({ symbol });
  await ctx.sleep(2_000);
  const left = await client.openOrders(symbol);
  results.cleanup = { openOrders: left.orders.length };
  const parts = ["base", "replace", "staticFailure", "crossMidBatch", "unknownSymbol"] as const;
  const pass = parts.every((p) => (results[p] as { ok: boolean }).ok) && left.orders.length === 0;
  return { pass, evidence: { symbol, accountId, results } };
}

export const main = (argv: readonly string[], env?: NodeJS.ProcessEnv, out?: (s: string) => void) =>
  runDayOne(PLAN, { dryRun: (a) => dryRunBodies(a.opts.symbol), live }, argv, env, out);

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
