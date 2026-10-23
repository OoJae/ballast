import { fileURLToPath } from "node:url";
import { defaultQuotePolicy, parseQuotePolicy } from "@ballast/core";
import { describe, expect, it } from "vitest";
import { runCritic } from "../src/index.js";

/** 60 s of recorded NIGHT and ADA (committed public market data, M2's fixture). */
const FIXTURE = fileURLToPath(new URL("../../market/test/fixtures/rec", import.meta.url));
const POLICY = defaultQuotePolicy({ policyId: "01JC0FFEE00000000000000000", validFromMs: 0 });

describe("determinism: same data root + policy hash + seed ⇒ same output hash", () => {
  it("replays the recorded fixture to an identical hash, twice", async () => {
    const a = await runCritic(POLICY, { root: FIXTURE }, ["recorded", "house-reaction"], {
      seed: 1,
    });
    const b = await runCritic(POLICY, { root: FIXTURE }, ["recorded", "house-reaction"], {
      seed: 1,
    });
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.hash).toBe(a.hash);
    expect(b.dataRoot).toBe(a.dataRoot);
    expect(a.scenarios[0]?.dataRoot).toMatch(/^[0-9a-f]{64}$/);
    // The fixture is real enough to quote on.
    expect(a.scenarios[0]?.diagnostics["exchange.creates"]).toBeGreaterThan(0);
    expect(a.verdict).toBe("PASS");
  });

  it("the stress library is reproducible per seed, and the seed matters", async () => {
    const ids = ["storm-429", "cover-sale"] as const;
    const a = await runCritic(POLICY, null, ids, { seed: 11 });
    const b = await runCritic(POLICY, null, ids, { seed: 11 });
    const c = await runCritic(POLICY, null, ids, { seed: 12 });
    expect(b.hash).toBe(a.hash);
    expect(c.dataRoot).not.toBe(a.dataRoot);
    expect(c.hash).not.toBe(a.hash);
  });

  it("a different policy is a different output", async () => {
    const other = parseQuotePolicy({ ...POLICY, requote: { ...POLICY.requote, indexMoveBps: 9 } });
    const a = await runCritic(POLICY, { root: FIXTURE }, ["recorded"], { seed: 1 });
    const b = await runCritic(other, { root: FIXTURE }, ["recorded"], { seed: 1 });
    expect(b.policyHash).not.toBe(a.policyHash);
    expect(b.dataRoot).toBe(a.dataRoot);
    expect(b.hash).not.toBe(a.hash);
  });

  it("records what could not run instead of passing it silently", async () => {
    const r = await runCritic(POLICY, null, ["recorded"], { seed: 1 });
    expect(r.skipped).toEqual(["recorded"]);
    expect(r.scenarios).toEqual([]);
    expect(r.verdict).toBe("FAIL");
  });
});
