/**
 * Watchdog configuration (host B, a different provider from the keeper's host A).
 *
 * - DRY_RUN=true is the default; live cancels need DRY_RUN=false + BALLAST_ARM=1 + `--mainnet`,
 *   and every half-armed combination is refused (the same rule as the keeper, @ballast/ops).
 * - The keeper's daemon public key(s) must be pinned: a heartbeat verifies only under them.
 * - HOSTING RULE: the watchdog holds a Strike key (cancel-only use), so it signs Strike requests
 *   and may run only outside Strike's restricted jurisdictions (strikefinance.org/restricted).
 *   BALLAST_ELIGIBLE_HOST=1 is the operator's attestation; never use a VPN or proxy.
 */
import {
  type Arming,
  assertEligibleHost,
  isStrikeHost,
  parseArmArgs,
  resolveArming,
} from "@ballast/ops";
import { z } from "zod";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodType>(s: T) => z.preprocess(emptyToUndefined, s.optional());
const list = z.string().transform((s) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
);

const EnvSchema = z.object({
  DRY_RUN: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("true")),
  BALLAST_ARM: z.preprocess(emptyToUndefined, z.enum(["0", "1"]).default("0")),
  BALLAST_ELIGIBLE_HOST: z.preprocess(emptyToUndefined, z.enum(["0", "1"]).default("0")),
  STRIKE_API_URL: z.preprocess(emptyToUndefined, z.url().default("https://api.strikefinance.org")),
  STRIKE_WS_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^wss?:\/\/[^/]+$/)
      .default("wss://api.strikefinance.org"),
  ),
  BALLAST_USER_AGENT: z.preprocess(
    emptyToUndefined,
    z.string().min(3).default("ballast-watchdog/0.1"),
  ),
  BALLAST_QUOTE_SYMBOL: z.preprocess(emptyToUndefined, z.enum(["NIGHT-USD"]).default("NIGHT-USD")),
  BALLAST_TRUSTED_DAEMONS: z.preprocess(
    emptyToUndefined,
    list.pipe(z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1, "pin the keeper's daemon key")),
  ),
  BALLAST_WATCHDOG_ACCOUNTS_FILE: opt(z.string().min(1)),
  BALLAST_KEK_PATH: z.preprocess(emptyToUndefined, z.string().min(1).default("data/keys/host.kek")),
  BALLAST_WATCHDOG_DB: z.preprocess(
    emptyToUndefined,
    z.string().min(1).default("data/watchdog.sqlite"),
  ),
  BALLAST_HEARTBEAT_HOST: z.preprocess(emptyToUndefined, z.string().default("127.0.0.1")),
  BALLAST_HEARTBEAT_PORT: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(65_535).default(9470),
  ),
  BALLAST_HEARTBEAT_DEADLINE_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(4_000).max(60_000).default(10_000),
  ),
  BALLAST_REPLICA_P99_BPS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .default("0.77"),
  ),
  BALLAST_HEALTH_HOST: z.preprocess(emptyToUndefined, z.string().default("127.0.0.1")),
  BALLAST_HEALTH_PORT: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(65_535).default(9465),
  ),
  BALLAST_DEADMAN_URL: opt(z.url()),
  BALLAST_KILL_LOG: z.preprocess(
    emptyToUndefined,
    z.string().min(1).default("data/watchdog/kills.jsonl"),
  ),
  TELEGRAM_BOT_TOKEN: opt(z.string().min(1)),
  TELEGRAM_CHAT_ID: opt(z.string().min(1)),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  ),
});

export interface WatchdogEnvConfig extends Arming {
  eligibleHost: boolean;
  apiUrl: string;
  wsOrigin: string;
  userAgent: string;
  symbol: "NIGHT-USD";
  trustedDaemons: string[];
  accountsFile: string | null;
  kekPath: string;
  dbPath: string;
  heartbeat: { host: string; port: number; deadlineMs: number };
  replicaP99Bps: string;
  health: { host: string; port: number };
  deadmanUrl: string | null;
  killLog: string;
  telegram: { botToken?: string; chatId?: string };
  logLevel: z.infer<typeof EnvSchema>["LOG_LEVEL"];
}

export function loadWatchdogConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = [],
): WatchdogEnvConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;
  const arming = resolveArming({
    dryRun: e.DRY_RUN === "true",
    armed: e.BALLAST_ARM === "1",
    mainnetFlag: parseArmArgs(argv, "watchdog").mainnetFlag,
  });
  if (
    arming.mode === "armed" &&
    (!isStrikeHost(e.STRIKE_API_URL) || !isStrikeHost(e.STRIKE_WS_URL))
  ) {
    throw new Error("Refusing to arm the watchdog against a non-Strike host.");
  }
  const eligibleHost = e.BALLAST_ELIGIBLE_HOST === "1";
  assertEligibleHost(e.BALLAST_WATCHDOG_ACCOUNTS_FILE !== undefined, eligibleHost, "watchdog");
  return {
    ...arming,
    eligibleHost,
    apiUrl: e.STRIKE_API_URL.replace(/\/+$/, ""),
    wsOrigin: e.STRIKE_WS_URL,
    userAgent: e.BALLAST_USER_AGENT,
    symbol: e.BALLAST_QUOTE_SYMBOL,
    trustedDaemons: e.BALLAST_TRUSTED_DAEMONS,
    accountsFile: e.BALLAST_WATCHDOG_ACCOUNTS_FILE ?? null,
    kekPath: e.BALLAST_KEK_PATH,
    dbPath: e.BALLAST_WATCHDOG_DB,
    heartbeat: {
      host: e.BALLAST_HEARTBEAT_HOST,
      port: e.BALLAST_HEARTBEAT_PORT,
      deadlineMs: e.BALLAST_HEARTBEAT_DEADLINE_MS,
    },
    replicaP99Bps: e.BALLAST_REPLICA_P99_BPS,
    health: { host: e.BALLAST_HEALTH_HOST, port: e.BALLAST_HEALTH_PORT },
    deadmanUrl: e.BALLAST_DEADMAN_URL ?? null,
    killLog: e.BALLAST_KILL_LOG,
    telegram: {
      ...(e.TELEGRAM_BOT_TOKEN !== undefined ? { botToken: e.TELEGRAM_BOT_TOKEN } : {}),
      ...(e.TELEGRAM_CHAT_ID !== undefined ? { chatId: e.TELEGRAM_CHAT_ID } : {}),
    },
    logLevel: e.LOG_LEVEL,
  };
}

const AccountsSchema = z.array(
  z.strictObject({
    accountId: z.string().min(1).max(128),
    stakeAddress: z.string().regex(/^stake1[0-9a-z]{20,120}$/),
    rBps: z.int().min(0).max(9_000).default(5_000),
    /** The account's Strike key, used here only for cancels and its own reads. */
    strikeKeyFile: z.string().min(1),
  }),
);

export type WatchdogAccountEntry = z.infer<typeof AccountsSchema>[number];

export function parseWatchdogAccounts(json: unknown): WatchdogAccountEntry[] {
  return AccountsSchema.parse(json);
}
