import {
  canonicalJson,
  HOLDER_PROOF_MAX_AGE_MS,
  HOLDER_PROOF_MAX_FUTURE_MS,
  hexToUtf8,
  holderAddress,
  isHex,
  parseHolderProofMessage,
  rawBodyHex,
  samePaymentKey,
  verifiedSigners,
  verifyCip8,
} from "@ballast/cardano";
import { ClockNotSyncedError, type ServerClock } from "./clock.js";
import { parseJsonExact, stringifyJsonExact } from "./json.js";
import { FUNDING_ROUTES, type FundingRoute, type HolderPresentProfile } from "./routes.js";
import { type ApiWalletSigner, sha256Hex } from "./sign.js";
import { StrikeApiError, StrikeRefusedError, StrikeTransportError } from "./signed-client.js";

/**
 * The HOLDER_PRESENT signer profile (plan §7, invariant 18): the only code in Ballast that signs
 * Strike's deposit and withdraw routes. It is a separate entry point
 * (`@ballast/strike-client/funding`); the main entry, and so the keeper and the watchdog, never
 * reach it (import-graph test).
 *
 * Every call needs a fresh holder proof: a CIP-8 `signData` by the account's own wallet, at most
 * 60 s old, naming the account and this exact request (path and the sha256 of the body's
 * canonical JSON), single-use. Even with a valid proof, the money itself moves only on the
 * holder's own transaction signature (deposit) or message plus transaction signature
 * (withdrawal); this profile signs the API request around it.
 *
 * Strike's docs disagree on whether an API wallet may call these routes (FRICTION 2026-10-23):
 * getting-started says no, strike-auth and the builder-codes pages say yes (masterOnly). Either
 * way the holder's wallet signs; D5 and D9 decide whether these requests are accepted or the
 * holder funds in Strike's own app instead.
 */
export const HOLDER_PRESENT: HolderPresentProfile = "HOLDER_PRESENT";

/** The two Cardano margin assets the onboarding offers (plan §1: "ADA or USDM margin"). */
export const FUNDING_ASSETS = ["ADA", "USDM"] as const;
export type FundingAsset = (typeof FUNDING_ASSETS)[number];

export interface HolderProof {
  /** hex(utf8(holder proof message)), exactly as the wallet signed it. */
  payload: string;
  /** `coseSign1Hex:coseKeyHex` (or Strike's JSON form). */
  signature: string;
}

export type FundingRouteCheck = { ok: true; route: FundingRoute } | { ok: false; reason: string };

const MAX_UTXOS = 500;
const MAX_HEX = 64 * 1024;
const MAX_PROOF_PAYLOAD = 4 * 1024;
const POSITIVE_INT = /^[1-9]\d{0,19}$/;
const USD = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function shortString(v: unknown, max = 128): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

function hexString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_HEX && isHex(v);
}

/** Exact keys: `required` must all be present, `optional` may be, nothing else. */
function keysAre(
  o: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): string | undefined {
  for (const k of Object.keys(o)) {
    if (!required.includes(k) && !optional.includes(k)) return `unexpected field ${k}`;
  }
  for (const k of required) if (o[k] === undefined) return `missing field ${k}`;
  return undefined;
}

function positiveUsd(v: unknown): boolean {
  return typeof v === "string" && USD.test(v) && /[1-9]/.test(v);
}

/**
 * Field-by-field check of one funding request. Ballast's subset only: Cardano, ADA or USDM,
 * balance mode, the holder's own wallet. `recipient_address`, collateral mode, staking-reward
 * withdrawals and every account selector are outside it, so a request can only move margin
 * between this account and the wallet that owns it.
 */
export function checkFundingRoute(
  method: string,
  path: string,
  body: unknown,
  holder: { address: string },
): FundingRouteCheck {
  const key = `${method} ${path}`;
  if (!(FUNDING_ROUTES as readonly string[]).includes(key)) {
    return { ok: false, reason: `${key} is not a HOLDER_PRESENT route` };
  }
  const route = key as FundingRoute;
  if (!isRecord(body)) return { ok: false, reason: `${key} needs a JSON object body` };
  const bad = (reason: string): FundingRouteCheck => ({ ok: false, reason: `${key}: ${reason}` });
  const asset = (v: unknown) => (FUNDING_ASSETS as readonly unknown[]).includes(v);
  let extra: string | undefined;
  switch (route) {
    case "POST /v2/deposit/quote":
      extra = keysAre(body, ["blockchain", "asset_symbol", "asset_amount"]);
      if (extra) return bad(extra);
      if (body.blockchain !== "cardano") return bad("blockchain must be cardano");
      if (!asset(body.asset_symbol)) return bad("asset_symbol must be ADA or USDM");
      if (typeof body.asset_amount !== "string" || !POSITIVE_INT.test(body.asset_amount)) {
        return bad("asset_amount must be a positive integer string in smallest units");
      }
      return { ok: true, route };
    case "POST /v2/deposit/build-tx": {
      extra = keysAre(body, ["request_id", "user_address", "utxos"]);
      if (extra) return bad(extra);
      if (!shortString(body.request_id)) return bad("request_id is required");
      if (
        typeof body.user_address !== "string" ||
        !samePaymentKey(body.user_address, holder.address)
      ) {
        return bad("user_address must carry the holder's payment key");
      }
      const u = body.utxos;
      if (!Array.isArray(u) || u.length === 0 || u.length > MAX_UTXOS || !u.every(hexString)) {
        return bad(`utxos must be 1-${MAX_UTXOS} CIP-30 hex strings`);
      }
      return { ok: true, route };
    }
    case "POST /v2/deposit":
      extra = keysAre(body, ["request_id", "tx_hash"]);
      if (extra) return bad(extra);
      if (!shortString(body.request_id)) return bad("request_id is required");
      if (typeof body.tx_hash !== "string" || !/^[0-9a-f]{64}$/.test(body.tx_hash)) {
        return bad("tx_hash must be a 64-hex Cardano transaction id");
      }
      return { ok: true, route };
    case "POST /v2/withdraw/estimate":
      extra = keysAre(body, ["usd_value", "blockchain", "asset"]);
      if (extra) return bad(extra);
      if (!positiveUsd(body.usd_value)) return bad("usd_value must be a positive decimal string");
      if (body.blockchain !== "cardano") return bad("blockchain must be cardano");
      if (!asset(body.asset)) return bad("asset must be ADA or USDM");
      return { ok: true, route };
    case "POST /v2/withdraw/quote":
      extra = keysAre(body, ["usd_value", "blockchain", "asset", "wallet_address"]);
      if (extra) return bad(extra);
      if (!positiveUsd(body.usd_value)) return bad("usd_value must be a positive decimal string");
      if (body.blockchain !== "cardano") return bad("blockchain must be cardano");
      if (!asset(body.asset)) return bad("asset must be ADA or USDM");
      // Strike pays only the account's registered wallet; naming it pins the signer too.
      if (body.wallet_address !== holder.address) return bad("wallet_address must be the holder's");
      return { ok: true, route };
    case "POST /v2/withdraw":
      extra = keysAre(body, ["withdraw_id", "wallet_signature"], ["signed_tx_cbor"]);
      if (extra) return bad(extra);
      if (!shortString(body.withdraw_id)) return bad("withdraw_id is required");
      if (!shortString(body.wallet_signature, MAX_HEX)) return bad("wallet_signature is required");
      if (body.signed_tx_cbor !== undefined && !hexString(body.signed_tx_cbor)) {
        return bad("signed_tx_cbor must be hex");
      }
      return { ok: true, route };
  }
}

export type HolderProofCheck =
  | { ok: true; nonce: string; issuedAtMs: number }
  | { ok: false; reason: string };

export interface HolderProofExpectation {
  accountId: string;
  address: string;
  path: string;
  /** The body exactly as it will be sent (parsed from the bytes). */
  body: unknown;
  nowMs: number;
}

/** Everything but replay: payload text, binding, freshness and the CIP-8 signature. */
export function checkHolderProof(proof: unknown, e: HolderProofExpectation): HolderProofCheck {
  const no = (reason: string): HolderProofCheck => ({ ok: false, reason });
  if (
    !isRecord(proof) ||
    typeof proof.payload !== "string" ||
    typeof proof.signature !== "string"
  ) {
    return no("a holder proof {payload, signature} is required");
  }
  const payload = proof.payload.toLowerCase();
  if (!isHex(payload) || payload.length === 0 || payload.length > MAX_PROOF_PAYLOAD) {
    return no("holder proof payload must be short hex");
  }
  let text: string;
  try {
    text = hexToUtf8(payload);
  } catch {
    return no("holder proof payload is not UTF-8");
  }
  const f = parseHolderProofMessage(text);
  if ("error" in f) return no(f.error);
  if (f.accountId !== e.accountId) return no("holder proof names another account");
  if (f.address !== e.address) return no("holder proof names another wallet");
  if (f.path !== e.path) return no("holder proof approves a different request");
  let bodyHash: string;
  try {
    bodyHash = sha256Hex(canonicalJson(e.body));
  } catch {
    return no("request body cannot be canonicalized");
  }
  if (f.bodySha256 !== bodyHash) return no("holder proof approves a different request body");
  if (f.issuedAtMs > e.nowMs + HOLDER_PROOF_MAX_FUTURE_MS)
    return no("holder proof is from the future");
  if (e.nowMs - f.issuedAtMs > HOLDER_PROOF_MAX_AGE_MS)
    return no("holder proof is older than 60 s");
  const v = verifyCip8(proof.signature, { address: e.address, payloadHex: payload });
  if (!v.ok) return no(`holder proof signature: ${v.reason}`);
  return { ok: true, nonce: f.nonce, issuedAtMs: f.issuedAtMs };
}

export interface DepositQuoteResponse {
  request_id: string;
  quote: {
    account_id: string;
    request_id: string;
    blockchain: string;
    asset_symbol: string;
    asset_amount: string;
    usd_value: string;
    exchange_rate: string;
    confirmations: number;
    timestamp: number;
    expiration_at: number;
  };
  signature: string;
  deposit_address: string;
  confirmations_required: number;
}

export interface DepositBuildTxResponse {
  blockchain: "cardano";
  unsigned_tx: string;
  format: "cardano_cbor";
  expires_at?: number;
}

export interface DepositConfirmResponse {
  request_id: string;
  status: "pending";
  tx_hash: string;
  message: string;
}

export interface WithdrawEstimateResponse {
  route: string;
  estimated_receive?: string;
  minimum_receive?: string;
  withdraw_fee_usd: string;
  destination_asset?: string;
  destination_asset_decimals?: number;
  [k: string]: unknown;
}

export interface WithdrawQuoteResponse {
  withdraw_id: string;
  fee: string;
  /** Cardano: already hex; signed as-is, never re-encoded. */
  message_to_sign: string;
  tx_cbor?: string;
  validator_address?: string;
  route?: string;
  [k: string]: unknown;
}

export interface WithdrawConfirmResponse {
  request_id: string;
  status: "pending" | "completed" | "failed";
  sequence_id?: number;
  message_id?: string;
}

export interface HolderPresentClientOptions {
  baseUrl: string;
  /** Cloudflare rejects default user agents. */
  userAgent: string;
  /** The account's API wallet, generated by Ballast; only its public key ever left. */
  signer: ApiWalletSigner;
  clock: ServerClock;
  accountId: string;
  /** The bech32 address the account was connected with (Strike's `Wallet:` line). */
  holderAddress: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

interface RememberedQuote {
  messageHex: string;
  txBodyHex: string | null;
  createdMs: number;
}

/** Strike's withdraw quote TTL is 15 min by default (strike-withdraw). */
const QUOTE_MEMORY_MS = 15 * 60_000;

/**
 * Funding client for one holder account. Each method takes the request body and the holder's
 * proof for exactly that body; nothing is signed or sent unless the route check, the proof and
 * the replay check all pass. Requests are sent once, never retried (Strike consumes the nonce
 * and writes have no idempotency).
 */
export class HolderPresentClient {
  readonly profile: HolderPresentProfile = HOLDER_PRESENT;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly usedNonces = new Map<string, number>();
  private readonly quotes = new Map<string, RememberedQuote>();
  readonly holderAddress: string;
  private readonly paymentKeyHash: string;

  constructor(private readonly opts: HolderPresentClientOptions) {
    const h = holderAddress(opts.holderAddress);
    this.holderAddress = h.address;
    this.paymentKeyHash = h.paymentKeyHash;
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get accountId(): string {
    return this.opts.accountId;
  }

  depositQuote(body: unknown, proof: unknown): Promise<DepositQuoteResponse> {
    return this.send("/v2/deposit/quote", body, proof);
  }

  async depositBuildTx(body: unknown, proof: unknown): Promise<DepositBuildTxResponse> {
    const r = await this.send<DepositBuildTxResponse>("/v2/deposit/build-tx", body, proof);
    if (r?.format !== "cardano_cbor" || !hexString(r.unsigned_tx)) {
      throw new StrikeRefusedError("route", "build-tx did not return a Cardano CBOR transaction");
    }
    return r;
  }

  depositConfirm(body: unknown, proof: unknown): Promise<DepositConfirmResponse> {
    return this.send("/v2/deposit", body, proof);
  }

  withdrawEstimate(body: unknown, proof: unknown): Promise<WithdrawEstimateResponse> {
    return this.send("/v2/withdraw/estimate", body, proof);
  }

  async withdrawQuote(body: unknown, proof: unknown): Promise<WithdrawQuoteResponse> {
    const q = await this.send<WithdrawQuoteResponse>("/v2/withdraw/quote", body, proof);
    if (!shortString(q?.withdraw_id) || !hexString(q.message_to_sign)) {
      throw new StrikeRefusedError("route", "withdraw quote has no withdraw_id or hex message");
    }
    if (q.tx_cbor !== undefined && !hexString(q.tx_cbor)) {
      throw new StrikeRefusedError("route", "withdraw quote tx_cbor is not hex");
    }
    this.forgetOldQuotes();
    this.quotes.set(q.withdraw_id, {
      messageHex: q.message_to_sign.toLowerCase(),
      txBodyHex: q.tx_cbor ? rawBodyHex(q.tx_cbor) : null,
      createdMs: this.now(),
    });
    return q;
  }

  /**
   * Before forwarding, the confirm is checked against the quote this client received: the wallet
   * signature must be the holder's over that exact `message_to_sign`, and a funding tx must be
   * the quote's own body carrying the holder's payment-key witness.
   */
  async withdrawConfirm(body: unknown, proof: unknown): Promise<WithdrawConfirmResponse> {
    const b = isRecord(body) ? body : {};
    const quote = typeof b.withdraw_id === "string" ? this.quotes.get(b.withdraw_id) : undefined;
    if (!quote) {
      throw new StrikeRefusedError("route", "no withdraw quote from this session for that id");
    }
    const sig = typeof b.wallet_signature === "string" ? b.wallet_signature : "";
    const v = verifyCip8(sig, { address: this.holderAddress, payloadHex: quote.messageHex });
    if (!v.ok) throw new StrikeRefusedError("route", `wallet_signature: ${v.reason}`);
    if (quote.txBodyHex !== null) {
      const signed = typeof b.signed_tx_cbor === "string" ? b.signed_tx_cbor : "";
      if (!signed) throw new StrikeRefusedError("route", "the quote's funding tx must be signed");
      let sameBody = false;
      let signers: string[] = [];
      try {
        sameBody = rawBodyHex(signed) === quote.txBodyHex;
        signers = verifiedSigners(signed);
      } catch {
        throw new StrikeRefusedError("route", "signed_tx_cbor is not a Cardano transaction");
      }
      if (!sameBody) throw new StrikeRefusedError("route", "signed_tx_cbor is not the quoted tx");
      if (!signers.includes(this.paymentKeyHash)) {
        throw new StrikeRefusedError("route", "signed_tx_cbor lacks the holder's signature");
      }
    } else if (b.signed_tx_cbor !== undefined) {
      throw new StrikeRefusedError("route", "the quote had no funding tx to sign");
    }
    const r = await this.send<WithdrawConfirmResponse>("/v2/withdraw", body, proof);
    this.quotes.delete(b.withdraw_id as string);
    return r;
  }

  private forgetOldQuotes(): void {
    const cutoff = this.now() - QUOTE_MEMORY_MS;
    for (const [id, q] of this.quotes) if (q.createdMs < cutoff) this.quotes.delete(id);
  }

  private consumeNonce(nonce: string, nowMs: number): boolean {
    for (const [n, exp] of this.usedNonces) if (exp <= nowMs) this.usedNonces.delete(n);
    if (this.usedNonces.has(nonce)) return false;
    this.usedNonces.set(nonce, nowMs + HOLDER_PROOF_MAX_AGE_MS + HOLDER_PROOF_MAX_FUTURE_MS);
    return true;
  }

  private async send<T>(path: string, body: unknown, proof: unknown): Promise<T> {
    let text: string;
    try {
      text = stringifyJsonExact(body);
    } catch (err) {
      throw new StrikeRefusedError("route", `body does not serialize: ${(err as Error).message}`);
    }
    const sent = parseJsonExact(text);
    const route = checkFundingRoute("POST", path, sent, { address: this.holderAddress });
    if (!route.ok) throw new StrikeRefusedError("route", route.reason);
    const nowMs = this.now();
    const p = checkHolderProof(proof, {
      accountId: this.opts.accountId,
      address: this.holderAddress,
      path,
      body: sent,
      nowMs,
    });
    if (!p.ok) throw new StrikeRefusedError("holder-proof", p.reason);
    if (!this.consumeNonce(p.nonce, nowMs)) {
      throw new StrikeRefusedError("holder-proof", "holder proof was already used");
    }
    let timestampSec: number;
    try {
      timestampSec = this.opts.clock.signingTimestampSec();
    } catch (err) {
      if (err instanceof ClockNotSyncedError) throw new StrikeRefusedError("clock", err.message);
      throw err;
    }
    const bytes = Buffer.from(text, "utf8");
    const url = new URL(path, this.opts.baseUrl);
    if (url.pathname + url.search !== path) {
      throw new StrikeRefusedError("route", `path changes on the wire: ${path}`);
    }
    const { headers } = this.opts.signer.signRest({
      method: "POST",
      pathWithQuery: path,
      body: bytes,
      timestampSec,
    });
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method: "POST",
        headers: {
          ...headers,
          "User-Agent": this.opts.userAgent,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: bytes,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      throw new StrikeTransportError("POST", path, true, err);
    }
    const out = await res.text();
    if (!res.ok) {
      let code = "";
      try {
        const j = JSON.parse(out) as { error?: unknown };
        if (typeof j.error === "string") code = j.error;
      } catch {}
      throw new StrikeApiError(res.status, code, out, "POST", path);
    }
    return (out ? parseJsonExact(out) : undefined) as T;
  }
}

export {
  type AccountLookup,
  BuilderConnectClient,
  type BuilderConnectOptions,
  foreignActivity,
  type RequestSignatureBody,
  type RequestSignatureResponse,
  type StrikeAccountView,
  type VerifySignatureResponse,
} from "./builder-connect.js";

/** sha256 of the body's canonical JSON: what a holder proof's Body-SHA256 line must equal. */
export function holderBodyHash(body: unknown): string {
  return sha256Hex(canonicalJson(body));
}
