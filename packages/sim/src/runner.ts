import type { QuotePolicy } from "@ballast/core";
import type { CriticRunner } from "@ballast/governance";
import { type CriticOptions, type CriticSegments, runCritic } from "./critic.js";
import { ALL_SCENARIOS, type ScenarioId } from "./scenarios.js";

export interface SimCriticRunnerConfig {
  segments: CriticSegments | null;
  scenarios?: readonly ScenarioId[];
  options?: CriticOptions;
  /** Commit of the simulator that produced the report, so a verifier can rerun it. */
  simGitSha: string;
}

/**
 * Adapts the simulator to the governance Critic gate. Fail-closed on top of the gate's own
 * checks: a requested scenario that was skipped (e.g. recorded windows without recordings) or
 * errored, or a run computed for a different policy hash, can never come back as a PASS.
 */
export function createSimCriticRunner(cfg: SimCriticRunnerConfig): CriticRunner<QuotePolicy> {
  return {
    async run({ policy, policyHash, signal }) {
      if (signal.aborted) throw new Error("critic aborted before the replay started");
      const run = await runCritic(
        policy,
        cfg.segments,
        cfg.scenarios ?? ALL_SCENARIOS,
        cfg.options,
      );
      if (signal.aborted) throw new Error("critic aborted during the replay");
      if (run.policyHash !== policyHash) {
        throw new Error(
          `simulator replayed policy ${run.policyHash}, gate asked for ${policyHash}`,
        );
      }
      const complete = run.skipped.length === 0 && run.scenarios.every((s) => !s.error);
      return {
        dataRoot: run.dataRoot,
        simGitSha: cfg.simGitSha,
        seed: String(run.seed),
        scenarios: run.scenarios.map((s) => ({
          id: s.id,
          window: s.window,
          violations: s.violations,
          fills: s.fills,
          armedHours: s.armedHours,
          maxCombinedDrawdownMicroUsd: s.maxCombinedDrawdownMicroUsd,
        })),
        verdict: run.verdict === "PASS" && complete ? "PASS" : "FAIL",
      };
    },
  };
}
