import { openEvidenceDb } from "@ballast/evidence/db";
import {
  accountUrl,
  type DayoneArgs,
  type DayoneDeps,
  type DayonePlan,
  evidencePath,
  microUsd,
  parseDayoneArgs,
  pollUntil,
  readAccount,
  renderPlan,
  runAsScript,
  runtime,
  USER_AGENT,
  writeEvidence,
} from "./common.js";

/**
 * D5 (plan §11): in-app ADA deposit, quote → build-tx (utxos) → signTx(partial) →
 * FixedTransaction witness merge → submitTx → POST /v2/deposit, then the same with USDM. Pass:
 * credited; record time-to-credit and conversion cost (usd_value vs index × amount). Fallback:
 * show the unsigned tx and accept a pasted hash; recommend USDM. It also settles FRICTION's open
 * question for deposits: whether an API wallet may call these routes at all.
 */
export function planD5(args: DayoneArgs): DayonePlan {
  const index = `${args.strike}/price/v2/premiumIndex?symbol=ADA-USD`;
  return {
    id: "D5",
    title: "In-app margin deposit signed by the holder's wallet",
    proves: [
      "Strike accepts deposit quote, build-tx and confirm from the Builder Connect API wallet (or refuses: then the Strike-app path applies)",
      "the wallet's partial witness merges into Strike's unsigned tx without changing its hash, and the wallet submits it",
      "Strike credits the account; time-to-credit and the ADA conversion cost are measured",
    ],
    human: [
      "Keep the D4 setup running (API with HOLDER_ROUTES=1, web dev server) and the D4 wallet signed in",
      "The wallet holds at least 20 ADA (and, for the second run, some USDM)",
      "On /join (step 5) choose ADA, enter 10, Get a quote: Lace asks for two short proof signatures",
      "Check the transaction review (pays Strike's address, change back to you), then Sign and submit: Lace signs the tx, submits it, and one more proof confirms",
      "Open the cexplorer link /join shows and wait for the transaction to confirm",
      "Run this script again and repeat with USDM",
    ],
    watch: [
      "reads Strike's public account balance before",
      "watches the evidence DB for this deposit's row to reach 'submitted' (tx hash, quoted USD)",
      "reads the ADA-USD index at that moment (public premiumIndex) for the conversion cost",
      `polls the public balance every ${args.pollMs / 1000} s until it rises (up to ${args.timeoutMs / 60_000} min)`,
      "writes a JSON record under data/dayone/",
    ],
    requests: [
      {
        method: "GET",
        url: accountUrl(args.strike, args.address),
        auth: "none",
        note: "before, then polled",
      },
      { method: "GET", url: index, auth: "none", note: "once, when the deposit is submitted" },
    ],
    pass: [
      "the deposit row reaches 'submitted' with a 64-hex tx hash, and that tx exists on cexplorer",
      "Strike's wallet_balance rises by the quoted usd_value",
      "time-to-credit and conversion cost (index × amount − usd_value) are recorded",
    ],
    fallback: [
      'if /join shows "Strike refused API-wallet funding": deposit in Strike\'s own app with the same wallet, record the exact error in FRICTION.md, and set HOLDER_FUNDING_MODE=strike-app',
      "if the merge or submit fails: keep the unsigned tx from /join, submit by hand, and confirm with the pasted hash (the reference app's flow); recommend USDM",
    ],
    evidence: [
      "the JSON record (private), the cexplorer link, and the quote's usd_value",
      "an EVIDENCE.md line: asset, amount, time-to-credit, conversion cost — no address",
    ],
  };
}

export async function runD5(args: DayoneArgs, deps: DayoneDeps = {}): Promise<number> {
  const rt = runtime(deps);
  rt.out(renderPlan(planD5(args), args));
  if (!args.live) {
    rt.out("DRY RUN: no request was sent.\n");
    return 0;
  }
  const startedAtMs = rt.now();
  const before = await readAccount(rt, args.strike, args.address);
  if (before.status !== 200 || !before.accountId) {
    throw new Error("Strike has no account for this wallet: run D4 first");
  }
  const accountId = before.accountId;
  rt.out(`balance before: $${before.walletBalance ?? "?"}\nNow deposit on /join. Waiting…\n`);
  const db = openEvidenceDb(args.db);
  try {
    const row = await pollUntil(rt, args, "a submitted deposit", async () =>
      db
        .fundingEvents(accountId)
        .find(
          (e) => e.kind === "deposit" && e.status === "submitted" && e.updatedAtMs >= startedAtMs,
        ),
    );
    const submittedAtMs = rt.now();
    rt.out(`submitted: ${row.asset} tx ${row.txHash} (quoted $${row.usdValue ?? "?"})\n`);
    let indexPrice: string | null = null;
    if (row.asset === "ADA") {
      const res = await rt.fetch(`${args.strike}/price/v2/premiumIndex?symbol=ADA-USD`, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      const j = (await res.json().catch(() => null)) as { indexPrice?: unknown } | null;
      indexPrice = typeof j?.indexPrice === "string" ? j.indexPrice : null;
    }
    const startBal = microUsd(before.walletBalance) ?? 0n;
    const credited = await pollUntil(rt, args, "the credit", async () => {
      const a = await readAccount(rt, args.strike, args.address);
      const bal = microUsd(a.walletBalance);
      return bal !== null && bal > startBal ? { ...a, bal } : undefined;
    });
    const quoted = microUsd(row.usdValue);
    const amountBase = row.amountBase ? BigInt(row.amountBase) : null;
    const index = microUsd(indexPrice);
    const marketValue =
      row.asset === "USDM"
        ? amountBase
        : amountBase !== null && index !== null
          ? (amountBase * index) / 1_000_000n
          : null;
    const record = {
      id: "D5",
      startedAtMs,
      address: args.address,
      accountId,
      asset: row.asset,
      amountBase: row.amountBase,
      txHash: row.txHash,
      quotedUsd: row.usdValue,
      indexPrice,
      balanceBefore: before.walletBalance,
      balanceAfter: credited.walletBalance,
      creditedMicroUsd: (credited.bal - startBal).toString(),
      submittedAtMs,
      creditedAtMs: credited.atMs,
      timeToCreditMs: credited.atMs - submittedAtMs,
      conversionCostMicroUsd:
        marketValue !== null && quoted !== null ? (marketValue - quoted).toString() : null,
      passed: quoted !== null && credited.bal - startBal === quoted,
    };
    const path = evidencePath(args, "D5", startedAtMs);
    writeEvidence(path, record);
    rt.out(`${record.passed ? "PASS" : "CHECK"} · evidence written to ${path}\n`);
    return record.passed ? 0 : 1;
  } finally {
    db.close();
  }
}

export async function d5Main(argv: readonly string[], deps: DayoneDeps = {}): Promise<number> {
  return runD5(parseDayoneArgs(argv, deps.env ?? process.env), deps);
}

runAsScript(import.meta.url, (argv) => d5Main(argv));
