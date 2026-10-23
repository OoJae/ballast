import { createHash } from "node:crypto";
import { canonicalize, type QuotePolicy, quotePolicyHash, sha256Hex } from "@ballast/core";
import { findL3Bootstrap, type MarkParams, type RecordLine, readRecordings } from "@ballast/market";
import {
  ALL_SCENARIOS,
  buildStressScenario,
  DEFAULT_ACCOUNTS,
  RECORDED_SCENARIOS,
  type ScenarioId,
  STRESS_SCENARIOS,
} from "./scenarios.js";
import { type SimAccountConfig, type SimConfig, Simulator, type Violations } from "./simulator.js";

/** Recorded data to replay: a recordings root and the receive-time windows to cover. */
export interface CriticSegments {
  root: string;
  /** Omitted: one window over everything recorded. */
  windows?: readonly { fromMs: number; toMs: number }[];
}

export interface CriticOptions {
  seed?: number;
  accounts?: readonly SimAccountConfig[];
  /** The mark replica's p99 error in bps (b_liq = liqBuffer + 2 × p99). Default 0.77. */
  replicaP99Bps?: string;
  /** P2-blind (before D6, the default) or the replica's P2 projection. */
  p2?: { mode: "blind" } | { mode: "replica"; params: MarkParams };
  /** House fair value for the house-reaction scenario, bps over index. */
  houseFairBps?: bigint;
}

export interface ScenarioReport {
  id: ScenarioId;
  window: { fromMs: number; toMs: number };
  violations: Violations;
  fills: number;
  armedHours: number;
  maxCombinedDrawdownMicroUsd: string;
  /** sha256 over the records this scenario consumed. */
  dataRoot: string;
  diagnostics: Record<string, number>;
  violationLog: string[];
  error?: string;
}

export interface CriticRun {
  v: 1;
  policyHash: string;
  /** sha256 over the scenarios' data roots, in order. */
  dataRoot: string;
  seed: number;
  scenarios: ScenarioReport[];
  /** Requested scenarios that could not run (e.g. recorded ones without recordings). */
  skipped: string[];
  verdict: "PASS" | "FAIL";
  /** sha256(JCS(this run without `hash`)): same data root + policy + seed ⇒ same hash. */
  hash: string;
}

const clean = (v: Violations) => v.cover + v.floor + v.p2 + v.static + v.rate === 0;

function recordLine(rec: RecordLine): string {
  return `${rec.r}|${rec.stream}|${rec.k}|${JSON.stringify(rec.d)}\n`;
}

function simConfig(
  policy: QuotePolicy,
  opts: CriticOptions,
  seed: number,
  over: Partial<SimConfig>,
): SimConfig {
  return {
    policy,
    accounts: opts.accounts ?? DEFAULT_ACCOUNTS,
    seed,
    ...(opts.replicaP99Bps ? { replicaP99Bps: opts.replicaP99Bps } : {}),
    ...(opts.p2 ? { p2: opts.p2 } : {}),
    ...over,
  };
}

function report(
  id: ScenarioId,
  sim: Simulator,
  dataRoot: string,
  window: { fromMs: number; toMs: number },
): ScenarioReport {
  const r = sim.finish();
  return {
    id,
    window: r.window.toMs > 0 ? r.window : window,
    violations: r.violations,
    fills: r.fills,
    armedHours: r.armedHours,
    maxCombinedDrawdownMicroUsd: r.maxCombinedDrawdownMicroUsd,
    dataRoot,
    diagnostics: r.diagnostics,
    violationLog: r.violationLog,
  };
}

/**
 * The Critic's deterministic replay (plan section 6), called by M4's activation gate. Every
 * requested scenario runs the candidate policy through the simulator with the keeper, engine and
 * Guard in the loop; recorded scenarios share one pass over the recordings per window. The
 * verdict is PASS only when every scenario that ran shows zero cover, floor, P2, static and rate
 * violations and none failed to run. Errors never throw out of here: they become a FAIL.
 */
export async function runCritic(
  policy: QuotePolicy,
  segments: CriticSegments | null,
  scenarios: readonly ScenarioId[] = ALL_SCENARIOS,
  opts: CriticOptions = {},
): Promise<CriticRun> {
  const seed = opts.seed ?? 1;
  const want = new Set(scenarios);
  const out: ScenarioReport[] = [];
  const skipped: string[] = [];
  const recorded = RECORDED_SCENARIOS.filter((s) => want.has(s));

  if (recorded.length > 0 && !segments) skipped.push(...recorded);
  if (recorded.length > 0 && segments) {
    const windows = segments.windows ?? [{ fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }];
    for (const w of windows) {
      const sims = recorded.map((id) => ({
        id,
        sim: new Simulator(
          simConfig(policy, opts, seed, {
            window: w,
            takerMode: id === "recorded-notional" ? "notional" : "size",
            houseReaction: id === "house-reaction" ? { fairBps: opts.houseFairBps ?? 60n } : null,
          }),
        ),
      }));
      const hash = createHash("sha256");
      let lines = 0;
      try {
        // Warm up from the latest hour whose L3 segment can bootstrap the book.
        const from = await findL3Bootstrap(segments.root, w.fromMs, [policy.market]);
        const filter = from === null ? { toMs: w.toMs } : { fromMs: from, toMs: w.toMs };
        for await (const rec of readRecordings(segments.root, filter)) {
          hash.update(recordLine(rec));
          lines += 1;
          for (const s of sims) s.sim.onRecord(rec);
        }
        const root = hash.digest("hex");
        if (lines === 0) skipped.push(...recorded.map((id) => `${id}@${w.fromMs}`));
        else for (const s of sims) out.push(report(s.id, s.sim, root, w));
      } catch (e) {
        for (const s of sims) {
          out.push({
            ...report(s.id, s.sim, "", w),
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  }

  for (const id of STRESS_SCENARIOS) {
    if (!want.has(id)) continue;
    try {
      const built = buildStressScenario(id, seed);
      const sim = new Simulator(
        simConfig(policy, opts, seed, { perturbations: built.perturbations, window: built.window }),
      );
      const hash = createHash("sha256");
      for (const rec of built.records) {
        hash.update(recordLine(rec));
        sim.onRecord(rec);
      }
      out.push(report(id, sim, hash.digest("hex"), built.window));
    } catch (e) {
      out.push({
        id,
        window: { fromMs: 0, toMs: 0 },
        violations: { cover: 0, floor: 0, p2: 0, static: 0, rate: 0 },
        fills: 0,
        armedHours: 0,
        maxCombinedDrawdownMicroUsd: "0",
        dataRoot: "",
        diagnostics: {},
        violationLog: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const body = {
    v: 1 as const,
    policyHash: quotePolicyHash(policy),
    dataRoot: sha256Hex(canonicalize(out.map((s) => s.dataRoot))),
    seed,
    scenarios: out,
    skipped,
    verdict:
      out.length > 0 && out.every((s) => s.error === undefined && clean(s.violations))
        ? ("PASS" as const)
        : ("FAIL" as const),
  };
  return { ...body, hash: sha256Hex(canonicalize(body)) };
}
