import { fileURLToPath } from "node:url";
import { defaultQuotePolicy, quotePolicyHash } from "@ballast/core";
import {
  DaemonKey,
  OperatorKey,
  runCriticGate,
  signPolicy,
  verifyCriticReport,
} from "@ballast/governance";
import { describe, expect, it } from "vitest";
import { createSimCriticRunner, STRESS_SCENARIOS } from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("../../market/test/fixtures/rec", import.meta.url));
const operator = OperatorKey.fromSeed(new Uint8Array(32).fill(7));
const daemon = DaemonKey.fromSeed(new Uint8Array(32).fill(9));
const policy = defaultQuotePolicy({ policyId: "01JBA11A5T0GATE0000000000A", validFromMs: 0 });
const signed = signPolicy(policy, operator);

describe("simulator as the governance Critic", () => {
  it("hashes the policy the same way on both sides", () => {
    expect(signed.hash).toBe(quotePolicyHash(policy));
  });

  it("produces a daemon-signed PASS over the recorded fixture and the stress library", async () => {
    const runner = createSimCriticRunner({
      segments: { root: FIXTURE },
      scenarios: ["recorded", "house-reaction", ...STRESS_SCENARIOS],
      options: { seed: 3 },
      simGitSha: "986f034",
    });
    const report = await runCriticGate({ runner, signed, daemonKey: daemon, timeoutMs: 120_000 });
    expect(report.verdict).toBe("PASS");
    expect(report.scenarios.length).toBeGreaterThan(STRESS_SCENARIOS.length);
    expect(verifyCriticReport(report, [daemon.publicKeyHex])).toEqual([]);
  }, 120_000);

  it("fails closed when a requested recorded scenario cannot run", async () => {
    const runner = createSimCriticRunner({
      segments: null,
      scenarios: ["recorded"],
      simGitSha: "986f034",
    });
    const report = await runCriticGate({ runner, signed, daemonKey: daemon });
    expect(report.verdict).toBe("FAIL");
  });

  it("fails closed when the gate asks about a different policy", async () => {
    const runner = createSimCriticRunner({
      segments: null,
      scenarios: ["index-stall"],
      simGitSha: "986f034",
    });
    const other = signPolicy({ ...policy, policyId: "01JBA11A5T0GATE0000000000B" }, operator);
    const report = await runCriticGate({
      runner: { run: (input) => runner.run({ ...input, policy }) },
      signed: other,
      daemonKey: daemon,
    });
    expect(report.verdict).toBe("FAIL");
  });
});
