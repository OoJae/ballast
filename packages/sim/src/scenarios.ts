import { type Dec, dec, type RecordLine } from "@ballast/market";
import { Prng } from "./prng.js";
import type { Perturbations, SimAccountConfig } from "./simulator.js";
import {
  type HouseLevel,
  longRow,
  type SyntheticSpec,
  type SyntheticTaker,
  synthesize,
} from "./synthetic.js";

/**
 * The stress library (plan sections 6 and 9). Recorded scenarios replay the segments; the
 * synthetic ones generate their own NIGHT-like market, so they run anywhere and every seed gives
 * the same stream.
 */
export const RECORDED_SCENARIOS = ["recorded", "recorded-notional", "house-reaction"] as const;
export const STRESS_SCENARIOS = [
  "mark-drop-417",
  "rally-30",
  "index-stall",
  "l3-clear",
  "koios-lag-3",
  "cover-sale",
  "storm-429",
  "partial-reject",
] as const;
export const ALL_SCENARIOS = [...RECORDED_SCENARIOS, ...STRESS_SCENARIOS] as const;
export type ScenarioId = (typeof ALL_SCENARIOS)[number];

/** Holder #0 (team, last in line, ≤ $300 unpaired) and two outside holders. */
export const DEFAULT_ACCOUNTS: readonly SimAccountConfig[] = [
  {
    id: "holder-0",
    holder0: true,
    coverSteps: 7_000n,
    rBps: 5_000n,
    equityMicroUsd: 500_000_000n,
    maxShortMicroUsd: null,
    approvedBuilderBps: 0,
  },
  {
    id: "holder-a",
    holder0: false,
    coverSteps: 150_000n,
    rBps: 5_000n,
    equityMicroUsd: 1_500_000_000n,
    maxShortMicroUsd: null,
    approvedBuilderBps: 10,
  },
  {
    id: "holder-b",
    holder0: false,
    coverSteps: 400_000n,
    rBps: 3_000n,
    equityMicroUsd: 2_500_000_000n,
    maxShortMicroUsd: null,
    approvedBuilderBps: 10,
  },
];

/** A fixed start for synthetic time: 2026-10-22 21:00 UTC, the Oct 20–22 regime. */
export const SYNTHETIC_START_MS = Date.UTC(2026, 9, 22, 21, 0, 0);
const MIN = 60_000;
const INDEX = dec("0.0383");

/** The house ladder of the Oct 22 regime: a deep bid near index, an ask side ~1.2% up. */
const BIDS: HouseLevel[] = [
  { offBps: -8, qty: 80_000 },
  { offBps: -20, qty: 200_000 },
  { offBps: -40, qty: 500_000 },
];
const ASKS: HouseLevel[] = [
  { offBps: 122, qty: 13_000 },
  { offBps: 140, qty: 50_000 },
  { offBps: 170, qty: 200_000 },
];

function walk(seed: number, durationMs: number, stepBps: number, drift = 0): (t: number) => Dec {
  // A bounded random walk sampled once per second, interpolated: deterministic per seed.
  const rng = new Prng(seed);
  const n = Math.ceil(durationMs / 1_000) + 2;
  const path: Dec[] = [];
  let x = 0;
  for (let i = 0; i < n; i++) {
    path.push(INDEX.times(dec(1).plus(dec(x).div(10_000))));
    x += rng.int(-stepBps, stepBps) + drift;
    if (x > 60) x = 60;
    if (x < -60) x = -60;
  }
  return (t: number) =>
    path[Math.max(0, Math.min(n - 1, Math.floor((t - SYNTHETIC_START_MS) / 1_000)))] as Dec;
}

function takers(
  seed: number,
  durationMs: number,
  everyMs: [number, number],
  qty: [number, number],
): SyntheticTaker[] {
  const rng = new Prng(seed ^ 0x5eed);
  const out: SyntheticTaker[] = [];
  for (
    let t = SYNTHETIC_START_MS + 30_000;
    t < SYNTHETIC_START_MS + durationMs;
    t += rng.int(...everyMs)
  ) {
    out.push({ tMs: t, side: rng.chance(4, 5) ? "buy" : "sell", qty: rng.int(...qty) });
  }
  return out;
}

const positionsEvery = (durationMs: number, rows: ReturnType<typeof longRow>[]) => {
  const out: { atMs: number; rows: ReturnType<typeof longRow>[] }[] = [];
  for (let t = SYNTHETIC_START_MS + 500; t < SYNTHETIC_START_MS + durationMs; t += 5 * MIN) {
    out.push({ atMs: t, rows });
  }
  return out;
};

const buy = (tMs: number, qty: number): SyntheticTaker => ({ tMs, side: "buy", qty });
const sell = (tMs: number, qty: number): SyntheticTaker => ({ tMs, side: "sell", qty });
const byTime = (ts: SyntheticTaker[]) => ts.sort((a, b) => a.tMs - b.tMs);

export interface BuiltScenario {
  id: ScenarioId;
  records: RecordLine[];
  perturbations: Perturbations;
  window: { fromMs: number; toMs: number };
}

/** A steady NIGHT market: small index noise, the house ladder, retail takers every ~30 s. */
function steady(seed: number, minutes: number) {
  const durationMs = minutes * MIN;
  const index = walk(seed, durationMs, 1);
  return {
    startMs: SYNTHETIC_START_MS,
    durationMs,
    index,
    premiumBps: 25,
    bids: BIDS,
    asks: ASKS,
    requoteMs: 5_000,
    takers: takers(seed, durationMs, [15_000, 45_000], [800, 2_400]),
    positions: positionsEvery(durationMs, [longRow(INDEX, -300), longRow(INDEX, -450, 60_000)]),
  };
}

export function buildStressScenario(
  id: (typeof STRESS_SCENARIOS)[number],
  seed: number,
): BuiltScenario {
  const at = (m: number) => SYNTHETIC_START_MS + m * MIN;
  let spec: SyntheticSpec = steady(seed, 15);
  let perturbations: Perturbations = {};
  switch (id) {
    case "mark-drop-417": {
      // Thin bids: one $417 market sell sweeps ~64 bps of them (21:29 on Oct 22).
      spec = {
        ...steady(seed, 20),
        bids: [
          { offBps: -5, qty: 2_600 },
          { offBps: -25, qty: 2_600 },
          { offBps: -45, qty: 2_600 },
          { offBps: -64, qty: 2_700 },
          { offBps: -90, qty: 400_000 },
        ],
        takers: byTime([
          ...takers(seed, 20 * MIN, [20_000, 40_000], [800, 2_000]).filter((t) => t.side === "buy"),
          sell(at(8), 10_900),
          buy(at(8) + 2_000, 3_000),
          buy(at(8) + 5_000, 3_000),
        ]),
        // A long 45 bps under index: not fragile, but the drop takes the mark most of the way.
        positions: positionsEvery(20 * MIN, [longRow(INDEX, -45, 80_000), longRow(INDEX, -300)]),
      };
      break;
    }
    case "rally-30": {
      const durationMs = 60 * MIN;
      const index = (t: number) =>
        INDEX.times(
          dec(1).plus(
            dec(Math.max(0, t - SYNTHETIC_START_MS))
              .div(durationMs)
              .times("0.3"),
          ),
        );
      spec = {
        ...steady(seed, 60),
        index,
        takers: takers(seed, durationMs, [10_000, 20_000], [800, 1_600]).map((t) => ({
          ...t,
          side: "buy" as const,
        })),
      };
      break;
    }
    case "index-stall":
      spec = { ...steady(seed, 12), stalls: [{ fromMs: at(4), toMs: at(4) + 40_000 }] };
      spec.takers = byTime([
        ...spec.takers,
        buy(at(4) + 10_000, 2_000),
        buy(at(4) + 20_000, 2_000),
      ]);
      break;
    case "l3-clear":
      spec = { ...steady(seed, 12), clears: [{ atMs: at(5), resnapshotMs: 10_000 }] };
      spec.takers = byTime([...spec.takers, buy(at(5) + 3_000, 2_000), buy(at(5) + 6_000, 2_000)]);
      break;
    case "koios-lag-3":
      spec = steady(seed, 12);
      perturbations = { koiosLagBlocks: 3 };
      break;
    case "cover-sale":
      spec = steady(seed, 15);
      // Holder A sells 90% of the cover while quoting, after the first fills.
      perturbations = {
        coverEvents: [{ atMs: at(6), accountId: "holder-a", coverSteps: 15_000n }],
      };
      break;
    case "storm-429":
      spec = steady(seed, 15);
      perturbations = { storm429: [{ fromMs: at(4), toMs: at(6), num: 9, den: 10 }] };
      break;
    case "partial-reject":
      spec = steady(seed, 15);
      // Every replace-batch in the window: cancels apply, the first create is rejected and the
      // rest are skipped (the post-only-cross stop rule).
      perturbations = { partialReject: { fromMs: at(3), toMs: at(9), index: 0 } };
      break;
  }
  return {
    id,
    records: synthesize(spec),
    perturbations,
    window: { fromMs: spec.startMs, toMs: spec.startMs + spec.durationMs },
  };
}
