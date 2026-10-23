/**
 * The watchdog's firing rules (plan section 5, kill path step 3), pure:
 * 1. no verified heartbeat from the keeper for 10 s → every account;
 * 2. a Ballast ask on L3 below the liquidation floor F, or below index + 20 bps → that account;
 * 3. cover drops: on-chain cover × r no longer covers short + resting asks, or cover fell while
 *    asks rest → that account.
 * Inputs are the watchdog's own views (its own L3, index, live positions and Koios reads, its own
 * user stream and REST reads), never the keeper's word for them.
 */
import { type RefPrice, refPlusBpsCeil } from "@ballast/core";

/** Ballast asks below index × (1 + this) are unsafe whatever the floor says. */
export const INDEX_GUARD_BPS = 20n;

export interface WatchedAsk {
  clientOrderId: string;
  px: bigint;
  /** Where the watchdog saw it: on L3 (attributed by fingerprint) or only in its order view. */
  source: "l3" | "view" | "fingerprint";
}

export interface AccountFacts {
  accountId: string;
  asks: readonly WatchedAsk[];
  /** short + resting asks (+ unconfirmed), in size steps, from the watchdog's own reconciler. */
  exposureSteps: bigint;
  /** floor(r × cover) in size steps, from the watchdog's own Koios read; null when unknown. */
  capacitySteps: bigint | null;
  /** The cover fell between the last two proofs. */
  coverFell: boolean;
}

export interface WatchdogFacts {
  heartbeatAlive: boolean;
  /** Past the startup grace period (a fresh watchdog waits one deadline before judging). */
  armedForHeartbeat: boolean;
  heartbeatAgeMs: number;
  /** F on the tick grid (0 = no constraint); null when the floor cannot be computed. */
  floorTicks: bigint | null;
  index: RefPrice | null;
  accounts: readonly AccountFacts[];
}

export interface FireDecision {
  accountId: string;
  rule: "heartbeat" | "price" | "cover";
  reason: string;
}

export function evaluateWatchdog(f: WatchdogFacts): FireDecision[] {
  const out: FireDecision[] = [];
  const minIndexPx = f.index && f.index.num > 0n ? refPlusBpsCeil(f.index, INDEX_GUARD_BPS) : null;
  for (const a of f.accounts) {
    if (!f.heartbeatAlive && f.armedForHeartbeat) {
      const age = Number.isFinite(f.heartbeatAgeMs) ? `${f.heartbeatAgeMs} ms` : "ever";
      out.push({
        accountId: a.accountId,
        rule: "heartbeat",
        reason: `no verified heartbeat for ${age}`,
      });
      continue;
    }
    const bad = a.asks.find(
      (x) =>
        (f.floorTicks !== null && f.floorTicks > 0n && x.px < f.floorTicks) ||
        (minIndexPx !== null && x.px < minIndexPx),
    );
    if (bad) {
      out.push({
        accountId: a.accountId,
        rule: "price",
        reason: `Ballast ask ${bad.clientOrderId} at ${bad.px} ticks is below max(F ${f.floorTicks ?? "?"}, index + ${INDEX_GUARD_BPS} bps ${minIndexPx ?? "?"}) (${bad.source})`,
      });
      continue;
    }
    if (a.capacitySteps !== null && a.exposureSteps > a.capacitySteps) {
      out.push({
        accountId: a.accountId,
        rule: "cover",
        reason: `short + asks ${a.exposureSteps} > r × cover ${a.capacitySteps}`,
      });
      continue;
    }
    if (a.coverFell && a.asks.length > 0) {
      out.push({
        accountId: a.accountId,
        rule: "cover",
        reason: "on-chain cover fell while asks rest",
      });
    }
  }
  return out;
}
