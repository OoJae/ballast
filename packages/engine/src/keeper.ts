import { type Steps, steps } from "@ballast/core";
import { committedSteps } from "./capacity.js";
import type { BandResult } from "./keeper-bands.js";

/**
 * The keeper's per-account enforcement step (invariant 1 and the margin bands). Pure: the caller
 * applies the actions and calls again once they are confirmed.
 *
 * Order matters. Any breach cancels first: resting asks are the only part of the exposure that
 * can grow, and cancels are cheap and never blocked by the Guard. Only once no ask rests (and
 * nothing is unknown) does a reduce-only buy-back close the short above r × cover; buying back
 * while asks still rest could be refilled by those very asks.
 */
export interface KeeperInput {
  symbol: string;
  shortSteps: Steps;
  /** Live asks, pending creates included. */
  restingSteps: Steps;
  /** Orders of unknown size or state: they count as resting and block buy-backs. */
  unknownOrders: number;
  /** Confirmed on-chain cover. */
  coverSteps: Steps;
  /** Effective r (already capped by the policy). */
  rBps: bigint;
  /**
   * An unconfirmed spend from the bound credential (mempool). Capacity drops to the post-spend
   * cover when it is known, else to zero, until a block confirms the new cover.
   */
  mempoolSpend: { coverAfterSteps: Steps | null } | null;
  /** Stale reasons (index/mark > 3 s, L3 gap, cover > 60 s, dead stream); empty when fresh. */
  stale: readonly string[];
  margin: BandResult;
  lossStop: boolean;
}

export type KeeperAction =
  | { kind: "cancel-all"; symbol: string; reason: string }
  | { kind: "buy-back"; symbol: string; qty: Steps; reason: string };

export interface KeeperDecision {
  actions: KeeperAction[];
  /** Whether the engine may create on this account now. */
  allowCreates: boolean;
  /** floor(r × cover) after any pending spend. */
  capacity: Steps;
  breach: boolean;
  /** A buy-back is due but waits for the cancels to be confirmed. */
  buyBackPending: Steps;
  reasons: string[];
}

export function keeperStep(k: KeeperInput): KeeperDecision {
  const cover = k.mempoolSpend ? (k.mempoolSpend.coverAfterSteps ?? steps(0n)) : k.coverSteps;
  const capacity = committedSteps(cover, k.rBps);
  const exposure = k.shortSteps + k.restingSteps;
  const breach = exposure > capacity || (k.unknownOrders > 0 && k.shortSteps > capacity);
  const reasons: string[] = [];
  if (breach) reasons.push(`cover: short ${k.shortSteps} + asks ${k.restingSteps} > ${capacity}`);
  if (k.mempoolSpend) reasons.push("cover: unconfirmed spend from the bound credential");
  for (const s of k.stale) reasons.push(`stale: ${s}`);
  if (k.margin.action !== "none") reasons.push(k.margin.reason);
  if (k.lossStop) reasons.push("loss stop: combined MTM loss reached the daily stop");

  let buyBack = 0n;
  if (k.margin.action === "flatten") buyBack = k.shortSteps;
  else if (k.shortSteps > capacity) buyBack = k.shortSteps - capacity;

  const mustCancel =
    breach ||
    k.mempoolSpend !== null ||
    k.stale.length > 0 ||
    k.margin.action !== "none" ||
    k.lossStop ||
    buyBack > 0n;
  const asksLive = k.restingSteps > 0n || k.unknownOrders > 0;
  const actions: KeeperAction[] = [];
  if (mustCancel && asksLive) {
    actions.push({ kind: "cancel-all", symbol: k.symbol, reason: reasons.join("; ") });
  } else if (buyBack > 0n) {
    actions.push({
      kind: "buy-back",
      symbol: k.symbol,
      qty: steps(buyBack),
      reason: k.margin.action === "flatten" ? "flatten band" : "short above r × cover",
    });
  }
  return {
    actions,
    allowCreates: !mustCancel && k.margin.allowCreates && k.unknownOrders === 0,
    capacity,
    breach,
    buyBackPending: steps(mustCancel && asksLive ? buyBack : 0n),
    reasons,
  };
}
