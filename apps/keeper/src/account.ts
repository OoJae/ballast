/**
 * One bound holder account at runtime: its signer and reads (the account's own SignedClient,
 * AUTONOMOUS profile), its reconciler (REST snapshots + user-stream deltas, unknown counts as
 * resting), its silent-drop registry, and the keeper's per-account state (margin band, loss stop,
 * replace-batch spacing, L3 attribution).
 */
import { type MicroUsd, microUsd, type RefPrice, type Steps } from "@ballast/core";
import type { BandState } from "@ballast/engine";
import {
  AccountReconciler,
  type CancelAllBody,
  type CancelAllResponse,
  type CancelOrderBody,
  type CancelOrderResponse,
  type CreateOrderBody,
  type CreateOrderResponse,
  type CreateOutcome,
  lookupVia,
  type OpenOrdersResponse,
  type PendingCreate,
  PendingCreates,
  type PositionsResponse,
  type Query,
  type ReplaceBatchBody,
  type ReplaceBatchResponse,
  type StrikeOrder,
  type WriteOptions,
} from "@ballast/strike-client";

export interface AccountConfig {
  accountId: string;
  /** The bound stake credential (stake1…): cover is measured over it. */
  stakeAddress: string;
  holder0: boolean;
  /** Holder-chosen r (capped by the policy and 0.9). */
  rBps: bigint;
  /** Holder-set cap on short + asks; null = the policy's. */
  maxShortMicroUsd: MicroUsd | null;
  /** The builder fee the holder approved at Builder Connect (0 until D0/D2 pass). */
  approvedBuilderBps: number;
}

/** Everything the keeper may send for one account. It is reached only through the Guard. */
export interface AccountSigner {
  replaceBatch(body: ReplaceBatchBody, wo?: WriteOptions): Promise<ReplaceBatchResponse>;
  placeBuyBack(body: CreateOrderBody): Promise<CreateOrderResponse>;
  cancelAll(body: CancelAllBody): Promise<CancelAllResponse>;
  cancelOrder(body: CancelOrderBody): Promise<CancelOrderResponse>;
}

/** Signed reads of the account's own data. */
export interface AccountReads {
  getOrder(
    symbol: string,
    ref: { clientOrderId: string } | { orderId: bigint },
  ): Promise<StrikeOrder>;
  openOrders(symbol?: string): Promise<OpenOrdersResponse>;
  positions(symbol?: string): Promise<PositionsResponse>;
  get<T>(path: string, query?: Query): Promise<T>;
}

export interface AccountPorts {
  cfg: AccountConfig;
  signer: AccountSigner;
  reads: AccountReads;
  /** The account's `/ws/user-api` is logged on and subscribed. */
  streamLive(): boolean;
}

/** One `/v2/balances` row (user-api.yaml BalanceResponse; asset USDT). */
export interface BalanceRow {
  asset: string;
  walletBalance: string;
  marginBalance: string;
  maintMargin: string;
  updateTime?: number;
}

export interface MarginFact {
  /** marginBalance in micro-USD (floored). */
  equityMicroUsd: MicroUsd;
  /** maintMargin / marginBalance in bps (rounded up); null when the balance is not positive. */
  ratioBps: bigint | null;
  atMs: number;
}

export class AccountRuntime {
  readonly reconciler: AccountReconciler;
  readonly pending: PendingCreates;
  band: BandState = { quoting: false, lastBand: "ok" };
  margin: MarginFact | null = null;
  marginError: string | null = null;
  /** null until the first successful public vault read: unknown is treated as shares held. */
  vaultShares: boolean | null = null;
  vaultCheckedAtMs = Number.NEGATIVE_INFINITY;
  lastReplaceBatchMs: number | null = null;
  needsResync = true;
  resyncing = false;
  allowCreates = false;
  /** client order id → L3 order id, once our open order was found on L3 by price + size. */
  readonly l3Ids = new Map<string, string>();
  /** Today's combined-MTM loss (loss stop), µUSD. */
  lossToday: MicroUsd = microUsd(0n);
  housekeeping = false;
  /** Reduce-only buy-back in flight (client id), so at most one is outstanding. */
  buyBackInFlight: string | null = null;
  /** Loss stop: today's integrated combined-MTM PnL (µUSD) and the last sample it rests on. */
  loss: {
    day: number;
    pnl: bigint;
    prev: { equity: bigint; short: Steps; index: RefPrice } | null;
    holdUntilMs: number | null;
  } = { day: -1, pnl: 0n, prev: null, holdUntilMs: null };

  constructor(
    readonly ports: AccountPorts,
    opts: {
      now: () => number;
      /** Bound on Strike's internal propagation (reconciler default 1 s). */
      lagMs?: number;
      onCreateOutcome: (rt: AccountRuntime, p: PendingCreate, o: CreateOutcome) => void;
      onLateEvent?: (rt: AccountRuntime, clientOrderId: string) => void;
      onAnomaly?: (rt: AccountRuntime, a: { kind: string; detail: string }) => void;
    },
  ) {
    this.reconciler = new AccountReconciler({
      accountId: ports.cfg.accountId,
      ...(opts.lagMs !== undefined ? { lagMs: opts.lagMs } : {}),
      onAnomaly: (a) => opts.onAnomaly?.(this, a),
    });
    this.pending = new PendingCreates({
      lookup: lookupVia(() => ports.reads),
      onOutcome: (p, o) => opts.onCreateOutcome(this, p, o),
      onLateEvent: (id) => opts.onLateEvent?.(this, id),
      now: opts.now,
    });
  }

  get id(): string {
    return this.ports.cfg.accountId;
  }

  get cfg(): AccountConfig {
    return this.ports.cfg;
  }
}
