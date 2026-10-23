import { type EvidenceDb, openEvidenceDb } from "@ballast/evidence/db";
import { HostKek, openSealedKey, readSealedKey } from "@ballast/governance";
import {
  ApiWalletSigner,
  apiTimeSource,
  createPublicHttp,
  RateLimiter,
  ServerClock,
  SignedClient,
  StrikeApiError,
} from "@ballast/strike-client";
import {
  accountUrl,
  type DayoneArgs,
  type DayoneDeps,
  type DayonePlan,
  evidencePath,
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
 * D4 (plan §11): mainnet Builder Connect with Lace and with Eternl. Pass: `/v2/account` flips
 * 404→200; reconnecting invalidates the old key (401 "authentication failed" or "wallet expired or
 * revoked"); revocation in the Strike app works. Fallback: the JSON {signature,key} form; support
 * only the wallets that pass.
 */
export function planD4(args: DayoneArgs): DayonePlan {
  return {
    id: "D4",
    title: "Builder Connect from a CIP-30 wallet on mainnet",
    proves: [
      "one CIP-30 signData from Lace (then Eternl) runs Strike's Builder Connect for a Cardano wallet",
      "Strike creates the account: its public account read flips 404 → 200",
      "the API key Strike registered is the one Ballast generated; only its public half left Ballast",
      "a second connect revokes the first key; revoking in the Strike app works",
    ],
    human: [
      "On the operator machine (outside Strike's restricted list, never a read-only host): run the API with HOLDER_ROUTES=1 BALLAST_ARM=1 HOLDER_KEK_PATH=… HOLDER_KEY_DIR=… HOLDER_DB_PATH=… pnpm api:dev, and pnpm web:dev",
      "In Lace, add a fresh account that has never touched Strike; send it 5 ADA for fees",
      "Open http://localhost:5173/join; tick the restricted-jurisdiction and risk boxes; Connect Lace; sign the sign-in message",
      "Step 4, Connect to Strike: read Strike's message on screen, then sign it in Lace",
      args.checkRevoked
        ? "Reload /join, sign in again and run Connect to Strike a second time (the reconnect)"
        : "(optional, with --check-revoked) reconnect once more to prove the old key is revoked",
      "Repeat with Eternl in its own fresh account, as a second D4 run with that address",
      "Finally revoke Ballast's API wallet in the Strike app and note what Strike shows",
    ],
    watch: [
      "reads Strike's public account check once (expects 404 for a fresh wallet)",
      `polls it every ${args.pollMs / 1000} s until it answers 200 (up to ${args.timeoutMs / 60_000} min), and records the flip`,
      "reads the holder role's evidence DB for the API key Ballast registered",
      ...(args.checkRevoked
        ? [
            "waits for a second key, then makes ONE signed GET /v2/account with the first key: it must be refused",
          ]
        : []),
      "writes a JSON record under data/dayone/ (private: it names the wallet and account)",
    ],
    requests: [
      {
        method: "GET",
        url: accountUrl(args.strike, args.address),
        auth: "none",
        note: "before, then polled",
      },
      ...(args.checkRevoked
        ? ([
            {
              method: "GET",
              url: `${args.strike}/v2/time`,
              auth: "none",
              note: "clock for the signed read",
            },
            {
              method: "GET",
              url: `${args.strike}/v2/account`,
              auth: "api-wallet (revoked key, expected 401)",
              note: "once, after the reconnect",
            },
          ] as const)
        : []),
    ],
    pass: [
      "before = 404 and after = 200 (or 200 before if this wallet was connected earlier: then only the reconnect is proven)",
      "the evidence DB holds exactly one active key for the account, and it is the one /join showed",
      ...(args.checkRevoked
        ? [
            'the first key is refused with 401 ("wallet expired or revoked" or "authentication failed")',
          ]
        : []),
    ],
    fallback: [
      "if Strike refuses the coseSign1:coseKey form, retry Builder Connect with the JSON {signature,key} form (record it in FRICTION.md)",
      "support only the wallets that pass; note the failing wallet and its error",
    ],
    evidence: [
      "the JSON record this script writes (keep it private)",
      "screenshots: Lace's signing prompt, /join's 404 → 200 line, the Strike app's revoke screen",
      "an EVIDENCE.md line: date, wallet (Lace/Eternl), flip time, revoke result — no address or account id",
    ],
  };
}

async function checkRevoked(
  args: DayoneArgs,
  deps: DayoneDeps,
  db: EvidenceDb,
  accountId: string,
): Promise<{ publicKey: string; status: number; error: string }> {
  const rt = runtime(deps);
  const env = deps.env ?? process.env;
  const wallets = await pollUntil(rt, args, "a second (reconnect) API key", async () => {
    const all = db.holderWallets(accountId);
    return all.length >= 2 ? all : undefined;
  });
  const old = wallets.find((w) => w.status === "revoked");
  if (!old) throw new Error("no revoked key recorded for the account");
  const kekPath = env.HOLDER_KEK_PATH;
  if (!kekPath) throw new Error("--check-revoked needs HOLDER_KEK_PATH to open the old key");
  const key = openSealedKey(readSealedKey(old.keyPath), HostKek.load(kekPath), "strike");
  const signer = key.useSeed((seed) => ApiWalletSigner.fromSeed(seed));
  const clock = new ServerClock({
    fetchServerTimeMs: apiTimeSource(
      createPublicHttp({ baseUrl: args.strike, userAgent: USER_AGENT, fetch: rt.fetch }),
    ),
    samples: 3,
  });
  await clock.sync();
  // CANCEL_ONLY: the narrowest profile that may sign a read of the account's own data.
  const client = new SignedClient({
    baseUrl: args.strike,
    userAgent: USER_AGENT,
    signer,
    clock,
    profile: "CANCEL_ONLY",
    rate: new RateLimiter(),
    account: accountId,
    fetch: rt.fetch,
    maxGetRetries: 0,
  });
  try {
    await client.get("/v2/account");
    return { publicKey: old.publicKey, status: 200, error: "" };
  } catch (err) {
    if (err instanceof StrikeApiError)
      return { publicKey: old.publicKey, status: err.status, error: err.code };
    throw err;
  }
}

export async function runD4(args: DayoneArgs, deps: DayoneDeps = {}): Promise<number> {
  const rt = runtime(deps);
  rt.out(renderPlan(planD4(args), args));
  if (!args.live) {
    rt.out("DRY RUN: no request was sent.\n");
    return 0;
  }
  const startedAtMs = rt.now();
  const before = await readAccount(rt, args.strike, args.address);
  rt.out(`before: ${before.status} at ${new Date(before.atMs).toISOString()}\n`);
  rt.out("Now do the wallet steps on /join. Waiting for the 200…\n");
  const after =
    before.status === 200
      ? before
      : await pollUntil(rt, args, "the 404→200 flip", async () => {
          const a = await readAccount(rt, args.strike, args.address);
          return a.status === 200 ? a : undefined;
        });
  rt.out(`after: ${after.status} at ${new Date(after.atMs).toISOString()}\n`);
  const db = openEvidenceDb(args.db);
  try {
    const accountId = after.accountId;
    const active = accountId ? db.activeHolderWallet(accountId) : null;
    const revoked =
      args.checkRevoked && accountId ? await checkRevoked(args, deps, db, accountId) : null;
    const passed =
      after.status === 200 && active !== null && (revoked === null || revoked.status === 401);
    const record = {
      id: "D4",
      startedAtMs,
      address: args.address,
      before: { status: before.status, atMs: before.atMs },
      after: { status: after.status, atMs: after.atMs, accountId },
      flipMs: before.status === 404 ? after.atMs - before.atMs : null,
      activeApiKey: active?.publicKey ?? null,
      revokedKeyCheck: revoked,
      passed,
    };
    const path = evidencePath(args, "D4", startedAtMs);
    writeEvidence(path, record);
    rt.out(`${passed ? "PASS" : "FAIL"} · evidence written to ${path}\n`);
    return passed ? 0 : 1;
  } finally {
    db.close();
  }
}

export async function d4Main(argv: readonly string[], deps: DayoneDeps = {}): Promise<number> {
  return runD4(parseDayoneArgs(argv, deps.env ?? process.env), deps);
}

runAsScript(import.meta.url, (argv) => d4Main(argv));
