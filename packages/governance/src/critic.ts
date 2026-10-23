import { canonicalize, sha256Hex } from "@ballast/core";
import { z } from "zod";
import { type DaemonKey, SIG_DOMAIN, verifyDomainSignature } from "./keys.js";
import type { PolicyHeader, SignedPolicy } from "./policy.js";
import { DAY_MS, errorText, type GateCheck, isHex64 } from "./types.js";

/** Violation counts per scenario (§6). PASS requires every count to be zero. */
export interface CriticViolations {
  cover: number;
  floor: number;
  p2: number;
  static: number;
  rate: number;
}

export interface CriticScenario {
  id: string;
  window: { fromMs: number; toMs: number };
  violations: CriticViolations;
  fills: number;
  armedHours: number;
  maxCombinedDrawdownMicroUsd: string;
}

/** What a replay Critic returns. The M3 simulator (packages/sim runCritic) implements this. */
export interface CriticRunOutput {
  dataRoot: string;
  simGitSha: string;
  seed: string;
  scenarios: CriticScenario[];
  verdict: "PASS" | "FAIL";
}

export interface CriticRunInput<P extends PolicyHeader = PolicyHeader> {
  policy: P;
  policyHash: string;
  /** Aborted when the gate's timeout fires; a runner should stop work promptly. */
  signal: AbortSignal;
}

export interface CriticRunner<P extends PolicyHeader = PolicyHeader> {
  run(input: CriticRunInput<P>): Promise<CriticRunOutput>;
}

/**
 * §6 CriticReport, signed by the daemon key. A report that could not be produced still exists:
 * it is a FAIL with `reason`, so "no report" can never be read as "no objection".
 */
export interface CriticReport {
  v: 1;
  policyHash: string;
  dataRoot: string | null;
  simGitSha: string | null;
  seed: string | null;
  scenarios: CriticScenario[];
  verdict: "PASS" | "FAIL";
  reason: string;
  createdMs: number;
  daemonPubkey: string;
  hash: string;
  daemonSig: string;
}

const count = z.number().int().nonnegative();
const ScenarioSchema = z.strictObject({
  id: z.string().min(1).max(128),
  window: z.strictObject({ fromMs: z.number().int(), toMs: z.number().int() }),
  violations: z.strictObject({ cover: count, floor: count, p2: count, static: count, rate: count }),
  fills: count,
  armedHours: z.number().finite().nonnegative(),
  maxCombinedDrawdownMicroUsd: z.string().regex(/^-?\d+$/),
});
const RunOutputSchema = z.strictObject({
  dataRoot: z.string().regex(/^[0-9a-f]{64}$/),
  simGitSha: z.string().regex(/^[0-9a-f]{7,64}$/),
  seed: z.string().min(1).max(128),
  scenarios: z.array(ScenarioSchema),
  verdict: z.enum(["PASS", "FAIL"]),
});

export const DEFAULT_CRITIC_TIMEOUT_MS = 30 * 60_000;
/** A PASS older than this cannot activate a policy. */
export const CRITIC_MAX_AGE_MS = DAY_MS;

function totalViolations(s: CriticScenario): number {
  const v = s.violations;
  return v.cover + v.floor + v.p2 + v.static + v.rate;
}

/** The verdict the scenarios support. A runner's PASS is never taken on trust. */
export function derivedVerdict(scenarios: readonly CriticScenario[]): "PASS" | "FAIL" {
  return scenarios.length > 0 && scenarios.every((s) => totalViolations(s) === 0) ? "PASS" : "FAIL";
}

type ReportBody = Omit<CriticReport, "hash" | "daemonSig">;

export function criticReportHash(body: ReportBody): string {
  return sha256Hex(canonicalize(body));
}

function signReport(body: ReportBody, key: DaemonKey): CriticReport {
  if (key.role !== "daemon") throw new TypeError("only the daemon key signs Critic reports");
  const hash = criticReportHash(body);
  return { ...body, hash, daemonSig: key.signCriticReportHash(hash) };
}

export interface CriticGateOptions<P extends PolicyHeader> {
  runner: CriticRunner<P> | null | undefined;
  signed: SignedPolicy<P>;
  daemonKey: DaemonKey;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Runs the Critic and always returns a signed report. FAIL-CLOSED BY CONSTRUCTION (Ripcord's
 * critic pattern): a missing runner, a throw, a timeout, malformed output or a PASS that its own
 * scenarios contradict all resolve to FAIL. The caller's previous valid policy keeps running.
 */
export async function runCriticGate<P extends PolicyHeader>(
  opts: CriticGateOptions<P>,
): Promise<CriticReport> {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CRITIC_TIMEOUT_MS;
  const base = {
    v: 1 as const,
    policyHash: opts.signed.hash,
    daemonPubkey: opts.daemonKey.publicKeyHex,
  };
  const fail = (reason: string): CriticReport =>
    signReport(
      {
        ...base,
        dataRoot: null,
        simGitSha: null,
        seed: null,
        scenarios: [],
        verdict: "FAIL",
        reason,
        createdMs: now(),
      },
      opts.daemonKey,
    );

  if (!opts.runner) return fail("no Critic runner: rejecting fail-closed");
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      ac.abort(new Error("critic timeout"));
      resolve("timeout");
    }, timeoutMs);
  });
  let raw: unknown;
  try {
    const outcome = await Promise.race([
      opts.runner.run({
        policy: opts.signed.policy,
        policyHash: opts.signed.hash,
        signal: ac.signal,
      }),
      timeout,
    ]);
    if (outcome === "timeout") return fail(`Critic timed out after ${timeoutMs} ms: rejecting`);
    raw = outcome;
  } catch (err) {
    return fail(`Critic error: ${errorText(err)}: rejecting`);
  } finally {
    clearTimeout(timer);
  }

  const parsed = RunOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return fail(`malformed Critic output (${issue}): rejecting`);
  }
  const out = parsed.data;
  const derived = derivedVerdict(out.scenarios);
  const verdict = out.verdict === "PASS" && derived === "PASS" ? "PASS" : "FAIL";
  let reason: string;
  if (verdict === "PASS") reason = `${out.scenarios.length} scenarios, 0 violations`;
  else if (out.verdict === "PASS") reason = "runner said PASS but its scenarios show violations";
  else reason = "Critic verdict FAIL";
  return signReport(
    {
      ...base,
      dataRoot: out.dataRoot,
      simGitSha: out.simGitSha,
      seed: out.seed,
      scenarios: out.scenarios,
      verdict,
      reason,
      createdMs: now(),
    },
    opts.daemonKey,
  );
}

/** Integrity only: the hash recomputes and a trusted daemon signed it. */
export function verifyCriticReport(
  report: CriticReport,
  trustedDaemons: readonly string[],
): string[] {
  const failures: string[] = [];
  try {
    const { hash, daemonSig, ...body } = report;
    if (criticReportHash(body) !== hash) failures.push("report hash does not recompute");
    if (!trustedDaemons.includes(report.daemonPubkey))
      failures.push("signer is not a trusted daemon");
    else if (
      !verifyDomainSignature(report.daemonPubkey, SIG_DOMAIN.criticReport, hash, daemonSig)
    ) {
      failures.push("daemon signature does not verify");
    }
    if (report.verdict === "PASS" && derivedVerdict(report.scenarios) !== "PASS") {
      failures.push("PASS contradicted by its own scenarios");
    }
  } catch (err) {
    failures.push(`malformed report: ${errorText(err)}`);
  }
  return failures;
}

/** `critic-pass`: a valid, trusted, recent PASS for exactly this policy hash. */
export function checkCriticPass(
  report: CriticReport | null | undefined,
  policyHashHex: string,
  trustedDaemons: readonly string[],
  nowMs: number,
  maxAgeMs: number = CRITIC_MAX_AGE_MS,
): GateCheck {
  const fail = (detail: string): GateCheck => ({ rule: "critic-pass", passed: false, detail });
  if (!report) return fail("no Critic report");
  const integrity = verifyCriticReport(report, trustedDaemons);
  if (integrity.length > 0) return fail(integrity.join("; "));
  if (!isHex64(policyHashHex) || report.policyHash !== policyHashHex) {
    return fail("report is for a different policy");
  }
  if (report.verdict !== "PASS") return fail(`verdict ${report.verdict}: ${report.reason}`);
  if (report.createdMs > nowMs) return fail("report is dated in the future");
  if (nowMs - report.createdMs > maxAgeMs) return fail("report is too old");
  return { rule: "critic-pass", passed: true, detail: report.reason };
}
