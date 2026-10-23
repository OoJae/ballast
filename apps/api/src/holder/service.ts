import { createHash } from "node:crypto";
import {
  consentMessage,
  GEOFENCE_STATEMENT,
  hexToUtf8,
  mergeWalletWitnesses,
  parseStrikeSignature,
  RESTRICTED_LIST_URL,
  RISK_DISCLOSURE,
  summarizeTx,
  toStrikeSignature,
  txHashOf,
  verifyCip8,
  WitnessMergeError,
} from "@ballast/cardano";
import { type CoverProof, MAX_R_BPS } from "@ballast/cover";
import { AccountBindingError, type EvidenceDb } from "@ballast/evidence/db";
import type { SealedKey } from "@ballast/governance";
import {
  apiTimeSource,
  createPublicHttp,
  ServerClock,
  StrikeApiError,
  StrikeRefusedError,
  StrikeTransportError,
} from "@ballast/strike-client";
import {
  BuilderConnectClient,
  foreignActivity,
  HolderPresentClient,
} from "@ballast/strike-client/funding";
import type {
  AccountCheckWire,
  ConnectFinishWire,
  ConnectStartWire,
  ConsentFinishWire,
  CoverWire,
  FundingMode,
  MergeWire,
  MeWire,
  SessionWire,
  SignRequestWire,
} from "../holder-types.js";
import { HolderError } from "./errors.js";
import type { HolderKeyStore } from "./keystore.js";
import { type HolderSession, HolderSessions, PendingSignatures } from "./sessions.js";

/**
 * The holder role (plan §7): sessions, Builder Connect, funding and consent for one holder at a
 * time, each step signed by the holder's own wallet. This process never holds funds and never
 * quotes: it proxies Builder Connect with a key it generates and seals, and forwards funding
 * requests through the HOLDER_PRESENT profile, which refuses anything without a fresh proof.
 */
export interface CoverReader {
  proof(stakeAddress: string): Promise<CoverProof>;
}

export interface HolderServiceDeps {
  strikeUrl: string;
  userAgent: string;
  builderCode: string;
  feeShareBps: number;
  fundingMode: FundingMode;
  network: "mainnet" | "testnet";
  domain: string;
  db: EvidenceDb;
  keys: HolderKeyStore;
  cover?: CoverReader;
  fetch?: typeof fetch;
  now?: () => number;
  /** Structured, secret-free events for the log. */
  onEvent?: (event: string, fields: Record<string, unknown>) => void;
}

export type FundingStep =
  | "deposit/quote"
  | "deposit/build"
  | "deposit/confirm"
  | "withdraw/estimate"
  | "withdraw/quote"
  | "withdraw/confirm";

interface PendingConnect {
  sealed: SealedKey;
  publicKeyHex: string;
  address: string;
  stakeAddress: string;
  accountBefore: 404 | 200;
}

interface PendingConsent {
  accountId: string;
  stakeAddress: string;
  rBps: number;
  maxShortBase: bigint;
  feeShareBps: number;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export const GEOFENCE_SHA256 = sha256(GEOFENCE_STATEMENT);
export const RISK_SHA256 = sha256(RISK_DISCLOSURE);

/** Strike errors that are about this request, not about API wallets being allowed to fund. */
const ORDINARY_401 = new Set([
  "wallet signature verification failed",
  "signature expired or invalid timestamp",
  "request already processed",
  "nonce already used",
  "authentication failed",
  "wallet expired or revoked",
]);

function record(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new HolderError(400, `${what} must be a JSON object`);
  }
  return v as Record<string, unknown>;
}

function nightToBase(text: unknown): bigint {
  const m = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(String(text ?? "").trim());
  if (!m) throw new HolderError(400, "max short must be a NIGHT amount with at most 6 decimals");
  return BigInt(m[1] as string) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

export class HolderService {
  readonly sessions: HolderSessions;
  private readonly now: () => number;
  private readonly connect: BuilderConnectClient;
  private readonly clock: ServerClock;
  private readonly connects: PendingSignatures<PendingConnect>;
  private readonly consents: PendingSignatures<PendingConsent>;
  private readonly clients = new Map<string, HolderPresentClient>();

  constructor(private readonly deps: HolderServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.sessions = new HolderSessions({
      now: this.now,
      domain: deps.domain,
      network: deps.network,
    });
    const net = {
      baseUrl: deps.strikeUrl,
      userAgent: deps.userAgent,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    };
    this.connect = new BuilderConnectClient(net);
    this.clock = new ServerClock({
      fetchServerTimeMs: apiTimeSource(createPublicHttp({ ...net, maxRetries: 1 })),
      samples: 3,
      now: this.now,
    });
    // Strike's challenge lives 5 minutes; Ballast's own copy dies a little earlier.
    this.connects = new PendingSignatures(this.now, 4.5 * 60_000);
    this.consents = new PendingSignatures(this.now, 5 * 60_000);
  }

  private event(name: string, fields: Record<string, unknown>): void {
    this.deps.onEvent?.(name, fields);
  }

  challenge(body: unknown): SignRequestWire {
    return this.sessions.challenge(record(body, "body").address);
  }

  signIn(body: unknown): SessionWire {
    const b = record(body, "body");
    const s = this.sessions.signIn(
      b.nonce,
      b.signature,
      (stake) => this.deps.db.accountByStake(stake)?.accountId ?? null,
    );
    this.event("holder.sign-in", { accountId: s.accountId });
    return s;
  }

  // ---- geofence and account checks -----------------------------------------------------------

  /** The holder's own statement, stored with its hash; no IP or location is looked at. */
  attest(s: HolderSession, body: unknown): { attestedAtMs: number } {
    const b = record(body, "body");
    if (b.attest !== true || b.statementSha256 !== GEOFENCE_SHA256) {
      throw new HolderError(400, "attest to the exact restricted-jurisdiction statement shown");
    }
    const attestedAtMs = this.now();
    this.deps.db.insertAttestation({
      stakeCred: s.stakeAddress,
      address: s.address,
      kind: "geofence",
      statementHash: GEOFENCE_SHA256,
      listUrl: RESTRICTED_LIST_URL,
      attestedAtMs,
    });
    return { attestedAtMs };
  }

  async accountCheck(s: HolderSession): Promise<AccountCheckWire> {
    const lookup = await this.strike(() => this.connect.accountByAddress(s.address));
    const bound = this.deps.db.accountByStake(s.stakeAddress);
    if (lookup.status === 404) {
      return { status: 404, accountId: null, foreign: [], boundToYou: false };
    }
    const boundToYou = bound?.accountId === lookup.account.account_id;
    return {
      status: 200,
      accountId: lookup.account.account_id,
      // Ballast's own account may carry Ballast's margin; only a new binding must be clean.
      foreign: boundToYou ? [] : foreignActivity(lookup.account),
      boundToYou,
    };
  }

  // ---- Builder Connect -----------------------------------------------------------------------

  async connectStart(s: HolderSession): Promise<ConnectStartWire> {
    if (this.deps.db.attestations(s.stakeAddress).length === 0) {
      throw new HolderError(409, "attest the restricted-jurisdiction statement first");
    }
    const check = await this.accountCheck(s);
    if (check.foreign.length > 0) {
      throw new HolderError(
        409,
        `this Strike account is not dedicated (${check.foreign.join("; ")}): connect a fresh wallet account`,
      );
    }
    const bound = this.deps.db.accountByStake(s.stakeAddress);
    if (bound && check.status === 200 && !check.boundToYou) {
      throw new HolderError(409, "this stake key is bound to a different Strike account");
    }
    const { publicKeyHex, sealed } = this.deps.keys.generate(this.now());
    const ch = await this.strike(() =>
      this.connect.requestSignature({
        address: s.address,
        chain: "cardano",
        code: this.deps.builderCode,
        fee_share_bps: this.deps.feeShareBps,
        public_key: publicKeyHex,
      }),
    );
    const req = this.connects.add(
      ch.message_to_sign,
      {
        sealed,
        publicKeyHex,
        address: s.address,
        stakeAddress: s.stakeAddress,
        accountBefore: check.status,
      },
      ch.nonce,
    );
    this.event("holder.connect.start", { apiPublicKey: publicKeyHex, accountBefore: check.status });
    return {
      ...req,
      apiPublicKey: publicKeyHex,
      builderCode: this.deps.builderCode,
      feeShareBps: this.deps.feeShareBps,
      accountBefore: check.status,
    };
  }

  async connectFinish(s: HolderSession, body: unknown): Promise<ConnectFinishWire> {
    const b = record(body, "body");
    const { req, data } = this.connects.take(b.nonce);
    if (data.address !== s.address)
      throw new HolderError(403, "that challenge belongs to another wallet");
    let signature: string;
    try {
      signature = toStrikeSignature(parseStrikeSignature(String(b.signature ?? "")));
    } catch (err) {
      throw new HolderError(400, err instanceof Error ? err.message : "unreadable signature");
    }
    // Checked here first: Strike burns the challenge on any attempt, good or bad.
    const v = verifyCip8(signature, { address: s.address, payloadHex: req.payload });
    if (!v.ok) throw new HolderError(401, `the wallet signature does not verify: ${v.reason}`);
    const r = await this.strike(() =>
      this.connect.verifySignature(
        { nonce: req.nonce, wallet_signature: signature },
        data.publicKeyHex,
      ),
    );
    const now = this.now();
    const bound = this.deps.db.accountByStake(s.stakeAddress);
    if (bound && bound.accountId !== r.account_id) {
      throw new HolderError(
        409,
        "Strike returned a different account than the one bound to this stake key",
      );
    }
    if (!bound) {
      try {
        this.deps.db.bindAccount({
          accountId: r.account_id,
          stakeCred: s.stakeAddress,
          nowMs: now,
        });
      } catch (err) {
        if (err instanceof AccountBindingError) throw new HolderError(409, err.message);
        throw err;
      }
    }
    const keyPath = this.deps.keys.persist(r.account_id, data.sealed);
    this.deps.db.rotateHolderWallet({
      publicKey: data.publicKeyHex,
      accountId: r.account_id,
      address: s.address,
      keyPath,
      createdAtMs: now,
    });
    this.clients.delete(r.account_id);
    s.accountId = r.account_id;
    const after = await this.strike(() => this.connect.accountByAddress(s.address));
    this.event("holder.connect.finish", {
      accountId: r.account_id,
      apiPublicKey: data.publicKeyHex,
      before: data.accountBefore,
      after: after.status,
    });
    return {
      accountId: r.account_id,
      apiPublicKey: data.publicKeyHex,
      builderCode: r.builder_code,
      feeShareBps: r.fee_share_bps,
      flip: { before: data.accountBefore, after: after.status, checkedAtMs: this.now() },
    };
  }

  // ---- funding (HOLDER_PRESENT) --------------------------------------------------------------

  private account(s: HolderSession): string {
    if (!s.accountId) throw new HolderError(409, "connect your Strike account first");
    return s.accountId;
  }

  private async client(s: HolderSession): Promise<HolderPresentClient> {
    const accountId = this.account(s);
    const wallet = this.deps.db.activeHolderWallet(accountId);
    if (!wallet) throw new HolderError(409, "this account has no API wallet: connect again");
    if (!this.clock.synced || this.clock.ageMs() > 300_000) {
      try {
        await this.clock.sync();
      } catch {
        throw new HolderError(504, "cannot read Strike's clock (GET /v2/time); nothing was sent");
      }
    }
    let c = this.clients.get(accountId);
    if (!c) {
      c = new HolderPresentClient({
        baseUrl: this.deps.strikeUrl,
        userAgent: this.deps.userAgent,
        signer: this.deps.keys.signer(wallet.keyPath),
        clock: this.clock,
        accountId,
        holderAddress: wallet.address,
        now: this.now,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      });
      this.clients.set(accountId, c);
    }
    return c;
  }

  async funding(s: HolderSession, step: FundingStep, body: unknown): Promise<unknown> {
    if (this.deps.fundingMode === "strike-app") {
      throw new HolderError(
        409,
        "in-app funding is off here: deposit and withdraw in Strike's own app",
        {
          fallback: "strike-app",
        },
      );
    }
    const b = record(body, "body");
    const req = record(b.body, "body.body");
    const proof = b.proof;
    const c = await this.client(s);
    const accountId = this.account(s);
    const now = this.now();
    const previous = (id: unknown) =>
      this.deps.db.fundingEvents(accountId).find((e) => e.requestId === id);
    const first =
      step === "deposit/quote" || step === "withdraw/estimate" || step === "withdraw/quote";
    const run = <T>(fn: () => Promise<T>) => this.strike(fn, first);
    switch (step) {
      case "deposit/quote": {
        const r = await run(() => c.depositQuote(req, proof));
        this.deps.db.recordFunding({
          accountId,
          kind: "deposit",
          requestId: r.request_id,
          asset: req.asset_symbol as "ADA" | "USDM",
          amountBase: String(req.asset_amount),
          usdValue: r.quote?.usd_value ?? null,
          txHash: null,
          status: "quoted",
          nowMs: now,
        });
        return r;
      }
      case "deposit/build": {
        const r = await run(() => c.depositBuildTx(req, proof));
        const prev = previous(req.request_id);
        this.deps.db.recordFunding({
          accountId,
          kind: "deposit",
          requestId: String(req.request_id),
          asset: prev?.asset ?? "ADA",
          amountBase: null,
          usdValue: null,
          txHash: null,
          status: "built",
          nowMs: now,
        });
        return { ...r, summary: summarizeTx(r.unsigned_tx) };
      }
      case "deposit/confirm": {
        const r = await run(() => c.depositConfirm(req, proof));
        const prev = previous(req.request_id);
        this.deps.db.recordFunding({
          accountId,
          kind: "deposit",
          requestId: String(req.request_id),
          asset: prev?.asset ?? "ADA",
          amountBase: null,
          usdValue: null,
          txHash: String(req.tx_hash),
          status: "submitted",
          nowMs: now,
        });
        this.event("holder.deposit.confirm", { accountId, txHash: req.tx_hash });
        return r;
      }
      case "withdraw/estimate":
        return run(() => c.withdrawEstimate(req, proof));
      case "withdraw/quote": {
        const q = await run(() => c.withdrawQuote(req, proof));
        this.deps.db.recordFunding({
          accountId,
          kind: "withdrawal",
          requestId: q.withdraw_id,
          asset: req.asset as "ADA" | "USDM",
          amountBase: null,
          usdValue: String(req.usd_value),
          txHash: null,
          status: "quoted",
          nowMs: now,
        });
        let message: string | null = null;
        try {
          message = hexToUtf8(q.message_to_sign);
        } catch {
          message = null;
        }
        return { ...q, message, summary: q.tx_cbor ? summarizeTx(q.tx_cbor) : null };
      }
      case "withdraw/confirm": {
        const r = await run(() => c.withdrawConfirm(req, proof));
        const prev = previous(req.withdraw_id);
        // The funding tx the holder signed (Strike submits it); the payout comes from the vault.
        const fundingTx =
          typeof req.signed_tx_cbor === "string" ? txHashOf(req.signed_tx_cbor) : null;
        this.deps.db.recordFunding({
          accountId,
          kind: "withdrawal",
          requestId: String(req.withdraw_id),
          asset: prev?.asset ?? "ADA",
          amountBase: null,
          usdValue: null,
          txHash: fundingTx,
          status: "submitted",
          nowMs: now,
        });
        this.event("holder.withdraw.confirm", { accountId, withdrawId: req.withdraw_id });
        return r;
      }
    }
  }

  /** Adds the wallet's witness set to a transaction without touching its body (FixedTransaction). */
  merge(_s: HolderSession, body: unknown): MergeWire {
    const b = record(body, "body");
    if (typeof b.tx !== "string" || typeof b.witnessSet !== "string") {
      throw new HolderError(400, "tx and witnessSet must be hex strings");
    }
    try {
      const m = mergeWalletWitnesses(b.tx.toLowerCase(), b.witnessSet.toLowerCase());
      return { tx: m.txHex, txHash: m.txHash };
    } catch (err) {
      if (err instanceof WitnessMergeError) throw new HolderError(400, err.message);
      throw new HolderError(400, "not a transaction and witness set this server can merge");
    }
  }

  // ---- consent and stop ----------------------------------------------------------------------

  consentStart(s: HolderSession, body: unknown): SignRequestWire {
    const accountId = this.account(s);
    const b = record(body, "body");
    const rBps = b.rBps;
    if (typeof rBps !== "number" || !Number.isInteger(rBps) || rBps < 1 || rBps > MAX_R_BPS) {
      throw new HolderError(400, `r must be an integer from 1 to ${MAX_R_BPS} bps (at most 0.9)`);
    }
    const maxShortBase = nightToBase(b.maxShortNight);
    if (maxShortBase <= 0n) throw new HolderError(400, "max short must be more than zero");
    const data: PendingConsent = {
      accountId,
      stakeAddress: s.stakeAddress,
      rBps,
      maxShortBase,
      feeShareBps: this.deps.feeShareBps,
    };
    const nonce = crypto.randomUUID();
    const message = consentMessage({
      accountId,
      address: s.address,
      stakeAddress: s.stakeAddress,
      rBps,
      maxShortBase,
      feeShareBps: this.deps.feeShareBps,
      riskSha256: RISK_SHA256,
      nonce,
      issuedAtMs: this.now(),
    });
    return this.consents.add(message, data, nonce);
  }

  consentFinish(s: HolderSession, body: unknown): ConsentFinishWire {
    const b = record(body, "body");
    const { req, data } = this.consents.take(b.nonce);
    if (data.stakeAddress !== s.stakeAddress || data.accountId !== s.accountId) {
      throw new HolderError(403, "that consent belongs to another wallet");
    }
    const v = verifyCip8(String(b.signature ?? ""), {
      address: s.address,
      payloadHex: req.payload,
    });
    if (!v.ok) throw new HolderError(401, `the consent signature does not verify: ${v.reason}`);
    const signedAtMs = this.now();
    const hash = sha256(req.message);
    this.deps.db.recordConsent({
      hash,
      accountId: data.accountId,
      stakeCred: data.stakeAddress,
      rBps: data.rBps,
      maxShortBase: data.maxShortBase.toString(),
      feeShareBps: data.feeShareBps,
      signatureHash: sha256(String(b.signature)),
      signedAtMs,
    });
    this.event("holder.consent", { accountId: data.accountId, hash, rBps: data.rBps });
    return { hash, rBps: data.rBps, maxShortBase: data.maxShortBase.toString(), signedAtMs };
  }

  /**
   * Stop: the account is paused, so the keeper arms nothing for it. Nothing rests in this
   * milestone; once the keeper runs (M7), Stop also cancels every Ballast order first.
   */
  stop(s: HolderSession): { status: "paused" } {
    const accountId = this.account(s);
    this.deps.db.setAccountStatus(accountId, "paused", "stopped by the holder", this.now());
    this.event("holder.stop", { accountId });
    return { status: "paused" };
  }

  // ---- reads ---------------------------------------------------------------------------------

  async me(s: HolderSession): Promise<MeWire> {
    const accountId = s.accountId;
    const acct = accountId ? this.deps.db.account(accountId) : null;
    const consent = accountId ? this.deps.db.latestConsent(accountId) : null;
    const wallet = accountId ? this.deps.db.activeHolderWallet(accountId) : null;
    const attestations = this.deps.db.attestations(s.stakeAddress);
    const [strike, cover] = await Promise.all([this.strikeRead(s), this.coverRead(s)]);
    return {
      address: s.address,
      stakeAddress: s.stakeAddress,
      accountId,
      account: acct
        ? {
            status: acct.status,
            rBps: acct.rBps,
            pausedReason: acct.pausedReason,
            manualActivity: acct.manualActivity,
          }
        : null,
      attestedAtMs: attestations.at(-1)?.attestedAtMs ?? null,
      consent: consent
        ? {
            hash: consent.hash,
            rBps: consent.rBps,
            maxShortBase: consent.maxShortBase,
            signedAtMs: consent.signedAtMs,
          }
        : null,
      apiWallet: wallet ? { publicKey: wallet.publicKey, createdAtMs: wallet.createdAtMs } : null,
      funding: accountId
        ? this.deps.db.fundingEvents(accountId).map(({ accountId: _a, ...e }) => e)
        : [],
      fundingMode: this.deps.fundingMode,
      strike,
      cover: cover.cover,
      coverStatus: cover.status,
      armed: false,
    };
  }

  private async strikeRead(s: HolderSession): Promise<MeWire["strike"]> {
    try {
      const r = await this.connect.accountByAddress(s.address);
      return r.status === 404
        ? { status: 404, walletBalance: null }
        : { status: 200, walletBalance: r.account.wallet_balance ?? null };
    } catch {
      return null;
    }
  }

  private async coverRead(
    s: HolderSession,
  ): Promise<{ cover: CoverWire | null; status: MeWire["coverStatus"] }> {
    if (!this.deps.cover) return { cover: null, status: "not-configured" };
    try {
      const p = await this.deps.cover.proof(s.stakeAddress);
      return {
        status: "ok",
        cover: {
          stakeAddress: s.stakeAddress,
          coverBase: p.coverBase,
          height: p.height,
          tipHash: p.tipHash,
          checkedAtMs: p.checkedAtMs,
          utxos: p.utxos.length,
          excluded: p.excluded.length,
          proofHash: p.hash,
        },
      };
    } catch {
      return { cover: null, status: "unavailable" };
    }
  }

  /** Maps Strike-side failures to answers the page can show and act on. */
  private async strike<T>(fn: () => Promise<T>, firstFundingStep = false): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StrikeRefusedError) {
        throw new HolderError(
          err.kind === "holder-proof" ? 403 : 400,
          `refused before sending: ${err.reason}`,
        );
      }
      if (err instanceof StrikeApiError) {
        const strike = { status: err.status, error: err.code || err.body.slice(0, 200) };
        if (
          firstFundingStep &&
          (err.status === 401 || err.status === 403) &&
          !ORDINARY_401.has(err.code)
        ) {
          // D5/D9 decide this: if Strike keeps API wallets off funding routes, fund in its app.
          throw new HolderError(
            502,
            "Strike refused API-wallet funding for this account: deposit or withdraw in Strike's own app",
            { fallback: "strike-app", strike },
          );
        }
        throw new HolderError(
          err.status === 409 ? 409 : 502,
          `Strike answered ${err.status}: ${strike.error}`,
          {
            strike,
          },
        );
      }
      if (err instanceof StrikeTransportError) {
        throw new HolderError(504, "Strike did not answer; nothing was retried");
      }
      throw err;
    }
  }
}
