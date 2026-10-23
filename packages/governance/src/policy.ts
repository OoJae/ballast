import { canonicalize, sha256Hex } from "@ballast/core";
import { type OperatorKey, SIG_DOMAIN, verifyDomainSignature } from "./keys.js";
import { DAY_MS, type GateCheck, HEX64_RE, isHex64 } from "./types.js";

/**
 * The fields governance needs from any policy. The full QuotePolicy schema lives with the engine
 * (packages/core/src/policy.ts); governance signs, chains and windows whatever JSON object it is
 * given, as long as it carries this header.
 */
export interface PolicyHeader {
  v: number;
  policyId: string;
  prevPolicyHash: string | null;
  validFromMs: number;
  validUntilMs: number;
  renewals: number;
}

/** §6: hash = sha256(JCS(policy)); sig = operator Ed25519 over `ballast/policy/v1:<hash>`. */
export interface SignedPolicy<T extends PolicyHeader = PolicyHeader> {
  policy: T;
  hash: string;
  operatorPubkey: string;
  sig: string;
}

export const MAX_POLICY_WINDOW_MS = DAY_MS;
export const MAX_RENEWALS = 7;

export function policyHash(policy: PolicyHeader): string {
  return sha256Hex(canonicalize(policy));
}

/** Structural checks on the header; an empty list means the header is valid. */
export function policyHeaderIssues(policy: unknown): string[] {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    return ["policy must be a JSON object"];
  }
  const p = policy as Record<string, unknown>;
  const issues: string[] = [];
  if (!Number.isSafeInteger(p.v)) issues.push("v must be an integer");
  if (typeof p.policyId !== "string" || p.policyId.length === 0 || p.policyId.length > 64) {
    issues.push("policyId must be a non-empty string of at most 64 chars");
  }
  if (p.prevPolicyHash !== null && !isHex64(p.prevPolicyHash)) {
    issues.push("prevPolicyHash must be null or a 64-hex hash");
  }
  const from = p.validFromMs;
  const until = p.validUntilMs;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(until)) {
    issues.push("validFromMs and validUntilMs must be integer ms");
  } else if ((until as number) <= (from as number)) {
    issues.push("validUntilMs must be after validFromMs");
  } else if ((until as number) - (from as number) > MAX_POLICY_WINDOW_MS) {
    issues.push("a policy is valid for at most 24 h");
  }
  if (!Number.isSafeInteger(p.renewals) || (p.renewals as number) < 0) {
    issues.push("renewals must be a non-negative integer");
  } else if ((p.renewals as number) > MAX_RENEWALS) {
    issues.push(`renewals must be at most ${MAX_RENEWALS}`);
  }
  return issues;
}

/** Signs a policy with the operator key. Refuses an invalid header rather than sign it. */
export function signPolicy<T extends PolicyHeader>(policy: T, key: OperatorKey): SignedPolicy<T> {
  if (key.role !== "operator") throw new TypeError("only the operator key signs policies");
  const issues = policyHeaderIssues(policy);
  if (issues.length > 0) throw new TypeError(`refusing to sign policy: ${issues.join("; ")}`);
  const hash = policyHash(policy);
  return { policy, hash, operatorPubkey: key.publicKeyHex, sig: key.signPolicyHash(hash) };
}

/**
 * `policy-signature`: the hash recomputes from the policy, the signature verifies, and the
 * signer is a trusted operator. Never throws; malformed input fails the check.
 */
export function checkPolicySignature(
  signed: SignedPolicy,
  trustedOperators: readonly string[],
): GateCheck {
  const fail = (detail: string): GateCheck => ({ rule: "policy-signature", passed: false, detail });
  try {
    const issues = policyHeaderIssues(signed.policy);
    if (issues.length > 0) return fail(issues.join("; "));
    const hash = policyHash(signed.policy);
    if (hash !== signed.hash) return fail("hash does not match sha256(JCS(policy))");
    if (!trustedOperators.includes(signed.operatorPubkey))
      return fail("signer is not a trusted operator");
    if (!verifyDomainSignature(signed.operatorPubkey, SIG_DOMAIN.policy, hash, signed.sig)) {
      return fail("operator signature does not verify");
    }
    return {
      rule: "policy-signature",
      passed: true,
      detail: `operator ${signed.operatorPubkey.slice(0, 12)}…`,
    };
  } catch (err) {
    return fail(`malformed signed policy: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `policy-window`: the header is valid and `nowMs` is before validUntilMs. */
export function checkPolicyUnexpired(policy: PolicyHeader, nowMs: number): GateCheck {
  const issues = policyHeaderIssues(policy);
  if (issues.length > 0) return { rule: "policy-window", passed: false, detail: issues.join("; ") };
  if (nowMs >= policy.validUntilMs) {
    return { rule: "policy-window", passed: false, detail: "policy has expired" };
  }
  return {
    rule: "policy-window",
    passed: true,
    detail: `valid until ${new Date(policy.validUntilMs).toISOString()}`,
  };
}

/** `policy-chain`: the candidate names the current head (null only for the first policy). */
export function checkPolicyChain(policy: PolicyHeader, headHash: string | null): GateCheck {
  if (policy.prevPolicyHash === headHash) {
    return {
      rule: "policy-chain",
      passed: true,
      detail: headHash ? "extends the head" : "genesis",
    };
  }
  return {
    rule: "policy-chain",
    passed: false,
    detail: `prevPolicyHash ${policy.prevPolicyHash ?? "null"} does not name the head ${headHash ?? "null"}`,
  };
}

export interface PolicyChainFailure {
  index: number;
  hash: string;
  reason: string;
}

/** Re-checks a whole published chain: each policy signed, windowed, and linked to the last. */
export function verifyPolicyChain(
  chain: readonly SignedPolicy[],
  trustedOperators: readonly string[],
): PolicyChainFailure[] {
  const failures: PolicyChainFailure[] = [];
  let head: string | null = null;
  const seen = new Set<string>();
  chain.forEach((sp, index) => {
    const hash = typeof sp?.hash === "string" ? sp.hash : "?";
    const sig = checkPolicySignature(sp, trustedOperators);
    if (!sig.passed) failures.push({ index, hash, reason: sig.detail });
    if (seen.has(hash)) failures.push({ index, hash, reason: "duplicate policy" });
    seen.add(hash);
    const link = checkPolicyChain(sp.policy, head);
    if (!link.passed) failures.push({ index, hash, reason: link.detail });
    head = HEX64_RE.test(hash) ? hash : head;
  });
  return failures;
}
