/**
 * Governance config (ported from Ripcord's config.ts).
 *
 * SAFETY INVARIANTS ENFORCED HERE
 * - DRY_RUN and BALLAST_ARM are strict enums: "flase", "yes" or "TRUE" fail loudly, never arm.
 * - Mainnet with DRY_RUN=false refuses to start without BALLAST_ARM=1 (invariant 3).
 * - Arming refuses to start without at least one trusted operator key: with none, no policy can
 *   ever activate, and an armed daemon that cannot quote is a misconfiguration.
 * - Secrets (the Anthropic key) are never part of describeConfig() output.
 */
import { z } from "zod";

/** Latest Claude model (per the claude-api skill, 2026-10). Overridable by BALLAST_ADVISOR_MODEL. */
export const DEFAULT_ADVISOR_MODEL = "claude-opus-5-5";
export const DEFAULT_KEK_PATH = "data/keys/host.kek";
export const DEFAULT_DB_PATH = "data/ballast.sqlite";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const pubkeyList = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  )
  .pipe(
    z
      .array(z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase 64-hex Ed25519 public key"))
      .refine((a) => new Set(a).size === a.length, "duplicate public key"),
  );

const EnvSchema = z.object({
  BALLAST_NETWORK: z.preprocess(
    emptyToUndefined,
    z.enum(["mainnet", "preprod"]).default("mainnet"),
  ),
  DRY_RUN: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("true")),
  BALLAST_ARM: z.preprocess(emptyToUndefined, z.enum(["0", "1"]).default("0")),
  BALLAST_OPERATOR_PUBKEYS: z.preprocess(emptyToUndefined, pubkeyList.optional()),
  BALLAST_KEK_PATH: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  BALLAST_DB_PATH: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  ANTHROPIC_BASE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  BALLAST_ADVISOR_MODEL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^[a-z0-9.-]{3,64}$/)
      .optional(),
  ),
  BALLAST_ADVISOR: z.preprocess(emptyToUndefined, z.enum(["off", "on"]).default("off")),
});

export interface GovernanceConfig {
  network: "mainnet" | "preprod";
  dryRun: boolean;
  armed: boolean;
  trustedOperators: string[];
  kekPath: string;
  dbPath: string;
  advisor: {
    enabled: boolean;
    model: string;
    apiKey?: string;
    baseURL?: string;
  };
}

export function loadGovernanceConfig(env: NodeJS.ProcessEnv = process.env): GovernanceConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;
  const dryRun = e.DRY_RUN === "true";
  const armed = e.BALLAST_ARM === "1";
  const trustedOperators = e.BALLAST_OPERATOR_PUBKEYS ?? [];

  if (e.BALLAST_NETWORK === "mainnet" && !dryRun && !armed) {
    throw new Error(
      "Refusing to start: BALLAST_NETWORK=mainnet with DRY_RUN=false requires BALLAST_ARM=1. " +
        "Either keep DRY_RUN=true or explicitly arm with BALLAST_ARM=1.",
    );
  }
  if (!dryRun && trustedOperators.length === 0) {
    throw new Error(
      "Refusing to start: DRY_RUN=false with no BALLAST_OPERATOR_PUBKEYS. No policy could ever " +
        "activate, so nothing could quote. Configure the operator's public key first.",
    );
  }
  const advisorEnabled = e.BALLAST_ADVISOR === "on";
  if (advisorEnabled && e.ANTHROPIC_API_KEY === undefined) {
    throw new Error("Refusing to start: BALLAST_ADVISOR=on requires ANTHROPIC_API_KEY.");
  }
  return {
    network: e.BALLAST_NETWORK,
    dryRun,
    armed,
    trustedOperators,
    kekPath: e.BALLAST_KEK_PATH ?? DEFAULT_KEK_PATH,
    dbPath: e.BALLAST_DB_PATH ?? DEFAULT_DB_PATH,
    advisor: {
      enabled: advisorEnabled,
      model: e.BALLAST_ADVISOR_MODEL ?? DEFAULT_ADVISOR_MODEL,
      ...(e.ANTHROPIC_API_KEY !== undefined ? { apiKey: e.ANTHROPIC_API_KEY } : {}),
      ...(e.ANTHROPIC_BASE_URL !== undefined ? { baseURL: e.ANTHROPIC_BASE_URL } : {}),
    },
  };
}

/** A log-safe view: secrets are reported as present or absent, never printed. */
export function describeConfig(c: GovernanceConfig): Record<string, unknown> {
  return {
    network: c.network,
    dryRun: c.dryRun,
    armed: c.armed,
    trustedOperators: c.trustedOperators.length,
    kekPath: c.kekPath,
    dbPath: c.dbPath,
    advisor: {
      enabled: c.advisor.enabled,
      model: c.advisor.model,
      apiKey: c.advisor.apiKey ? "[set]" : "[unset]",
      baseURL: c.advisor.baseURL ? redactUrl(c.advisor.baseURL) : null,
    },
  };
}

/**
 * Renders an endpoint for logs with the path and query elided, since provider URLs often carry
 * a key in the path (Ripcord's redactRpcUrl).
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" && u.search === "" && u.username === "" ? u.origin : `${u.origin}/…`;
  } catch {
    return "[unparseable-url]";
  }
}

/** Scrubs a URL (and its key-bearing path) out of arbitrary error text. */
export function scrubUrl(text: string, url: string): string {
  if (url === "") return text;
  let out = text.split(url).join(redactUrl(url));
  try {
    const path = new URL(url).pathname;
    if (path.length > 1) out = out.split(path).join("/…");
  } catch {
    // Unparseable: the whole-URL replacement above is the best available.
  }
  return out;
}
