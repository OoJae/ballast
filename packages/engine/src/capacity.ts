import {
  BPS,
  type MicroUsd,
  maxBigint,
  microUsd,
  minBigint,
  type NotionalRate,
  notionalFloor,
  policyMoney,
  type QuotePolicy,
  type RefPrice,
  refNotionalCeil,
  type Steps,
  steps,
  ticks,
} from "@ballast/core";
import type { LevelBook } from "@ballast/market";
import type { MarketCaps } from "./arm-list.js";

/** The hard ceiling on r (plan section 5): default 0.50, maximum 0.90. */
export const R_MAX_BPS = 9_000n;
/** Exit depth: live asks within this band over mid, Ballast excluded. */
export const EXIT_DEPTH_BAND_BPS = 200n;

export interface CapacityAccount {
  id: string;
  holder0: boolean;
  /** On-chain cover in the market's size steps (NIGHT units for NIGHT-USD). */
  coverSteps: Steps;
  /** The holder's chosen r; capped by the policy and R_MAX_BPS. */
  rBps: bigint;
  shortSteps: Steps;
  /**
   * Asks that stay counted whatever this requote does: orders of unknown size, unconfirmed
   * creates, or resting orders the requote keeps (unknown counts as resting).
   */
  lockedSteps: Steps;
  /** Holder-set USD cap on short + asks; null = the policy cap alone. */
  maxShortMicroUsd: MicroUsd | null;
}

export interface AccountCapacity {
  id: string;
  holder0: boolean;
  /** C_i = floor(r_i × cover_i). */
  committed: Steps;
  /** short + locked asks. */
  used: Steps;
  /** K_i = r_i·cover_i − short_i − locked_i (never negative). */
  room: Steps;
  /** min(policy per-account cap, holder-set cap, holder #0 cap). */
  usdCap: MicroUsd;
  /** short + locked valued at mark, rounded up. */
  usdUsed: MicroUsd;
  /** True when short + locked already exceed r × cover: the keeper must act, nothing is added. */
  breached: boolean;
}

export function effectiveRBps(rBps: bigint, policy: QuotePolicy): bigint {
  return maxBigint(0n, minBigint(rBps, minBigint(BigInt(policy.sizing.rMaxBps), R_MAX_BPS)));
}

/** floor(r × cover) in steps. */
export function committedSteps(coverSteps: Steps, rBps: bigint): Steps {
  if (coverSteps <= 0n || rBps <= 0n) return steps(0n);
  return steps((coverSteps * rBps) / BPS);
}

export function accountCapacity(
  a: CapacityAccount,
  policy: QuotePolicy,
  caps: MarketCaps,
  mark: RefPrice,
  rate: NotionalRate,
): AccountCapacity {
  const committed = committedSteps(a.coverSteps, effectiveRBps(a.rBps, policy));
  const used = steps(a.shortSteps + a.lockedSteps);
  let usdCap: bigint = policyMoney(policy).perAccountMaxShort;
  if (a.maxShortMicroUsd !== null) usdCap = minBigint(usdCap, a.maxShortMicroUsd);
  if (a.holder0) usdCap = minBigint(usdCap, caps.holder0MaxShort);
  return {
    id: a.id,
    holder0: a.holder0,
    committed,
    used,
    room: steps(maxBigint(0n, committed - used)),
    usdCap: microUsd(usdCap),
    usdUsed: refNotionalCeil(mark, used, rate),
    breached: used > committed,
  };
}

/**
 * Exit depth: quote notional of the asks (Ballast excluded) at or below mid × (1 + 2%), the
 * liquidity Ballast's shorts could buy back into. Zero without a two-sided book (fail closed).
 */
export function exitDepthMicroUsd(
  book: LevelBook,
  rate: NotionalRate,
  bandBps: bigint = EXIT_DEPTH_BAND_BPS,
): MicroUsd {
  const bid = book.bids[0];
  const ask = book.asks[0];
  if (!bid || !ask) return microUsd(0n);
  // px ≤ (bid + ask)/2 × (1 + band)  ⟺  2·px·10⁴ ≤ (bid + ask)·(10⁴ + band)
  const bound = (bid.px + ask.px) * (BPS + bandBps);
  let total = 0n;
  for (const l of book.asks) {
    if (2n * l.px * BPS > bound) break;
    total += notionalFloor(ticks(l.px), steps(l.qty), rate);
  }
  return microUsd(total);
}

/** min(policy aggregate cap, exit depth): the bound on Σ(short + asks) across all accounts. */
export function aggregateCap(policy: QuotePolicy, exitDepth: MicroUsd): MicroUsd {
  return microUsd(minBigint(policyMoney(policy).aggregateMaxShort, exitDepth));
}

export interface ProtocolTakerInput {
  /** Σ r × cover across accounts at the start of the UTC day. */
  dayCapacitySteps: Steps;
  /** Today's Ballast fills where the protocol (house) was the taker, from trade_id joins. */
  filledSteps: Steps;
  /** Strike's written opt-in waives the budget. */
  waived: boolean;
}

/**
 * Protocol-as-taker fill budget (plan section 5, engine): at most `budgetBps` of the day's
 * capacity may be sold to the protocol itself, so Ballast's cover is not just inventory relief
 * for the house. Null means no limit (waived). Never negative.
 */
export function protocolTakerRoom(input: ProtocolTakerInput, budgetBps: bigint): Steps | null {
  if (input.waived) return null;
  const budget = (input.dayCapacitySteps * budgetBps) / BPS;
  return steps(maxBigint(0n, budget - input.filledSteps));
}

/** What the aggregate cap still allows for new asks after every account's short and locks. */
export function aggregateRoom(cap: MicroUsd, accounts: readonly AccountCapacity[]): MicroUsd {
  let used = 0n;
  for (const a of accounts) used += a.usdUsed;
  return microUsd(maxBigint(0n, cap - used));
}
