import {
  type MicroUsd,
  type QuotePolicy,
  type RefPrice,
  refPrice,
  type Steps,
  steps,
} from "@ballast/core";
import type { Dec, FloorPosition, LevelBook } from "@ballast/market";
import {
  type AllocAccount,
  type AllocationResult,
  type AllocLevel,
  type AllocOptions,
  allocAccount,
  allocate,
} from "./allocator.js";
import type { MarketCaps } from "./arm-list.js";
import {
  type AccountCapacity,
  accountCapacity,
  aggregateCap,
  aggregateRoom,
  exitDepthMicroUsd,
} from "./capacity.js";
import { clientOrderId } from "./client-id.js";
import { type DesiredOrder, type DiffResult, diffOrders, type RestingOrder } from "./differ.js";
import { FINGERPRINT_MODULUS, fingerprintCode, fingerprintSize } from "./fingerprint.js";
import { type GovernorResult, govern, type P2Mode } from "./governor.js";
import type { EngineMarket } from "./market.js";
import { validateCreate } from "./validate.js";

export interface RequoteAccount {
  id: string;
  holder0: boolean;
  coverSteps: Steps;
  rBps: bigint;
  shortSteps: Steps;
  /** This account's live Ballast asks on the symbol. */
  resting: readonly RestingOrder[];
  maxShortMicroUsd: MicroUsd | null;
  lastReplaceBatchMs: number | null;
  /** From the keeper: false means the account only cancels this round. */
  allowCreates: boolean;
}

export interface RequoteInput {
  market: EngineMarket;
  caps: MarketCaps;
  policy: QuotePolicy;
  policyHash: string;
  /** The book without Ballast's orders. */
  book: LevelBook;
  index: Dec;
  mark: Dec;
  positions: readonly FloorPosition[];
  positionsAgeMs: number;
  replicaP99Bps: Dec;
  p2: P2Mode;
  accounts: readonly RequoteAccount[];
  nowMs: number;
  /** Decision sequence number: the seq36 of every client id this round creates. */
  seq: bigint;
  fingerprintModulus?: bigint;
}

export interface AccountPlan {
  accountId: string;
  desired: DesiredOrder[];
  /** Levels dropped by fingerprinting or the static checks. */
  dropped: { level: number; reason: string }[];
  diff: DiffResult;
}

export interface RequotePlan {
  governor: GovernorResult;
  mark: RefPrice;
  exitDepth: MicroUsd;
  aggregateCap: MicroUsd;
  aggregateRoom: MicroUsd;
  capacities: AccountCapacity[];
  /** Exactly what the allocator ran on, so the Guard can recompute it. */
  allocatorInput: { accounts: AllocAccount[]; ladder: AllocLevel[]; opts: AllocOptions };
  allocation: AllocationResult;
  accounts: AccountPlan[];
}

/** Orders a requote cannot cancel by id stay counted against cover (unknown counts as resting). */
function lockedSteps(resting: readonly RestingOrder[]): Steps {
  let n = 0n;
  for (const r of resting) if (r.status !== "open" || r.orderId === null) n += r.qty;
  return steps(n);
}

/**
 * One requote for one market: governor (floor + P2) → capacity → allocator → fingerprinted,
 * validated desired orders → per-account replace-batch diff. A stand-down, or an account the
 * keeper has stopped, yields an empty desired set, so the diff only cancels.
 */
export function planRequote(input: RequoteInput): RequotePlan {
  const { market, caps, policy } = input;
  const mark = refPrice(market.tick, input.mark.toFixed());
  const capacities = input.accounts.map((a) =>
    accountCapacity(
      {
        id: a.id,
        holder0: a.holder0,
        coverSteps: a.coverSteps,
        rBps: a.rBps,
        shortSteps: a.shortSteps,
        lockedSteps: lockedSteps(a.resting),
        maxShortMicroUsd: a.maxShortMicroUsd,
      },
      policy,
      caps,
      mark,
      market.rate,
    ),
  );
  const exitDepth = exitDepthMicroUsd(input.book, market.rate);
  const cap = aggregateCap(policy, exitDepth);
  const room = aggregateRoom(cap, capacities);
  const governor = govern({
    market,
    caps,
    policy,
    book: input.book,
    index: input.index,
    mark: input.mark,
    positions: input.positions,
    positionsAgeMs: input.positionsAgeMs,
    replicaP99Bps: input.replicaP99Bps,
    p2: input.p2,
    budget: room,
  });

  const creating = new Set(input.accounts.filter((a) => a.allowCreates).map((a) => a.id));
  const allocAccounts = capacities.filter((c) => creating.has(c.id)).map(allocAccount);
  const ladder: AllocLevel[] = governor.ok
    ? governor.ladder.map((l) => ({ level: l.level, px: l.px, qty: l.qty }))
    : [];
  const opts: AllocOptions = {
    rate: market.rate,
    minNotional: market.ballastMinNotional,
    aggregateRoom: room,
  };
  const allocation = allocate(allocAccounts, ladder, opts);
  const modulus = input.fingerprintModulus ?? FINGERPRINT_MODULUS;

  const accounts = input.accounts.map((a): AccountPlan => {
    const desired: DesiredOrder[] = [];
    const dropped: AccountPlan["dropped"] = [];
    for (const al of allocation.allocations) {
      if (al.accountId !== a.id) continue;
      const level = al.level as 1 | 2 | 3;
      const qty = fingerprintSize(al.qty, fingerprintCode(a.id, level, modulus), modulus);
      if (qty === null) {
        dropped.push({ level, reason: "too small to fingerprint" });
        continue;
      }
      const v = validateCreate(
        market,
        {
          price: market.tick.fromUnits(al.px).toFixed(),
          size: market.step.fromUnits(qty).toFixed(),
          reduceOnly: false,
        },
        mark,
      );
      if (!v.ok) {
        const failed = v.checks.filter((c) => !c.ok).map((c) => c.id);
        dropped.push({ level, reason: `static: ${failed.join(", ")}` });
        continue;
      }
      desired.push({ level, px: al.px, qty });
    }
    const diff = diffOrders({
      market,
      resting: a.resting,
      desired,
      nowMs: input.nowMs,
      lastReplaceBatchMs: a.lastReplaceBatchMs,
      minIntervalMs: policy.requote.minIntervalMs,
      clientId: (level) =>
        clientOrderId({ policyHash: input.policyHash, accountId: a.id, level, seq: input.seq }),
    });
    return { accountId: a.id, desired, dropped, diff };
  });

  return {
    governor,
    mark,
    exitDepth,
    aggregateCap: cap,
    aggregateRoom: room,
    capacities,
    allocatorInput: { accounts: allocAccounts, ladder, opts },
    allocation,
    accounts,
  };
}
