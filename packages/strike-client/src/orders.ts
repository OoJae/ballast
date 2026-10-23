import { randomBytes } from "node:crypto";
import { compareDecimalStrings, isDecimalString, parseDec } from "./decimal.js";
import { assertClientOrderId, RESERVED_CLIENT_ID_PREFIXES } from "./ids.js";

/**
 * Request bodies exactly as trade-api.yaml defines them (CreateOrderRequest, CreateBatchOrders-
 * Request, ReplaceBatchOrdersRequest, CancelOrderRequest, CancelAllOrdersRequest, LeverageRequest,
 * MarginModeRequest). REST enums are lowercase except time_in_force; optional fields are omitted
 * rather than sent as "" (an empty enum or decimal is a 400).
 */

export type OrderSide = "buy" | "sell";
export type OrderType =
  | "limit"
  | "market"
  | "stop"
  | "stop_limit"
  | "take_profit"
  | "take_profit_limit"
  | "trailing_stop_market";
export type TimeInForce = "GTC" | "IOC" | "FOK";
export type MarginMode = "cross" | "isolated";

export interface CreateOrderBody {
  client_order_id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  /** Decimal string, base asset. */
  size: string;
  price?: string;
  time_in_force?: TimeInForce;
  post_only?: boolean;
  reduce_only?: boolean;
  /** Market only: fraction from book mid ("0.01" = 1%). */
  slippage?: string;
}

export interface BatchOrdersBody {
  orders: CreateOrderBody[];
}

/** Cancel legs take the engine's numeric order id (client ids are not supported here). */
export interface ReplaceCancelLeg {
  order_id: bigint;
  symbol: string;
}

export interface ReplaceItem {
  cancel?: ReplaceCancelLeg;
  new_order?: CreateOrderBody;
}

export interface ReplaceBatchBody {
  replacements: ReplaceItem[];
}

export type CancelOrderBody =
  | { symbol: string; order_id: bigint }
  | { symbol: string; client_order_id: string };

export interface CancelAllBody {
  symbol: string;
}

export interface LeverageBody {
  symbol: string;
  leverage: number;
}

export interface MarginModeBody {
  symbol: string;
  marginMode: MarginMode;
}

export { assertClientOrderId, RESERVED_CLIENT_ID_PREFIXES };

function assertPositiveDecimal(value: string, field: string): void {
  if (!isDecimalString(value) || parseDec(value).m <= 0n) {
    throw new TypeError(`${field} must be a positive plain decimal string, got ${value}`);
  }
}

function assertSymbol(symbol: string): void {
  if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(symbol)) throw new TypeError(`bad symbol ${symbol}`);
}

/**
 * Issues `bal_<time><counter><random>` ids. Strike does not check uniqueness for single creates
 * (a reused id makes the silent-drop lookup ambiguous), so ids are never reused in a process.
 */
export class ClientOrderIdFactory {
  private counter = 0;
  private readonly issued = new Set<string>();
  private readonly session = randomBytes(4).toString("hex");

  constructor(
    private readonly tag = "",
    private readonly now: () => number = Date.now,
  ) {
    if (tag && !/^[a-z0-9]{1,16}$/.test(tag)) throw new TypeError("tag must be 1-16 [a-z0-9]");
  }

  next(): string {
    this.counter += 1;
    const id = [
      "bal",
      ...(this.tag ? [this.tag] : []),
      this.now().toString(36),
      this.session,
      this.counter.toString(36),
    ].join("_");
    if (this.issued.has(id)) throw new Error(`client order id collision: ${id}`);
    this.issued.add(id);
    return id;
  }
}

export interface LimitOrderParams {
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  size: string;
  price: string;
  postOnly?: boolean;
  reduceOnly?: boolean;
  timeInForce?: TimeInForce;
}

export function limitOrder(p: LimitOrderParams): CreateOrderBody {
  assertClientOrderId(p.clientOrderId);
  assertSymbol(p.symbol);
  assertPositiveDecimal(p.size, "size");
  assertPositiveDecimal(p.price, "price");
  if (p.side === "buy" && p.reduceOnly !== true) {
    throw new TypeError("every Ballast buy is reduce-only (invariant 6)");
  }
  if (p.postOnly && p.timeInForce && p.timeInForce !== "GTC") {
    throw new TypeError("post-only orders rest, so time_in_force must be GTC");
  }
  return {
    client_order_id: p.clientOrderId,
    symbol: p.symbol,
    side: p.side,
    type: "limit",
    size: p.size,
    price: p.price,
    ...(p.timeInForce ? { time_in_force: p.timeInForce } : {}),
    ...(p.postOnly ? { post_only: true } : {}),
    ...(p.reduceOnly ? { reduce_only: true } : {}),
  };
}

/** The only body POST /v2/order may carry under AUTONOMOUS: a reduce-only IOC buy-back. */
export function reduceOnlyBuyBack(p: {
  clientOrderId: string;
  symbol: string;
  size: string;
  /** Limit price cap; omit for a market buy bounded by `slippage`. */
  price?: string;
  slippage?: string;
}): CreateOrderBody {
  assertClientOrderId(p.clientOrderId);
  assertSymbol(p.symbol);
  assertPositiveDecimal(p.size, "size");
  if (p.price !== undefined) {
    assertPositiveDecimal(p.price, "price");
    if (p.slippage !== undefined) throw new TypeError("slippage applies to market orders only");
  } else if (p.slippage !== undefined) {
    assertPositiveDecimal(p.slippage, "slippage");
  }
  return {
    client_order_id: p.clientOrderId,
    symbol: p.symbol,
    side: "buy",
    type: p.price !== undefined ? "limit" : "market",
    size: p.size,
    ...(p.price !== undefined ? { price: p.price } : {}),
    time_in_force: "IOC",
    reduce_only: true,
    ...(p.slippage !== undefined ? { slippage: p.slippage } : {}),
  };
}

function assertUniqueIds(orders: readonly CreateOrderBody[]): void {
  const seen = new Set<string>();
  for (const o of orders) {
    if (seen.has(o.client_order_id)) {
      throw new TypeError(`duplicate client_order_id ${o.client_order_id}`);
    }
    seen.add(o.client_order_id);
  }
}

/** `POST /v2/orders/batch`: independent creates, no atomicity. */
export function batchOrders(orders: readonly CreateOrderBody[]): BatchOrdersBody {
  if (orders.length === 0) throw new TypeError("a batch needs at least one order");
  assertUniqueIds(orders);
  return { orders: [...orders] };
}

/**
 * Creates sorted far-to-near: asks by descending price, bids by ascending price.
 *
 * Replace-batch semantics (trade-api.yaml, strike-trading):
 * - A static-rule failure in any create (size/step, tick, price range/bound, min notional)
 *   applies nothing, not even the cancels, and that create is published as rejected.
 * - Otherwise every cancel applies, then creates run in order until the first rejection for any
 *   other reason (margin, post-only cross, ...); later creates are skipped with no order event.
 *   `conditional_order_triggers_immediately` does not stop the batch.
 * - An unknown symbol or a create missing side/type drops the whole command silently.
 * - A duplicate client_order_id is `400 duplicate_request_id`; at most 1,000 operations.
 * Far-to-near means a near level rejected for crossing still leaves the far levels resting.
 */
export function farToNear(creates: readonly CreateOrderBody[]): CreateOrderBody[] {
  const sides = new Set(creates.map((c) => c.side));
  if (sides.size > 1) throw new TypeError("a replace-batch quotes one side; split asks and bids");
  return [...creates].sort((a, b) => {
    if (a.price === undefined || b.price === undefined) {
      throw new TypeError("replace-batch creates must be priced limit orders");
    }
    const c = compareDecimalStrings(a.price, b.price);
    return a.side === "sell" ? -c : c;
  });
}

/** `POST /v2/order/replace-batch`: one engine command on one symbol. */
export function replaceBatch(
  symbol: string,
  legs: { cancels: readonly bigint[]; creates: readonly CreateOrderBody[] },
): ReplaceBatchBody {
  assertSymbol(symbol);
  const ops = legs.cancels.length + legs.creates.length;
  if (ops === 0) throw new TypeError("a replace-batch needs at least one leg");
  if (ops > 1000) throw new TypeError("a replace-batch carries at most 1000 operations");
  if (legs.creates.some((c) => c.symbol !== symbol)) {
    throw new TypeError("every replace-batch leg must use the same symbol");
  }
  if (new Set(legs.cancels).size !== legs.cancels.length) {
    throw new TypeError("duplicate cancel order_id");
  }
  for (const id of legs.cancels) if (id <= 0n) throw new TypeError("order_id must be positive");
  assertUniqueIds(legs.creates);
  const creates = farToNear(legs.creates);
  const items: ReplaceItem[] = [];
  for (let i = 0; i < Math.max(legs.cancels.length, creates.length); i++) {
    const cancel = legs.cancels[i];
    const create = creates[i];
    items.push({
      ...(cancel !== undefined ? { cancel: { order_id: cancel, symbol } } : {}),
      ...(create !== undefined ? { new_order: create } : {}),
    });
  }
  return { replacements: items };
}

export function cancelOrder(
  symbol: string,
  ref: { orderId: bigint } | { clientOrderId: string },
): CancelOrderBody {
  assertSymbol(symbol);
  if ("orderId" in ref) {
    if (ref.orderId <= 0n) throw new TypeError("order_id must be positive");
    return { symbol, order_id: ref.orderId };
  }
  if (!ref.clientOrderId) throw new TypeError("client_order_id is empty");
  return { symbol, client_order_id: ref.clientOrderId };
}

/** Always names the symbol: `{}` would cancel every symbol on the account. */
export function cancelAll(symbol: string): CancelAllBody {
  assertSymbol(symbol);
  return { symbol };
}

export function leverage(symbol: string, value: number): LeverageBody {
  assertSymbol(symbol);
  if (!Number.isInteger(value) || value < 1 || value > 125) {
    throw new TypeError("leverage must be an integer from 1 to 125");
  }
  return { symbol, leverage: value };
}

export function marginMode(symbol: string, mode: MarginMode): MarginModeBody {
  assertSymbol(symbol);
  return { symbol, marginMode: mode };
}
