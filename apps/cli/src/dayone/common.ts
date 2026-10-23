import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { holderAddress } from "@ballast/cardano";

/**
 * Shared plumbing for the day-one write-path checks (plan §11). Every script prints its exact
 * plan first and is a dry run unless BOTH `--yes-i-approve` and BALLAST_ARM=1 are given.
 * D4, D5 and D9 need a browser wallet, so the human does the wallet part on /join and /me; the
 * scripts only watch: Strike's public account read, the holder role's evidence DB and Koios.
 */
export const USER_AGENT = "ballast-dayone/0.1";
export const STRIKE_MAINNET = "https://api.strikefinance.org";

export interface DayoneArgs {
  live: boolean;
  /** The dedicated wallet's bech32 base address (the one connected on /join). */
  address: string;
  stakeAddress: string;
  strike: string;
  /** The Ballast API running with HOLDER_ROUTES=1 (for the human's /join and /me). */
  api: string;
  /** The holder role's evidence DB, read for the funding rows. */
  db: string;
  out: string | null;
  timeoutMs: number;
  pollMs: number;
  /** D4 only: after a reconnect, prove the old API key is refused (one signed GET). */
  checkRevoked: boolean;
}

export class DayoneRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DayoneRefusal";
  }
}

export function parseDayoneArgs(argv: readonly string[], env: NodeJS.ProcessEnv): DayoneArgs {
  const { values } = parseArgs({
    args: argv[0] === "--" ? argv.slice(1) : [...argv],
    options: {
      address: { type: "string" },
      strike: { type: "string", default: STRIKE_MAINNET },
      api: { type: "string", default: "http://127.0.0.1:8787" },
      db: { type: "string", default: env.HOLDER_DB_PATH ?? "data/evidence.sqlite" },
      out: { type: "string" },
      "timeout-min": { type: "string", default: "30" },
      "poll-s": { type: "string", default: "5" },
      "dry-run": { type: "boolean", default: false },
      "yes-i-approve": { type: "boolean", default: false },
      "check-revoked": { type: "boolean", default: false },
    },
  });
  if (!values.address)
    throw new DayoneRefusal("--address addr1… (the dedicated wallet) is required");
  let h: ReturnType<typeof holderAddress>;
  try {
    h = holderAddress(values.address);
  } catch (err) {
    throw new DayoneRefusal(`--address: ${err instanceof Error ? err.message : String(err)}`);
  }
  const approved = values["yes-i-approve"] === true;
  const armed = env.BALLAST_ARM === "1";
  if (approved && !armed) {
    throw new DayoneRefusal(
      "--yes-i-approve needs BALLAST_ARM=1 as well: refusing a half-armed run",
    );
  }
  if (approved && values["dry-run"]) {
    throw new DayoneRefusal("--dry-run and --yes-i-approve contradict each other");
  }
  const minutes = Number(values["timeout-min"]);
  const pollS = Number(values["poll-s"]);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 240)
    throw new DayoneRefusal("--timeout-min 1-240");
  if (!Number.isFinite(pollS) || pollS < 1 || pollS > 60) throw new DayoneRefusal("--poll-s 1-60");
  return {
    live: approved && armed,
    address: h.address,
    stakeAddress: h.stakeAddress,
    strike: String(values.strike).replace(/\/+$/, ""),
    api: String(values.api).replace(/\/+$/, ""),
    db: String(values.db),
    out: values.out ?? null,
    timeoutMs: minutes * 60_000,
    pollMs: pollS * 1000,
    checkRevoked: values["check-revoked"] === true,
  };
}

export interface PlannedRequest {
  method: "GET" | "POST";
  url: string;
  auth: "none" | "api-wallet (revoked key, expected 401)";
  note: string;
}

export interface DayonePlan {
  id: "D4" | "D5" | "D9";
  title: string;
  proves: string[];
  /** What the human does, with Lace, in the browser. */
  human: string[];
  /** What this script does while the human works. */
  watch: string[];
  requests: PlannedRequest[];
  pass: string[];
  fallback: string[];
  evidence: string[];
}

export function renderPlan(plan: DayonePlan, args: DayoneArgs): string {
  const list = (xs: readonly string[]) => xs.map((x, i) => `  ${i + 1}. ${x}`).join("\n");
  const mode = args.live
    ? "LIVE: --yes-i-approve and BALLAST_ARM=1 are both set"
    : "DRY RUN: nothing is sent. Live needs --yes-i-approve and BALLAST_ARM=1.";
  return [
    `${plan.id} · ${plan.title}`,
    `mode: ${mode}`,
    `wallet: ${args.address}`,
    `stake:  ${args.stakeAddress}`,
    `strike: ${args.strike}   ballast api: ${args.api}   evidence db: ${args.db}`,
    "",
    "What this proves:",
    list(plan.proves),
    "",
    "You, with Lace (or Eternl) in the browser:",
    list(plan.human),
    "",
    "This script, meanwhile:",
    list(plan.watch),
    "",
    "Requests it makes (public reads unless marked):",
    list(plan.requests.map((r) => `${r.method} ${r.url}  [auth: ${r.auth}]  ${r.note}`)),
    "",
    "Pass when:",
    list(plan.pass),
    "",
    "If it fails:",
    list(plan.fallback),
    "",
    "Evidence to capture:",
    list(plan.evidence),
    "",
  ].join("\n");
}

export interface DayoneDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  out?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
}

export interface Runtime {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  out: (s: string) => void;
}

export function runtime(deps: DayoneDeps): Runtime {
  return {
    fetch: deps.fetch ?? fetch,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    out: deps.out ?? ((s) => void process.stdout.write(s)),
  };
}

export const accountUrl = (strike: string, address: string) =>
  `${strike}/v2/account?blockchain_address=${encodeURIComponent(address)}`;

export interface AccountRead {
  status: number;
  atMs: number;
  accountId: string | null;
  walletBalance: string | null;
}

/** Strike's public account read: 404 "user not found" until Builder Connect creates one. */
export async function readAccount(
  rt: Runtime,
  strike: string,
  address: string,
): Promise<AccountRead> {
  const res = await rt.fetch(accountUrl(strike, address), {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const atMs = rt.now();
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return {
    status: res.status,
    atMs,
    accountId: typeof body?.account_id === "string" ? body.account_id : null,
    walletBalance: typeof body?.wallet_balance === "string" ? body.wallet_balance : null,
  };
}

/** Polls until `test` returns a value, or gives up at the deadline (no retries of writes: reads only). */
export async function pollUntil<T>(
  rt: Runtime,
  args: Pick<DayoneArgs, "timeoutMs" | "pollMs">,
  label: string,
  test: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = rt.now() + args.timeoutMs;
  for (;;) {
    const v = await test();
    if (v !== undefined) return v;
    if (rt.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await rt.sleep(args.pollMs);
  }
}

export function writeEvidence(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
}

export function evidencePath(args: DayoneArgs, id: string, nowMs: number): string {
  return (
    args.out ??
    `data/dayone/${id.toLowerCase()}-${new Date(nowMs).toISOString().replace(/[:.]/g, "-")}.json`
  );
}

/** Lets each script also run directly: `pnpm exec tsx apps/cli/src/dayone/d4-builder-connect.ts`. */
export function runAsScript(
  moduleUrl: string,
  main: (argv: readonly string[]) => Promise<number>,
): void {
  const entry = process.argv[1];
  if (!entry || pathToFileURL(entry).href !== moduleUrl) return;
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    },
  );
}

/** Decimal USD strings → exact micro-USD. */
export function microUsd(v: string | null): bigint | null {
  const m = /^(-?)(\d+)(?:\.(\d{1,18}))?$/.exec(v ?? "");
  if (!m) return null;
  const x = BigInt(m[2] as string) * 1_000_000n + BigInt((m[3] ?? "").slice(0, 6).padEnd(6, "0"));
  return m[1] ? -x : x;
}
