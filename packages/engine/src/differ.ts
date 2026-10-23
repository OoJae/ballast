import { priceString, type Steps, sizeString, type Ticks } from "@ballast/core";
import {
  type CreateOrderBody,
  limitOrder,
  type ReplaceBatchBody,
  replaceBatch,
} from "@ballast/strike-client";
import type { OrderLevel } from "./client-id.js";
import type { EngineMarket } from "./market.js";

/** At most one replace-batch per account per 2 s (plan section 5, rate). */
export const REPLACE_BATCH_SPACING_MS = 2_000;

export interface RestingOrder {
  clientOrderId: string;
  /** The engine's numeric id (user stream `i`); replace-batch cancel legs need it. */
  orderId: bigint | null;
  px: Ticks;
  /** Remaining size. */
  qty: Steps;
  status: "open" | "pending" | "unknown";
}

export interface DesiredOrder {
  level: 1 | 2 | 3;
  px: Ticks;
  /** Already fingerprinted and validated. */
  qty: Steps;
}

export interface DiffInput {
  market: Pick<EngineMarket, "symbol" | "tick" | "step">;
  resting: readonly RestingOrder[];
  desired: readonly DesiredOrder[];
  nowMs: number;
  lastReplaceBatchMs: number | null;
  minIntervalMs?: number;
  clientId: (level: OrderLevel) => string;
}

export type DiffResult =
  | { kind: "none"; keep: RestingOrder[] }
  | { kind: "throttled"; retryAfterMs: number }
  /** An order that must go is still pending or unknown: wait (unknown counts as resting). */
  | { kind: "wait"; reason: string }
  | {
      kind: "replace-batch";
      cancels: bigint[];
      creates: CreateOrderBody[];
      body: ReplaceBatchBody;
      keep: RestingOrder[];
    };

/**
 * Turns resting orders into the desired ladder with one replace-batch: an order already at the
 * desired price and size is kept (it keeps its queue place), everything else is cancelled by its
 * numeric id and the missing levels are created post-only, far-to-near (replaceBatch sorts them),
 * so a near level rejected for crossing still leaves the far levels resting.
 */
export function diffOrders(input: DiffInput): DiffResult {
  const keep: RestingOrder[] = [];
  const cancel: RestingOrder[] = [];
  const missing: DesiredOrder[] = [];
  const pool = [...input.resting];
  for (const d of [...input.desired].sort((a, b) => a.level - b.level)) {
    // A pending match is kept too: re-creating it would double the level.
    const i = pool.findIndex((r) => r.px === d.px && r.qty === d.qty);
    if (i >= 0) keep.push(...pool.splice(i, 1));
    else missing.push(d);
  }
  cancel.push(...pool);
  if (cancel.length === 0 && missing.length === 0) return { kind: "none", keep };

  const uncancellable = cancel.find((r) => r.orderId === null || r.status !== "open");
  if (uncancellable) {
    return {
      kind: "wait",
      reason: `${uncancellable.clientOrderId} is ${uncancellable.status}; it cannot be cancelled by id yet`,
    };
  }
  const spacing = input.minIntervalMs ?? REPLACE_BATCH_SPACING_MS;
  if (input.lastReplaceBatchMs !== null && input.nowMs - input.lastReplaceBatchMs < spacing) {
    return { kind: "throttled", retryAfterMs: input.lastReplaceBatchMs + spacing - input.nowMs };
  }
  const creates = missing.map((d) =>
    limitOrder({
      clientOrderId: input.clientId(d.level),
      symbol: input.market.symbol,
      side: "sell",
      size: sizeString(input.market.step, d.qty),
      price: priceString(input.market.tick, d.px),
      postOnly: true,
    }),
  );
  const cancels = cancel.map((r) => r.orderId as bigint);
  return {
    kind: "replace-batch",
    cancels,
    creates,
    body: replaceBatch(input.market.symbol, { cancels, creates }),
    keep,
  };
}
