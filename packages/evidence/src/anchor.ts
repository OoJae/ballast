import { canonicalize, sha256Hex } from "@ballast/core";
import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import { merkleRootHex } from "./merkle.js";

/**
 * Daily CIP-20 anchor (§6): metadata label 674, `msg` = [root hex, first/last seq, segment
 * count]. CIP-20 caps each metadata string at 64 bytes, so every string is split on UTF-8
 * boundaries into consecutive entries. This module builds and signs the transaction offline;
 * nothing here submits anything.
 */
export const CIP20_LABEL = 674;
export const CIP20_MAX_BYTES = 64;

/** Splits text into ≤ maxBytes UTF-8 chunks without cutting a code point. */
export function chunkUtf8(text: string, maxBytes = CIP20_MAX_BYTES): string[] {
  if (maxBytes < 4) throw new RangeError("a chunk must fit any code point (4 bytes)");
  if (text === "") return [""];
  const chunks: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (curBytes + n > maxBytes) {
      chunks.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += n;
  }
  chunks.push(cur);
  return chunks;
}

export interface AnchorPayload {
  root: string;
  firstSeq: number;
  lastSeq: number;
  segmentCount: number;
}

function payloadIssues(p: AnchorPayload): string[] {
  const issues: string[] = [];
  if (!/^[0-9a-f]{64}$/.test(p.root)) issues.push("root must be 64 lowercase hex");
  if (!Number.isSafeInteger(p.firstSeq) || p.firstSeq < 1) issues.push("firstSeq must be ≥ 1");
  if (!Number.isSafeInteger(p.lastSeq) || p.lastSeq < p.firstSeq)
    issues.push("lastSeq must be ≥ firstSeq");
  if (!Number.isSafeInteger(p.segmentCount) || p.segmentCount < 0) issues.push("bad segmentCount");
  return issues;
}

/** The three logical CIP-20 lines, each split into ≤ 64-byte entries. */
export function anchorMessage(p: AnchorPayload): string[] {
  const issues = payloadIssues(p);
  if (issues.length > 0) throw new TypeError(`bad anchor payload: ${issues.join("; ")}`);
  return [p.root, `seq ${p.firstSeq}-${p.lastSeq}`, `segments ${p.segmentCount}`].flatMap((s) =>
    chunkUtf8(s),
  );
}

export function cip20Metadata(p: AnchorPayload): { [CIP20_LABEL]: { msg: string[] } } {
  return { [CIP20_LABEL]: { msg: anchorMessage(p) } };
}

/** Reads an anchor back from a transaction's metadata (Koios tx_metadata shape). */
export function parseCip20Anchor(
  metadata: Record<string, unknown> | null | undefined,
): AnchorPayload | null {
  const entry = metadata?.[String(CIP20_LABEL)] as { msg?: unknown } | undefined;
  const msg = entry?.msg;
  if (!Array.isArray(msg) || msg.some((m) => typeof m !== "string")) return null;
  const [root, seq, segs] = msg as string[];
  const s = /^seq (\d+)-(\d+)$/.exec(seq ?? "");
  const g = /^segments (\d+)$/.exec(segs ?? "");
  if (!root || !s || !g || msg.length !== 3) return null;
  const p = { root, firstSeq: Number(s[1]), lastSeq: Number(s[2]), segmentCount: Number(g[1]) };
  return payloadIssues(p).length === 0 ? p : null;
}

/**
 * The anchored root: an RFC 6962 tree over two leaves, the decision records' root (their hashes
 * in seq order) and the recorder segments' root (their sha256s in manifest order). A verifier
 * recomputes both from the bundle and the recordings.
 */
export function anchorRoots(decisionHashes: readonly string[], segmentHashes: readonly string[]) {
  const decisionsRoot = merkleRootHex(decisionHashes);
  const segmentsRoot = merkleRootHex(segmentHashes);
  return { decisionsRoot, segmentsRoot, root: merkleRootHex([decisionsRoot, segmentsRoot]) };
}

/**
 * The `inputsDigest` of the signed "anchor" decision that commits to an anchor record: every
 * field except `txHash`, which is only known after submission (and is checked on chain).
 */
export function anchorRecordDigest<T extends { txHash?: string | null }>(record: T): string {
  const { txHash: _later, ...committed } = record;
  return sha256Hex(canonicalize(committed));
}

/** Protocol parameters the fee and min-UTxO math needs (from Koios `epoch_params`). */
export interface ProtocolParams {
  minFeeA: number;
  minFeeB: number;
  maxTxSize: number;
  maxValueSize: number;
  keyDeposit: bigint;
  poolDeposit: bigint;
  coinsPerUtxoByte: bigint;
  refScriptCostPerByte: number;
}

/** preprod epoch 321 and mainnet epoch 663, read from Koios epoch_params on 2026-10-23. */
export const PREPROD_PARAMS: ProtocolParams = {
  minFeeA: 44,
  minFeeB: 155_381,
  maxTxSize: 16_384,
  maxValueSize: 5_000,
  keyDeposit: 2_000_000n,
  poolDeposit: 500_000_000n,
  coinsPerUtxoByte: 4_310n,
  refScriptCostPerByte: 15,
};
export const MAINNET_PARAMS: ProtocolParams = { ...PREPROD_PARAMS };

export interface AnchorUtxo {
  txHash: string;
  index: number;
  address: string;
  lovelace: bigint;
  assets?: { policyId: string; assetNameHex: string; quantity: bigint }[];
}

/** Anything that can lend a 32-byte Ed25519 seed synchronously (AnchorWalletKey does). */
export interface SeedLender {
  readonly role?: string;
  useSeed<T>(fn: (seed: Uint8Array) => T): T;
}

export interface AnchorTxInput {
  network: "preprod" | "mainnet";
  utxos: readonly AnchorUtxo[];
  /** The anchor wallet's own enterprise or base address: inputs and change both live here. */
  changeAddress: string;
  signingKey: SeedLender;
  payload: AnchorPayload;
  params: ProtocolParams;
  /** Absolute slot after which the transaction is invalid (recommended). */
  ttlSlot?: number;
}

export interface BuiltAnchorTx {
  txHex: string;
  txHash: string;
  feeLovelace: bigint;
  inputs: string[];
  changeLovelace: bigint;
  metadata: { [CIP20_LABEL]: { msg: string[] } };
}

const big = (v: bigint | number) => CSL.BigNum.from_str(String(v));

/** Enough ADA to pay the fee and leave a change output above min-UTxO. */
const MIN_SELECTION_LOVELACE = 2_000_000n;

function toCslValue(u: AnchorUtxo): CSL.Value {
  const value = CSL.Value.new(big(u.lovelace));
  if (u.assets && u.assets.length > 0) {
    const ma = CSL.MultiAsset.new();
    for (const a of u.assets) {
      const policy = CSL.ScriptHash.from_hex(a.policyId);
      const assets = ma.get(policy) ?? CSL.Assets.new();
      assets.insert(CSL.AssetName.new(Buffer.from(a.assetNameHex, "hex")), big(a.quantity));
      ma.insert(policy, assets);
    }
    value.set_multiasset(ma);
  }
  return value;
}

/** Largest pure-ADA UTxOs first; token-bearing ones only if needed. Deterministic. */
function selectInputs(utxos: readonly AnchorUtxo[]): AnchorUtxo[] {
  const sorted = [...utxos].sort((a, b) => {
    const at = a.assets?.length ? 1 : 0;
    const bt = b.assets?.length ? 1 : 0;
    if (at !== bt) return at - bt;
    if (a.lovelace !== b.lovelace) return a.lovelace > b.lovelace ? -1 : 1;
    return a.txHash === b.txHash ? a.index - b.index : a.txHash < b.txHash ? -1 : 1;
  });
  const chosen: AnchorUtxo[] = [];
  let total = 0n;
  for (const u of sorted) {
    if (total >= MIN_SELECTION_LOVELACE) break;
    chosen.push(u);
    total += u.lovelace;
  }
  if (total < MIN_SELECTION_LOVELACE) {
    throw new Error(
      `anchor wallet holds ${total} lovelace; at least ${MIN_SELECTION_LOVELACE} is needed`,
    );
  }
  return chosen;
}

/**
 * Builds and signs (never submits) a self-send carrying the CIP-20 anchor. Refuses inputs that
 * are not at the change address, a key that does not own that address, or a network mismatch.
 */
export function buildAnchorTx(input: AnchorTxInput): BuiltAnchorTx {
  if (input.signingKey.role !== undefined && input.signingKey.role !== "anchor") {
    throw new TypeError("only the anchor wallet key signs anchor transactions");
  }
  const networkId = input.network === "mainnet" ? 1 : 0;
  const change = CSL.Address.from_bech32(input.changeAddress);
  if (change.network_id() !== networkId)
    throw new Error(`change address is not a ${input.network} address`);
  const payHash = change.payment_cred()?.to_keyhash()?.to_hex();
  if (!payHash) throw new Error("the anchor wallet must be a key-hash (not script) address");
  for (const u of input.utxos) {
    if (u.address !== input.changeAddress)
      throw new Error("every input must be at the anchor wallet address");
  }
  const ownerHash = input.signingKey.useSeed((seed) => {
    const sk = CSL.PrivateKey.from_normal_bytes(seed);
    try {
      return sk.to_public().hash().to_hex();
    } finally {
      sk.free();
    }
  });
  if (ownerHash !== payHash)
    throw new Error("the signing key does not own the anchor wallet address");

  const p = input.params;
  const cfg = CSL.TransactionBuilderConfigBuilder.new()
    .fee_algo(CSL.LinearFee.new(big(p.minFeeA), big(p.minFeeB)))
    .pool_deposit(big(p.poolDeposit))
    .key_deposit(big(p.keyDeposit))
    .max_value_size(p.maxValueSize)
    .max_tx_size(p.maxTxSize)
    .coins_per_utxo_byte(big(p.coinsPerUtxoByte))
    .ref_script_coins_per_byte(CSL.UnitInterval.new(big(p.refScriptCostPerByte), big(1)))
    .build();
  const tb = CSL.TransactionBuilder.new(cfg);
  const chosen = selectInputs(input.utxos);
  for (const u of chosen) {
    tb.add_regular_input(
      change,
      CSL.TransactionInput.new(CSL.TransactionHash.from_hex(u.txHash), u.index),
      toCslValue(u),
    );
  }
  const metadata = cip20Metadata(input.payload);
  // NoConversions: strings stay strings (no "0x…" → bytes rewriting).
  tb.add_metadatum(
    big(CIP20_LABEL),
    CSL.encode_json_str_to_metadatum(
      JSON.stringify(metadata[CIP20_LABEL]),
      CSL.MetadataJsonSchema.NoConversions,
    ),
  );
  if (input.ttlSlot !== undefined) tb.set_ttl_bignum(big(input.ttlSlot));
  if (!tb.add_change_if_needed(change))
    throw new Error("no change output: inputs too small for a self-send");
  const tx = tb.build_tx();
  const fixed = CSL.FixedTransaction.from_bytes(tx.to_bytes());
  input.signingKey.useSeed((seed) => {
    const sk = CSL.PrivateKey.from_normal_bytes(seed);
    try {
      fixed.sign_and_add_vkey_signature(sk);
    } finally {
      sk.free();
    }
  });
  const body = fixed.body();
  const outputs = body.outputs();
  let changeLovelace = 0n;
  for (let i = 0; i < outputs.len(); i++)
    changeLovelace += BigInt(outputs.get(i).amount().coin().to_str());
  return {
    txHex: fixed.to_hex(),
    txHash: fixed.transaction_hash().to_hex(),
    feeLovelace: BigInt(body.fee().to_str()),
    inputs: chosen.map((u) => `${u.txHash}#${u.index}`),
    changeLovelace,
    metadata,
  };
}
