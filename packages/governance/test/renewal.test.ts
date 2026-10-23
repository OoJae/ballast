import { describe, expect, it } from "vitest";
import {
  type CriticReport,
  type GuardTripFact,
  PolicyRegistry,
  runCriticGate,
  type SignedPolicyRenewal,
  signRenewalEnvelope,
} from "../src/index.js";
import {
  DAY,
  daemon,
  HOUR,
  operator,
  passReport,
  signed,
  strangerDaemon,
  strangerOperator,
  T0,
  TRUST,
} from "./helpers.js";

const failedRules = (r: { checks: { rule: string; passed: boolean }[] }) =>
  r.checks.filter((c) => !c.passed).map((c) => c.rule);

async function setup(maxRenewals = 2) {
  const base = signed({ renewals: 3 });
  const reg = new PolicyRegistry(TRUST);
  expect(reg.activate(base, await passReport(base), T0).ok).toBe(true);
  const env = signRenewalEnvelope(base, maxRenewals, operator, T0);
  expect(reg.attachEnvelope(env)).toBe(true);
  return { base, reg, env };
}

describe("renewal envelope: operator pre-authorizes up to N ≤ 7 re-issues", () => {
  it("refuses N above 7, above the policy's own renewals, or below 1", () => {
    const base = signed({ renewals: 3 });
    expect(() => signRenewalEnvelope(base, 4, operator, T0)).toThrow(
      /more renewals than the policy/,
    );
    expect(() => signRenewalEnvelope(signed({ renewals: 7 }), 8, operator, T0)).toThrow(/1\.\.7/);
    expect(() => signRenewalEnvelope(base, 0, operator, T0)).toThrow(/1\.\.7/);
    const env = signRenewalEnvelope(base, 3, operator, T0);
    expect(env.envelope.notAfterMs).toBe(T0 + 4 * DAY);
  });

  it("renews up to N times with fresh PASSes, then refuses N + 1", async () => {
    const { base, reg } = await setup(2);
    const r1 = reg.renew(await passReport(base, T0 + DAY - HOUR), [], T0 + DAY - HOUR, daemon);
    expect(r1.ok).toBe(true);
    expect(reg.activeAt(T0 + DAY + HOUR)).toMatchObject({ policyHash: base.hash, index: 1 });
    const r2 = reg.renew(
      await passReport(base, T0 + 2 * DAY - HOUR),
      [],
      T0 + 2 * DAY - HOUR,
      daemon,
    );
    expect(r2.ok).toBe(true);
    const r3 = reg.renew(
      await passReport(base, T0 + 3 * DAY - HOUR),
      [],
      T0 + 3 * DAY - HOUR,
      daemon,
    );
    expect(failedRules(r3)).toContain("renewal-count");
    expect(reg.activeAt(T0 + 3 * DAY - 1)?.index).toBe(2);
    expect(reg.activeAt(T0 + 3 * DAY)).toBeNull();
  });

  it("refuses without a fresh Critic PASS", async () => {
    const { base, reg } = await setup();
    const now = T0 + DAY - HOUR;
    expect(failedRules(reg.renew(null, [], now, daemon))).toEqual(["renewal-critic"]);
    const stale = await passReport(base, now - 3 * HOUR);
    expect(failedRules(reg.renew(stale, [], now, daemon))).toEqual(["renewal-critic"]);
    const fail = await runCriticGate({
      runner: null,
      signed: base,
      daemonKey: daemon,
      now: () => now,
    });
    expect(failedRules(reg.renew(fail, [], now, daemon))).toEqual(["renewal-critic"]);
    const foreign = await passReport(base, now, strangerDaemon);
    expect(failedRules(reg.renew(foreign, [], now, daemon))).toEqual(["renewal-critic"]);
    // The base activation's own report cannot be recycled for the next window.
    const reg2 = new PolicyRegistry(TRUST);
    const first = await passReport(base, T0 + DAY - 2 * HOUR);
    reg2.activate(base, first, T0 + DAY - 2 * HOUR);
    reg2.attachEnvelope(signRenewalEnvelope(base, 2, operator, T0));
    expect(failedRules(reg2.renew(first, [], T0 + DAY - HOUR, daemon))).toEqual(["renewal-critic"]);
  });

  it("refuses after a safety-class Guard trip in the ending window; other trips do not block", async () => {
    const { base, reg } = await setup();
    const now = T0 + DAY - HOUR;
    const report = await passReport(base, now);
    const benign: GuardTripFact[] = [{ ruleId: "rate-budget", tsMs: T0 + HOUR }];
    const safety: GuardTripFact[] = [...benign, { ruleId: "cover-invariant", tsMs: T0 + 2 * HOUR }];
    const before: GuardTripFact[] = [{ ruleId: "price-floor", tsMs: T0 - HOUR }];
    expect(failedRules(reg.renew(report, safety, now, daemon))).toEqual(["renewal-no-safety-trip"]);
    expect(reg.renew(report, [...benign, ...before], now, daemon).ok).toBe(true);
  });

  it("refuses after the window has expired, or without an envelope", async () => {
    const { base, reg } = await setup();
    const late = T0 + DAY + 1;
    expect(failedRules(reg.renew(await passReport(base, late), [], late, daemon))).toContain(
      "renewal-timely",
    );
    const bare = new PolicyRegistry(TRUST);
    bare.activate(base, await passReport(base), T0);
    expect(
      failedRules(bare.renew(await passReport(base, T0 + HOUR), [], T0 + HOUR, daemon)),
    ).toEqual(["renewal-envelope"]);
  });

  it("refuses an envelope signed by an untrusted operator or for another policy", async () => {
    const base = signed({ renewals: 3 });
    const reg = new PolicyRegistry(TRUST);
    reg.activate(base, await passReport(base), T0);
    reg.attachEnvelope(signRenewalEnvelope(base, 2, strangerOperator, T0));
    const now = T0 + DAY - HOUR;
    expect(failedRules(reg.renew(await passReport(base, now), [], now, daemon))).toEqual([
      "renewal-envelope",
    ]);
    expect(
      reg.attachEnvelope(
        signRenewalEnvelope(signed({ policyId: "X", renewals: 3 }), 1, operator, T0),
      ),
    ).toBe(false);
  });
});

describe("verifier: recorded renewals are re-checked rule by rule", () => {
  async function recorded() {
    const { base, reg, env } = await setup();
    const now = T0 + DAY - HOUR;
    const report = await passReport(base, now);
    const out = reg.renew(report, [], now, daemon);
    if (!out.ok) throw new Error("setup renewal failed");
    return { base, env, report, renewal: out.signed };
  }

  async function replay(
    renewal: SignedPolicyRenewal,
    report: CriticReport,
    trips: GuardTripFact[] = [],
  ) {
    const { base, env } = await recorded();
    const v = new PolicyRegistry(TRUST);
    v.activate(base, await passReport(base), T0);
    v.attachEnvelope(env);
    return v.applyRenewal(renewal, report, trips);
  }

  it("accepts the genuine renewal", async () => {
    const { renewal, report } = await recorded();
    expect((await replay(renewal, report)).ok).toBe(true);
  });

  it("tamper: edited window, index, report hash or signature all fail", async () => {
    const { renewal, report } = await recorded();
    const edits: SignedPolicyRenewal[] = [
      {
        ...renewal,
        renewal: { ...renewal.renewal, validUntilMs: renewal.renewal.validUntilMs + HOUR },
      },
      { ...renewal, renewal: { ...renewal.renewal, index: 2 } },
      { ...renewal, renewal: { ...renewal.renewal, safetyTrips: 1 } },
      { ...renewal, sig: strangerDaemon.signRenewalHash(renewal.hash) },
    ];
    for (const e of edits) expect((await replay(e, report)).ok).toBe(false);
    const otherReport = await passReport((await recorded()).base, T0 + DAY - 30 * 60_000);
    expect((await replay(renewal, otherReport)).ok).toBe(false);
  });

  it("a trip the daemon failed to report makes its renewal fail verification", async () => {
    const { renewal, report } = await recorded();
    const r = await replay(renewal, report, [{ ruleId: "data-freshness", tsMs: T0 + 3 * HOUR }]);
    expect(failedRules(r)).toEqual(["renewal-no-safety-trip"]);
  });
});
