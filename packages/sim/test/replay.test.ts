import { defaultQuotePolicy } from "@ballast/core";
import { describe, expect, it } from "vitest";
import { RECORDED_SCENARIOS, runCritic } from "../src/index.js";

/**
 * The M3 replay exit criterion over the local recordings (read-only, gitignored, never
 * committed). Skipped when BALLAST_RECORDINGS is unset. The criterion asks for 7 days; the
 * recorder has been live only since 2026-10-23 00:49 UTC, so this covers what exists and says so.
 */
const ROOT = process.env.BALLAST_RECORDINGS;
const POLICY = defaultQuotePolicy({ policyId: "01JC0FFEE00000000000000000", validFromMs: 0 });
const SEVEN_DAYS_H = 7 * 24;

describe.skipIf(!ROOT)("replay over the recordings (BALLAST_RECORDINGS)", () => {
  it(
    "every recorded scenario replays with zero invariant violations",
    async () => {
      const run = await runCritic(POLICY, { root: ROOT as string }, RECORDED_SCENARIOS, {
        seed: 1,
      });
      expect(run.skipped).toEqual([]);
      for (const s of run.scenarios) {
        expect(s.error, s.id).toBeUndefined();
        expect(s.violations, `${s.id}: ${s.violationLog.join(" | ")}`).toEqual({
          cover: 0,
          floor: 0,
          p2: 0,
          static: 0,
          rate: 0,
        });
      }
      expect(run.verdict).toBe("PASS");
      const recorded = run.scenarios.find((s) => s.id === "recorded");
      if (!recorded) throw new Error("no recorded scenario");
      const hours = (recorded.window.toMs - recorded.window.fromMs) / 3_600_000;
      expect(hours).toBeGreaterThan(0.5);
      expect(recorded.armedHours).toBeGreaterThan(0);
      // The house lifting every ask under fair value is the worst case for fills.
      expect(run.scenarios.find((s) => s.id === "house-reaction")?.fills).toBeGreaterThan(0);
      console.info(
        `replayed ${hours.toFixed(2)} h of recordings (${new Date(recorded.window.fromMs).toISOString()} → ${new Date(recorded.window.toMs).toISOString()}): ` +
          `0 violations, armed ${recorded.armedHours.toFixed(2)} h, ${recorded.fills} fills. ` +
          `The M3 exit criterion needs ${SEVEN_DAYS_H} h; ${(SEVEN_DAYS_H - hours).toFixed(1)} h are not recorded yet.`,
      );
    },
    15 * 60_000,
  );
});
