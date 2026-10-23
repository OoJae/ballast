import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { sha256Hex } from "./hash.js";
import { type MicroUsd, microUsdFromString } from "./units.js";

/**
 * The QuotePolicy (plan section 6), exactly as the operator signs it. It is parametric: prices
 * come from live state, so market events never need a new policy. Money is carried as
 * non-negative integer micro-USD strings, which keeps the signed bytes JSON-safe and exact.
 *
 * Self-contained on purpose: signing and envelopes (M4) treat it as an opaque JSON value and
 * hash it with `quotePolicyHash`.
 */

export const POLICY_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
export const POLICY_MAX_RENEWALS = 7;
/** Ballast depth before D6 passes (plan section 5): ≤ $300 total. */
export const PRE_D6_DEPTH_CAP_MICRO_USD = 300_000_000n;

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HEX32_RE = /^[0-9a-f]{64}$/;
const MICRO_USD_RE = /^(0|[1-9]\d{0,17})$/;

const int = (min: number, max: number) => z.int().min(min).max(max);
const microUsdString = z.string().regex(MICRO_USD_RE, "a non-negative integer micro-USD string");
const epochMs = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

export const QuotePolicySchema = z
  .strictObject({
    v: z.literal(1),
    policyId: z.string().regex(ULID_RE, "a ULID"),
    prevPolicyHash: z.string().regex(HEX32_RE, "a lowercase sha256 hex").nullable(),
    market: z.enum(["NIGHT-USD", "ADA-USD"]),
    mode: z.literal("asks_only"),
    validFromMs: epochMs,
    validUntilMs: epochMs,
    renewals: int(0, POLICY_MAX_RENEWALS),
    pricing: z.strictObject({
      minOffsetBps: int(38, 10_000),
      liqBufferBps: int(10, 10_000),
      /** L2 and L3 offsets from L1 (plan section 5: [10, 25]). */
      levelSpacingBps: z.array(int(1, 10_000)).max(2),
      maxLevels: int(1, 3),
      minImprovementBps: int(5, 10_000),
    }),
    sizing: z.strictObject({
      rMaxBps: int(0, 9_000),
      preD6DepthCapMicroUsd: microUsdString,
      l1RefillMicroUsd: microUsdString,
      perAccountMaxShortMicroUsd: microUsdString,
      aggregateMaxShortMicroUsd: microUsdString,
      protocolTakerBudgetBps: int(0, 10_000),
    }),
    risk: z.strictObject({
      maxLeverageX100: int(1, 200),
      marginReduceBps: int(1, 5_000),
      marginFlattenBps: int(1, 6_000),
      lossStopBpsOfCover: int(1, 200),
    }),
    fees: z.strictObject({
      entryBuilderBps: int(0, 10),
      exitBuilderBps: z.literal(0),
    }),
    exits: z.strictObject({
      mode: z.enum(["below_best_bid", "at_best_bid_opt_in"]),
    }),
    requote: z.strictObject({
      indexMoveBps: int(1, 10_000),
      minIntervalMs: int(2_000, 3_600_000),
    }),
  })
  .superRefine((p, ctx) => {
    if (p.validUntilMs <= p.validFromMs) {
      ctx.addIssue({
        code: "custom",
        path: ["validUntilMs"],
        message: "must be after validFromMs",
      });
    } else if (p.validUntilMs - p.validFromMs > POLICY_MAX_WINDOW_MS) {
      ctx.addIssue({ code: "custom", path: ["validUntilMs"], message: "window exceeds 24 h" });
    }
    const spacing = p.pricing.levelSpacingBps;
    if (spacing.length < p.pricing.maxLevels - 1) {
      ctx.addIssue({
        code: "custom",
        path: ["pricing", "levelSpacingBps"],
        message: "needs one offset per level beyond L1",
      });
    }
    for (let i = 1; i < spacing.length; i++) {
      if ((spacing[i] as number) <= (spacing[i - 1] as number)) {
        ctx.addIssue({
          code: "custom",
          path: ["pricing", "levelSpacingBps", i],
          message: "level offsets must strictly increase",
        });
      }
    }
    if (BigInt(p.sizing.preD6DepthCapMicroUsd) > PRE_D6_DEPTH_CAP_MICRO_USD) {
      ctx.addIssue({
        code: "custom",
        path: ["sizing", "preD6DepthCapMicroUsd"],
        message: "pre-D6 depth is capped at $300",
      });
    }
    if (p.risk.marginReduceBps >= p.risk.marginFlattenBps) {
      ctx.addIssue({
        code: "custom",
        path: ["risk", "marginFlattenBps"],
        message: "the flatten band must be above the reduce band",
      });
    }
  });

export type QuotePolicy = z.infer<typeof QuotePolicySchema>;

/** Strict parse: unknown keys, out-of-range caps and float money all throw. */
export function parseQuotePolicy(value: unknown): QuotePolicy {
  return QuotePolicySchema.parse(value);
}

export function safeParseQuotePolicy(
  value: unknown,
): { ok: true; policy: QuotePolicy } | { ok: false; error: string } {
  const r = QuotePolicySchema.safeParse(value);
  if (r.success) return { ok: true, policy: r.data };
  return {
    ok: false,
    error: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
  };
}

/** sha256(JCS(policy)), the hash every client order id and decision record refers to. */
export function quotePolicyHash(policy: QuotePolicy): string {
  return sha256Hex(canonicalize(policy));
}

/**
 * The plan's section 5 defaults, as a starting draft for the operator (r 0.5, ladder +38 bps
 * with L2/L3 at +10/+25 bps, $300 pre-D6 depth, 2x, margin bands 50/60%, 1% loss stop). ADA
 * quotes one level and charges no builder fee. Only the operator's signature activates it.
 */
export function defaultQuotePolicy(opts: {
  policyId: string;
  validFromMs: number;
  market?: QuotePolicy["market"];
  validForMs?: number;
  prevPolicyHash?: string | null;
}): QuotePolicy {
  const market = opts.market ?? "NIGHT-USD";
  const night = market === "NIGHT-USD";
  return parseQuotePolicy({
    v: 1,
    policyId: opts.policyId,
    prevPolicyHash: opts.prevPolicyHash ?? null,
    market,
    mode: "asks_only",
    validFromMs: opts.validFromMs,
    validUntilMs: opts.validFromMs + (opts.validForMs ?? POLICY_MAX_WINDOW_MS),
    renewals: 7,
    pricing: {
      minOffsetBps: 38,
      liqBufferBps: 10,
      levelSpacingBps: night ? [10, 25] : [],
      maxLevels: night ? 3 : 1,
      minImprovementBps: 5,
    },
    sizing: {
      rMaxBps: 5_000,
      preD6DepthCapMicroUsd: "300000000",
      l1RefillMicroUsd: "300000000",
      perAccountMaxShortMicroUsd: night ? "2000000000" : "1000000000",
      aggregateMaxShortMicroUsd: "27700000000",
      protocolTakerBudgetBps: 2_500,
    },
    risk: {
      maxLeverageX100: 200,
      marginReduceBps: 5_000,
      marginFlattenBps: 6_000,
      lossStopBpsOfCover: 100,
    },
    fees: { entryBuilderBps: night ? 10 : 0, exitBuilderBps: 0 },
    exits: { mode: "below_best_bid" },
    requote: { indexMoveBps: 3, minIntervalMs: 2_000 },
  });
}

/** The policy's money fields as integer micro-USD. */
export interface PolicyMoney {
  preD6DepthCap: MicroUsd;
  l1Refill: MicroUsd;
  perAccountMaxShort: MicroUsd;
  aggregateMaxShort: MicroUsd;
}

export function policyMoney(p: QuotePolicy): PolicyMoney {
  return {
    preD6DepthCap: microUsdFromString(p.sizing.preD6DepthCapMicroUsd),
    l1Refill: microUsdFromString(p.sizing.l1RefillMicroUsd),
    perAccountMaxShort: microUsdFromString(p.sizing.perAccountMaxShortMicroUsd),
    aggregateMaxShort: microUsdFromString(p.sizing.aggregateMaxShortMicroUsd),
  };
}
