import { KoiosClient, type KoiosReader, loadCoverConfig } from "@ballast/cover";
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
  writeEvidence,
} from "./common.js";

/**
 * D9 (plan §11): exit on an ADA-funded account. With no position (nothing quotes in M5) the
 * reduce-only buy-back is a no-op; the withdrawal is quote (wallet_address, asset) → signData
 * with the hex as-is plus signTx(tx_cbor) → POST /v2/withdraw. Pass: WITHDRAWAL_SETTLED; record
 * the asset received, the $1 fee and the end-to-end time. Fallback: USDM route; Strike app.
 */
export function planD9(args: DayoneArgs): DayonePlan {
  return {
    id: "D9",
    title: "User-signed withdrawal back to the holder's wallet",
    proves: [
      "Strike accepts withdraw estimate, quote and confirm from the Builder Connect API wallet, with the wallet's signature (or refuses: then the Strike-app path applies)",
      "the holder's wallet signs message_to_sign exactly as Strike sent it (already hex) and the min-UTxO funding tx",
      "the payout lands at the same wallet; the $1 fee and end-to-end time are measured",
    ],
    human: [
      "Keep the D4/D5 setup running and the wallet signed in; the account holds the D5 deposit",
      "Check Strike shows no open position (nothing has quoted in M5); if one exists, close it first",
      "On /me, Withdraw: choose ADA, enter at least $5 (fee $1), Get a withdrawal quote: two proof signatures",
      "Read Strike's message on screen, then Sign: Lace signs the message, then the ~2 ADA funding tx, then one proof confirms",
      "Leave the page open; Strike submits the funding tx and pays out from its vault",
    ],
    watch: [
      "reads Strike's public balance before",
      "watches the evidence DB for the withdrawal row to reach 'submitted'",
      `polls the public balance until it drops, and Koios for a new UTxO at the wallet (every ${args.pollMs / 1000} s, up to ${args.timeoutMs / 60_000} min)`,
      "writes a JSON record under data/dayone/",
    ],
    requests: [
      {
        method: "GET",
        url: accountUrl(args.strike, args.address),
        auth: "none",
        note: "before, then polled",
      },
      {
        method: "POST",
        url: "https://api.koios.rest/api/v1/address_utxos",
        auth: "none",
        note: "Koios public read of the wallet's UTxOs (POST is Koios's read RPC), polled",
      },
    ],
    pass: [
      "the withdrawal row reaches 'submitted'; Strike's balance drops by the withdrawn USD",
      "a new UTxO from the payout appears at the wallet address; record its tx hash and lovelace",
      "fee = $1 and end-to-end time recorded",
    ],
    fallback: [
      'if /me shows "Strike refused API-wallet funding": withdraw in Strike\'s own app, record the exact error in FRICTION.md, set HOLDER_FUNDING_MODE=strike-app',
      "if ADA fails, try the USDM route (direct_cardano_usdm)",
    ],
    evidence: [
      "the JSON record (private) and the payout tx on cexplorer",
      "an EVIDENCE.md line: asset received, fee, end-to-end time — no address",
    ],
  };
}

export interface D9Deps extends DayoneDeps {
  koios?: KoiosReader;
}

export async function runD9(args: DayoneArgs, deps: D9Deps = {}): Promise<number> {
  const rt = runtime(deps);
  rt.out(renderPlan(planD9(args), args));
  if (!args.live) {
    rt.out("DRY RUN: no request was sent.\n");
    return 0;
  }
  const cfg = loadCoverConfig(deps.env ?? process.env);
  const koios =
    deps.koios ??
    new KoiosClient({
      baseUrl: cfg.koiosUrl,
      ...(cfg.koiosToken ? { token: cfg.koiosToken } : {}),
    });
  const startedAtMs = rt.now();
  const before = await readAccount(rt, args.strike, args.address);
  if (before.status !== 200 || !before.accountId)
    throw new Error("Strike has no account for this wallet");
  const accountId = before.accountId;
  const seen = new Set(
    (await koios.addressUtxos([args.address])).map((u) => `${u.tx_hash}#${u.tx_index}`),
  );
  rt.out(`balance before: $${before.walletBalance ?? "?"}\nNow withdraw on /me. Waiting…\n`);
  const db = openEvidenceDb(args.db);
  try {
    const row = await pollUntil(rt, args, "a submitted withdrawal", async () =>
      db
        .fundingEvents(accountId)
        .find(
          (e) =>
            e.kind === "withdrawal" && e.status === "submitted" && e.updatedAtMs >= startedAtMs,
        ),
    );
    const submittedAtMs = rt.now();
    const startBal = microUsd(before.walletBalance) ?? 0n;
    const debited = await pollUntil(rt, args, "the debit", async () => {
      const a = await readAccount(rt, args.strike, args.address);
      const bal = microUsd(a.walletBalance);
      return bal !== null && bal < startBal ? { ...a, bal } : undefined;
    });
    // The funding tx's own change also lands at the wallet; the payout is any other new UTxO.
    // VERIFY: WITHDRAWAL_SETTLED arrives only on the user stream, which M5 does not open, so the
    // payout UTxO stands in for it (FRICTION 2026-10-23).
    const payout = await pollUntil(rt, args, "the payout UTxO", async () =>
      (await koios.addressUtxos([args.address])).find(
        (u) =>
          !seen.has(`${u.tx_hash}#${u.tx_index}`) &&
          u.tx_hash !== row.txHash &&
          u.block_height !== null &&
          u.block_height !== undefined,
      ),
    );
    const settledAtMs = rt.now();
    const requested = microUsd(row.usdValue);
    const record = {
      id: "D9",
      startedAtMs,
      address: args.address,
      accountId,
      asset: row.asset,
      requestedUsd: row.usdValue,
      balanceBefore: before.walletBalance,
      balanceAfter: debited.walletBalance,
      debitedMicroUsd: (startBal - debited.bal).toString(),
      fundingTxHash: row.txHash,
      payout: { txHash: payout.tx_hash, index: payout.tx_index, lovelace: payout.value },
      submittedAtMs,
      settledAtMs,
      endToEndMs: settledAtMs - submittedAtMs,
      passed: requested !== null && startBal - debited.bal === requested,
    };
    const path = evidencePath(args, "D9", startedAtMs);
    writeEvidence(path, record);
    rt.out(`${record.passed ? "PASS" : "CHECK"} · evidence written to ${path}\n`);
    return record.passed ? 0 : 1;
  } finally {
    db.close();
  }
}

export async function d9Main(argv: readonly string[], deps: D9Deps = {}): Promise<number> {
  return runD9(parseDayoneArgs(argv, deps.env ?? process.env), deps);
}

runAsScript(import.meta.url, (argv) => d9Main(argv));
