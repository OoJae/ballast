import { type CriticReport, checkCriticPass } from "./critic.js";
import type { DaemonKey } from "./keys.js";
import {
  checkPolicyChain,
  checkPolicySignature,
  checkPolicyUnexpired,
  type PolicyHeader,
  type SignedPolicy,
} from "./policy.js";
import {
  type GuardTripFact,
  issueRenewal,
  type PriorWindow,
  type RenewalOutcome,
  type SignedPolicyRenewal,
  type SignedRenewalEnvelope,
  verifyRenewal,
} from "./renewal.js";
import { type GateCheck, type GateResult, gate } from "./types.js";

/** One window in which a policy may quote: the base window or a daemon-issued renewal. */
export interface PolicyWindow {
  /** Base policy hash: what every `bal_` order and decision record names. */
  policyHash: string;
  /** This window's own hash (the policy hash for the base window, else the renewal hash). */
  windowHash: string;
  index: number;
  validFromMs: number;
  validUntilMs: number;
  criticReportHash: string;
}

/**
 * Invariant 2's gate: every rule evaluated, all must pass. A signed policy activates only if its
 * signature verifies under a trusted operator, it has not expired, it extends the current head,
 * and a trusted daemon signed a recent Critic PASS for exactly its hash.
 */
export function checkActivation(
  signed: SignedPolicy,
  report: CriticReport | null | undefined,
  ctx: {
    nowMs: number;
    headHash: string | null;
    trustedOperators: readonly string[];
    trustedDaemons: readonly string[];
  },
): GateResult {
  const checks: GateCheck[] = [checkPolicySignature(signed, ctx.trustedOperators)];
  checks.push(
    signed?.policy
      ? checkPolicyUnexpired(signed.policy, ctx.nowMs)
      : { rule: "policy-window", passed: false, detail: "no policy" },
  );
  checks.push(
    signed?.policy
      ? checkPolicyChain(signed.policy, ctx.headHash)
      : { rule: "policy-chain", passed: false, detail: "no policy" },
  );
  checks.push(checkCriticPass(report, signed?.hash ?? "", ctx.trustedDaemons, ctx.nowMs));
  return gate(checks);
}

interface Head<T extends PolicyHeader> {
  signed: SignedPolicy<T>;
  envelope: SignedRenewalEnvelope | null;
}

export interface RegistryOptions {
  trustedOperators: readonly string[];
  trustedDaemons: readonly string[];
}

/**
 * The daemon's view of which policy may quote. A rejected candidate changes nothing: the current
 * policy keeps quoting until its own window ends, and then nothing quotes until a new policy
 * activates. There is no path that extends a window without a check passing.
 */
export class PolicyRegistry<T extends PolicyHeader = PolicyHeader> {
  private head: Head<T> | null = null;
  /** Every window ever granted, oldest first. Earlier policies' windows are cut at the start of a newer one. */
  private readonly windows: PolicyWindow[] = [];

  constructor(private readonly opts: RegistryOptions) {}

  headHash(): string | null {
    return this.head?.signed.hash ?? null;
  }

  headPolicy(): SignedPolicy<T> | null {
    return this.head?.signed ?? null;
  }

  /** The window in force at `nowMs`, or null: no window means no creates. */
  activeAt(nowMs: number): PolicyWindow | null {
    for (let i = this.windows.length - 1; i >= 0; i--) {
      const w = this.windows[i];
      if (w && w.validFromMs <= nowMs && nowMs < w.validUntilMs) return w;
    }
    return null;
  }

  activate(
    signed: SignedPolicy<T>,
    report: CriticReport | null | undefined,
    nowMs: number,
  ): GateResult {
    const result = checkActivation(signed, report, {
      nowMs,
      headHash: this.headHash(),
      trustedOperators: this.opts.trustedOperators,
      trustedDaemons: this.opts.trustedDaemons,
    });
    if (result.ok && report) {
      // The previous policy keeps quoting until the new one's window opens, never beyond it.
      const opensAt = Math.max(signed.policy.validFromMs, nowMs);
      for (const w of this.windows) w.validUntilMs = Math.min(w.validUntilMs, opensAt);
      this.head = { signed, envelope: null };
      this.windows.push({
        policyHash: signed.hash,
        windowHash: signed.hash,
        index: 0,
        validFromMs: signed.policy.validFromMs,
        validUntilMs: signed.policy.validUntilMs,
        criticReportHash: report.hash,
      });
    }
    return result;
  }

  /** Registers the operator's envelope for the head policy. Renewals need it. */
  attachEnvelope(envelope: SignedRenewalEnvelope): boolean {
    if (!this.head || envelope.envelope.basePolicyHash !== this.head.signed.hash) return false;
    this.head.envelope = envelope;
    return true;
  }

  private prior(): PriorWindow | null {
    const last = this.windows.at(-1);
    return this.head && last?.policyHash === this.head.signed.hash
      ? {
          hash: last.windowHash,
          index: last.index,
          validFromMs: last.validFromMs,
          validUntilMs: last.validUntilMs,
          criticReportHash: last.criticReportHash,
        }
      : null;
  }

  /** Daemon path: issue and apply the next window if every renewal rule passes. */
  renew(
    report: CriticReport | null | undefined,
    trips: readonly GuardTripFact[],
    nowMs: number,
    key: DaemonKey,
  ): RenewalOutcome {
    const prior = this.prior();
    if (!this.head || !prior || !this.head.envelope) {
      return {
        ok: false,
        checks: [{ rule: "renewal-envelope", passed: false, detail: "no head policy or envelope" }],
      };
    }
    const outcome = issueRenewal(
      {
        base: this.head.signed,
        envelope: this.head.envelope,
        prior,
        report,
        trips,
        nowMs,
        trustedOperators: this.opts.trustedOperators,
        trustedDaemons: this.opts.trustedDaemons,
      },
      key,
    );
    if (outcome.ok) this.pushRenewal(outcome.signed);
    return outcome;
  }

  /** Verifier path: re-apply a recorded renewal, re-checking every rule. */
  applyRenewal(
    signed: SignedPolicyRenewal,
    report: CriticReport | null | undefined,
    trips: readonly GuardTripFact[],
  ): GateResult {
    const prior = this.prior();
    if (!this.head || !prior || !this.head.envelope) {
      return gate([
        { rule: "renewal-envelope", passed: false, detail: "no head policy or envelope" },
      ]);
    }
    const result = verifyRenewal(signed, {
      base: this.head.signed,
      envelope: this.head.envelope,
      prior,
      report,
      trips,
      nowMs: signed.renewal.issuedAtMs,
      trustedOperators: this.opts.trustedOperators,
      trustedDaemons: this.opts.trustedDaemons,
    });
    if (result.ok) this.pushRenewal(signed);
    return result;
  }

  private pushRenewal(signed: SignedPolicyRenewal): void {
    const r = signed.renewal;
    this.windows.push({
      policyHash: r.basePolicyHash,
      windowHash: signed.hash,
      index: r.index,
      validFromMs: r.validFromMs,
      validUntilMs: r.validUntilMs,
      criticReportHash: r.criticReportHash,
    });
  }
}

/**
 * The policy rules the Guard evaluates on every create batch (`policy-signature`,
 * `policy-window`, `critic-pass`), reduced to whether a window is in force for this policy.
 */
export function policyGuardChecks(
  registry: PolicyRegistry,
  policyHash: string | undefined,
  nowMs: number,
): GateCheck[] {
  const w = registry.activeAt(nowMs);
  const named = w !== null && policyHash === w.policyHash;
  return [
    {
      rule: "policy-signature",
      passed: named,
      detail: named ? "operator-signed policy is active" : "no active operator-signed policy",
    },
    {
      rule: "policy-window",
      passed: w !== null,
      detail: w
        ? `window ${w.index} until ${new Date(w.validUntilMs).toISOString()}`
        : "no window in force",
    },
    {
      rule: "critic-pass",
      passed: named,
      detail: named ? `report ${w.criticReportHash.slice(0, 12)}…` : "no Critic PASS in force",
    },
  ];
}
