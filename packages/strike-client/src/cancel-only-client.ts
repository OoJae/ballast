import type { CancelAllBody, CancelOrderBody } from "./orders.js";
import { SignedTransport, type TransportOptions } from "./transport.js";
import type {
  CancelAllResponse,
  CancelOrderResponse,
  OpenOrdersResponse,
  PositionsResponse,
  StrikeOrder,
} from "./types.js";

/**
 * The watchdog's client (invariant 4: "the watchdog build is CANCEL_ONLY"). It is a separate
 * class over the shared signing transport, not a profile flag on SignedClient, so the watchdog's
 * module graph contains no create method and no order builder at all: there is nothing to call
 * that could place an order, and the transport's route check refuses every create under
 * CANCEL_ONLY even if one were smuggled in as a raw write.
 *
 * The profile is fixed; a caller cannot pass AUTONOMOUS.
 */
export type CancelOnlyOptions = Omit<TransportOptions, "profile">;

export class CancelOnlyClient extends SignedTransport {
  constructor(opts: CancelOnlyOptions) {
    super({ ...opts, profile: "CANCEL_ONLY" });
  }

  /** `DELETE /v2/order/cancel-all {symbol}`. `{}` would cancel every symbol, so symbol is required. */
  cancelAll(body: CancelAllBody): Promise<CancelAllResponse> {
    return this.sendWrite("DELETE", "/v2/order/cancel-all", body);
  }

  /** `DELETE /v2/order/cancel` by numeric id or client id. */
  cancelOrder(body: CancelOrderBody): Promise<CancelOrderResponse> {
    return this.sendWrite("DELETE", "/v2/order/cancel", body);
  }

  getOrder(
    symbol: string,
    ref: { clientOrderId: string } | { orderId: bigint },
  ): Promise<StrikeOrder> {
    return this.get(
      "/v2/order",
      "clientOrderId" in ref
        ? { symbol, client_order_id: ref.clientOrderId }
        : { symbol, order_id: ref.orderId },
    );
  }

  async openOrders(symbol?: string): Promise<OpenOrdersResponse> {
    const r = await this.get<Partial<OpenOrdersResponse> | null>("/v2/openOrders", { symbol });
    const orders = r?.orders ?? [];
    return { orders, count: r?.count ?? orders.length };
  }

  async positions(symbol?: string): Promise<PositionsResponse> {
    const r = await this.get<Partial<PositionsResponse> | null>("/v2/positions", { symbol });
    const positions = r?.positions ?? [];
    return { positions, count: r?.count ?? positions.length };
  }
}
