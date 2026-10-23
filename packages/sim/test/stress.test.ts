import { defaultQuotePolicy } from "@ballast/core";
import { dec } from "@ballast/market";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildStressScenario,
  type CriticRun,
  DEFAULT_ACCOUNTS,
  longRow,
  runCritic,
  type ScenarioReport,
  Simulator,
  STRESS_SCENARIOS,
  SYNTHETIC_START_MS,
  synthesize,
} from "../src/index.js";

const POLICY = defaultQuotePolicy({ policyId: "01JC0FFEE00000000000000000", validFromMs: 0 });

describe("stress library: every scenario runs clean", () => {
  let run: CriticRun;
  const get = (id: string): ScenarioReport => {
    const s = run.scenarios.find((x) => x.id === id);
    if (!s) throw new Error(`no ${id}`);
    return s;
  };
  beforeAll(async () => {
    run = await runCritic(POLICY, null, STRESS_SCENARIOS, { seed: 7 });
  });

  it("has all eight scenarios with zero violations and a PASS verdict", () => {
    expect(run.scenarios.map((s) => s.id)).toEqual([...STRESS_SCENARIOS]);
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
    expect(run.skipped).toEqual([]);
  });

  it("is not vacuous: Ballast quotes and gets filled in the quoting scenarios", () => {
    for (const id of [
      "mark-drop-417",
      "rally-30",
      "index-stall",
      "l3-clear",
      "cover-sale",
      "storm-429",
      "partial-reject",
    ]) {
      const s = get(id);
      expect(s.fills, id).toBeGreaterThan(10);
      expect(s.armedHours, id).toBeGreaterThan(0.1);
      expect(s.diagnostics["exchange.creates"], id).toBeGreaterThan(20);
    }
  });

  it("index stall and L3 clear cancel on stale data", () => {
    expect(get("index-stall").diagnostics["keeper.cancel-all.stale"]).toBeGreaterThan(0);
    expect(get("l3-clear").diagnostics["keeper.cancel-all.stale"]).toBeGreaterThan(0);
    expect(get("l3-clear").diagnostics["l3.break.clear"]).toBe(1);
  });

  it("Koios three blocks behind keeps cover stale (> 60 s): Ballast stays out", () => {
    const s = get("koios-lag-3");
    expect(s.fills).toBe(0);
    expect(s.armedHours).toBeLessThan(0.01);
  });

  it("a holder selling cover mid-quote is cancelled and bought back down to r × cover", () => {
    const s = get("cover-sale");
    expect(s.diagnostics["cover.events"]).toBe(1);
    expect(s.diagnostics["keeper.buy-back"]).toBeGreaterThan(0);
  });

  it("a 429 storm pauses creates (the Guard sees the pause) without breaking anything", () => {
    const s = get("storm-429");
    expect(s.diagnostics["exchange.429.replace-batch"]).toBeGreaterThan(0);
    expect(s.diagnostics["guard.blocked.rate-budget"]).toBeGreaterThan(0);
  });

  it("partial replace-batch rejects apply the cancels and leave nothing unsafe", () => {
    expect(get("partial-reject").diagnostics["exchange.partial-reject"]).toBeGreaterThan(10);
  });

  it("the +30% rally keeps requoting above the rising floor", () => {
    const s = get("rally-30");
    expect(s.fills).toBeGreaterThan(50);
    expect(s.diagnostics["engine.armed"]).toBeGreaterThan(1_000);
  });
});

describe("the simulator's own checks are live (not vacuous)", () => {
  it("counts a cover breach when a spend goes unseen: no mempool signal, Koios behind", () => {
    const built = buildStressScenario("cover-sale", 3);
    const sim = new Simulator({
      policy: POLICY,
      accounts: DEFAULT_ACCOUNTS,
      seed: 3,
      window: built.window,
      perturbations: {
        coverEvents: [
          // Mid-block, so the next confirmed block is ~19 s away.
          {
            atMs: SYNTHETIC_START_MS + 6 * 60_000 + 1_000,
            accountId: "holder-a",
            coverSteps: 1_000n,
            mempool: false,
          },
        ],
      },
    });
    for (const r of built.records) sim.onRecord(r);
    const rep = sim.finish();
    expect(rep.violations.cover).toBeGreaterThan(0);
    expect(rep.violationLog.some((l) => l.includes("cover"))).toBe(true);
  });

  it("stands down in P2-blind mode while a live long is fragile", () => {
    const index = dec("0.0383");
    const spec = {
      startMs: SYNTHETIC_START_MS,
      durationMs: 5 * 60_000,
      index: () => index,
      premiumBps: 25,
      bids: [{ offBps: -8, qty: 80_000 }],
      asks: [{ offBps: 122, qty: 13_000 }],
      requoteMs: 5_000,
      takers: [{ tMs: SYNTHETIC_START_MS + 120_000, side: "buy" as const, qty: 3_000 }],
      // LP 5 bps under index: inside b_liq, so fragile.
      positions: [{ atMs: SYNTHETIC_START_MS + 500, rows: [longRow(index, -5)] }],
    };
    const sim = new Simulator({ policy: POLICY, accounts: DEFAULT_ACCOUNTS, seed: 1 });
    for (const r of synthesize(spec)) sim.onRecord(r);
    const rep = sim.finish();
    expect(rep.fills).toBe(0);
    expect(rep.diagnostics["engine.stand-down.blind-fragile-long"]).toBeGreaterThan(100);
    expect(rep.diagnostics["exchange.creates"] ?? 0).toBe(0);
  });
});
