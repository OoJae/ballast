import { z } from "zod";

/**
 * The holder role's configuration. Off by default: unless HOLDER_ROUTES=1 every /api/holder
 * route answers 404 and this process stays the keyless, read-only public API.
 *
 * Turned on, this process signs Strike requests (Builder Connect proxying and HOLDER_PRESENT
 * funding calls), so the hosting rule applies: it must run outside Strike's restricted
 * jurisdictions (CLAUDE.md), never on the read-only hosts. It still never holds funds: every
 * deposit and withdrawal needs the holder's own wallet signature.
 */
export const STRIKE_MAINNET_HOST = "api.strikefinance.org";
export const STRIKE_TESTNET_HOST = "api-v2-testnet.strikefinance.org";

const EnvSchema = z.object({
  HOLDER_ROUTES: z.string().default("0"),
  /** Injectable so tests point it at the fake; nothing else in this role names a Strike host. */
  HOLDER_STRIKE_URL: z.url().default(`https://${STRIKE_MAINNET_HOST}`),
  HOLDER_USER_AGENT: z.string().min(3).default("ballast-holder/0.1"),
  HOLDER_BUILDER_CODE: z
    .string()
    // Strike's builder codes are case-sensitive: the registered code is "Ballast" (D4, 2026-10-23).
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .default("Ballast"),
  HOLDER_FEE_SHARE_BPS: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(0).max(100))
    .default(10),
  HOLDER_KEK_PATH: z.string().optional(),
  HOLDER_KEY_DIR: z.string().optional(),
  HOLDER_DB_PATH: z.string().min(1).default("data/evidence.sqlite"),
  /** Shown in the Sign-In-With-Cardano message so a signature names the site it was made for. */
  HOLDER_DOMAIN: z.string().min(1).default("localhost"),
  /** "strike-app" sends holders to fund in Strike's own app (D5/D9 fallback). */
  HOLDER_FUNDING_MODE: z.enum(["api-wallet", "strike-app"]).default("api-wallet"),
  HOLDER_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  HOLDER_COVER: z.enum(["koios", "off"]).default("koios"),
  BALLAST_ARM: z.string().optional(),
});

export interface HolderConfig {
  enabled: boolean;
  strikeUrl: string;
  userAgent: string;
  builderCode: string;
  feeShareBps: number;
  kekPath: string;
  keyDir: string;
  dbPath: string;
  domain: string;
  fundingMode: "api-wallet" | "strike-app";
  network: "mainnet" | "testnet";
  cover: "koios" | "off";
}

export function loadHolderConfig(env: NodeJS.ProcessEnv = process.env): HolderConfig | null {
  const e = EnvSchema.parse(env);
  if (e.HOLDER_ROUTES !== "1") return null;
  if (!e.HOLDER_KEK_PATH || !e.HOLDER_KEY_DIR) {
    throw new Error("HOLDER_ROUTES=1 needs HOLDER_KEK_PATH and HOLDER_KEY_DIR (sealed API keys)");
  }
  const host = new URL(e.HOLDER_STRIKE_URL).host;
  if (host === STRIKE_MAINNET_HOST && e.HOLDER_NETWORK !== "mainnet") {
    throw new Error("HOLDER_NETWORK=testnet cannot point at Strike mainnet");
  }
  if (host === STRIKE_TESTNET_HOST && e.HOLDER_NETWORK !== "testnet") {
    throw new Error("Strike testnet takes testnet (preprod) wallets: set HOLDER_NETWORK=testnet");
  }
  // Invariant 3's spirit: no half-armed start. Mainnet funding requests are real requests.
  if (host === STRIKE_MAINNET_HOST && e.BALLAST_ARM !== "1") {
    throw new Error(
      "holder routes against Strike mainnet sign real funding requests: they need BALLAST_ARM=1",
    );
  }
  if (
    new URL(e.HOLDER_STRIKE_URL).protocol !== "https:" &&
    !/^(127\.0\.0\.1|localhost)(:|$)/.test(host)
  ) {
    throw new Error("HOLDER_STRIKE_URL must be https (plain http only for a local fake)");
  }
  return {
    enabled: true,
    strikeUrl: e.HOLDER_STRIKE_URL.replace(/\/+$/, ""),
    userAgent: e.HOLDER_USER_AGENT,
    builderCode: e.HOLDER_BUILDER_CODE,
    feeShareBps: e.HOLDER_FEE_SHARE_BPS,
    kekPath: e.HOLDER_KEK_PATH,
    keyDir: e.HOLDER_KEY_DIR,
    dbPath: e.HOLDER_DB_PATH,
    domain: e.HOLDER_DOMAIN,
    fundingMode: e.HOLDER_FUNDING_MODE,
    network: e.HOLDER_NETWORK,
    cover: e.HOLDER_COVER,
  };
}
