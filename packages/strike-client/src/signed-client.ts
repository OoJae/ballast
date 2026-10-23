import { StrikeRefusedError } from "./errors.js";
import type {
  BatchOrdersBody,
  CancelAllBody,
  CancelOrderBody,
  CreateOrderBody,
  LeverageBody,
  MarginModeBody,
  ReplaceBatchBody,
} from "./orders.js";
import type { RouteCheck } from "./routes.js";
import { SignedTransport, type TransportOptions } from "./transport.js";
import type {
  BatchOrdersResponse,
  CancelAllResponse,
  CancelOrderResponse,
  CreateOrderResponse,
  LeverageResponse,
  MarginModeResponse,
  OpenOrdersResponse,
  PositionsResponse,
  ReplaceBatchResponse,
  StrikeOrder,
  SymbolSettingsResponse,
} from "./types.js";

export { StrikeApiError, StrikeRefusedError, StrikeTransportError } from "./errors.js";
export type { Query, SignedClientAlarm } from "./transport.js";

export interface BuilderFeeConfig {
  /** Holder-approved maximum, already ≤ min(policy, approved); never above Strike's 100. */
  capBps: number;
  /** Sent on entry orders when the caller does not pass one. */
  defaultBps?: number;
}

export interface SignedClientOptions extends TransportOptions {
  builderFee?: BuilderFeeConfig;
  /** How many sent create client ids to remember; a repeat is refused before signing. */
  sentClientIdCapacity?: number;
}

export interface WriteOptions {
  /** Overrides the default builder fee on an order route. */
  builderFeeBps?: number;
  /**
   * Marks entry-side creates as exits too. Reduce-only creates and buys are exits whatever this
   * says; exits carry no builder fee, so the header is omitted (Strike then charges 0).
   */
  exit?: boolean;
}

const BUILDER_FEE_HEADER = "X-Builder-Fee-Bps";

/**
 * Signed REST client for one account. Every request is checked against the route allowlist
 * and the rate budget, then signed with server time − 1 s and a fresh UUIDv4 nonce.
 * Writes are sent exactly once: Strike consumes the nonce even when the request fails, writes are
 * asynchronous (201 = sequenced), and there is no idempotency, so a retry could double-place.
 */
export class SignedClient extends SignedTransport {
  /** Create client ids already handed to fetch, oldest first (bounded). */
  private readonly sentIds = new Set<string>();

  constructor(private readonly opts: SignedClientOptions) {
    super(opts);
    const fee = opts.builderFee;
    if (fee) {
      if (!Number.isInteger(fee.capBps) || fee.capBps < 0 || fee.capBps > 100) {
        throw new RangeError("builder fee cap must be an integer 0-100 bps");
      }
      if (fee.defaultBps !== undefined) this.checkFee(fee.defaultBps);
    }
  }

  private checkFee(bps: number): number {
    const cap = this.opts.builderFee?.capBps;
    if (cap === undefined) {
      throw new StrikeRefusedError("builder-fee", "no builder fee is configured");
    }
    if (!Number.isInteger(bps) || bps < 0 || bps > cap) {
      throw new StrikeRefusedError("builder-fee", `builder fee ${bps} bps is outside 0-${cap}`);
    }
    return bps;
  }

  /**
   * The header applies to every order in the request, so exit status comes from the checked
   * body: a request whose creates are all exits sends none, and one mixing entries and exits
   * may not carry a fee (split it). Plan section 5: entries ≤ the approved cap, exits 0.
   */
  private feeHeader(route: RouteCheck & { ok: true }, wo: WriteOptions): string | undefined {
    const noFee = (why: string): undefined => {
      if (wo.builderFeeBps !== undefined && wo.builderFeeBps !== 0) {
        throw new StrikeRefusedError("builder-fee", why);
      }
      return undefined;
    };
    if (!route.builderFeeRoute) {
      if (wo.builderFeeBps !== undefined) {
        throw new StrikeRefusedError("builder-fee", `${route.route} is not an order route`);
      }
      return undefined;
    }
    const creates = route.cost.creates;
    if (creates === 0) return noFee("a request without creates carries no builder fee");
    if (wo.exit || route.exitCreates === creates) return noFee("exits carry no builder fee");
    const bps = wo.builderFeeBps ?? this.opts.builderFee?.defaultBps;
    if (route.exitCreates > 0 && bps !== undefined && bps !== 0) {
      throw new StrikeRefusedError(
        "builder-fee",
        "the fee header would apply to the request's exits too: send entries and exits apart",
      );
    }
    return bps === undefined || bps === 0 ? undefined : String(this.checkFee(bps));
  }

  /** Strike does not check client id uniqueness on creates, so a repeat would double-place. */
  private checkUnsent(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.sentIds.has(id)) {
        throw new StrikeRefusedError("route", `client_order_id ${id} was already sent`);
      }
    }
  }

  private markSent(ids: readonly string[]): void {
    const cap = this.opts.sentClientIdCapacity ?? 500_000;
    for (const id of ids) this.sentIds.add(id);
    for (const id of this.sentIds) {
      if (this.sentIds.size <= cap) break;
      this.sentIds.delete(id);
    }
  }

  /**
   * One signed write, sent once. The body is serialized exactly once; the route check runs on
   * the parsed form of those bytes, the signature hashes them, and fetch sends them.
   */
  write<T>(
    method: "POST" | "DELETE",
    path: string,
    body: unknown,
    wo: WriteOptions = {},
  ): Promise<T> {
    return this.sendWrite<T>(method, path, body, (route) => {
      this.checkUnsent(route.clientOrderIds);
      const fee = this.feeHeader(route, wo);
      const headers: Record<string, string> = {};
      if (fee !== undefined) headers[BUILDER_FEE_HEADER] = fee;
      return {
        headers,
        // From here the request may reach Strike, so its creates count as sent whatever happens.
        onCommitted: () => this.markSent(route.clientOrderIds),
      };
    });
  }

  placeBatch(body: BatchOrdersBody, wo?: WriteOptions): Promise<BatchOrdersResponse> {
    return this.write("POST", "/v2/orders/batch", body, wo);
  }

  replaceBatch(body: ReplaceBatchBody, wo?: WriteOptions): Promise<ReplaceBatchResponse> {
    return this.write("POST", "/v2/order/replace-batch", body, wo);
  }

  /** Reduce-only IOC buy-back; always an exit, so never a builder fee. */
  placeBuyBack(body: CreateOrderBody): Promise<CreateOrderResponse> {
    return this.write("POST", "/v2/order", body);
  }

  cancelOrder(body: CancelOrderBody): Promise<CancelOrderResponse> {
    return this.write("DELETE", "/v2/order/cancel", body);
  }

  cancelAll(body: CancelAllBody): Promise<CancelAllResponse> {
    return this.write("DELETE", "/v2/order/cancel-all", body);
  }

  setLeverage(body: LeverageBody): Promise<LeverageResponse> {
    return this.write("POST", "/v2/leverage", body);
  }

  /** Refused silently while the symbol has active orders: confirm with symbols(). */
  setMarginMode(body: MarginModeBody): Promise<MarginModeResponse> {
    return this.write("POST", "/v2/marginMode", body);
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

  symbols(): Promise<SymbolSettingsResponse> {
    return this.get("/v2/symbols");
  }
}
