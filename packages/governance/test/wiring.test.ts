import { describe, expect, it, vi } from "vitest";
import { AdvisorService, type LlmClient } from "../src/advisor/index.js";
import { DecisionLog, PolicyRegistry, policyGuardChecks } from "../src/index.js";
import { daemon, HOUR, passReport, signed, T0, TRUST } from "./helpers.js";

/**
 * Invariant 19 wiring test: the Advisor is not in the path. The same ticks run with no Advisor,
 * a hung Advisor and a throwing Advisor; the signer sees identical batches, the decision chain
 * is identical, and the tick path makes zero LLM calls.
 */
type Mode = "none" | "hung" | "throws";

async function scenario(mode: Mode) {
  const llmSpy = vi.fn();
  const llm: LlmClient | null =
    mode === "none"
      ? null
      : {
          complete: async (req) => {
            llmSpy(req.user.slice(0, 20));
            if (mode === "throws") throw new Error("advisor exploded");
            return new Promise<string>(() => {});
          },
        };
  const notes: unknown[] = [];
  const advisor = new AdvisorService({ llm, timeoutMs: 40, onNote: (n) => notes.push(n) });
  const registry = new PolicyRegistry(TRUST);
  let t = T0;
  const log = new DecisionLog({ key: daemon, now: () => t });
  const signer = vi.fn();
  const sp = signed();
  const report = await passReport(sp);

  // Activation: deterministic text is recorded first; the Advisor note is requested after.
  expect(registry.activate(sp, report, T0).ok).toBe(true);
  log.append({ kind: "policy", policyHash: sp.hash, inputsDigest: report.hash, inputsRef: null });
  advisor.submit({ kind: "policy", subjectHash: sp.hash, deterministicText: "policy activated" });

  const callsDuringTicks: number[] = [];
  const tick = (nowMs: number) => {
    t = nowMs;
    const before = llmSpy.mock.calls.length;
    const creates = ["bal_a_1", "bal_a_2"]; // a maximally permissive engine
    const checks = policyGuardChecks(registry, sp.hash, nowMs);
    const blocked = checks.some((c) => !c.passed);
    if (!blocked) signer(creates);
    log.append({
      kind: "requote",
      policyHash: sp.hash,
      inputsDigest: "e".repeat(64),
      inputsRef: null,
      guard: {
        decision: blocked ? "blocked" : "dry-run",
        checksHash: "f".repeat(64),
        violations: [],
      },
    });
    // Ask for commentary on every tick; it must not change this tick or the next.
    advisor.submit({ kind: "guard-trip", subjectHash: "a".repeat(64), deterministicText: "tick" });
    callsDuringTicks.push(llmSpy.mock.calls.length - before);
  };

  // Real time passes between ticks, so the Advisor runs (and hangs or throws) concurrently.
  for (const at of [T0 + 1, T0 + HOUR, T0 + 2 * HOUR, T0 + 25 * HOUR]) {
    tick(at);
    await new Promise((r) => setTimeout(r, 15));
  }
  await advisor.idle();
  return { signer: signer.mock.calls, head: log.head(), callsDuringTicks, llmSpy, notes };
}

describe("invariant 19: a hung or throwing Advisor changes nothing", () => {
  it("identical signer calls and decision chain across Advisor modes; zero tick-path LLM calls", async () => {
    const none = await scenario("none");
    const hung = await scenario("hung");
    const throws = await scenario("throws");
    expect(none.signer).toHaveLength(3); // the 25 h tick is past the policy window
    expect(hung.signer).toEqual(none.signer);
    expect(throws.signer).toEqual(none.signer);
    expect(hung.head).toEqual(none.head);
    expect(throws.head).toEqual(none.head);
    for (const s of [none, hung, throws]) expect(s.callsDuringTicks).toEqual([0, 0, 0, 0]);
    // The Advisor did run, later and off the tick path, and produced nothing.
    expect(hung.llmSpy).toHaveBeenCalled();
    expect(throws.llmSpy).toHaveBeenCalled();
    expect(hung.notes).toEqual([]);
    expect(throws.notes).toEqual([]);
  });

  it("submit never throws, even with a broken scheduler or callback", async () => {
    const subject = {
      kind: "policy" as const,
      subjectHash: "a".repeat(64),
      deterministicText: "x",
    };
    const broken = new AdvisorService({
      llm: { complete: async () => "{}" },
      schedule: () => {
        throw new Error("scheduler down");
      },
    });
    for (let i = 0; i < 5; i++) expect(() => broken.submit(subject)).not.toThrow();
    await broken.idle();
    const ok = JSON.stringify({
      summary: "fine",
      risks: [],
      recommendation: "no_change",
      confidence: 1,
    });
    const badCallback = new AdvisorService({
      llm: { complete: async () => ok },
      onNote: () => {
        throw new Error("callback bug");
      },
    });
    expect(() => badCallback.submit(subject)).not.toThrow();
    await badCallback.idle();
  });
});
