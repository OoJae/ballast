/**
 * Keeper configuration (ported from Ripcord's config.ts and layered on the governance config).
 *
 * SAFETY INVARIANTS ENFORCED HERE (invariant 3)
 * - DRY_RUN=true is the default. DRY_RUN and BALLAST_ARM are strict enums ("flase" fails loudly).
 * - Mainnet creates need BALLAST_ARM=1 AND the explicit `--mainnet` flag AND DRY_RUN=false.
 *   Every other combination of the three is half-armed and refused at startup:
 *     DRY_RUN=true,  ARM=0, no --mainnet  → dry-run (the default)
 *     DRY_RUN=false, ARM=1, --mainnet     → armed
 *     anything else                       → refuse, naming what is missing
 * - Armed creates go only to Strike's own hosts (https, *.strikefinance.org).
 * - HOSTING RULE: any process that loads a Strike key signs Strike requests (signed reads and
 *   the user-stream logon too), so it refuses to start without BALLAST_ELIGIBLE_HOST=1, the
 *   operator's attestation that this host is not in a Strike-restricted jurisdiction
 *   (strikefinance.org/restricted). No VPN or proxy may be used to get around the list.
 * - Secrets (Telegram token, Koios token) never appear in describeKeeperConfig().
 */
import { loadGovernanceConfig, redactUrl } from "@ballast/governance";
import {
  type Arming,
  assertEligibleHost,
  isStrikeHost,
  parseArmArgs,
  resolveArming,
} from "@ballast/ops";
import { z } from "zod";

export const MAINNET_API_URL = "https://api.strikefinance.org";
export const MAINNET_WS_ORIGIN = "wss://api.strikefinance.org";
export const DEFAULT_USER_AGENT = "ballast-keeper/0.1";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodType>(s: T) => z.preprocess(emptyToUndefined, s.optional());

const list = z.string().transform((s) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
);

const EnvSchema = z.object({
  BALLAST_ELIGIBLE_HOST: z.preprocess(emptyToUndefined, z.enum(["0", "1"]).default("0")),
  STRIKE_API_URL: z.preprocess(emptyToUndefined, z.url().default(MAINNET_API_URL)),
  STRIKE_WS_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^wss?:\/\/[^/]+$/, "origin only, e.g. wss://api.strikefinance.org")
      .default(MAINNET_WS_ORIGIN),
  ),
  BALLAST_USER_AGENT: z.preprocess(emptyToUndefined, z.string().min(3).default(DEFAULT_USER_AGENT)),
  BALLAST_SYMBOLS: z.preprocess(emptyToUndefined, list.default(["NIGHT-USD", "ADA-USD"])),
  BALLAST_QUOTE_SYMBOL: z.preprocess(emptyToUndefined, z.enum(["NIGHT-USD"]).default("NIGHT-USD")),
  BALLAST_DAEMON_KEY_FILE: z.preprocess(
    emptyToUndefined,
    z.string().min(1).default("data/keys/daemon.json"),
  ),
  BALLAST_ACCOUNTS_FILE: opt(z.string().min(1)),
  BALLAST_POLICY_DIR: opt(z.string().min(1)),
  BALLAST_TRUSTED_DAEMONS: opt(list),
  BALLAST_HEARTBEAT_URLS: opt(list),
  BALLAST_HEARTBEAT_FILE: opt(z.string().min(1)),
  BALLAST_HEALTH_HOST: z.preprocess(emptyToUndefined, z.string().default("127.0.0.1")),
  BALLAST_HEALTH_PORT: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(65_535).default(9464),
  ),
  BALLAST_DEADMAN_URL: opt(z.url()),
  TELEGRAM_BOT_TOKEN: opt(z.string().min(1)),
  TELEGRAM_CHAT_ID: opt(z.string().min(1)),
  BALLAST_RECORDINGS: opt(z.string().min(1)),
  BALLAST_SIM_GIT_SHA: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^[0-9a-f]{7,64}$/)
      .default("0000000"),
  ),
  BALLAST_REPLICA_P99_BPS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .default("0.77"),
  ),
  BALLAST_WOULD_PLACE_LOG: z.preprocess(
    emptyToUndefined,
    z.string().min(1).default("data/keeper/would-place.jsonl"),
  ),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  ),
});

export type KeeperMode = Arming["mode"];
export { resolveArming };

export interface KeeperConfig extends Arming {
  eligibleHost: boolean;
  apiUrl: string;
  wsOrigin: string;
  userAgent: string;
  symbols: string[];
  quoteSymbol: "NIGHT-USD";
  trustedOperators: string[];
  /** Extra daemon keys whose reports and renewals this keeper accepts (its own is always). */
  extraTrustedDaemons: string[];
  dbPath: string;
  kekPath: string;
  daemonKeyFile: string;
  accountsFile: string | null;
  policyDir: string | null;
  heartbeatUrls: string[];
  heartbeatFile: string | null;
  health: { host: string; port: number };
  deadmanUrl: string | null;
  telegram: { botToken?: string; chatId?: string };
  recordingsRoot: string | null;
  simGitSha: string;
  replicaP99Bps: string;
  wouldPlaceLog: string;
  logLevel: z.infer<typeof EnvSchema>["LOG_LEVEL"];
}

export function loadKeeperConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = [],
): KeeperConfig {
  const gov = loadGovernanceConfig(env);
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;
  const { mainnetFlag } = parseArmArgs(argv, "keeper");
  const arming = resolveArming({ dryRun: gov.dryRun, armed: gov.armed, mainnetFlag });
  if (
    arming.mode === "armed" &&
    (!isStrikeHost(e.STRIKE_API_URL) || !isStrikeHost(e.STRIKE_WS_URL))
  ) {
    throw new Error(
      "Refusing to arm against a non-Strike host: STRIKE_API_URL and STRIKE_WS_URL must be " +
        "https/wss on *.strikefinance.org when armed.",
    );
  }
  const eligibleHost = e.BALLAST_ELIGIBLE_HOST === "1";
  assertEligibleHost(e.BALLAST_ACCOUNTS_FILE !== undefined, eligibleHost, "keeper");
  for (const s of e.BALLAST_SYMBOLS) {
    if (!/^[A-Z0-9]+-USD$/.test(s)) throw new Error(`BALLAST_SYMBOLS: bad symbol ${s}`);
  }
  if (e.BALLAST_SYMBOLS.length === 0 || e.BALLAST_SYMBOLS.length > 10) {
    throw new Error("BALLAST_SYMBOLS must list 1-10 symbols (one L3 connection)");
  }
  if (!e.BALLAST_SYMBOLS.includes(e.BALLAST_QUOTE_SYMBOL)) {
    throw new Error("BALLAST_SYMBOLS must include the quoted symbol");
  }
  return {
    ...arming,
    eligibleHost,
    apiUrl: e.STRIKE_API_URL.replace(/\/+$/, ""),
    wsOrigin: e.STRIKE_WS_URL,
    userAgent: e.BALLAST_USER_AGENT,
    symbols: e.BALLAST_SYMBOLS,
    quoteSymbol: e.BALLAST_QUOTE_SYMBOL,
    trustedOperators: gov.trustedOperators,
    extraTrustedDaemons: e.BALLAST_TRUSTED_DAEMONS ?? [],
    dbPath: gov.dbPath,
    kekPath: gov.kekPath,
    daemonKeyFile: e.BALLAST_DAEMON_KEY_FILE,
    accountsFile: e.BALLAST_ACCOUNTS_FILE ?? null,
    policyDir: e.BALLAST_POLICY_DIR ?? null,
    heartbeatUrls: e.BALLAST_HEARTBEAT_URLS ?? [],
    heartbeatFile: e.BALLAST_HEARTBEAT_FILE ?? null,
    health: { host: e.BALLAST_HEALTH_HOST, port: e.BALLAST_HEALTH_PORT },
    deadmanUrl: e.BALLAST_DEADMAN_URL ?? null,
    telegram: {
      ...(e.TELEGRAM_BOT_TOKEN !== undefined ? { botToken: e.TELEGRAM_BOT_TOKEN } : {}),
      ...(e.TELEGRAM_CHAT_ID !== undefined ? { chatId: e.TELEGRAM_CHAT_ID } : {}),
    },
    recordingsRoot: e.BALLAST_RECORDINGS ?? null,
    simGitSha: e.BALLAST_SIM_GIT_SHA,
    replicaP99Bps: e.BALLAST_REPLICA_P99_BPS,
    wouldPlaceLog: e.BALLAST_WOULD_PLACE_LOG,
    logLevel: e.LOG_LEVEL,
  };
}

/** Log-safe view: secrets are reported as set or unset, URLs with paths are elided. */
export function describeKeeperConfig(c: KeeperConfig): Record<string, unknown> {
  return {
    mode: c.mode,
    dryRun: c.dryRun,
    armed: c.armed,
    mainnetFlag: c.mainnetFlag,
    eligibleHost: c.eligibleHost,
    apiUrl: redactUrl(c.apiUrl),
    wsOrigin: c.wsOrigin,
    symbols: c.symbols,
    quoteSymbol: c.quoteSymbol,
    trustedOperators: c.trustedOperators.length,
    accounts: c.accountsFile ? "[file]" : "[none]",
    heartbeatUrls: c.heartbeatUrls.length,
    health: `${c.health.host}:${c.health.port}`,
    deadman: c.deadmanUrl ? "[set]" : "[unset]",
    telegram: c.telegram.botToken ? "[set]" : "[unset]",
    recordings: c.recordingsRoot ? "[set]" : "[unset]",
  };
}
