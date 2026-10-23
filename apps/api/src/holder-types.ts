/**
 * Wire types of the holder routes (`/api/holder/*`, enabled only with HOLDER_ROUTES=1). Shared
 * with the web app, so this file imports nothing. Unlike the public API these responses carry
 * the signed-in holder's own address and account, and only to that holder's session.
 */

export interface HolderProofWire {
  /** hex(utf8(holder proof message)). */
  payload: string;
  /** `coseSign1Hex:coseKeyHex`. */
  signature: string;
}

/** A message for the wallet to sign: the text to show and the exact hex payload. */
export interface SignRequestWire {
  nonce: string;
  message: string;
  payload: string;
  expiresAtMs: number;
}

export interface SessionWire {
  token: string;
  expiresAtMs: number;
  address: string;
  stakeAddress: string;
  accountId: string | null;
}

export interface AccountCheckWire {
  /** Strike's `GET /v2/account?blockchain_address=`: 404 means no account yet. */
  status: 404 | 200;
  accountId: string | null;
  /** Non-empty means the account is not dedicated: Ballast refuses it. */
  foreign: string[];
  /** The account is already bound to this wallet's stake key in Ballast. */
  boundToYou: boolean;
}

export interface ConnectStartWire extends SignRequestWire {
  /** The public half of the API wallet Ballast generated and sealed. */
  apiPublicKey: string;
  builderCode: string;
  feeShareBps: number;
  accountBefore: 404 | 200;
}

export interface ConnectFinishWire {
  accountId: string;
  apiPublicKey: string;
  builderCode: string;
  feeShareBps: number;
  /** The proof that Builder Connect worked: Strike's answer before and after. */
  flip: { before: 404 | 200; after: 404 | 200; checkedAtMs: number };
}

export interface TxOutputWire {
  address: string;
  lovelace: string;
  assets: { policyId: string; assetNameHex: string; quantity: string }[];
}

export interface TxSummaryWire {
  txHash: string;
  feeLovelace: string;
  ttlSlot: string | null;
  validFromSlot: string | null;
  inputs: string[];
  outputs: TxOutputWire[];
  requiredSigners: string[];
  vkeyWitnesses: number;
}

export interface MergeWire {
  tx: string;
  txHash: string;
}

export type FundingMode = "api-wallet" | "strike-app";

export interface FundingEventWire {
  kind: "deposit" | "withdrawal";
  requestId: string;
  asset: "ADA" | "USDM";
  amountBase: string | null;
  usdValue: string | null;
  txHash: string | null;
  status: "quoted" | "built" | "submitted" | "confirmed" | "failed";
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CoverWire {
  stakeAddress: string;
  /** Pinned NIGHT in base units (6 decimals). */
  coverBase: string;
  height: number;
  tipHash: string;
  checkedAtMs: number;
  utxos: number;
  excluded: number;
  proofHash: string;
}

export interface MeWire {
  address: string;
  stakeAddress: string;
  accountId: string | null;
  account: {
    status: "onboarding" | "active" | "paused" | "closed";
    rBps: number;
    pausedReason: string | null;
    manualActivity: boolean;
  } | null;
  attestedAtMs: number | null;
  consent: { hash: string; rBps: number; maxShortBase: string; signedAtMs: number } | null;
  apiWallet: { publicKey: string; createdAtMs: number } | null;
  funding: FundingEventWire[];
  fundingMode: FundingMode;
  /** Strike's public account read for this wallet, or null when it could not be read. */
  strike: { status: 404 | 200; walletBalance: string | null } | null;
  cover: CoverWire | null;
  coverStatus: "ok" | "not-configured" | "unavailable";
  /** Live arming is not part of this milestone. */
  armed: false;
}

export interface ConsentFinishWire {
  hash: string;
  rBps: number;
  maxShortBase: string;
  signedAtMs: number;
}

/** A refusal that the UI can act on: `fallback` names the Strike-app funding path. */
export interface HolderErrorWire {
  error: string;
  fallback?: "strike-app";
  strike?: { status: number; error: string };
}
