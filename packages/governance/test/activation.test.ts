import { describe, expect, it, vi } from "vitest";
import {
  checkActivation,
  PolicyRegistry,
  policyGuardChecks,
  type PolicyRegistry as Registry,
  runCriticGate,
  signPolicy,
} from "../src/index.js";
import {
  DAY,
  daemon,
  HOUR,
  passOutput,
  passReport,
  runnerReturning,
  samplePolicy,
  signed,
  strangerDaemon,
  strangerOperator,
  T0,
  TRUST,
} from "./helpers.js";

const ctx = (nowMs: number, headHash: string | null = null) => ({ nowMs, headHash, ...TRUST });
const failedRules = (r: { checks: { rule: string; passed: boolean }[] }) =>
  r.checks.filter((c) => !c.passed).map((c) => c.rule);

describe("invariant 2: no activation without a signed, unexpired policy with a Critic PASS", () => {
  it("activates a trusted, unexpired, chained policy with a fresh PASS", async () => {
    const sp = signed();
    const r = checkActivation(sp, await passReport(sp), ctx(T0 + HOUR));
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.rule)).toEqual([
      "policy-signature",
      "policy-window",
      "policy-chain",
      "critic-pass",
    ]);
  });

  it("bad signature", async () => {
    const sp = signed();
    const report = await passReport(sp);
    const forged = { ...sp, sig: strangerOperator.signPolicyHash(sp.hash) };
    expect(failedRules(checkActivation(forged, report, ctx(T0)))).toEqual(["policy-signature"]);
    const edited = { ...sp, policy: { ...sp.policy, renewals: 7 } };
    expect(failedRules(checkActivation(edited, report, ctx(T0)))).toContain("policy-signature");
    const untrusted = signPolicy(samplePolicy(), strangerOperator);
    expect(failedRules(checkActivation(untrusted, await passReport(untrusted), ctx(T0)))).toEqual([
      "policy-signature",
    ]);
  });

  it("expired", async () => {
    const sp = signed();
    const report = await passReport(sp, T0 + DAY - HOUR);
    expect(failedRules(checkActivation(sp, report, ctx(T0 + DAY)))).toEqual(["policy-window"]);
    expect(checkActivation(sp, report, ctx(T0 + DAY - 1)).ok).toBe(true);
  });

  it("chain break", async () => {
    const a = signed();
    const b = signed({ policyId: "B", prevPolicyHash: a.hash });
    const c = signed({ policyId: "C", prevPolicyHash: "f".repeat(64) });
    expect(failedRules(checkActivation(b, await passReport(b), ctx(T0, null)))).toEqual([
      "policy-chain",
    ]);
    expect(failedRules(checkActivation(a, await passReport(a), ctx(T0, a.hash)))).toEqual([
      "policy-chain",
    ]);
    expect(failedRules(checkActivation(c, await passReport(c), ctx(T0, a.hash)))).toEqual([
      "policy-chain",
    ]);
    expect(checkActivation(b, await passReport(b), ctx(T0, a.hash)).ok).toBe(true);
  });

  it("missing, failing, foreign, untrusted or stale Critic report", async () => {
    const sp = signed();
    expect(failedRules(checkActivation(sp, null, ctx(T0)))).toEqual(["critic-pass"]);
    expect(failedRules(checkActivation(sp, undefined, ctx(T0)))).toEqual(["critic-pass"]);
    const fail = await runCriticGate({
      runner: null,
      signed: sp,
      daemonKey: daemon,
      now: () => T0,
    });
    expect(failedRules(checkActivation(sp, fail, ctx(T0)))).toEqual(["critic-pass"]);
    const other = signed({ policyId: "OTHER" });
    expect(failedRules(checkActivation(sp, await passReport(other), ctx(T0)))).toEqual([
      "critic-pass",
    ]);
    expect(
      failedRules(checkActivation(sp, await passReport(sp, T0, strangerDaemon), ctx(T0))),
    ).toEqual(["critic-pass"]);
    expect(failedRules(checkActivation(sp, await passReport(sp, T0 + HOUR), ctx(T0)))).toEqual([
      "critic-pass",
    ]);
    const old = await passReport(
      signed({ validFromMs: T0 + HOUR, validUntilMs: T0 + DAY + HOUR }),
      T0 - 2 * HOUR,
    );
    const late = signed({ validFromMs: T0 + HOUR, validUntilMs: T0 + DAY + HOUR });
    expect(failedRules(checkActivation(late, old, ctx(T0 + DAY - HOUR)))).toEqual(["critic-pass"]);
  });

  it("never throws on garbage input; it fails every rule it cannot check", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed input
    const r = checkActivation({} as any, { bogus: true } as any, ctx(T0));
    expect(r.ok).toBe(false);
    expect(failedRules(r)).toEqual([
      "policy-signature",
      "policy-window",
      "policy-chain",
      "critic-pass",
    ]);
  });
});

describe("registry: a rejected candidate leaves the previous policy running until it expires", () => {
  it("keeps A after B is rejected, then nothing after A's window ends", async () => {
    const reg = new PolicyRegistry(TRUST);
    const a = signed();
    expect(reg.activate(a, await passReport(a), T0).ok).toBe(true);
    const b = signed({
      policyId: "B",
      prevPolicyHash: a.hash,
      validFromMs: T0 + 12 * HOUR,
      validUntilMs: T0 + 36 * HOUR,
    });
    const failing = await runCriticGate({
      runner: null,
      signed: b,
      daemonKey: daemon,
      now: () => T0 + 12 * HOUR,
    });
    expect(reg.activate(b, failing, T0 + 12 * HOUR).ok).toBe(false);
    expect(reg.activeAt(T0 + 12 * HOUR)?.policyHash).toBe(a.hash);
    expect(reg.activeAt(T0 + DAY - 1)?.policyHash).toBe(a.hash);
    expect(reg.activeAt(T0 + DAY)).toBeNull();
    expect(reg.headHash()).toBe(a.hash);
  });

  it("a future-dated successor takes over exactly when its window opens", async () => {
    const reg = new PolicyRegistry(TRUST);
    const a = signed();
    reg.activate(a, await passReport(a), T0);
    const b = signed({
      policyId: "B",
      prevPolicyHash: a.hash,
      validFromMs: T0 + 20 * HOUR,
      validUntilMs: T0 + 44 * HOUR,
    });
    expect(reg.activate(b, await passReport(b, T0 + 10 * HOUR), T0 + 10 * HOUR).ok).toBe(true);
    expect(reg.activeAt(T0 + 20 * HOUR - 1)?.policyHash).toBe(a.hash);
    expect(reg.activeAt(T0 + 20 * HOUR)?.policyHash).toBe(b.hash);
  });
});

/**
 * Wiring test (Ripcord pattern): a maximally permissive engine proposes creates on every tick,
 * and the signer spy is called only while the registry has a policy window in force.
 */
function tick(reg: Registry, nowMs: number, signer: (ops: string[]) => void): string {
  const proposal = {
    policyHash: reg.headHash() ?? "0".repeat(64),
    creates: ["bal_x_1", "bal_x_2"],
  };
  const checks = policyGuardChecks(reg, proposal.policyHash, nowMs);
  if (checks.some((c) => !c.passed)) return "blocked";
  signer(proposal.creates);
  return "execute";
}

describe("invariant 2 wiring: a permissive engine never reaches the signer without a policy", () => {
  it("blocks every create for each missing condition", async () => {
    const signer = vi.fn();
    const reg = new PolicyRegistry(TRUST);
    expect(tick(reg, T0, signer)).toBe("blocked");

    const sp = signed();
    reg.activate(sp, null, T0);
    reg.activate(
      { ...sp, sig: strangerOperator.signPolicyHash(sp.hash) },
      await passReport(sp),
      T0,
    );
    reg.activate(
      sp,
      await runCriticGate({
        runner: runnerReturning(passOutput({ verdict: "FAIL" })),
        signed: sp,
        daemonKey: daemon,
        now: () => T0,
      }),
      T0,
    );
    expect(tick(reg, T0, signer)).toBe("blocked");
    expect(signer).not.toHaveBeenCalled();

    reg.activate(sp, await passReport(sp), T0);
    expect(tick(reg, T0 + HOUR, signer)).toBe("execute");
    expect(signer).toHaveBeenCalledTimes(1);

    expect(tick(reg, T0 + DAY, signer)).toBe("blocked");
    expect(signer).toHaveBeenCalledTimes(1);
  });
});
