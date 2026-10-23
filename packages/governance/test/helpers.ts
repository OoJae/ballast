import { createHash } from "node:crypto";
import {
  type CriticReport,
  type CriticRunner,
  type CriticRunOutput,
  type CriticScenario,
  DaemonKey,
  OperatorKey,
  type PolicyHeader,
  runCriticGate,
  type SignedPolicy,
  signPolicy,
} from "../src/index.js";

export const T0 = Date.parse("2026-10-23T00:00:00Z");
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Deterministic test seeds. They guard nothing: synthetic keys for synthetic fixtures. */
export function seed(label: string): Buffer {
  return createHash("sha256").update(`ballast-test:${label}`).digest();
}

export const operator = OperatorKey.fromSeed(seed("operator"));
export const daemon = DaemonKey.fromSeed(seed("daemon"));
export const strangerOperator = OperatorKey.fromSeed(seed("stranger-operator"));
export const strangerDaemon = DaemonKey.fromSeed(seed("stranger-daemon"));
export const TRUST = {
  trustedOperators: [operator.publicKeyHex],
  trustedDaemons: [daemon.publicKeyHex],
} as const;

/** A QuotePolicy-shaped object. Governance only reads the header; the rest is opaque JSON. */
export interface TestPolicy extends PolicyHeader {
  market: "NIGHT-USD";
  mode: "asks_only";
  pricing: { minOffsetBps: number; liqBufferBps: number; maxLevels: number };
  sizing: { rMaxBps: number; perAccountMaxShortMicroUsd: string };
}

export function samplePolicy(over: Partial<TestPolicy> = {}): TestPolicy {
  return {
    v: 1,
    policyId: "01JTESTPOLICY0000000000001",
    prevPolicyHash: null,
    market: "NIGHT-USD",
    mode: "asks_only",
    validFromMs: T0,
    validUntilMs: T0 + DAY,
    renewals: 3,
    pricing: { minOffsetBps: 38, liqBufferBps: 10, maxLevels: 3 },
    sizing: { rMaxBps: 5000, perAccountMaxShortMicroUsd: "2000000000" },
    ...over,
  };
}

export function scenario(over: Partial<CriticScenario> = {}): CriticScenario {
  return {
    id: "last-24h",
    window: { fromMs: T0 - DAY, toMs: T0 },
    violations: { cover: 0, floor: 0, p2: 0, static: 0, rate: 0 },
    fills: 12,
    armedHours: 20.5,
    maxCombinedDrawdownMicroUsd: "-1250000",
    ...over,
  };
}

export function passOutput(over: Partial<CriticRunOutput> = {}): CriticRunOutput {
  return {
    dataRoot: "a".repeat(64),
    simGitSha: "4622508",
    seed: "42",
    scenarios: [scenario(), scenario({ id: "stress-2129-sell" })],
    verdict: "PASS",
    ...over,
  };
}

export function runnerReturning(out: unknown): CriticRunner<TestPolicy> {
  return { run: async () => out as CriticRunOutput };
}

export function signed(over: Partial<TestPolicy> = {}): SignedPolicy<TestPolicy> {
  return signPolicy(samplePolicy(over), operator);
}

export async function passReport(
  sp: SignedPolicy<TestPolicy>,
  nowMs: number = T0,
  key: DaemonKey = daemon,
): Promise<CriticReport> {
  return runCriticGate({
    runner: runnerReturning(passOutput()),
    signed: sp,
    daemonKey: key,
    now: () => nowMs,
  });
}
