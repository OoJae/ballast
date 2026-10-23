import { isDecimalString, parseDec } from "./decimal.js";
import { assertClientOrderId } from "./orders.js";

/**
 * Signer route allowlists (CLAUDE.md invariant 4). A request is checked here, on the exact body
 * bytes it will send, before any nonce or signature exists. Anything not explicitly allowed is
 * refused, so a new Strike route is unreachable until someone adds it on purpose.
 *
 * Bodies are checked against an exact key allowlist at every object level. Strike binds with
 * Go/gin, and Go's encoding/json also matches keys case-insensitively, so `{"side":"sell",
 * "Side":"buy"}` would be checked as a sell here but bound as a buy there. Only byte-identical
 * keys from Ballast's own subset pass.
 */
// VERIFY: that Strike's JSON binding is case-insensitive (Go encoding/json default) is inferred
// from its Go/gin binding errors, not documented; the exact-key allowlist is safe either way
// (FRICTION 2026-10-23).

export type SignerProfile = "AUTONOMOUS" | "CANCEL_ONLY";

/**
 * M5: deposit and withdraw run only while the holder is present and has just signed with their
 * own wallet. Defined here so the type exists; every check under it refuses until M5 lands.
 */
export type HolderPresentProfile = "HOLDER_PRESENT";

export type ProfileName = SignerProfile | HolderPresentProfile;

/** Funding routes (strike-auth, masterOnly). Reserved for HOLDER_PRESENT; never AUTONOMOUS. */
export const FUNDING_ROUTES = [
  "POST /v2/deposit/quote",
  "POST /v2/deposit/build-tx",
  "POST /v2/deposit",
  "POST /v2/withdraw/estimate",
  "POST /v2/withdraw/quote",
  "POST /v2/withdraw",
] as const;

export type FundingRoute = (typeof FUNDING_ROUTES)[number];

export type RouteId =
  | "orders.batch"
  | "order.replace-batch"
  | "order.exit"
  | "order.cancel"
  | "order.cancel-all"
  | "leverage"
  | "margin-mode"
  | "read";

/**
 * How a request draws on the rate budget. `reduce` is a reduce-only IOC buy-back (risk reducing,
 * like a cancel); `config` is leverage or margin mode, which places no order.
 */
export type RateClass = "create" | "reduce" | "cancel" | "config" | "read";

export interface RouteCost {
  rateClass: RateClass;
  /** Order operations: creates + cancel legs (cancel-all counts 1, as in Strike's 1000-op cap). */
  ops: number;
  creates: number;
  cancels: number;
  replaceBatch: boolean;
}

export type RouteCheck =
  | {
      ok: true;
      route: RouteId;
      cost: RouteCost;
      builderFeeRoute: boolean;
      /** client_order_id of every create in the request, in body order. */
      clientOrderIds: readonly string[];
      /** Creates that reduce a position (any buy, or reduce_only): they carry no builder fee. */
      exitCreates: number;
    }
  | { ok: false; reason: string };

/** Signed reads of the signer's own account (FlexibleAuth with API wallet headers). */
export const SIGNED_READ_PATHS: ReadonlySet<string> = new Set([
  "/v2/account",
  "/v2/balances",
  "/v2/portfolio",
  "/v2/positions",
  "/v2/closedPositions",
  "/v2/openOrders",
  "/v2/order",
  "/v2/symbols",
  "/v2/history/order",
  "/v2/history/fill",
  "/v2/history/funding",
  "/v2/history/transaction",
  "/v2/history/position",
]);

const REFUSED: readonly { test: (method: string, path: string) => boolean; reason: string }[] = [
  {
    test: (_m, p) => p === "/v2/order/replace" || p === "/v2/orders/replace",
    reason: "replace routes are refused: /v2/order/replace drops builder attribution",
  },
  { test: (_m, p) => /^\/v2\/vaults?(\/|$)/.test(p), reason: "vault routes are refused" },
  { test: (_m, p) => /^\/v2\/copy(\/|$)/.test(p), reason: "copy-trading routes are refused" },
  { test: (_m, p) => /^\/v2\/grid(\/|$)/.test(p), reason: "grid-bot routes are refused" },
  { test: (_m, p) => p.startsWith("/v2/rfq"), reason: "RFQ routes are refused" },
  { test: (_m, p) => /^\/v2\/algo(\/|$)/.test(p), reason: "TWAP routes are refused" },
  { test: (_m, p) => p === "/v2/isoMargin", reason: "isolated-margin transfers are refused" },
  { test: (m, p) => m === "PUT" && p === "/v2/symbols", reason: "PUT /v2/symbols is refused" },
  {
    test: (_m, p) => /^\/v2\/(deposit|withdraw)(\/|$)/.test(p),
    reason: "funding routes belong to the HOLDER_PRESENT profile (M5), never the keeper",
  },
];

/** Account selectors that would make a signed request act on, or read, another account. */
const BODY_SELECTORS = new Set(["vault_id", "sub_account_id"]);
// Public selectors win over auth on FlexibleAuth reads, so a signed read carrying one would
// silently read someone else's account (and the data policy forbids that).
const QUERY_SELECTORS = new Set([
  "vault_id",
  "sub_account_id",
  "account_id",
  "blockchain_address",
  "blockchain",
  "scope",
  "include_copies",
]);

const PATH_RE = /^\/v2(\/[A-Za-z][A-Za-z0-9-]*)+$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_REPLACE_OPS = 1000;

/** Ballast's subset of CreateOrderRequest. Stops, close_position and selectors are not in it. */
const CREATE_KEYS = [
  "client_order_id",
  "symbol",
  "side",
  "type",
  "size",
  "price",
  "time_in_force",
  "post_only",
  "reduce_only",
  "slippage",
] as const;
const BATCH_TYPES = ["limit"] as const;
const EXIT_TYPES = ["limit", "market"] as const;
const TIME_IN_FORCE = new Set(["GTC", "IOC", "FOK"]);

/**
 * Go's case-insensitive key match uses Unicode simple folding, under which U+017F (long s)
 * folds to "s" and U+212A (Kelvin sign) to "k"; toLowerCase handles the rest.
 */
function goFold(key: string): string {
  return key.replace(/\u017f/g, "s").toLowerCase();
}

const FOLDED_BODY_SELECTORS = new Set([...BODY_SELECTORS].map(goFold));
const FOLDED_QUERY_SELECTORS = new Set([...QUERY_SELECTORS].map(goFold));

function refuse(reason: string): RouteCheck {
  return { ok: false, reason };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A selector key at any depth, in any casing Go would bind to it. */
function findSelector(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    for (const item of v) {
      const hit = findSelector(item);
      if (hit) return hit;
    }
  } else if (isRecord(v)) {
    for (const [k, inner] of Object.entries(v)) {
      if (FOLDED_BODY_SELECTORS.has(goFold(k))) return k;
      const hit = findSelector(inner);
      if (hit) return hit;
    }
  }
  return undefined;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isOrderId(v: unknown): boolean {
  return (
    (typeof v === "number" && Number.isSafeInteger(v) && v > 0) || (typeof v === "bigint" && v > 0n)
  );
}

/** The first key that is not byte-identical to an allowed one (case variants included). */
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(o).find((k) => !allowed.includes(k));
}

function positiveDecimal(v: unknown): boolean {
  return typeof v === "string" && isDecimalString(v) && parseDec(v).m > 0n;
}

/** A create that reduces a position; Ballast never opens a long, so every buy is one. */
function isExit(o: Record<string, unknown>): boolean {
  return o.side === "buy" || o.reduce_only === true;
}

/**
 * One create, field by field: exact keys, a bal_ client id, lowercase side and type from the
 * route's set, uppercase time_in_force, plain positive decimal strings and boolean flags.
 * Strike drops a replace-batch silently on a missing or invalid side/type, so they are checked
 * here rather than left to the engine. Invariant 6: every buy is reduce-only.
 */
function checkCreate(o: unknown, where: string, types: readonly string[]): string | undefined {
  if (!isRecord(o)) return `${where} must be an object`;
  const extra = onlyKeys(o, CREATE_KEYS);
  if (extra !== undefined) return `${where} has a field outside Ballast's create subset: ${extra}`;
  if (typeof o.client_order_id !== "string") return `${where} needs a client_order_id`;
  try {
    assertClientOrderId(o.client_order_id);
  } catch (err) {
    return `${where}: ${(err as Error).message}`;
  }
  if (!nonEmptyString(o.symbol)) return `${where} needs a symbol`;
  if (o.side !== "buy" && o.side !== "sell") return `${where} side must be "buy" or "sell"`;
  if (typeof o.type !== "string" || !types.includes(o.type)) {
    return `${where} type must be ${types.map((t) => `"${t}"`).join(" or ")}`;
  }
  if (!positiveDecimal(o.size)) return `${where} size must be a positive decimal string`;
  if (o.type === "limit") {
    if (!positiveDecimal(o.price)) return `${where} limit price must be a positive decimal string`;
  } else if (o.price !== undefined) {
    return `${where} price applies to limit orders only`;
  }
  if (o.slippage !== undefined) {
    if (o.type !== "market") return `${where} slippage applies to market orders only`;
    if (!positiveDecimal(o.slippage)) return `${where} slippage must be a positive decimal string`;
  }
  const tif = o.time_in_force;
  if (tif !== undefined && (typeof tif !== "string" || !TIME_IN_FORCE.has(tif))) {
    return `${where} time_in_force must be GTC, IOC or FOK`;
  }
  for (const flag of ["post_only", "reduce_only"] as const) {
    if (o[flag] !== undefined && typeof o[flag] !== "boolean") {
      return `${where} ${flag} must be a boolean`;
    }
  }
  if (o.post_only === true && (o.type !== "limit" || (tif !== undefined && tif !== "GTC"))) {
    return `${where} post-only orders are resting GTC limits`;
  }
  if (o.side === "buy" && o.reduce_only !== true) return `${where} is a buy without reduce_only`;
  return undefined;
}

interface CreateTally {
  clientOrderIds: string[];
  exitCreates: number;
}

/** Check every create of one request; client ids must be unique within it. */
function checkCreates(
  creates: readonly { value: unknown; where: string }[],
  types: readonly string[],
): { error: string } | CreateTally {
  const tally: CreateTally = { clientOrderIds: [], exitCreates: 0 };
  for (const { value, where } of creates) {
    const bad = checkCreate(value, where, types);
    if (bad) return { error: bad };
    const o = value as Record<string, unknown>;
    const id = o.client_order_id as string;
    if (tally.clientOrderIds.includes(id)) return { error: `duplicate client_order_id ${id}` };
    tally.clientOrderIds.push(id);
    if (isExit(o)) tally.exitCreates += 1;
  }
  return tally;
}

function checkExitOrder(body: unknown): { error: string } | CreateTally {
  if (!isRecord(body)) return { error: "POST /v2/order needs a JSON object body" };
  const r = checkCreates([{ value: body, where: "order" }], EXIT_TYPES);
  if ("error" in r) return r;
  if (body.side !== "buy" || body.reduce_only !== true || body.time_in_force !== "IOC") {
    return { error: "POST /v2/order is allowed only for a reduce-only IOC buy-back" };
  }
  return r;
}

function checkCancel(body: unknown): string | undefined {
  if (!isRecord(body)) return "cancel needs a JSON object body";
  const extra = onlyKeys(body, ["symbol", "order_id", "client_order_id"]);
  if (extra) return `cancel has an unexpected field ${extra}`;
  if (!nonEmptyString(body.symbol)) return "cancel needs a symbol";
  const byId = body.order_id !== undefined;
  const byClient = body.client_order_id !== undefined;
  if (byId === byClient) return "cancel needs exactly one of order_id or client_order_id";
  if (byId && !isOrderId(body.order_id)) return "cancel order_id must be a positive integer";
  if (byClient && !nonEmptyString(body.client_order_id)) return "cancel client_order_id is empty";
  return undefined;
}

function checkCancelAll(body: unknown): string | undefined {
  if (!isRecord(body)) return "cancel-all needs a JSON object body";
  if (!nonEmptyString(body.symbol)) {
    return "cancel-all must name a symbol: {} cancels every symbol on the account";
  }
  const extra = onlyKeys(body, ["symbol"]);
  if (extra) return `cancel-all has an unexpected field ${extra}`;
  return undefined;
}

function checkReplaceBatch(
  body: unknown,
): { error: string } | (CreateTally & { creates: number; cancels: number }) {
  if (!isRecord(body) || !Array.isArray(body.replacements) || body.replacements.length === 0) {
    return { error: "replace-batch needs a non-empty replacements array" };
  }
  const extra = onlyKeys(body, ["replacements"]);
  if (extra) return { error: `replace-batch has an unexpected field ${extra}` };
  const symbols = new Set<string>();
  const creates: { value: unknown; where: string }[] = [];
  let cancels = 0;
  for (const [i, item] of body.replacements.entries()) {
    if (!isRecord(item)) return { error: `replacement ${i} must be an object` };
    const extraLeg = onlyKeys(item, ["cancel", "new_order"]);
    if (extraLeg) return { error: `replacement ${i} has an unexpected field ${extraLeg}` };
    if (item.cancel === undefined && item.new_order === undefined) {
      return { error: `replacement ${i} has neither cancel nor new_order` };
    }
    if (item.cancel !== undefined) {
      const c = item.cancel;
      if (!isRecord(c) || !isOrderId(c.order_id) || !nonEmptyString(c.symbol)) {
        return { error: `replacement ${i} cancel needs a numeric order_id and symbol` };
      }
      const extraCancel = onlyKeys(c, ["order_id", "symbol"]);
      if (extraCancel)
        return { error: `replacement ${i} cancel has an unexpected field ${extraCancel}` };
      symbols.add(c.symbol);
      cancels += 1;
    }
    if (item.new_order !== undefined) {
      creates.push({ value: item.new_order, where: `replacement ${i} new_order` });
      if (isRecord(item.new_order) && typeof item.new_order.symbol === "string") {
        symbols.add(item.new_order.symbol);
      }
    }
  }
  const tally = checkCreates(creates, BATCH_TYPES);
  if ("error" in tally) return tally;
  if (symbols.size !== 1) return { error: "replace-batch legs must share one symbol" };
  if (creates.length + cancels > MAX_REPLACE_OPS) {
    return { error: `replace-batch exceeds ${MAX_REPLACE_OPS} operations` };
  }
  return { ...tally, creates: creates.length, cancels };
}

function cost(
  rateClass: RateClass,
  creates: number,
  cancels: number,
  replaceBatch = false,
): RouteCost {
  return { rateClass, ops: creates + cancels, creates, cancels, replaceBatch };
}

/**
 * Decide whether `profile` may sign `method pathWithQuery` with `body`, where `body` is the
 * parsed form of the exact bytes to be sent (undefined when there is no body).
 */
export function checkRoute(
  profile: ProfileName,
  method: string,
  pathWithQuery: string,
  body: unknown,
): RouteCheck {
  if (!METHODS.has(method)) return refuse(`unsupported method ${method}`);
  const q = pathWithQuery.indexOf("?");
  const path = q === -1 ? pathWithQuery : pathWithQuery.slice(0, q);
  const query = q === -1 ? "" : pathWithQuery.slice(q + 1);
  if (!PATH_RE.test(path)) return refuse(`malformed or non-v2 path ${path}`);

  for (const r of REFUSED) if (r.test(method, path)) return refuse(r.reason);

  if (q !== -1) {
    if (query.length === 0) return refuse("empty query string");
    const seen = new Set<string>();
    for (const key of new URLSearchParams(query).keys()) {
      const folded = goFold(key);
      if (FOLDED_QUERY_SELECTORS.has(folded)) return refuse(`query selector ${key} is refused`);
      if (seen.has(folded)) return refuse(`query parameter ${key} is repeated`);
      seen.add(folded);
    }
  }
  const selector = findSelector(body);
  if (selector) return refuse(`body selector ${selector} is refused`);

  if (profile === "HOLDER_PRESENT") {
    return refuse("HOLDER_PRESENT is defined for M5 and signs nothing yet");
  }
  if (profile !== "AUTONOMOUS" && profile !== "CANCEL_ONLY") {
    return refuse(`unknown profile ${String(profile)}`);
  }

  const ok = (
    route: RouteId,
    c: RouteCost,
    builderFeeRoute = false,
    tally: CreateTally = { clientOrderIds: [], exitCreates: 0 },
  ): RouteCheck => ({ ok: true, route, cost: c, builderFeeRoute, ...tally });

  if (method === "GET") {
    if (body !== undefined) return refuse("GET requests carry no body");
    if (!SIGNED_READ_PATHS.has(path)) return refuse(`GET ${path} is not an allowlisted read`);
    return ok("read", cost("read", 0, 0));
  }
  if (q !== -1) return refuse("writes carry their parameters in the body, not the query");

  const key = `${method} ${path}`;
  if (key === "DELETE /v2/order/cancel") {
    const bad = checkCancel(body);
    if (bad) return refuse(bad);
    return ok("order.cancel", cost("cancel", 0, 1));
  }
  if (key === "DELETE /v2/order/cancel-all") {
    const bad = checkCancelAll(body);
    if (bad) return refuse(bad);
    return ok("order.cancel-all", cost("cancel", 0, 1));
  }
  if (profile === "CANCEL_ONLY") return refuse(`${key} is not allowed under CANCEL_ONLY`);

  switch (key) {
    case "POST /v2/orders/batch": {
      if (!isRecord(body) || !Array.isArray(body.orders) || body.orders.length === 0) {
        return refuse("orders/batch needs a non-empty orders array");
      }
      const extra = onlyKeys(body, ["orders"]);
      if (extra) return refuse(`orders/batch has an unexpected field ${extra}`);
      const tally = checkCreates(
        body.orders.map((value, i) => ({ value, where: `orders[${i}]` })),
        BATCH_TYPES,
      );
      if ("error" in tally) return refuse(tally.error);
      return ok("orders.batch", cost("create", body.orders.length, 0), true, tally);
    }
    case "POST /v2/order/replace-batch": {
      const r = checkReplaceBatch(body);
      if ("error" in r) return refuse(r.error);
      const c = cost(r.creates > 0 ? "create" : "cancel", r.creates, r.cancels, true);
      return ok("order.replace-batch", c, true, r);
    }
    case "POST /v2/order": {
      const r = checkExitOrder(body);
      if ("error" in r) return refuse(r.error);
      return ok("order.exit", cost("reduce", 1, 0), true, r);
    }
    case "POST /v2/leverage": {
      if (!isRecord(body) || !nonEmptyString(body.symbol)) return refuse("leverage needs a symbol");
      const lev = body.leverage;
      if (typeof lev !== "number" || !Number.isInteger(lev) || lev < 1 || lev > 125) {
        return refuse("leverage must be an integer from 1 to 125");
      }
      const extra = onlyKeys(body, ["symbol", "leverage"]);
      if (extra) return refuse(`leverage has an unexpected field ${extra}`);
      return ok("leverage", cost("config", 0, 0));
    }
    case "POST /v2/marginMode": {
      if (!isRecord(body) || !nonEmptyString(body.symbol))
        return refuse("marginMode needs a symbol");
      if (body.marginMode !== "cross" && body.marginMode !== "isolated") {
        return refuse('marginMode must be "cross" or "isolated"');
      }
      const extra = onlyKeys(body, ["symbol", "marginMode"]);
      if (extra) return refuse(`marginMode has an unexpected field ${extra}`);
      return ok("margin-mode", cost("config", 0, 0));
    }
    default:
      return refuse(`${key} is not on the ${profile} allowlist`);
  }
}
