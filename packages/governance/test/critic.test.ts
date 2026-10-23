import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type CriticReport,
  type CriticRunner,
  runCriticGate,
  verifyCriticReport,
} from "../src/index.js";
import {
  daemon,
  passOutput,
  runnerReturning,
  scenario,
  signed,
  strangerDaemon,
  T0,
  type TestPolicy,
  TRUST,
} from "./helpers.js";

const now = () => T0;
const sp = signed();
const gate = (runner: CriticRunner<TestPolicy> | null, timeoutMs?: number) =>
  runCriticGate({
    runner,
    signed: sp,
    daemonKey: daemon,
    now,
    ...(timeoutMs ? { timeoutMs } : {}),
  });

describe("Critic gate: fail-closed by construction", () => {
  it("PASS only with a well-formed PASS whose every scenario has zero violations", async () => {
    const r = await gate(runnerReturning(passOutput()));
    expect(r).toMatchObject({
      verdict: "PASS",
      policyHash: sp.hash,
      daemonPubkey: daemon.publicKeyHex,
    });
    expect(verifyCriticReport(r, TRUST.trustedDaemons)).toEqual([]);
  });

  const failing: [string, () => Promise<CriticReport>, RegExp][] = [
    ["missing runner", () => gate(null), /no Critic runner/],
    [
      "throwing runner",
      () =>
        gate({
          run: async () => {
            throw new Error("replay crashed");
          },
        }),
      /Critic error: replay crashed/,
    ],
    [
      "synchronously throwing runner",
      () =>
        gate({
          run: () => {
            throw new Error("boom");
          },
        }),
      /Critic error: boom/,
    ],
    ["hung runner (timeout)", () => gate({ run: () => new Promise(() => {}) }, 50), /timed out/],
    ["undefined output", () => gate(runnerReturning(undefined)), /malformed/],
    ["extra key", () => gate(runnerReturning({ ...passOutput(), approve: true })), /malformed/],
    ["bad dataRoot", () => gate(runnerReturning(passOutput({ dataRoot: "zz" }))), /malformed/],
    ["no scenarios", () => gate(runnerReturning(passOutput({ scenarios: [] }))), /violations|PASS/],
    [
      "PASS contradicted by violations",
      () =>
        gate(
          runnerReturning(
            passOutput({
              scenarios: [
                scenario(),
                scenario({
                  id: "rally",
                  violations: { cover: 0, floor: 1, p2: 0, static: 0, rate: 0 },
                }),
              ],
            }),
          ),
        ),
      /scenarios show violations/,
    ],
    ["runner FAIL", () => gate(runnerReturning(passOutput({ verdict: "FAIL" }))), /verdict FAIL/],
  ];
  for (const [name, run, reason] of failing) {
    it(`FAIL on ${name}, still signed`, async () => {
      const r = await run();
      expect(r.verdict).toBe("FAIL");
      expect(r.reason).toMatch(reason);
      expect(verifyCriticReport(r, TRUST.trustedDaemons)).toEqual([]);
    });
  }

  it("aborts the runner's signal on timeout", async () => {
    let signal: AbortSignal | undefined;
    await gate(
      {
        run: ({ signal: s }) => {
          signal = s;
          return new Promise(() => {});
        },
      },
      20,
    );
    expect(signal?.aborted).toBe(true);
  });

  it("tamper: any edit to a report, or a signature by another daemon, fails verification", async () => {
    const r = await gate(runnerReturning(passOutput()));
    fc.assert(
      fc.property(
        fc.constantFrom(
          "verdict",
          "policyHash",
          "dataRoot",
          "seed",
          "createdMs",
          "reason",
          "scenarios",
        ),
        (field) => {
          const copy = structuredClone(r) as unknown as Record<string, unknown>;
          if (field === "verdict") copy.verdict = "FAIL";
          else if (field === "createdMs") copy.createdMs = (r.createdMs as number) + 1;
          else if (field === "scenarios") copy.scenarios = [scenario({ fills: 13 })];
          else copy[field] = `${String(copy[field])}x`;
          return (
            verifyCriticReport(copy as unknown as CriticReport, TRUST.trustedDaemons).length > 0
          );
        },
      ),
    );
    const other = await runCriticGate({
      runner: runnerReturning(passOutput()),
      signed: sp,
      daemonKey: strangerDaemon,
      now,
    });
    expect(verifyCriticReport(other, TRUST.trustedDaemons)).toContain(
      "signer is not a trusted daemon",
    );
    expect(
      verifyCriticReport({ ...r, daemonSig: other.daemonSig }, TRUST.trustedDaemons),
    ).toContain("daemon signature does not verify");
  });
});
