/**
 * `@ballast/strike-client/cancel-only`: everything the watchdog's CANCEL_ONLY build needs, and
 * nothing that builds or sends a create. The main entry (index.ts) also exports SignedClient and
 * the order builders; this barrel deliberately does not, and apps/watchdog's import-graph test
 * proves that no module it reaches defines a create path.
 */
export { CancelOnlyClient, type CancelOnlyOptions } from "./cancel-only-client.js";
export {
  apiTimeSource,
  ClockNotSyncedError,
  ServerClock,
  type ServerClockOptions,
} from "./clock.js";
export {
  compareDecimalStrings,
  type Dec,
  decToString,
  isDecimalString,
  parseDec,
} from "./decimal.js";
export { StrikeApiError, StrikeRefusedError, StrikeTransportError } from "./errors.js";
export {
  backoffMs,
  createPublicHttp,
  type HttpOptions,
  type PublicHttp,
  StrikeHttpError,
} from "./http.js";
export { assertClientOrderId, RESERVED_CLIENT_ID_PREFIXES } from "./ids.js";
export { parseJsonExact, stringifyJsonExact, toOrderId } from "./json.js";
export {
  canonicalPrice,
  isZeroSize,
  L3Book,
  L3Feed,
  type L3FeedOptions,
  type L3Order,
  type L3Snapshot,
  type L3Status,
  type L3Update,
} from "./l3.js";
export type { CancelAllBody, CancelOrderBody } from "./orders.js";
export { type RateDecision, RateLimiter, type RateLimiterOptions } from "./rate.js";
export {
  createPublicReads,
  type LivePosition,
  type LivePositions,
  type PremiumIndex,
  type PublicReads,
} from "./reads.js";
export { checkRoute, type ProfileName, type RouteCheck, type SignerProfile } from "./routes.js";
export { ApiWalletSigner, publicKeyHex } from "./sign.js";
export type { SignedClientAlarm } from "./transport.js";
export type {
  CancelAllResponse,
  CancelOrderResponse,
  OpenOrdersResponse,
  StrikeOrder,
} from "./types.js";
export {
  classifyUserMessage,
  type OrderTradeUpdate,
  UserStream,
  type UserStreamAlarm,
  type UserStreamEvent,
  type UserStreamOptions,
  type UserStreamState,
} from "./userstream.js";
export {
  ReconnectingSocket,
  type ReconnectingSocketOptions,
  type SocketInfo,
  type SocketState,
} from "./ws.js";
