import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkPolicySignature,
  policyHash,
  policyHeaderIssues,
  signPolicy,
  verifyPolicyChain,
} from "../src/index.js";
import { DAY, operator, samplePolicy, signed, strangerOperator, T0, TRUST } from "./helpers.js";

describe("SignedPolicy", () => {
  it("hash = sha256(JCS(policy)), independent of key order", () => {
    const sp = signed();
    expect(sp.hash).toBe(policyHash(sp.policy));
    const reordered = Object.fromEntries(Object.entries(sp.policy).reverse()) as typeof sp.policy;
    expect(policyHash(reordered)).toBe(sp.hash);
    expect(checkPolicySignature(sp, TRUST.trustedOperators).passed).toBe(true);
  });

  it("refuses to sign a window over 24 h, a reversed window, or more than 7 renewals", () => {
    expect(() => signPolicy(samplePolicy({ validUntilMs: T0 + DAY + 1 }), operator)).toThrow(
      /24 h/,
    );
    expect(() => signPolicy(samplePolicy({ validUntilMs: T0 }), operator)).toThrow(/after/);
    expect(() => signPolicy(samplePolicy({ renewals: 8 }), operator)).toThrow(/at most 7/);
    expect(policyHeaderIssues({ ...samplePolicy(), prevPolicyHash: "xyz" })).toContain(
      "prevPolicyHash must be null or a 64-hex hash",
    );
    expect(policyHeaderIssues(null)).toEqual(["policy must be a JSON object"]);
  });

  it("an untrusted operator's valid signature still fails", () => {
    const sp = signPolicy(samplePolicy(), strangerOperator);
    expect(checkPolicySignature(sp, TRUST.trustedOperators)).toMatchObject({
      passed: false,
      detail: "signer is not a trusted operator",
    });
  });

  it("tamper: any change to any policy field, the hash or the signature fails", () => {
    const sp = signed();
    const paths = [
      ["policyId"],
      ["validUntilMs"],
      ["renewals"],
      ["pricing", "minOffsetBps"],
      ["sizing", "perAccountMaxShortMicroUsd"],
    ] as const;
    fc.assert(
      fc.property(fc.constantFrom(...paths), fc.integer({ min: 1, max: 1_000 }), (path, delta) => {
        const copy = structuredClone(sp);
        // biome-ignore lint/suspicious/noExplicitAny: walking a JSON path for tampering
        let node: any = copy.policy;
        for (const k of path.slice(0, -1)) node = node[k];
        const leaf = path[path.length - 1] as string;
        const old = node[leaf];
        node[leaf] = typeof old === "number" ? old - delta : `${old}${delta}`;
        return !checkPolicySignature(copy, TRUST.trustedOperators).passed;
      }),
    );
    const flip = (hex: string) => `${hex.slice(0, -1)}${hex.endsWith("0") ? "1" : "0"}`;
    expect(checkPolicySignature({ ...sp, sig: flip(sp.sig) }, TRUST.trustedOperators).passed).toBe(
      false,
    );
    expect(
      checkPolicySignature({ ...sp, hash: flip(sp.hash) }, TRUST.trustedOperators).passed,
    ).toBe(false);
  });

  it("verifies a policy chain and pinpoints a break", () => {
    const a = signed();
    const b = signed({
      policyId: "B",
      prevPolicyHash: a.hash,
      validFromMs: T0 + DAY,
      validUntilMs: T0 + 2 * DAY,
    });
    const c = signed({
      policyId: "C",
      prevPolicyHash: b.hash,
      validFromMs: T0 + 2 * DAY,
      validUntilMs: T0 + 3 * DAY,
    });
    expect(verifyPolicyChain([a, b, c], TRUST.trustedOperators)).toEqual([]);
    const forked = signed({ policyId: "C2", prevPolicyHash: a.hash });
    const failures = verifyPolicyChain([a, b, forked], TRUST.trustedOperators);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ index: 2 });
    expect(verifyPolicyChain([b], TRUST.trustedOperators)[0]?.reason).toMatch(
      /does not name the head/,
    );
  });
});
