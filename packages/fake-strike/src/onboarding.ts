import { randomBytes, randomUUID } from "node:crypto";
import {
  addressHexToBech32,
  bytesToHex,
  holderAddress,
  paymentKeyHashOf,
  rawBodyHex,
  samePaymentKey,
  utf8ToHex,
  verifiedSigners,
  verifyCip8,
} from "@ballast/cardano";
import { buildPaymentTx } from "@ballast/cardano/testing";
import type { FakeAccount } from "./engine.js";
import { bad, HttpError } from "./errors.js";
import { fmt, isRecord, mulFixed, SCALE, toFixed } from "./util.js";

/**
 * Strike's onboarding and funding routes, faked from the docs (builder-connect.md, deposit.md,
 * withdraw.md and the strike-auth / strike-deposit / strike-withdraw skills):
 * - public Builder Connect: request-signature (strict body, 5-minute single-use challenge) and
 *   verify-signature (CIP-8 check, account created on first connect, previous builder wallets
 *   revoked, a fresh public key required);
 * - public `GET /v2/account?blockchain_address=`: 404 "user not found" until the first connect;
 * - deposit quote → build-tx (a real unsigned Cardano tx over the wallet's UTxOs) → confirm
 *   (409 on a repeat), crediting the balance afterwards;
 * - withdraw estimate → quote (hex `message_to_sign`, a min-UTxO funding `tx_cbor`) → confirm
 *   (wallet signature and signed funding tx checked), debiting the balance.
 * Nothing here talks to a chain. Behaviour the docs leave open is marked VERIFY.
 */
export interface OnboardingOptions {
  builderCode: string;
  /** "jwt-only" answers every funding route the way getting-started says API wallets are treated. */
  fundingAuth: "api-wallet" | "jwt-only";
  /** Spendable UTxOs (CIP-30 hex) Strike would read for a wallet's withdraw funding tx. */
  cardanoUtxos?: (address: string) => readonly string[];
  /** USD per whole ADA (default "0.35"). */
  adaUsd?: string;
  /** Delay before a confirmed deposit is credited (default 0: on the next tick). */
  creditDelayMs?: number;
  referralCode?: string;
}

export interface OnboardingHost {
  now(): number;
  createAccount(publicKeyHex: string, approvedFeeBps: number): FakeAccount;
  registerKey(acct: FakeAccount, publicKeyHex: string): void;
  revokeKey(publicKeyHex: string): void;
  keyKnown(publicKeyHex: string): boolean;
  emit(accountId: string, msg: Record<string, unknown>): void;
  ids(): { sequence_id: number; message_id: string };
}

interface Challenge {
  nonce: string;
  message: string;
  address: string;
  chain: string;
  code: string;
  feeShareBps: number;
  publicKey: string;
  expiresMs: number;
}

interface WalletAccount {
  account: FakeAccount;
  address: string;
  /** USD, 18-dp fixed point. */
  walletBalance: bigint;
  builderKeys: string[];
}

interface DepositQuote {
  requestId: string;
  accountId: string;
  asset: "ADA" | "USDM";
  amount: bigint;
  usd: bigint;
  expiresMs: number;
  exchanger?: string;
  txHash?: string;
}

interface WithdrawQuote {
  withdrawId: string;
  accountId: string;
  usd: bigint;
  asset: string;
  messageHex: string;
  txCbor?: string;
  createdMs: number;
  used: boolean;
}

export interface FundingEvent {
  kind: "deposit" | "withdrawal";
  accountId: string;
  usd: string;
  txHash?: string;
  atMs: number;
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const DEPOSIT_QUOTE_TTL_MS = 10 * 60_000;
const WITHDRAW_QUOTE_TTL_MS = 15 * 60_000;
const TX_VALIDITY_MS = 30 * 60_000;
const WITHDRAW_FEE_USD = 1n * SCALE;
const MIN_WITHDRAW_USD = 5n * SCALE;
const MIN_DEPOSIT_USD = 1n * SCALE;
/** Shelley-era mainnet slot = unix seconds − 1591566291. */
const SLOT_OFFSET_S = 1_591_566_291;
/** The fake's USDM: a test policy, not the real token. */
export const FAKE_USDM = { policyId: "f".repeat(56), assetNameHex: "5553444d" } as const;

const REQUEST_KEYS = ["address", "chain", "code", "fee_share_bps", "public_key", "referral_code"];

function fakeAddress(header: number): string {
  return addressHexToBech32(`${header.toString(16)}${bytesToHex(randomBytes(28))}`);
}

function usdString(v: bigint): string {
  return fmt(v);
}

export class FakeOnboarding {
  /** Strike's vault address on Cardano (key-hash enterprise, fake). */
  readonly vaultAddress = fakeAddress(0x61);
  /** The withdrawal validator (script enterprise, fake). */
  readonly validatorAddress = fakeAddress(0x71);
  readonly challenges = new Map<string, Challenge>();
  readonly wallets = new Map<string, WalletAccount>();
  readonly byAccount = new Map<string, WalletAccount>();
  readonly deposits = new Map<string, DepositQuote>();
  readonly withdrawals = new Map<string, WithdrawQuote>();
  readonly events: FundingEvent[] = [];
  private nextWalletId = 1_200;
  private pending = 0;

  constructor(
    private readonly host: OnboardingHost,
    private readonly opts: OnboardingOptions,
  ) {}

  /** Resolves once every scheduled credit and debit has applied. */
  async settled(): Promise<void> {
    while (this.pending > 0) await new Promise((r) => setTimeout(r, 1));
  }

  /** Seed an existing Strike account at a wallet address (e.g. one with foreign activity). */
  seedAccount(address: string, publicKeyHex: string, walletBalanceUsd = "0"): FakeAccount {
    const account = this.host.createAccount(publicKeyHex, 0);
    const w: WalletAccount = {
      account,
      address,
      walletBalance: toFixed(walletBalanceUsd) ?? 0n,
      builderKeys: [],
    };
    this.wallets.set(address, w);
    this.byAccount.set(account.id, w);
    return account;
  }

  balanceOf(accountId: string): string {
    return usdString(this.byAccount.get(accountId)?.walletBalance ?? 0n);
  }

  // ---- public routes ------------------------------------------------------------------------

  /** Routes that need no API wallet; undefined when `path` is not one of them. */
  publicRoute(
    method: string,
    url: URL,
    body: () => unknown,
    hasWalletHeader: boolean,
  ): [number, unknown] | undefined {
    const key = `${method} ${url.pathname}`;
    if (key === "POST /auth/builder/request-signature") return this.requestSignature(body());
    if (key === "POST /auth/builder/verify-signature") return this.verifySignature(body());
    if (
      key === "GET /v2/account" &&
      !hasWalletHeader &&
      url.searchParams.has("blockchain_address")
    ) {
      const w = this.wallets.get(url.searchParams.get("blockchain_address") ?? "");
      if (!w) throw new HttpError(404, { error: "user not found" });
      return [200, this.accountView(w)];
    }
    return undefined;
  }

  /** The signed (API wallet) side: own-account reads and the funding routes. */
  signedRoute(
    acct: FakeAccount,
    method: string,
    url: URL,
    body: () => unknown,
  ): [number, unknown] | undefined {
    const key = `${method} ${url.pathname}`;
    if (key === "GET /v2/account") {
      const w = this.byAccount.get(acct.id);
      if (!w) throw new HttpError(404, { error: "user not found" });
      return [200, this.accountView(w)];
    }
    const funding = [
      "POST /v2/deposit/quote",
      "POST /v2/deposit/build-tx",
      "POST /v2/deposit",
      "POST /v2/withdraw/estimate",
      "POST /v2/withdraw/quote",
      "POST /v2/withdraw",
    ];
    if (!funding.includes(key)) return undefined;
    if (this.opts.fundingAuth === "jwt-only") {
      // VERIFY: the error an API wallet would get if getting-started's "requires JWT" holds.
      throw new HttpError(401, { error: "missing authorization header" });
    }
    const w = this.byAccount.get(acct.id);
    if (!w) throw new HttpError(404, { error: "account not found" });
    const b = body();
    if (!isRecord(b)) throw bad("invalid request body");
    switch (key) {
      case "POST /v2/deposit/quote":
        return this.depositQuote(w, b);
      case "POST /v2/deposit/build-tx":
        return this.buildTx(w, b);
      case "POST /v2/deposit":
        return this.confirmDeposit(w, b);
      case "POST /v2/withdraw/estimate":
        return this.estimate(b);
      case "POST /v2/withdraw/quote":
        return this.withdrawQuote(w, b);
      default:
        return this.confirmWithdraw(w, b);
    }
  }

  private accountView(w: WalletAccount): Record<string, unknown> {
    const bal = usdString(w.walletBalance);
    const settings: Record<string, unknown> = {};
    for (const [s, lev] of w.account.leverage) {
      settings[s] = {
        margin_mode: w.account.marginMode.get(s) ?? "cross",
        leverage: lev,
        allow_pre_trade: false,
      };
    }
    return {
      account_id: w.account.id,
      blockchain: "cardano",
      blockchain_address: w.address,
      wallet_balance: bal,
      available_balance: bal,
      copy_reserved_balance: "0",
      copy_deployed_margin: "0",
      copy_profit_share_reserved: "0",
      unrealized_pnl: "0",
      margin_balance: bal,
      total_margin: "0",
      position_initial_margin: "0",
      maintenance_margin: "0",
      sub_accounts: [],
      default_margin_mode: "cross",
      default_leverage: 10,
      ...(Object.keys(settings).length > 0 ? { symbol_settings: settings } : {}),
    };
  }

  // ---- Builder Connect ----------------------------------------------------------------------

  private requestSignature(raw: unknown): [number, unknown] {
    if (!isRecord(raw)) throw bad("invalid request body");
    // The body is decoded strictly (strike-auth): unknown fields are rejected.
    for (const k of Object.keys(raw)) {
      if (!REQUEST_KEYS.includes(k)) throw bad(`json: unknown field "${k}"`);
    }
    for (const k of ["address", "chain", "code", "fee_share_bps", "public_key"]) {
      if (raw[k] === undefined || raw[k] === "") throw bad(`${k} is required`);
    }
    const chain = String(raw.chain).toLowerCase();
    if (!["ethereum", "solana", "cardano"].includes(chain)) {
      throw bad("chain must be ethereum, solana, or cardano");
    }
    const pub = String(raw.public_key);
    if (!/^[0-9a-fA-F]+$/.test(pub)) throw bad("invalid public key: must be hex-encoded");
    if (pub.length !== 64) throw bad("invalid public key: must be 64 hex characters (Ed25519)");
    const fee = raw.fee_share_bps;
    if (typeof fee !== "number" || !Number.isInteger(fee) || fee < 0 || fee > 100) {
      throw bad("fee_share_bps must be 0-100");
    }
    if (raw.code !== this.opts.builderCode)
      throw new HttpError(404, { error: "builder code not found" });
    if (raw.referral_code !== undefined && raw.referral_code !== this.opts.referralCode) {
      throw bad("referral code does not belong to the builder");
    }
    const nonce = randomUUID();
    const address = String(raw.address);
    const message = [
      `Connect to Strike via builder "${this.opts.builderCode}".`,
      `This authorizes the builder to collect up to ${fee / 100}% fee on your trades.`,
      "Referral attribution: none.",
      "By signing, you are entrusting your API wallet private key to this builder. You trust the builder to store and use this key responsibly.",
      `Wallet: ${address}`,
      `Chain: ${chain}`,
      `API Key: ${pub}`,
      `Nonce: ${nonce}`,
      `Timestamp: ${new Date(this.host.now()).toISOString().replace(/\.\d{3}Z$/, "Z")}`,
      "",
      "Complete verify-signature within 5 minutes; after that the challenge expires.",
    ].join("\n");
    this.challenges.set(nonce, {
      nonce,
      message,
      address,
      chain,
      code: this.opts.builderCode,
      feeShareBps: fee,
      publicKey: pub.toLowerCase(),
      expiresMs: this.host.now() + CHALLENGE_TTL_MS,
    });
    return [200, { nonce, message_to_sign: message, message }];
  }

  private verifySignature(raw: unknown): [number, unknown] {
    if (!isRecord(raw)) throw bad("invalid request body");
    for (const k of Object.keys(raw)) {
      if (k !== "nonce" && k !== "wallet_signature") throw bad(`json: unknown field "${k}"`);
    }
    if (typeof raw.nonce !== "string" || raw.nonce === "") throw bad("nonce is required");
    if (typeof raw.wallet_signature !== "string" || raw.wallet_signature === "") {
      throw bad("wallet_signature is required");
    }
    // GETDEL: any attempt, good or bad, consumes the challenge.
    const ch = this.challenges.get(raw.nonce);
    this.challenges.delete(raw.nonce);
    if (!ch || ch.expiresMs <= this.host.now()) throw bad("challenge not found or expired");
    if (ch.chain !== "cardano") throw bad("only cardano is faked");
    try {
      holderAddress(ch.address);
    } catch {
      throw bad("invalid address format");
    }
    // The server hex-encodes the message before verifying (strike-auth).
    const v = verifyCip8(raw.wallet_signature, {
      address: ch.address,
      payloadHex: utf8ToHex(ch.message),
    });
    if (!v.ok) throw new HttpError(401, { error: "wallet signature verification failed" });
    if (this.host.keyKnown(ch.publicKey)) {
      throw new HttpError(500, { error: "failed to create API wallet" });
    }
    let w = this.wallets.get(ch.address);
    if (!w) {
      const account = this.host.createAccount(ch.publicKey, ch.feeShareBps);
      w = { account, address: ch.address, walletBalance: 0n, builderKeys: [ch.publicKey] };
      this.wallets.set(ch.address, w);
      this.byAccount.set(account.id, w);
    } else {
      // Revokes any existing API wallets of this account for the same builder code.
      for (const k of w.builderKeys) this.host.revokeKey(k);
      w.builderKeys = [ch.publicKey];
      w.account.approvedBuilderFeeBps = ch.feeShareBps;
      this.host.registerKey(w.account, ch.publicKey);
    }
    this.nextWalletId += 1;
    return [
      200,
      {
        account_id: w.account.id,
        nickname: "",
        avatar_url: "",
        builder_code: ch.code,
        fee_share_bps: ch.feeShareBps,
        api_wallet_id: this.nextWalletId,
        api_wallet_public_key: ch.publicKey,
        api_wallet_expired_at: "9999-12-31T23:59:59Z",
        referral: { status: "not_requested" },
      },
    ];
  }

  // ---- deposit ------------------------------------------------------------------------------

  private rate(asset: string): bigint {
    return asset === "USDM" ? SCALE : (toFixed(this.opts.adaUsd ?? "0.35") as bigint);
  }

  private depositQuote(w: WalletAccount, b: Record<string, unknown>): [number, unknown] {
    if (b.blockchain !== "cardano") throw bad("blockchain not supported");
    if (b.asset_symbol !== "ADA" && b.asset_symbol !== "USDM") throw bad("unsupported asset");
    if (typeof b.asset_amount !== "string" || !/^\d+$/.test(b.asset_amount)) {
      throw bad("invalid amount");
    }
    const amount = BigInt(b.asset_amount);
    const usd = mulFixed((amount * SCALE) / 1_000_000n, this.rate(b.asset_symbol));
    if (usd < MIN_DEPOSIT_USD) throw bad("amount below minimum");
    const now = this.host.now();
    const requestId = randomUUID();
    this.deposits.set(requestId, {
      requestId,
      accountId: w.account.id,
      asset: b.asset_symbol,
      amount,
      usd,
      expiresMs: now + DEPOSIT_QUOTE_TTL_MS,
    });
    return [
      200,
      {
        request_id: requestId,
        quote: {
          account_id: w.account.id,
          request_id: requestId,
          blockchain: "cardano",
          asset_symbol: b.asset_symbol,
          asset_amount: b.asset_amount,
          usd_value: usdString(usd),
          exchange_rate: fmt(this.rate(b.asset_symbol)),
          confirmations: 15,
          timestamp: now,
          expiration_at: now + DEPOSIT_QUOTE_TTL_MS,
        },
        signature: bytesToHex(randomBytes(64)),
        deposit_address: this.vaultAddress,
        confirmations_required: 15,
      },
    ];
  }

  private quoteFor(w: WalletAccount, requestId: unknown): DepositQuote {
    const q = typeof requestId === "string" ? this.deposits.get(requestId) : undefined;
    if (!q) throw new HttpError(404, { error: "deposit quote not found or expired" });
    if (q.accountId !== w.account.id) throw new HttpError(403, { error: "access denied" });
    if (q.expiresMs <= this.host.now()) throw bad("deposit quote has expired");
    return q;
  }

  private buildTx(w: WalletAccount, b: Record<string, unknown>): [number, unknown] {
    const q = this.quoteFor(w, b.request_id);
    const user = typeof b.user_address === "string" ? b.user_address : "";
    // "Cardano: any address with the same payment key" as the account's wallet.
    if (!samePaymentKey(user, w.address)) throw new HttpError(403, { error: "access denied" });
    const utxos = b.utxos;
    if (!Array.isArray(utxos) || utxos.length === 0 || !utxos.every((u) => typeof u === "string")) {
      throw new HttpError(500, { error: "failed to build transaction" });
    }
    // ADA pays an exchanger address created at build-tx; USDM goes straight to the vault.
    const exchanger = q.asset === "ADA" ? fakeAddress(0x61) : undefined;
    const expiresMs = this.host.now() + TX_VALIDITY_MS;
    let tx: string;
    try {
      tx = buildPaymentTx({
        utxosHex: utxos as string[],
        changeAddress: user,
        outputs: [
          q.asset === "ADA"
            ? { address: exchanger as string, lovelace: q.amount }
            : {
                address: this.vaultAddress,
                lovelace: 2_000_000n,
                assets: [{ ...FAKE_USDM, quantity: q.amount }],
              },
        ],
        ttlSlot: Math.floor(expiresMs / 1000) - SLOT_OFFSET_S,
      });
    } catch {
      throw new HttpError(500, { error: "failed to build transaction" });
    }
    if (exchanger) q.exchanger = exchanger;
    return [
      200,
      { blockchain: "cardano", unsigned_tx: tx, format: "cardano_cbor", expires_at: expiresMs },
    ];
  }

  private confirmDeposit(w: WalletAccount, b: Record<string, unknown>): [number, unknown] {
    if (typeof b.request_id !== "string" || typeof b.tx_hash !== "string") {
      throw bad("request_id and tx_hash are required");
    }
    if (b.tx_hash.length < 10) throw bad("invalid tx_hash format");
    const q = this.quoteFor(w, b.request_id);
    if (q.txHash !== undefined) {
      throw new HttpError(409, { error: "deposit already submitted", tx_hash: q.txHash });
    }
    q.txHash = b.tx_hash;
    const txHash = b.tx_hash;
    this.balanceEvent(w, "DEPOSIT_PENDING");
    this.later(() => {
      w.walletBalance += q.usd;
      this.events.push({
        kind: "deposit",
        accountId: w.account.id,
        usd: usdString(q.usd),
        txHash,
        atMs: this.host.now(),
      });
      // VERIFY: the credit's event kind; strike-userstream names DEPOSIT_PENDING, then a balance update.
      this.balanceEvent(w, "DEPOSIT");
    });
    return [
      200,
      {
        request_id: q.requestId,
        status: "pending",
        tx_hash: txHash,
        message: "Deposit submission confirmed, awaiting blockchain confirmation",
      },
    ];
  }

  // ---- withdraw -----------------------------------------------------------------------------

  private usd(v: unknown): bigint {
    const x = typeof v === "string" ? toFixed(v) : undefined;
    if (x === undefined || x <= 0n) throw bad("invalid amount", { code: "amount_invalid" });
    return x;
  }

  private estimate(b: Record<string, unknown>): [number, unknown] {
    const usd = this.usd(b.usd_value);
    if (b.blockchain !== "cardano")
      throw bad("unsupported blockchain", { code: "unsupported_blockchain" });
    const asset = b.asset ?? "ADA";
    if (asset !== "ADA" && asset !== "USDM")
      throw bad("unsupported asset", { code: "unsupported_asset" });
    if (usd < MIN_WITHDRAW_USD) {
      throw bad("withdrawal below minimum", { code: "below_minimum", minimum_usd: "5" });
    }
    const net = usd - WITHDRAW_FEE_USD;
    const receive = ((net * 1_000_000n) / this.rate(asset)).toString();
    return [
      200,
      {
        route: asset === "USDM" ? "direct_cardano_usdm" : "direct_cardano",
        is_relay: false,
        source_blockchain: "cardano",
        source_asset: asset,
        destination_blockchain: "cardano",
        destination_asset: asset,
        destination_asset_decimals: 6,
        estimated_receive: receive,
        estimated_receive_usd: usdString(net),
        minimum_receive: receive,
        withdraw_fee_usd: "1",
        network_cost_usd: "0",
        eta_seconds: 120,
        as_of: Math.floor(this.host.now() / 1000),
        ttl_seconds: 20,
      },
    ];
  }

  private withdrawQuote(w: WalletAccount, b: Record<string, unknown>): [number, unknown] {
    const usd = this.usd(b.usd_value);
    if (b.blockchain !== "cardano")
      throw bad("unsupported blockchain", { code: "unsupported_blockchain" });
    const asset = typeof b.asset === "string" && b.asset ? b.asset : "ADA";
    if (asset !== "ADA" && asset !== "USDM")
      throw bad("unsupported asset", { code: "unsupported_asset" });
    if (b.wallet_address !== undefined && b.wallet_address !== w.address) {
      throw new HttpError(403, { error: "access denied" });
    }
    if (usd < MIN_WITHDRAW_USD) {
      throw bad("withdrawal below minimum", { code: "below_minimum", minimum_usd: "5" });
    }
    if (usd > w.walletBalance) throw bad("withdrawal amount exceeds available balance");
    const utxos = this.opts.cardanoUtxos?.(w.address) ?? [];
    let txCbor: string | undefined;
    try {
      txCbor = buildPaymentTx({
        utxosHex: utxos,
        changeAddress: w.address,
        outputs: [{ address: this.validatorAddress, lovelace: 2_000_000n }],
        ttlSlot: Math.floor((this.host.now() + WITHDRAW_QUOTE_TTL_MS) / 1000) - SLOT_OFFSET_S,
      });
    } catch {
      throw bad("insufficient wallet funds", { code: "insufficient_wallet_funds" });
    }
    const withdrawId = randomUUID();
    const now = this.host.now();
    const stamp = new Date(now)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const text = [
      "Authorize withdrawal from Strike Perpetuals.",
      "",
      `Wallet: ${w.address}`,
      "Chain: cardano",
      `Amount: ${fmt(usd)} USD`,
      "Fee: 1 USD",
      `Timestamp: ${stamp} UTC`,
      `Withdraw ID: ${withdrawId}`,
    ].join("\n");
    const messageHex = utf8ToHex(text);
    this.withdrawals.set(withdrawId, {
      withdrawId,
      accountId: w.account.id,
      usd,
      asset,
      messageHex,
      txCbor,
      createdMs: now,
      used: false,
    });
    return [
      200,
      {
        withdraw_id: withdrawId,
        fee: "1",
        message_to_sign: messageHex,
        tx_cbor: txCbor,
        validator_address: this.validatorAddress,
        route: asset === "USDM" ? "direct_cardano_usdm" : "direct_cardano",
        source_blockchain: "cardano",
        source_asset: asset,
        destination_asset: asset,
      },
    ];
  }

  private confirmWithdraw(w: WalletAccount, b: Record<string, unknown>): [number, unknown] {
    if (typeof b.withdraw_id !== "string") throw bad("withdraw_id is required");
    if (typeof b.wallet_signature !== "string" || !b.wallet_signature) {
      throw bad("wallet_signature is required");
    }
    const q = this.withdrawals.get(b.withdraw_id);
    const failed = () => new HttpError(401, { error: "wallet signature verification failed" });
    if (!q || q.createdMs + WITHDRAW_QUOTE_TTL_MS <= this.host.now()) throw failed();
    if (q.accountId !== w.account.id) throw new HttpError(403, { error: "access denied" });
    if (q.used) throw bad("quote has already been used");
    const v = verifyCip8(b.wallet_signature, { address: w.address, payloadHex: q.messageHex });
    if (!v.ok) throw failed();
    if (q.txCbor !== undefined) {
      if (typeof b.signed_tx_cbor !== "string" || !b.signed_tx_cbor) {
        throw bad("signed_tx_cbor is required");
      }
      let ok = false;
      try {
        ok =
          rawBodyHex(b.signed_tx_cbor) === rawBodyHex(q.txCbor) &&
          verifiedSigners(b.signed_tx_cbor).includes(paymentKeyHashOf(w.address) ?? "");
      } catch {
        ok = false;
      }
      // VERIFY: Strike's error text for a funding tx that is not the quoted one or unsigned.
      if (!ok) throw bad("invalid signed_tx_cbor");
    }
    if (q.usd > w.walletBalance) throw bad("withdrawal amount exceeds available balance");
    q.used = true;
    w.walletBalance -= q.usd;
    this.balanceEvent(w, "WITHDRAWAL_PENDING");
    this.later(() => {
      this.events.push({
        kind: "withdrawal",
        accountId: w.account.id,
        usd: usdString(q.usd),
        atMs: this.host.now(),
      });
      this.balanceEvent(w, "WITHDRAWAL_SETTLED");
    });
    return [201, { request_id: q.withdrawId, status: "pending", ...this.host.ids() }];
  }

  private later(fn: () => void): void {
    this.pending += 1;
    setTimeout(() => {
      try {
        fn();
      } finally {
        this.pending -= 1;
      }
    }, this.opts.creditDelayMs ?? 0);
  }

  private balanceEvent(w: WalletAccount, kind: string): void {
    const t = this.host.now();
    const wb = usdString(w.walletBalance);
    this.host.emit(w.account.id, {
      e: "ACCOUNT_UPDATE",
      E: t,
      data: { e: kind, B: [{ a: "USDT", wb, cw: wb, bc: "0" }], P: [], r: "", E: t, T: t },
    });
  }
}
