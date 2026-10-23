/**
 * The published evidence bundle (docs/evidence/bundles/preprod-m4), read at build time so the
 * Policies and Conduct pages show exactly the records `ballast verify` checks. Public fields only:
 * hashes, public keys, the policy and the Critic's scenario results.
 */
import criticRaw from "../../../docs/evidence/bundles/preprod-m4/critic-reports.jsonl?raw";
import decisionsRaw from "../../../docs/evidence/bundles/preprod-m4/decisions.jsonl?raw";
import policiesRaw from "../../../docs/evidence/bundles/preprod-m4/policies.jsonl?raw";
import envelopesRaw from "../../../docs/evidence/bundles/preprod-m4/renewal-envelopes.jsonl?raw";

const lines = <T>(raw: string): T[] =>
  raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);

export interface BundlePolicy {
  hash: string;
  operatorPubkey: string;
  sig: string;
  policy: {
    policyId: string;
    market: string;
    mode: string;
    validFromMs: number;
    validUntilMs: number;
    renewals: number;
    pricing: {
      minOffsetBps: number;
      liqBufferBps: number;
      levelSpacingBps: number[];
      maxLevels: number;
      minImprovementBps: number;
    };
    sizing: {
      rMaxBps: number;
      preD6DepthCapMicroUsd: string;
      perAccountMaxShortMicroUsd: string;
      aggregateMaxShortMicroUsd: string;
    };
    risk: { maxLeverageX100: number; marginReduceBps: number; marginFlattenBps: number };
    fees: { entryBuilderBps: number; exitBuilderBps: number };
  };
}

export interface BundleCritic {
  hash: string;
  verdict: "PASS" | "FAIL";
  reason: string;
  policyHash: string;
  simGitSha: string;
  scenarios: {
    id: string;
    window: { fromMs: number; toMs: number };
    fills: number;
    armedHours: number;
    maxCombinedDrawdownMicroUsd: string;
    violations: Record<string, number>;
  }[];
}

export interface BundleDecision {
  seq: number;
  kind: string;
  tsMs: number;
  hash: string;
  prevHash: string | null;
  inputsDigest: string;
  policyHash?: string;
}

export interface BundleEnvelope {
  hash: string;
  envelope: { maxRenewals: number; notAfterMs: number; basePolicyHash: string };
}

export const POLICIES = lines<BundlePolicy>(policiesRaw);
export const CRITIC_REPORTS = lines<BundleCritic>(criticRaw);
export const DECISIONS = lines<BundleDecision>(decisionsRaw);
export const ENVELOPES = lines<BundleEnvelope>(envelopesRaw);

export const ANCHOR_TX = "7d8a1cddf6fe4e9e0eeee0b5b3ae533c337bd3d19bb79d386edee0eacfe7723c";
export const ANCHOR_URL = `https://preprod.cexplorer.io/tx/${ANCHOR_TX}`;
export const EVIDENCE_URL = "https://github.com/OoJae/ballast/blob/main/docs/evidence/EVIDENCE.md";
export const BUNDLE_URL =
  "https://github.com/OoJae/ballast/tree/main/docs/evidence/bundles/preprod-m4";

export const usd = (micro: string) =>
  `$${(Number(BigInt(micro)) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
