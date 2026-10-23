/**
 * REST response shapes from the pinned trade-api.yaml / user-api.yaml (openapi/PIN.json).
 * Decimals are strings. Engine ids are bigint because the client parses with parseJsonExact
 * and normalizes them; a field can still arrive as a number when it is small.
 */

export type OrderStatus =
  | "pending"
  | "open"
  | "filled"
  | "canceled"
  | "untriggered"
  | "rejected"
  | "expired";

/** `GET /v2/order` and `GET /v2/openOrders` rows (PascalCase engine model). */
export interface StrikeOrder {
  ID: number | bigint;
  ClientOrderID: string;
  AccountID: string;
  Symbol: string;
  CloseReason: string;
  Side: "buy" | "sell";
  Status: OrderStatus;
  Type: string;
  OriginType?: string;
  AutoCloseType?: string;
  TimeInForce: "GTC" | "IOC" | "FOK";
  WorkingType?: string;
  Size: string;
  Filled: string;
  Price: string;
  StopPrice?: string;
  BoundPrice?: string;
  PostOnly: boolean;
  ReduceOnly: boolean;
  ClosePosition?: boolean;
  PriceProtect?: boolean;
  CreateTimestamp: number;
  EntryTimestamp?: number;
  EventTimestamp: number;
  Builder?: { Code: string; FeeBps: number };
}

export interface OpenOrdersResponse {
  /** Coalesced to [] by the client; Strike serves `null` for some empty lists. */
  orders: StrikeOrder[];
  count: number;
}

/** `GET /v2/positions` row (snake_case, user-api.yaml `Position`). */
export interface StrikePosition {
  id: number | bigint;
  account_id: string;
  margin_mode: "cross" | "isolated";
  leverage: number;
  /** Signed: negative is short. */
  size: string;
  entry_price: string;
  iso_balance: string;
  accumulated_funding_fees: string;
  create_timestamp: number;
  update_timestamp: number;
  symbol: string;
  upnl: string;
  maintenance_margin: string;
  bankruptcy_price: string;
  liquidation_price: string;
}

export interface PositionsResponse {
  positions: StrikePosition[];
  count: number;
}

export interface CreateOrderResponse {
  client_order_id: string;
  account_id: string;
  symbol: string;
  status: "pending";
  sequence_id?: number;
  message_id?: string;
}

/** `successful` / `failed` are null (not []) when empty. */
export interface BatchOrdersResponse {
  successful: CreateOrderResponse[] | null;
  failed: { index: number; error: string }[] | null;
}

export interface ReplaceBatchResponse {
  sequence_id: number;
  message_id: string;
  results: {
    cancel?: { order_id: number | bigint; symbol: string };
    new_order?: CreateOrderResponse;
  }[];
}

export interface CancelOrderResponse {
  order_id?: number | bigint;
  client_order_id?: string;
  symbol: string;
  sequence_id: number;
  message_id: string;
}

export interface CancelAllResponse {
  account_id: string;
  symbol?: string;
  /** Always -1: cancellation is asynchronous, confirm on the stream and on L3. */
  canceled_count: number;
  sequence_id: number;
  message_id: string;
}

export interface LeverageResponse {
  leverage: number;
  maxNotionalValue: string;
  symbol: string;
  /** Matches LEVERAGE_UPDATED / LEVERAGE_UPDATE_FAILED on the user stream. */
  request_id: string;
}

export interface MarginModeResponse {
  marginMode: "cross" | "isolated";
  symbol: string;
}

export interface SymbolSettingsResponse {
  default_margin_mode: "cross" | "isolated";
  default_leverage: number;
  symbol_settings: Record<string, { margin_mode: "cross" | "isolated"; leverage: number }>;
}
