/**
 * D8 (plan section 11): how many /ws/user-api logons one IP may hold, and how replace-batch
 * operations count toward Strike's orders/min budget.
 *
 *   pnpm exec tsx apps/cli/src/dayone/d8-socket-and-rate-limits.ts [--dry-run]
 *   BALLAST_ARM=1 pnpm exec tsx apps/cli/src/dayone/d8-socket-and-rate-limits.ts --live \
 *     --yes-i-approve --eligible-host --account <id> --key <sealed key file>
 *
 * Bounded on purpose: rounds of 5/10/20/40 sockets, then at most --batches replace-batches of
 * one cancel + one far ask, spaced ≥ 2.1 s (≤ 60 ops/min, a twentieth of the advertised budget).
 * It records what Strike answers; it does not try to find the budget by exceeding it.
 */
import { pathToFileURL } from "node:url";
import { engineMarket, REFERENCE_MARKETS } from "@ballast/engine";
import { dec } from "@ballast/market";
import {
  type ApiWalletSigner,
  ReconnectingSocket,
  type ServerClock,
  StrikeApiError,
} from "@ballast/strike-client";
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
  id: "D8",
  title: "User-stream sockets per IP and replace-batch rate accounting",
  network: "strike-mainnet",
  prerequisites: [
    "one account's sealed key (the same key is logged on N times)",
    "the keeper stopped for that account (its socket would count too)",
  ],
  steps: [
    "for N in --rounds (default 5,10,20,40): open N /ws/user-api sockets, session.logon + subscribe each; record which go live, which are refused (code, message, close code); close all; wait 10 s",
    "stop at the first round with a refusal: that is the cap",
    "then up to --batches (default 20) replace-batches, each [cancel the previous ask, create one ask ≈ $10.5 at ceil(mark × 1.04)], spaced --spacing-ms (default 2100)",
    "record each answer's status and any rate-limit headers (x-ratelimit-*, retry-after); stop at the first 429",
    "cancel-all NIGHT-USD",
  ],
  pass: "Socket cap found; budgets calibrated",
  fallback:
    "Shard keepers by IP, or poll public reads (openOrders, history/fill?since_trade_id) every 2 s",
  exposure: "one ≈ $10.5 post-only ask 4% above mark resting at a time; ≤ 2 order ops per 2.1 s",
  options: {
    "--account": "account id (live)",
    "--key": "sealed key (live)",
    "--rounds": "comma-separated socket counts (default 5,10,20,40)",
    "--batches": "replace-batches to send (default 20)",
    "--spacing-ms": "spacing between replace-batches (default 2100, never below 2000)",
    "--round-pause-ms": "pause between socket rounds (default 10000)",
  },
};

export function dryRunBodies(args: DayOneArgs) {
  const m = engineMarket(REFERENCE_MARKETS["NIGHT-USD"]);
  const px = m.tick.ceilUnits(dec("0.03835").times(1.04));
  return {
    rounds: (args.opts.rounds ?? "5,10,20,40").split(",").map(Number),
    logon: {
      id: 1,
      method: "session.logon",
      params: { apiKey: "<public key>", signature: "<sig>", timestamp: "<ms>" },
    },
    subscribe: { method: "subscribe", channel: "userstream", id: 2 },
    batch: {
      replacements: [
        {
          cancel: { order_id: "<previous ask id>", symbol: "NIGHT-USD" },
          new_order: tenDollarAsk(m, probeId("d8", 1, 0), px),
        },
      ],
    },
  };
}

interface SocketOutcome {
  live: boolean;
  error?: string;
  closeCode?: number;
}

/** One raw logon + subscribe on its own socket (UserStream allows one per key per process). */
function probeSocket(
  url: string,
  ua: string,
  signer: ApiWalletSigner,
  clock: ServerClock,
): {
  done: Promise<SocketOutcome>;
  stop: () => void;
} {
  let resolve: (o: SocketOutcome) => void = () => {};
  const done = new Promise<SocketOutcome>((r) => {
    resolve = r;
  });
  const sock = new ReconnectingSocket({
    url,
    userAgent: ua,
    maxBackoffMs: 60_000,
    onOpen: (s) => {
      s.send({
        id: 1,
        method: "session.logon",
        params: signer.signLogon(clock.logonTimestampMs()),
      });
    },
    onMessage: (m) => {
      const d = m as Record<string, unknown> | null;
      if (!d) return;
      if (d.e === "error") {
        const err = d.error as { code?: number; msg?: string } | undefined;
        resolve({ live: false, error: `${err?.code ?? "?"} ${err?.msg ?? ""}`.trim() });
      } else if (d.id === 1 && d.status === 200) {
        s2();
      } else if (d.id === 2 && d.result === null) {
        resolve({ live: true });
      }
    },
    onStateChange: (state, info) => {
      if (state === "closed")
        resolve({
          live: false,
          ...(info.code !== undefined ? { closeCode: info.code } : {}),
          error: info.reason ?? info.error ?? "closed",
        });
    },
  });
  const s2 = () => sock.send({ method: "subscribe", channel: "userstream", id: 2 });
  sock.start();
  setTimeout(() => resolve({ live: false, error: "timeout" }), 15_000).unref();
  return { done, stop: () => sock.stop() };
}

export async function live(ctx: LiveContext, args: DayOneArgs) {
  const accountId = requireOpt(args, "account", PLAN);
  const signer = ctx.signer(requireOpt(args, "key", PLAN));
  const rounds = (args.opts.rounds ?? "5,10,20,40").split(",").map(Number);
  if (rounds.some((n) => !Number.isInteger(n) || n < 1 || n > 40))
    throw new Error("--rounds: 1..40");
  const sockets: { n: number; live: number; refused: SocketOutcome[] }[] = [];
  let cap: number | null = null;
  for (const n of rounds) {
    const probes = Array.from({ length: n }, () =>
      probeSocket(`${ctx.ws}/ws/user-api`, ctx.userAgent, signer, ctx.clock),
    );
    const outcomes = await Promise.all(probes.map((p) => p.done));
    for (const p of probes) p.stop();
    const refused = outcomes.filter((o) => !o.live);
    sockets.push({ n, live: outcomes.length - refused.length, refused });
    if (refused.length > 0) {
      cap = outcomes.length - refused.length;
      break;
    }
    await ctx.sleep(Number(args.opts["round-pause-ms"] ?? "10000"));
  }

  const headers: Record<string, string>[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const h: Record<string, string> = { status: String(res.status) };
    res.headers.forEach((v, k) => {
      if (/ratelimit|retry-after|x-mbx|weight/i.test(k)) h[k] = v;
    });
    headers.push(h);
    return res;
  };
  const client = ctx.client(signer, accountId, undefined, recordingFetch);
  const tap = await ctx.tap(signer, accountId);
  const s = await nightState(ctx);
  const batches = Math.min(Number(args.opts.batches ?? "20"), 30);
  const spacing = Math.max(Number(args.opts["spacing-ms"] ?? "2100"), 2_000);
  const answers: { n: number; status: number | string }[] = [];
  let prev: bigint | null = null;
  for (let n = 1; n <= batches; n++) {
    const ask = tenDollarAsk(s.market, probeId("d8", n, ctx.now()), markPlusBps(s, 400));
    try {
      await client.replaceBatch({
        replacements: [
          {
            ...(prev !== null ? { cancel: { order_id: prev, symbol: s.market.symbol } } : {}),
            new_order: ask,
          },
        ],
      });
      answers.push({ n, status: 200 });
      const open = await tap.waitFor(isOrderEvent(ask.client_order_id, "OPEN"), 5_000);
      prev = open && (open.kind === "order" || open.kind === "fill") ? open.data.i : null;
    } catch (err) {
      answers.push({ n, status: err instanceof StrikeApiError ? err.status : String(err) });
      if (err instanceof StrikeApiError && err.status === 429) break;
    }
    await ctx.sleep(spacing);
  }
  await client.cancelAll({ symbol: s.market.symbol }).catch(() => {});
  // Confirm the cleanup on the stream: every probe ask must be gone before the report.
  const open = tap.events
    .map((e) => e.ev)
    .flatMap((ev) =>
      (ev.kind === "order" || ev.kind === "fill") && ev.data.X === "OPEN" ? [ev.data.c] : [],
    );
  await Promise.all(open.map((c) => tap.waitFor(isOrderEvent(c, "CANCELED"), 10_000)));
  return {
    pass: sockets.length > 0 && answers.length > 0,
    evidence: {
      accountId,
      sockets,
      socketCap: cap ?? `≥ ${rounds.at(-1)} (no refusal seen)`,
      replaceBatches: answers,
      opsPerMinute: Math.round((2 * 60_000) / spacing),
      rateHeaders: headers,
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
