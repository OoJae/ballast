import {
  defaultQuotePolicy,
  microUsd,
  type QuotePolicy,
  quotePolicyHash,
  refPrice,
  steps,
  ticks,
} from "@ballast/core";
import {
  engineMarket,
  NIGHT_CAPS,
  planRequote,
  REFERENCE_MARKETS,
  type RequotePlan,
} from "@ballast/engine";
import { dec, type LevelBook } from "@ballast/market";
import type { GuardInput } from "../src/index.js";

export const T0 = 1_792_716_885_000;
export const NOW = T0 + 60_000;
export const NIGHT = engineMarket(REFERENCE_MARKETS["NIGHT-USD"]);
export const POLICY: QuotePolicy = defaultQuotePolicy({
  policyId: "01JC0FFEE00000000000000000",
  validFromMs: T0,
});
export const HASH = quotePolicyHash(POLICY);
export const ACCOUNT = "019a0c2e-1111-7000-8000-000000000001";
export const SEQ = 7n;

export const BOOK: LevelBook = {
  bids: [
    { px: 38_300n, qty: 400_000n },
    { px: 38_250n, qty: 200_000n },
  ],
  asks: [
    { px: 38_750n, qty: 30_000n },
    { px: 38_800n, qty: 100_000n },
    { px: 39_000n, qty: 400_000n },
  ],
};
export const INDEX = "0.0383";
export const MARK = "0.03835";

/** The real pipeline's plan for one outside account with 100k NIGHT at r = 0.5. */
export function plan(over: { cover?: bigint; short?: bigint } = {}): RequotePlan {
  return planRequote({
    market: NIGHT,
    caps: NIGHT_CAPS,
    policy: POLICY,
    policyHash: HASH,
    book: BOOK,
    index: dec(INDEX),
    mark: dec(MARK),
    positions: [],
    positionsAgeMs: 1_000,
    replicaP99Bps: dec("0.77"),
    p2: { mode: "blind" },
    accounts: [
      {
        id: ACCOUNT,
        holder0: false,
        coverSteps: steps(over.cover ?? 100_000n),
        rBps: 5_000n,
        shortSteps: steps(over.short ?? 0n),
        resting: [],
        maxShortMicroUsd: null,
        lastReplaceBatchMs: null,
        allowCreates: true,
      },
    ],
    nowMs: NOW,
    seq: SEQ,
  });
}

/** A fully valid, armed, live (DRY_RUN=false) mainnet requote that every rule passes. */
export function baseInput(): GuardInput {
  const p = plan();
  const acct = p.accounts[0];
  if (acct?.diff.kind !== "replace-batch") throw new Error("fixture: no replace-batch");
  if (!p.governor.ok) throw new Error(`fixture: ${p.governor.reason}`);
  return {
    nowMs: NOW,
    request: {
      method: "POST",
      path: "/v2/order/replace-batch",
      body: acct.diff.body,
      builderFeeBps: 10,
    },
    profile: "AUTONOMOUS",
    flags: { dryRun: false, armed: true, mainnet: true },
    policy: { policy: POLICY, hash: HASH, signatureValid: true, renewalsUsed: 0 },
    critic: { verdict: "PASS", policyHash: HASH, reportValid: true },
    market: {
      spec: NIGHT,
      caps: NIGHT_CAPS,
      allowlist: ["NIGHT-USD", "ADA-USD"],
      arm: { armed: true },
      index: refPrice(NIGHT.tick, INDEX),
      mark: refPrice(NIGHT.tick, MARK),
      bestBidTicks: ticks(38_300n),
      bestAskTicks: ticks(38_750n),
      floor: {
        ticks: ticks(p.governor.floor.ticks),
        bLiqMicroBps: 11_540_000n,
        replicaP99MicroBps: 770_000n,
        positionsStale: false,
      },
      p2: p.governor.p2,
      others: { exposureMicroUsd: microUsd(0n), askMicroUsd: microUsd(0n), l1Steps: steps(0n) },
      exitDepthMicroUsd: p.exitDepth,
      recyclingOptIn: false,
    },
    data: {
      indexAgeMs: 400,
      markAgeMs: 400,
      l3Synced: true,
      l3GapFree: true,
      coverAgeMs: 8_000,
      marketsAgeMs: 30_000,
      userStreamConnected: true,
    },
    reference: { status: "ok", deviationBps: 6n },
    account: {
      id: ACCOUNT,
      holder0: false,
      stakeBinding: { bound: true, unique: true },
      foreignOrders: 0,
      foreignPositions: false,
      vaultShares: false,
      coverSteps: steps(100_000n),
      rBps: 5_000n,
      shortSteps: steps(0n),
      resting: [],
      pendingSteps: steps(0n),
      unknownOrders: 0,
      exposureUpperBound: true,
      oldestUnconfirmedCreateAtMs: null,
      equityMicroUsd: microUsd(500_000_000n),
      marginRatioBps: 800n,
      marginBand: "ok",
      maxShortMicroUsd: null,
      approvedBuilderBps: 10,
      lossTodayMicroUsd: microUsd(0n),
      lossHoldUntilMs: null,
      committedCoverMicroUsd: microUsd(1_915_000_000n),
    },
    allocator: p.allocatorInput,
    rate: {
      usedInWindow: 0,
      windowCap: 300,
      cancelReserve: 60,
      lastReplaceBatchMs: null,
      spacingMs: 2_000,
      pausedUntilMs: 0,
    },
    decisionSeq: SEQ,
    usedClientOrderIds: new Set(),
  };
}

/** The first create of the base request, for building variants. */
export function firstCreate(input: GuardInput): Record<string, unknown> {
  const body = input.request.body as { replacements: { new_order?: Record<string, unknown> }[] };
  const c = body.replacements.find((r) => r.new_order)?.new_order;
  if (!c) throw new Error("fixture: no create");
  return c;
}

/** The base request with its (single) create edited. */
export function withCreate(edit: (c: Record<string, unknown>) => void): GuardInput {
  const input = baseInput();
  const c = structuredClone(firstCreate(input));
  edit(c);
  return {
    ...input,
    request: { ...input.request, body: { replacements: [{ new_order: c }] } },
  };
}
