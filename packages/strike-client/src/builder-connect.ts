import { stringifyJsonExact } from "./json.js";
import { StrikeApiError, StrikeRefusedError, StrikeTransportError } from "./signed-client.js";

/**
 * Strike's public Builder Connect (strike-auth, builder-connect.md) and the public account lookup
 * that proves it worked (`GET /v2/account?blockchain_address=`: 404 "user not found" → 200).
 * Nothing here is signed by Ballast: the holder's wallet signs the challenge, and only the
 * public half of the API wallet Ballast generated is sent.
 */
export interface RequestSignatureBody {
  address: string;
  chain: "cardano";
  code: string;
  fee_share_bps: number;
  public_key: string;
}

export interface RequestSignatureResponse {
  nonce: string;
  message_to_sign: string;
  message?: string;
  referral_code?: string;
}

export interface VerifySignatureResponse {
  account_id: string;
  builder_code: string;
  fee_share_bps: number;
  api_wallet_id: number;
  api_wallet_public_key: string;
  api_wallet_expired_at?: string;
  referral?: { status: string; code?: string };
  nickname?: string;
  avatar_url?: string;
}

/** The fields of `GET /v2/account` Ballast reads (strike-account). Decimals are strings. */
export interface StrikeAccountView {
  account_id: string;
  blockchain?: string;
  blockchain_address?: string | null;
  wallet_balance?: string;
  available_balance?: string;
  unrealized_pnl?: string;
  margin_balance?: string;
  total_margin?: string;
  position_initial_margin?: string;
  maintenance_margin?: string;
  sub_accounts?: unknown[] | null;
  symbol_settings?: Record<string, unknown>;
  [k: string]: unknown;
}

export type AccountLookup = { status: 404 } | { status: 200; account: StrikeAccountView };

export interface BuilderConnectOptions {
  baseUrl: string;
  userAgent: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * What a dedicated account looks like before Ballast ever quotes from it: no balance, margin,
 * PnL, sub-accounts or symbol settings. Anything else is foreign activity (plan §7, /join step 3).
 */
// VERIFY: that a fresh Builder Connect account reads as all zeros, no sub-accounts and no
// symbol_settings; D4 records the first 200 (FRICTION 2026-10-23).
export function foreignActivity(a: StrikeAccountView): string[] {
  const out: string[] = [];
  const nonZero = (v: unknown) => typeof v === "string" && /[1-9]/.test(v);
  for (const k of [
    "wallet_balance",
    "available_balance",
    "unrealized_pnl",
    "margin_balance",
    "total_margin",
    "position_initial_margin",
    "maintenance_margin",
  ]) {
    if (nonZero(a[k])) out.push(`${k} is ${String(a[k])}`);
  }
  if (Array.isArray(a.sub_accounts) && a.sub_accounts.length > 0) out.push("has sub-accounts");
  if (a.symbol_settings && Object.keys(a.symbol_settings).length > 0) {
    out.push("has per-symbol leverage or margin settings");
  }
  return out;
}

export class BuilderConnectClient {
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: BuilderConnectOptions) {
    this.doFetch = opts.fetch ?? fetch;
  }

  /** Sent once: a challenge is single-use and a repeat would only make a second one. */
  async requestSignature(body: RequestSignatureBody): Promise<RequestSignatureResponse> {
    // Strike decodes this body strictly; only these five keys are ever sent.
    const exact: RequestSignatureBody = {
      address: body.address,
      chain: body.chain,
      code: body.code,
      fee_share_bps: body.fee_share_bps,
      public_key: body.public_key,
    };
    if (exact.chain !== "cardano") throw new StrikeRefusedError("route", "chain must be cardano");
    if (!/^[0-9a-f]{64}$/.test(exact.public_key)) {
      throw new StrikeRefusedError("route", "public_key must be 64 lowercase hex");
    }
    if (
      !Number.isInteger(exact.fee_share_bps) ||
      exact.fee_share_bps < 0 ||
      exact.fee_share_bps > 100
    ) {
      throw new StrikeRefusedError("route", "fee_share_bps must be an integer 0-100");
    }
    const r = await this.post<RequestSignatureResponse>("/auth/builder/request-signature", exact);
    const m = typeof r?.message_to_sign === "string" ? r.message_to_sign.split("\n") : [];
    // The holder signs this verbatim; it must name this wallet, this key and this nonce.
    // VERIFY: these lines follow strike-auth's documented template; a template change makes
    // Ballast refuse the challenge rather than ask for a blind signature (FRICTION 2026-10-23).
    const has = (line: string) => m.includes(line);
    if (
      typeof r?.nonce !== "string" ||
      !has(`Wallet: ${exact.address}`) ||
      !has(`API Key: ${exact.public_key}`) ||
      !has(`Nonce: ${r.nonce}`) ||
      !m[0]?.startsWith(`Connect to Strike via builder "${exact.code}"`)
    ) {
      throw new StrikeRefusedError(
        "route",
        "the challenge does not name this wallet, key and nonce",
      );
    }
    return r;
  }

  async verifySignature(
    body: { nonce: string; wallet_signature: string },
    expectPublicKey: string,
  ): Promise<VerifySignatureResponse> {
    const r = await this.post<VerifySignatureResponse>("/auth/builder/verify-signature", {
      nonce: body.nonce,
      wallet_signature: body.wallet_signature,
    });
    if (typeof r?.account_id !== "string" || r.api_wallet_public_key !== expectPublicKey) {
      throw new StrikeRefusedError("route", "verify-signature registered a different key");
    }
    return r;
  }

  /** Public read; a 404 "user not found" is an answer, not an error. */
  async accountByAddress(address: string): Promise<AccountLookup> {
    const url = new URL("/v2/account", this.opts.baseUrl);
    url.searchParams.set("blockchain_address", address);
    let res: Response;
    try {
      res = await this.doFetch(url, {
        headers: { "User-Agent": this.opts.userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      throw new StrikeTransportError("GET", "/v2/account", false, err);
    }
    const text = await res.text();
    if (res.status === 404) return { status: 404 };
    if (!res.ok) throw new StrikeApiError(res.status, errorCode(text), text, "GET", "/v2/account");
    return { status: 200, account: JSON.parse(text) as StrikeAccountView };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(new URL(path, this.opts.baseUrl), {
        method: "POST",
        headers: {
          "User-Agent": this.opts.userAgent,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: stringifyJsonExact(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      throw new StrikeTransportError("POST", path, true, err);
    }
    const text = await res.text();
    if (!res.ok) throw new StrikeApiError(res.status, errorCode(text), text, "POST", path);
    return JSON.parse(text) as T;
  }
}

function errorCode(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: unknown };
    return typeof j.error === "string" ? j.error : "";
  } catch {
    return "";
  }
}
