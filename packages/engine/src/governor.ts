import {
  type MicroUsd,
  maxBigint,
  microUsd,
  minBigint,
  policyMoney,
  type QuotePolicy,
  refPrice,
  type Steps,
  steps,
  type Ticks,
  ticks,
} from "@ballast/core";
import {
  type Dec,
  type FloorPosition,
  fragileLongs,
  type LevelBook,
  type LiquidationFloor,
  liquidationFloor,
  type MarkParams,
  P2_BLIND_MAX_NOTIONAL,
  type P2StandDownReason,
  p2BlindMode,
  projectP2,
} from "@ballast/market";
import type { MarketCaps } from "./arm-list.js";
import {
  buildLadder,
  capLadderNotional,
  type LadderLevel,
  type LadderStandDown,
  policyRations,
} from "./ladder.js";
import type { EngineMarket } from "./market.js";

export type P2Mode =
  | { mode: "blind" }
  | {
      mode: "replica";
      params: MarkParams;
      /** Current basis history, oldest first. */
      basis: readonly Dec[];
      basisGapFree: boolean;
    };

export interface GovernorInput {
  market: EngineMarket;
  caps: MarketCaps;
  policy: QuotePolicy;
  /** The book without Ballast's orders. */
  book: LevelBook;
  index: Dec;
  mark: Dec;
  positions: readonly FloorPosition[];
  positionsAgeMs: number;
  /** The mark replica's p99 error in bps; b_liq = policy liqBuffer + 2 × this. */
  replicaP99Bps: Dec;
  p2: P2Mode;
  /** Notional the aggregate cap still allows (capacity.ts); omitted = no extra cap. */
  budget?: MicroUsd;
}

/** What the Guard's p2-constraint rule is told about the admitted ladder. */
export type P2Fact =
  | { mode: "blind"; fragileLong: boolean; capMicroUsd: MicroUsd }
  | { mode: "replica"; safe: boolean; minL1Ticks: Ticks; maxL1DepthSteps: Steps };

export type GovernorStandDown =
  | LadderStandDown
  | P2StandDownReason
  | "market-closed"
  | "empty-ladder"
  | "p2-recheck-failed";

export type GovernorResult =
  | {
      ok: true;
      mode: P2Fact["mode"];
      ladder: LadderLevel[];
      l1: Ticks;
      floor: LiquidationFloor;
      p2: P2Fact;
    }
  | {
      ok: false;
      reason: GovernorStandDown;
      detail: string;
      floor: LiquidationFloor | null;
    };

const BLIND_CAP = microUsd(BigInt(P2_BLIND_MAX_NOTIONAL.times(1_000_000).toFixed(0)));

/**
 * Combines the floor, the P2 constraint and P2-blind mode into one admissible aggregate ladder,
 * or a stand-down with its reason. Before D6 passes (no validated replica) the governor runs
 * P2-blind: total ≤ min($300, policy pre-D6 cap), L1 ≥ max(F, mark), and no quote while any
 * long is fragile. With the replica it solves the cheapest safe L1 and its depth, then rebuilds
 * the final ladder and re-projects it, so what is admitted is exactly what was checked.
 */
export function govern(input: GovernorInput): GovernorResult {
  const { market, caps, policy } = input;
  if (!market.trading) {
    return { ok: false, reason: "market-closed", detail: "market is not trading", floor: null };
  }
  const floor = liquidationFloor({
    positions: input.positions,
    tiers: market.spec.tiers,
    positionsAgeMs: input.positionsAgeMs,
    mark: input.mark,
    replicaP99Bps: input.replicaP99Bps,
    tick: market.tick,
    baseBps: policy.pricing.liqBufferBps,
  });
  const index = refPrice(market.tick, input.index.toFixed());
  const money = policyMoney(policy);
  const levels = Math.min(policy.pricing.maxLevels, caps.maxLevels);
  const ladderArgs = {
    floorTicks: ticks(floor.ticks),
    index,
    minOffsetBps: maxBigint(BigInt(policy.pricing.minOffsetBps), caps.minOffsetBps),
    spacingBps: policy.pricing.levelSpacingBps.slice(0, levels - 1).map(BigInt),
    levels,
    bestAskTicks: input.book.asks[0] ? ticks(input.book.asks[0].px) : null,
    minImprovementBps: BigInt(policy.pricing.minImprovementBps),
    rations: policyRations(money.l1Refill),
    rate: market.rate,
  };
  const stand = (reason: GovernorStandDown, detail: string): GovernorResult => ({
    ok: false,
    reason,
    detail,
    floor,
  });
  const budget = input.budget ?? null;
  const asLevels = (ls: readonly LadderLevel[]) => ls.map((l) => ({ px: l.px, qty: l.qty }));

  if (input.p2.mode === "blind") {
    const markTicks = ticks(market.tick.ceilUnits(input.mark));
    const built = buildLadder({ ...ladderArgs, markTicks });
    if (!built.ok) return stand(built.reason, built.detail);
    let cap = minBigint(BLIND_CAP, money.preD6DepthCap);
    if (budget !== null) cap = minBigint(cap, budget);
    const ladder = capLadderNotional(built.levels, microUsd(cap), market.rate);
    if (ladder.length === 0) return stand("empty-ladder", `no size fits $${cap} micro-USD`);
    const blind = p2BlindMode({
      floorTicks: floor.ticks,
      mark: input.mark,
      index: input.index,
      positions: input.positions,
      tiers: market.spec.tiers,
      bLiqBps: floor.bLiqBps,
      ladder: asLevels(ladder),
      tick: market.tick,
      step: market.step,
    });
    if (!blind.ok) return stand(blind.reason, blind.detail);
    return {
      ok: true,
      mode: "blind",
      ladder,
      l1: built.l1,
      floor,
      p2: { mode: "blind", fragileLong: false, capMicroUsd: microUsd(cap) },
    };
  }

  const p2 = input.p2;
  const first = buildLadder(ladderArgs);
  if (!first.ok) return stand(first.reason, first.detail);
  const shaped =
    budget === null ? first.levels : capLadderNotional(first.levels, budget, market.rate);
  if (shaped.length === 0) return stand("empty-ladder", "the aggregate cap leaves no size");
  const fragile =
    fragileLongs(input.positions, market.spec.tiers, input.index, floor.bLiqBps).length > 0;
  const common = {
    book: input.book,
    index: input.index,
    basis: p2.basis,
    basisGapFree: p2.basisGapFree,
    params: p2.params,
    market: market.spec,
    target: floor.liquidationTarget,
    fragileLong: fragile,
  };
  const plan = projectP2({
    ...common,
    ladder: asLevels(shaped),
    minL1Ticks: first.l1,
    maxL1Ticks: first.maxL1Ticks,
  });
  if (!plan.ok) return stand(plan.reason, plan.detail);

  const final = buildLadder({ ...ladderArgs, p2SafeTicks: ticks(plan.l1Ticks) });
  if (!final.ok) return stand(final.reason, final.detail);
  let ladder = final.levels.map((l, i) =>
    i === 0 ? { ...l, qty: steps(minBigint(l.qty, plan.maxDepthSteps)) } : l,
  );
  if (budget !== null) ladder = capLadderNotional(ladder, budget, market.rate);
  ladder = ladder.filter((l) => l.qty > 0n);
  if (ladder.length === 0 || ladder[0]?.level !== 1) {
    return stand("empty-ladder", "no depth at L1 keeps P2 safe");
  }
  // Re-project exactly the ladder being admitted (L2/L3 sit at bps offsets, not the solve's
  // tick shift), with the L1 search pinned to it.
  const recheck = projectP2({
    ...common,
    ladder: asLevels(ladder),
    minL1Ticks: final.l1,
    maxL1Ticks: final.l1,
  });
  const l1Qty = ladder[0]?.qty ?? 0n;
  if (!recheck.ok || !recheck.proposed.safe || recheck.maxDepthSteps < l1Qty) {
    return stand(
      "p2-recheck-failed",
      recheck.ok ? "the admitted ladder is not P2-safe as proposed" : recheck.detail,
    );
  }
  return {
    ok: true,
    mode: "replica",
    ladder,
    l1: final.l1,
    floor,
    p2: {
      mode: "replica",
      safe: true,
      minL1Ticks: final.l1,
      maxL1DepthSteps: steps(recheck.maxDepthSteps),
    },
  };
}
