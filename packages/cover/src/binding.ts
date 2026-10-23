import { parseAddress, stakeAddressOf } from "./address.js";

/**
 * One stake credential ↔ one Ballast account, and the account is dedicated (invariant 16).
 * The evidence DB's UNIQUE(stake_cred) and UNIQUE(account_id) constraints are the authority;
 * this module gives the same answer up front, explains conflicts, and detects foreign activity.
 */
export class BindingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindingConflictError";
  }
}

export class StakeBindings {
  private readonly byStake = new Map<string, string>();
  private readonly byAccount = new Map<string, string>();

  /** Binds an address's stake credential to an account. Idempotent for the same pair. */
  bind(addressOrStake: string, accountId: string): string {
    const stake = bindableStake(addressOrStake);
    const holder = this.byStake.get(stake);
    if (holder !== undefined && holder !== accountId) {
      throw new BindingConflictError(
        `stake credential ${stake} is already bound to another account`,
      );
    }
    const bound = this.byAccount.get(accountId);
    if (bound !== undefined && bound !== stake) {
      throw new BindingConflictError(
        `account ${accountId} is already bound to another stake credential`,
      );
    }
    this.byStake.set(stake, accountId);
    this.byAccount.set(accountId, stake);
    return stake;
  }

  accountFor(addressOrStake: string): string | undefined {
    return this.byStake.get(bindableStake(addressOrStake));
  }

  stakeFor(accountId: string): string | undefined {
    return this.byAccount.get(accountId);
  }
}

/** The stake address a holder's input binds to. Only key-hash stake credentials can bind. */
export function bindableStake(addressOrStake: string): string {
  const p = parseAddress(addressOrStake);
  if (p.type !== "base" && p.type !== "reward") {
    throw new BindingConflictError("only base or stake addresses carry a stake credential to bind");
  }
  if (p.stake.kind !== "key") {
    throw new BindingConflictError("script stake credentials cannot sign the holder's consent");
  }
  return stakeAddressOf(p.stake, p.network);
}

/**
 * Groups base addresses by stake credential. Two base addresses on one stake key are one wallet
 * account: they share cover and can bind only once.
 */
export function sharedStakeKeys(addresses: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const a of addresses) {
    const p = parseAddress(a);
    if (p.type !== "base") continue;
    const stake = stakeAddressOf(p.stake, p.network);
    groups.set(stake, [...new Set([...(groups.get(stake) ?? []), a])]);
  }
  return new Map([...groups].filter(([, list]) => list.length > 1));
}

export interface ForeignActivity {
  manual: boolean;
  foreign: string[];
}

/**
 * A dedicated account shows only `bal_` orders. Any other client id (or an order with none)
 * means someone traded by hand, so the account pauses and is flagged publicly.
 */
export function detectManualActivity(
  orders: readonly { clientOrderId: string | null | undefined; orderId?: string }[],
): ForeignActivity {
  const foreign = orders
    .filter(
      (o) => typeof o.clientOrderId !== "string" || !/^bal_[A-Za-z0-9_-]+$/.test(o.clientOrderId),
    )
    .map((o) => o.clientOrderId ?? `order ${o.orderId ?? "?"} (no client id)`);
  return { manual: foreign.length > 0, foreign };
}
