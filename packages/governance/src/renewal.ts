import { canonicalize, sha256Hex } from "@ballast/core";
import { type CriticReport, checkCriticPass } from "./critic.js";
import { type DaemonKey, type OperatorKey, SIG_DOMAIN, verifyDomainSignature } from "./keys.js";
import {
  checkPolicySignature,
  MAX_POLICY_WINDOW_MS,
  MAX_RENEWALS,
  type PolicyHeader,
  type SignedPolicy,
} from "./policy.js";
import { errorText, type GateCheck, type GateResult, gate, HOUR_MS, isHex64 } from "./types.js";

/**
 * The operator pre-authorizes up to N ≤ 7 re-issues of one policy's exact parameters. The daemon
 * may then issue each next 24 h window itself, but only with a fresh Critic PASS for that policy
 * and no safety-class Guard trip in the window that is ending. It can never change a parameter:
 * a renewal names the base policy hash, and the policy itself is not re-signed.
 */
export interface RenewalEnvelope {
  v: 1;
  kind: "renewal-envelope";
  basePolicyHash: string;
  maxRenewals: number;
  windowMs: number;
  /** Hard stop: no renewed window may end after this. */
  notAfterMs: number;
  issuedAtMs: number;
}

export interface SignedRenewalEnvelope {
  envelope: RenewalEnvelope;
  hash: string;
  operatorPubkey: string;
  sig: string;
}

export interface PolicyRenewal {
  v: 1;
  kind: "policy-renewal";
  envelopeHash: string;
  basePolicyHash: string;
  /** 1 for the first re-issue, up to envelope.maxRenewals. */
  index: number;
  /** The previous window's hash: the base policy hash for index 1, else the previous renewal. */
  prevHash: string;
  validFromMs: number;
  validUntilMs: number;
  criticReportHash: string;
  /** Safety-class Guard trips the daemon saw in the ending window; must be 0 to issue. */
  safetyTrips: number;
  issuedAtMs: number;
}

export interface SignedPolicyRenewal {
  renewal: PolicyRenewal;
  hash: string;
  daemonPubkey: string;
  sig: string;
}

/**
 * Guard rules whose trips block a renewal: anything that protects cover, the floor, data
 * integrity or the account's dedication. Rate and fee hiccups do not.
 */
export const SAFETY_CLASS_RULES: ReadonlySet<string> = new Set([
  "cover-invariant",
  "stake-binding",
  "dedicated-account",
  "price-floor",
  "p2-constraint",
  "data-freshness",
  "reference-sanity",
  "no-bid-ahead",
  "leverage-cap",
  "margin-band",
  "per-account-short",
  "aggregate-cap",
  "loss-stop",
  "holder0-unpaired",
  "unknown-orders",
  "allocator-conformance",
  "route-allowlist",
]);

export interface GuardTripFact {
  ruleId: string;
  tsMs: number;
  accountId?: string;
}

/** A renewal's Critic PASS must be no older than this when the renewal is issued. */
export const RENEWAL_CRITIC_MAX_AGE_MS = 2 * HOUR_MS;

export function envelopeHash(e: RenewalEnvelope): string {
  return sha256Hex(canonicalize(e));
}

export function renewalHash(r: PolicyRenewal): string {
  return sha256Hex(canonicalize(r));
}

/** Operator side: authorize up to `maxRenewals` contiguous re-issues of `base`. */
export function signRenewalEnvelope(
  base: SignedPolicy,
  maxRenewals: number,
  key: OperatorKey,
  issuedAtMs: number,
): SignedRenewalEnvelope {
  if (key.role !== "operator") throw new TypeError("only the operator key signs envelopes");
  if (!Number.isSafeInteger(maxRenewals) || maxRenewals < 1 || maxRenewals > MAX_RENEWALS) {
    throw new TypeError(`maxRenewals must be 1..${MAX_RENEWALS}`);
  }
  if (maxRenewals > base.policy.renewals) {
    throw new TypeError("an envelope cannot authorize more renewals than the policy allows");
  }
  const windowMs = base.policy.validUntilMs - base.policy.validFromMs;
  const envelope: RenewalEnvelope = {
    v: 1,
    kind: "renewal-envelope",
    basePolicyHash: base.hash,
    maxRenewals,
    windowMs,
    notAfterMs: base.policy.validUntilMs + maxRenewals * windowMs,
    issuedAtMs,
  };
  const hash = envelopeHash(envelope);
  return {
    envelope,
    hash,
    operatorPubkey: key.publicKeyHex,
    sig: key.signRenewalEnvelopeHash(hash),
  };
}

function checkEnvelope(
  env: SignedRenewalEnvelope,
  base: SignedPolicy,
  trustedOperators: readonly string[],
): GateCheck {
  const fail = (detail: string): GateCheck => ({ rule: "renewal-envelope", passed: false, detail });
  try {
    const e = env.envelope;
    if (e.v !== 1 || e.kind !== "renewal-envelope") return fail("not a renewal envelope");
    if (envelopeHash(e) !== env.hash) return fail("envelope hash does not recompute");
    if (!trustedOperators.includes(env.operatorPubkey))
      return fail("envelope signer is not a trusted operator");
    if (!verifyDomainSignature(env.operatorPubkey, SIG_DOMAIN.renewalEnvelope, env.hash, env.sig)) {
      return fail("envelope signature does not verify");
    }
    if (e.basePolicyHash !== base.hash) return fail("envelope is for a different policy");
    if (!Number.isSafeInteger(e.maxRenewals) || e.maxRenewals < 1) return fail("bad maxRenewals");
    if (e.maxRenewals > MAX_RENEWALS || e.maxRenewals > base.policy.renewals) {
      return fail("envelope authorizes more renewals than allowed");
    }
    const windowMs = base.policy.validUntilMs - base.policy.validFromMs;
    if (e.windowMs !== windowMs || e.windowMs > MAX_POLICY_WINDOW_MS) return fail("bad window");
    if (e.notAfterMs !== base.policy.validUntilMs + e.maxRenewals * windowMs) {
      return fail("notAfterMs does not match the authorized renewals");
    }
    return {
      rule: "renewal-envelope",
      passed: true,
      detail: `${e.maxRenewals} renewals authorized`,
    };
  } catch (err) {
    return fail(`malformed envelope: ${errorText(err)}`);
  }
}

/** The window a renewal extends: the base policy or the previous renewal. */
export interface PriorWindow {
  hash: string;
  index: number;
  validFromMs: number;
  validUntilMs: number;
  criticReportHash: string | null;
}

export interface RenewalFacts<T extends PolicyHeader> {
  base: SignedPolicy<T>;
  envelope: SignedRenewalEnvelope;
  prior: PriorWindow;
  report: CriticReport | null | undefined;
  trips: readonly GuardTripFact[];
  nowMs: number;
  trustedOperators: readonly string[];
  trustedDaemons: readonly string[];
  safetyRules?: ReadonlySet<string>;
}

/** Every renewal rule, evaluated in full (shared by issue and verify). */
export function checkRenewalConditions<T extends PolicyHeader>(
  f: RenewalFacts<T>,
  draft: Pick<PolicyRenewal, "index" | "validFromMs" | "validUntilMs" | "issuedAtMs">,
): GateResult {
  const rules = f.safetyRules ?? SAFETY_CLASS_RULES;
  const checks: GateCheck[] = [checkPolicySignature(f.base, f.trustedOperators)];
  checks.push(checkEnvelope(f.envelope, f.base, f.trustedOperators));
  const e = f.envelope.envelope;
  const windowMs = f.base.policy.validUntilMs - f.base.policy.validFromMs;
  const indexOk = draft.index === f.prior.index + 1 && draft.index <= e.maxRenewals;
  checks.push({
    rule: "renewal-count",
    passed: indexOk,
    detail: indexOk
      ? `renewal ${draft.index} of ${e.maxRenewals}`
      : `renewal ${draft.index} does not follow ${f.prior.index} within ${e.maxRenewals}`,
  });
  const contiguous =
    draft.validFromMs === f.prior.validUntilMs &&
    draft.validUntilMs - draft.validFromMs === windowMs &&
    draft.validUntilMs <= e.notAfterMs;
  checks.push({
    rule: "renewal-window",
    passed: contiguous,
    detail: contiguous
      ? `next ${windowMs} ms window, same parameters`
      : "a renewal must be the next contiguous window of the same length, within the envelope",
  });
  const critic = checkCriticPass(
    f.report,
    f.base.hash,
    f.trustedDaemons,
    draft.issuedAtMs,
    RENEWAL_CRITIC_MAX_AGE_MS,
  );
  const reused = f.report?.hash !== undefined && f.report.hash === f.prior.criticReportHash;
  const afterPrior = f.report ? f.report.createdMs >= f.prior.validFromMs : false;
  checks.push({
    ...critic,
    rule: "renewal-critic",
    passed: critic.passed && !reused && afterPrior,
    detail: !critic.passed
      ? critic.detail
      : reused
        ? "the previous window's report cannot be reused"
        : !afterPrior
          ? "the PASS predates the ending window"
          : `fresh PASS: ${critic.detail}`,
  });
  const safety = f.trips.filter(
    (t) => rules.has(t.ruleId) && t.tsMs >= f.prior.validFromMs && t.tsMs <= draft.issuedAtMs,
  );
  checks.push({
    rule: "renewal-no-safety-trip",
    passed: safety.length === 0,
    detail:
      safety.length === 0
        ? "no safety-class Guard trip in the ending window"
        : `${safety.length} safety-class trip(s): ${[...new Set(safety.map((t) => t.ruleId))].join(", ")}`,
  });
  const timely = draft.issuedAtMs <= f.prior.validUntilMs && draft.issuedAtMs <= f.nowMs;
  checks.push({
    rule: "renewal-timely",
    passed: timely,
    detail: timely ? "issued before the ending window expired" : "issued after the window expired",
  });
  return gate(checks);
}

export type RenewalOutcome =
  | { ok: true; signed: SignedPolicyRenewal; checks: GateCheck[] }
  | { ok: false; checks: GateCheck[] };

/** Daemon side: issue the next window, or refuse with every failed rule listed. */
export function issueRenewal<T extends PolicyHeader>(
  f: RenewalFacts<T>,
  key: DaemonKey,
): RenewalOutcome {
  if (key.role !== "daemon") throw new TypeError("only the daemon key issues renewals");
  const windowMs = f.base.policy.validUntilMs - f.base.policy.validFromMs;
  const draft = {
    index: f.prior.index + 1,
    validFromMs: f.prior.validUntilMs,
    validUntilMs: f.prior.validUntilMs + windowMs,
    issuedAtMs: f.nowMs,
  };
  const result = checkRenewalConditions(f, draft);
  if (!result.ok || !f.report) return { ok: false, checks: result.checks };
  const renewal: PolicyRenewal = {
    v: 1,
    kind: "policy-renewal",
    envelopeHash: f.envelope.hash,
    basePolicyHash: f.base.hash,
    index: draft.index,
    prevHash: f.prior.hash,
    validFromMs: draft.validFromMs,
    validUntilMs: draft.validUntilMs,
    criticReportHash: f.report.hash,
    safetyTrips: 0,
    issuedAtMs: draft.issuedAtMs,
  };
  const hash = renewalHash(renewal);
  return {
    ok: true,
    checks: result.checks,
    signed: { renewal, hash, daemonPubkey: key.publicKeyHex, sig: key.signRenewalHash(hash) },
  };
}

/** Verifier side: integrity of a signed renewal plus every issuing rule, re-evaluated. */
export function verifyRenewal<T extends PolicyHeader>(
  signed: SignedPolicyRenewal,
  f: RenewalFacts<T>,
): GateResult {
  const checks: GateCheck[] = [];
  const integrity: string[] = [];
  try {
    const r = signed.renewal;
    if (r.v !== 1 || r.kind !== "policy-renewal") integrity.push("not a renewal");
    if (renewalHash(r) !== signed.hash) integrity.push("renewal hash does not recompute");
    if (!f.trustedDaemons.includes(signed.daemonPubkey))
      integrity.push("signer is not a trusted daemon");
    else if (
      !verifyDomainSignature(signed.daemonPubkey, SIG_DOMAIN.renewal, signed.hash, signed.sig)
    ) {
      integrity.push("daemon signature does not verify");
    }
    if (r.basePolicyHash !== f.base.hash) integrity.push("renewal is for a different policy");
    if (r.envelopeHash !== f.envelope.hash) integrity.push("renewal names a different envelope");
    if (r.prevHash !== f.prior.hash) integrity.push("renewal does not chain to the prior window");
    if (!isHex64(r.criticReportHash) || r.criticReportHash !== f.report?.hash) {
      integrity.push("renewal names a different Critic report");
    }
    if (r.safetyTrips !== 0) integrity.push("renewal records safety trips");
    checks.push({
      rule: "renewal-signature",
      passed: integrity.length === 0,
      detail: integrity.length === 0 ? "daemon-signed, chained" : integrity.join("; "),
    });
    checks.push(...checkRenewalConditions({ ...f, nowMs: r.issuedAtMs }, r).checks);
  } catch (err) {
    checks.push({
      rule: "renewal-signature",
      passed: false,
      detail: `malformed: ${errorText(err)}`,
    });
  }
  return gate(checks);
}
