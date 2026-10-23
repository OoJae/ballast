/**
 * D10 (plan section 11): the cover oracle against live Cardano mainnet (read-only Koios).
 *
 *   pnpm exec tsx apps/cli/src/dayone/d10-cover-oracle.ts [--dry-run]
 *   BALLAST_ARM=1 pnpm exec tsx apps/cli/src/dayone/d10-cover-oracle.ts --live --yes-i-approve \
 *     --eligible-host --stake <stake1…> [--addresses addr1…,addr1…] [--minutes 10]
 *
 * Reads only: Koios tip and account UTxOs (and an Ogmios mempool when BALLAST_OGMIOS_URL is
 * set). No Strike request, no key, no transaction. It still takes the full live gate because it
 * touches mainnet data that the keeper will act on.
 */
import { pathToFileURL } from "node:url";
import {
  BindingConflictError,
  bindableStake,
  CoverOracle,
  KOIOS_MAINNET_URL,
  KoiosClient,
  type KoiosReader,
  NIGHT,
  StakeBindings,
  sharedStakeKeys,
  spendsAgainstCover,
} from "@ballast/cover";
import { AccountBindingError, openEvidenceDb } from "@ballast/evidence/db";
import {
  type DayOneArgs,
  type DayOnePlan,
  type LiveContext,
  requireOpt,
  runDayOne,
} from "./m6-kit.js";

export const PLAN: DayOnePlan = {
  id: "D10",
  title:
    "Cover oracle: pinned NIGHT per stake credential at the tip, refresh latency, mempool spends, single binding",
  network: "cardano-mainnet-read-only",
  prerequisites: [
    "a bound holder's stake address (stake1…) and, for the binding test, two base addresses on one stake key",
    "optional: KOIOS_TOKEN for higher limits; BALLAST_OGMIOS_URL for the mempool test",
  ],
  steps: [
    `Koios account_utxos for the stake address: pinned NIGHT (policy ${NIGHT.policyId.slice(0, 12)}…, asset ${NIGHT.assetNameHex}) at the tip`,
    "poll the tip and the cover every --every-s (default 5 s) for --minutes (default 10); record block arrivals (~20 s) and each read's latency",
    "binding: StakeBindings and the evidence DB's UNIQUE(stake_cred) both refuse a second account on the same stake key",
    "two base addresses on one stake key are grouped as one wallet (sharedStakeKeys)",
    "mempool: with Ogmios, a pending spend of a counted UTxO must alert r = 0; without it, the matcher is exercised on the live proof and the live test is marked untested",
  ],
  pass: "Single binding enforced; latency measured; mempool event triggers r = 0",
  fallback: "Blockfrost as second provider; poll every 10 s; widen the cancel-first path",
  exposure: "none: public reads only",
  options: {
    "--stake": "the bound holder's stake1… address (required for --live)",
    "--addresses": "comma-separated base addresses expected on one stake key",
    "--minutes": "how long to watch the tip (default 10)",
    "--every-s": "poll interval in seconds (default 5)",
  },
};

export function dryRunBodies(args: DayOneArgs) {
  return {
    koios: KOIOS_MAINNET_URL,
    reads: ["GET /tip", "POST /account_utxos {_stake_addresses:[<stake>], _extended:true}"],
    watch: {
      minutes: Number(args.opts.minutes ?? "10"),
      everyS: Number(args.opts["every-s"] ?? "5"),
    },
    mempool: process.env.BALLAST_OGMIOS_URL
      ? "Ogmios configured"
      : "no BALLAST_OGMIOS_URL: live mempool test will be skipped",
  };
}

export async function liveWith(koios: KoiosReader, ctx: LiveContext, args: DayOneArgs) {
  const stake = bindableStake(requireOpt(args, "stake", PLAN));
  const oracle = new CoverOracle(koios);
  const minutes = Number(args.opts.minutes ?? "10");
  const everyMs = Number(args.opts["every-s"] ?? "5") * 1_000;

  // Single binding, both in memory and in the evidence DB's schema.
  const b = new StakeBindings();
  b.bind(stake, "probe-account-a");
  let memoryRefused = false;
  try {
    b.bind(stake, "probe-account-b");
  } catch (err) {
    memoryRefused = err instanceof BindingConflictError;
  }
  const db = openEvidenceDb(":memory:");
  db.bindAccount({ accountId: "probe-account-a", stakeCred: stake, nowMs: ctx.now() });
  let dbRefused = false;
  try {
    db.bindAccount({ accountId: "probe-account-b", stakeCred: stake, nowMs: ctx.now() });
  } catch (err) {
    dbRefused = err instanceof AccountBindingError;
  }
  db.close();
  const addresses = (args.opts.addresses ?? "").split(",").filter(Boolean);
  const groups = Object.fromEntries(sharedStakeKeys(addresses));

  const polls: { atMs: number; height: number; readMs: number; coverBase: string }[] = [];
  const end = ctx.now() + minutes * 60_000;
  let lastProof = null as Awaited<ReturnType<CoverOracle["proof"]>> | null;
  while (ctx.now() < end) {
    const t0 = ctx.now();
    try {
      const p = await oracle.proof({ kind: "stake", stakeAddress: stake });
      lastProof = p;
      polls.push({ atMs: t0, height: p.height, readMs: ctx.now() - t0, coverBase: p.coverBase });
    } catch (err) {
      ctx.log(`read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await ctx.sleep(Math.max(0, everyMs - (ctx.now() - t0)));
  }
  const arrivals: { height: number; firstSeenMs: number }[] = [];
  for (const p of polls)
    if (arrivals.at(-1)?.height !== p.height)
      arrivals.push({ height: p.height, firstSeenMs: p.atMs });
  const intervals = arrivals
    .slice(1)
    .map((a, i) => a.firstSeenMs - (arrivals[i] as { firstSeenMs: number }).firstSeenMs);
  const reads = polls.map((p) => p.readMs).sort((x, y) => x - y);

  // VERIFY: D10 — Ogmios LocalTxMonitor is a stub until a node is provisioned (FRICTION).
  const ogmios = process.env.BALLAST_OGMIOS_URL
    ? "configured, not yet implemented (stub)"
    : "skipped: no BALLAST_OGMIOS_URL";
  const first = lastProof?.utxos[0];
  const synthetic = first
    ? spendsAgainstCover(
        {
          txId: "synthetic-spend",
          inputs: [
            { txHash: first.ref.split("#")[0] as string, index: Number(first.ref.split("#")[1]) },
          ],
          seenAtMs: ctx.now(),
        },
        lastProof ? [lastProof] : [],
      )
    : [];
  const matcherRZero = synthetic.length === 1 && synthetic[0]?.rBps === 0;
  return {
    pass: memoryRefused && dbRefused && intervals.length >= 2 && matcherRZero,
    evidence: {
      stake,
      binding: { memoryRefused, dbRefused },
      sharedStakeKeys: groups,
      polls: polls.length,
      blockArrivals: arrivals.length,
      blockIntervalsMs: intervals,
      readLatencyMs: {
        p50: reads[Math.floor(reads.length / 2)] ?? null,
        max: reads.at(-1) ?? null,
      },
      lastCoverBase: lastProof?.coverBase ?? null,
      mempool: { live: ogmios, matcherRZero },
    },
  };
}

export const main = (
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
  out?: (s: string) => void,
  deps: { koios?: KoiosReader } = {},
) =>
  runDayOne(
    PLAN,
    {
      dryRun: dryRunBodies,
      live: (ctx, args) =>
        liveWith(
          deps.koios ??
            new KoiosClient({
              baseUrl: (env ?? process.env).KOIOS_URL ?? KOIOS_MAINNET_URL,
              ...((env ?? process.env).KOIOS_TOKEN
                ? { token: (env ?? process.env).KOIOS_TOKEN as string }
                : {}),
            }),
          ctx,
          args,
        ),
    },
    argv,
    env,
    out,
  );

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
