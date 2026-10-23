import { z } from "zod";

/**
 * The only asset Ballast counts as cover. Pinned here, frozen, and never taken from a CLI flag,
 * an environment variable, an API response or model output: at least 16 other Cardano assets
 * are also named "NIGHT", and only this policy is Midnight's (registry-verified 2026-10-22).
 */
export const NIGHT = Object.freeze({
  symbol: "NIGHT",
  policyId: "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa",
  assetNameHex: "4e49474854",
  decimals: 6,
  network: "mainnet" as const,
});
export type PinnedAsset = typeof NIGHT;

export const NIGHT_UNIT = 10n ** BigInt(NIGHT.decimals);

/** r is in basis points: default 0.5, never above 0.9 (§5). */
export const DEFAULT_R_BPS = 5000;
export const MAX_R_BPS = 9000;

/** Cover older than this is stale and cancels quoting (invariant 8/10). */
export const COVER_MAX_AGE_MS = 60_000;

export const KOIOS_MAINNET_URL = "https://api.koios.rest/api/v1";
export const KOIOS_PREPROD_URL = "https://preprod.koios.rest/api/v1";
export const USER_AGENT = "ballast-cover/0.1 (read-only cover oracle)";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const EnvSchema = z.object({
  KOIOS_URL: z.preprocess(
    emptyToUndefined,
    z
      .url()
      .refine((u) => u.startsWith("https://"), "must be https")
      .optional(),
  ),
  /** Optional Koios bearer token (higher limits). A secret: never logged. */
  KOIOS_TOKEN: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  BALLAST_COVER_R_BPS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(MAX_R_BPS).optional(),
  ),
});

export interface CoverConfig {
  koiosUrl: string;
  koiosToken?: string;
  rBps: number;
}

export function loadCoverConfig(env: NodeJS.ProcessEnv = process.env): CoverConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;
  return {
    koiosUrl: (e.KOIOS_URL ?? KOIOS_MAINNET_URL).replace(/\/+$/, ""),
    ...(e.KOIOS_TOKEN !== undefined ? { koiosToken: e.KOIOS_TOKEN } : {}),
    rBps: e.BALLAST_COVER_R_BPS ?? DEFAULT_R_BPS,
  };
}
