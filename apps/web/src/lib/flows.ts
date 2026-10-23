import type {
  ConnectFinishWire,
  ConnectStartWire,
  ConsentFinishWire,
  HolderProofWire,
  MergeWire,
  SessionWire,
  SignRequestWire,
  TxSummaryWire,
} from "@ballast/api/holder-types";
import { type Cip30Api, isTxHash, signDataForStrike, utf8ToHex } from "@ballast/cardano/cip30";
import { bodySha256, holderProofMessage } from "@ballast/cardano/messages";

/**
 * The holder flows as the browser runs them, with the HTTP call and the wallet injected so the
 * same code runs in tests against a Node wallet. Each wallet prompt is one function call here;
 * nothing signs without the page calling it from a click.
 */
export type Post = <T>(path: string, body: unknown) => Promise<T>;

export interface WalletLike {
  api: Pick<Cip30Api, "signData" | "signTx" | "submitTx" | "getUtxos">;
  /** bech32, the address the session and the Strike account are bound to. */
  address: string;
}

/** A fresh holder proof for exactly this Strike request (≤ 60 s old when it arrives). */
export async function holderProof(
  wallet: WalletLike,
  accountId: string,
  path: string,
  body: unknown,
  nowMs: number = Date.now(),
): Promise<HolderProofWire> {
  const message = holderProofMessage({
    accountId,
    address: wallet.address,
    method: "POST",
    path,
    bodySha256: await bodySha256(body),
    issuedAtMs: nowMs,
    nonce: crypto.randomUUID(),
  });
  const payload = utf8ToHex(message);
  return { payload, signature: await signDataForStrike(wallet.api, wallet.address, payload) };
}

/** Signs a server-written message (sign-in, Builder Connect, consent) exactly as given. */
export function signRequest(wallet: WalletLike, req: SignRequestWire): Promise<string> {
  return signDataForStrike(wallet.api, wallet.address, req.payload);
}

export async function signIn(post: Post, wallet: WalletLike): Promise<SessionWire> {
  const ch = await post<SignRequestWire>("session/challenge", { address: wallet.address });
  return post<SessionWire>("session", {
    nonce: ch.nonce,
    signature: await signRequest(wallet, ch),
  });
}

export function startConnect(post: Post): Promise<ConnectStartWire> {
  return post<ConnectStartWire>("connect/start", {});
}

export async function finishConnect(
  post: Post,
  wallet: WalletLike,
  start: ConnectStartWire,
): Promise<ConnectFinishWire> {
  return post<ConnectFinishWire>("connect/finish", {
    nonce: start.nonce,
    signature: await signRequest(wallet, start),
  });
}

/** Strike's funding paths, as the holder proofs name them. */
const STRIKE_PATH = {
  "deposit/quote": "/v2/deposit/quote",
  "deposit/build": "/v2/deposit/build-tx",
  "deposit/confirm": "/v2/deposit",
  "withdraw/estimate": "/v2/withdraw/estimate",
  "withdraw/quote": "/v2/withdraw/quote",
  "withdraw/confirm": "/v2/withdraw",
} as const;
export type FundingRoute = keyof typeof STRIKE_PATH;

/** One funding call: the Strike body plus a holder proof for that body. */
export async function fund<T>(
  post: Post,
  wallet: WalletLike,
  accountId: string,
  route: FundingRoute,
  body: Record<string, unknown>,
): Promise<T> {
  const proof = await holderProof(wallet, accountId, STRIKE_PATH[route], body);
  return post<T>(route, { body, proof });
}

export interface DepositQuoteWire {
  request_id: string;
  quote: { usd_value: string; exchange_rate: string; expiration_at: number };
  deposit_address: string;
}

export interface PreparedDeposit {
  quote: DepositQuoteWire;
  unsignedTx: string;
  summary: TxSummaryWire;
  expiresAtMs: number | null;
}

/** Quote and build: two proofs. Returns the unsigned tx and what it does, before any signTx. */
export async function prepareDeposit(
  post: Post,
  wallet: WalletLike,
  accountId: string,
  asset: "ADA" | "USDM",
  amountBase: string,
): Promise<PreparedDeposit> {
  const quote = await fund<DepositQuoteWire>(post, wallet, accountId, "deposit/quote", {
    blockchain: "cardano",
    asset_symbol: asset,
    asset_amount: amountBase,
  });
  const utxos = (await wallet.api.getUtxos()) ?? [];
  if (utxos.length === 0) throw new Error("the wallet reports no spendable UTxOs");
  const built = await fund<{ unsigned_tx: string; summary: TxSummaryWire; expires_at?: number }>(
    post,
    wallet,
    accountId,
    "deposit/build",
    { request_id: quote.request_id, user_address: wallet.address, utxos },
  );
  return {
    quote,
    unsignedTx: built.unsigned_tx,
    summary: built.summary,
    expiresAtMs: built.expires_at ?? null,
  };
}

/** signTx(partial) → merge (body unchanged) → the wallet submits → confirm with the tx hash. */
export async function completeDeposit(
  post: Post,
  wallet: WalletLike,
  accountId: string,
  prepared: PreparedDeposit,
): Promise<{ txHash: string }> {
  const witnessSet = await wallet.api.signTx(prepared.unsignedTx, true);
  const merged = await post<MergeWire>("tx/merge", { tx: prepared.unsignedTx, witnessSet });
  if (merged.txHash !== prepared.summary.txHash) {
    throw new Error("the merged transaction is not the one Strike built");
  }
  const submitted = (await wallet.api.submitTx(merged.tx)).toLowerCase();
  if (!isTxHash(submitted) || submitted !== merged.txHash) {
    throw new Error(`the wallet submitted ${submitted}, not ${merged.txHash}`);
  }
  await fund(post, wallet, accountId, "deposit/confirm", {
    request_id: prepared.quote.request_id,
    tx_hash: submitted,
  });
  return { txHash: submitted };
}

export interface WithdrawQuoteWire {
  withdraw_id: string;
  fee: string;
  message_to_sign: string;
  message: string | null;
  tx_cbor?: string;
  summary: TxSummaryWire | null;
}

export interface PreparedWithdrawal {
  estimate: Record<string, unknown>;
  quote: WithdrawQuoteWire;
}

export async function prepareWithdrawal(
  post: Post,
  wallet: WalletLike,
  accountId: string,
  asset: "ADA" | "USDM",
  usdValue: string,
): Promise<PreparedWithdrawal> {
  const base = { usd_value: usdValue, blockchain: "cardano", asset };
  const estimate = await fund<Record<string, unknown>>(
    post,
    wallet,
    accountId,
    "withdraw/estimate",
    base,
  );
  const quote = await fund<WithdrawQuoteWire>(post, wallet, accountId, "withdraw/quote", {
    ...base,
    wallet_address: wallet.address,
  });
  return { estimate, quote };
}

/**
 * The message is already hex for Cardano and is signed as-is; the funding tx (if any) is signed,
 * merged and handed to Strike, which submits it. Then the confirm, with its own proof.
 */
export async function completeWithdrawal(
  post: Post,
  wallet: WalletLike,
  accountId: string,
  prepared: PreparedWithdrawal,
): Promise<{ withdrawId: string }> {
  const q = prepared.quote;
  const wallet_signature = await signDataForStrike(wallet.api, wallet.address, q.message_to_sign);
  let signed_tx_cbor: string | undefined;
  if (q.tx_cbor) {
    const witnessSet = await wallet.api.signTx(q.tx_cbor, true);
    signed_tx_cbor = (await post<MergeWire>("tx/merge", { tx: q.tx_cbor, witnessSet })).tx;
  }
  await fund(post, wallet, accountId, "withdraw/confirm", {
    withdraw_id: q.withdraw_id,
    wallet_signature,
    ...(signed_tx_cbor ? { signed_tx_cbor } : {}),
  });
  return { withdrawId: q.withdraw_id };
}

/** The server writes the consent text, so the page can show it before the wallet does. */
export function startConsent(
  post: Post,
  rBps: number,
  maxShortNight: string,
): Promise<SignRequestWire> {
  return post<SignRequestWire>("consent/start", { rBps, maxShortNight });
}

export async function finishConsent(
  post: Post,
  wallet: WalletLike,
  req: SignRequestWire,
): Promise<ConsentFinishWire> {
  return post<ConsentFinishWire>("consent/finish", {
    nonce: req.nonce,
    signature: await signRequest(wallet, req),
  });
}
