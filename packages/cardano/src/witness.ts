import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import { hexToBytes } from "./cip30.js";

/**
 * Witness merges for the two transactions a holder signs (plan §4):
 * - deposit: Strike's build-tx returns an unsigned tx; the wallet's `signTx(tx, true)` returns
 *   only a witness set; the merged tx goes back to the wallet's `submitTx`;
 * - withdrawal: the quote's `tx_cbor` (the validator min-UTxO funding tx) is signed the same
 *   way and the full signed CBOR goes to Strike as `signed_tx_cbor`.
 *
 * The body is never re-serialized. `FixedTransaction` keeps the body bytes exactly as Strike
 * encoded them, so the transaction hash the wallet signed is the hash of what is submitted;
 * re-encoding through `Transaction` could reorder map keys or change array headers, which
 * changes the hash and invalidates every signature. Each merge re-checks both invariants.
 */
export class WitnessMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WitnessMergeError";
  }
}

export interface MergeOptions {
  /** Key hashes that must sign (the holder's payment key). Each must be among the new witnesses. */
  requireKeyHashes?: readonly string[];
}

export interface MergeResult {
  txHex: string;
  txHash: string;
  /** Key hashes of the vkey witnesses the wallet added. */
  added: string[];
}

function parseTx(hex: string, what: string): CSL.FixedTransaction {
  try {
    return CSL.FixedTransaction.from_bytes(hexToBytes(hex));
  } catch {
    throw new WitnessMergeError(`${what} is not a Cardano transaction`);
  }
}

function keyHashHex(pk: CSL.PublicKey): string {
  const h = pk.hash();
  try {
    return h.to_hex();
  } finally {
    h.free();
  }
}

/** The transaction id: blake2b-256 of the body bytes as encoded. */
export function txHashOf(txHex: string): string {
  const tx = parseTx(txHex, "the transaction");
  try {
    return tx.transaction_hash().to_hex();
  } finally {
    tx.free();
  }
}

/** Raw body bytes, hex, exactly as encoded in the transaction. */
export function rawBodyHex(txHex: string): string {
  const tx = parseTx(txHex, "the transaction");
  try {
    return Buffer.from(tx.raw_body()).toString("hex");
  } finally {
    tx.free();
  }
}

/**
 * Adds the wallet's vkey witnesses to an unsigned (or partly signed) transaction. Refuses any
 * witness that does not verify over this body hash, any non-vkey witness, and any change to the
 * body bytes or hash.
 */
export function mergeWalletWitnesses(
  unsignedTxHex: string,
  walletWitnessSetHex: string,
  opts: MergeOptions = {},
): MergeResult {
  const fixed = parseTx(unsignedTxHex, "the unsigned transaction");
  let ws: CSL.TransactionWitnessSet;
  try {
    ws = CSL.TransactionWitnessSet.from_bytes(hexToBytes(walletWitnessSetHex));
  } catch {
    fixed.free();
    throw new WitnessMergeError("the wallet's reply is not a transaction witness set");
  }
  try {
    const before = fixed.transaction_hash().to_hex();
    const bodyBefore = Buffer.from(fixed.raw_body());
    const hashBytes = Buffer.from(before, "hex");
    if (
      ws.bootstraps() ||
      ws.native_scripts() ||
      ws.plutus_scripts() ||
      ws.plutus_data() ||
      ws.redeemers()
    ) {
      throw new WitnessMergeError("the wallet returned witnesses other than vkey signatures");
    }
    const vkeys = ws.vkeys();
    if (!vkeys || vkeys.len() === 0) throw new WitnessMergeError("the wallet added no signature");

    const present = new Set<string>();
    const existing = fixed.witness_set().vkeys();
    for (let i = 0; i < (existing?.len() ?? 0); i++) {
      const vk = existing?.get(i);
      if (vk) present.add(vk.vkey().public_key().to_hex());
    }
    const added: string[] = [];
    for (let i = 0; i < vkeys.len(); i++) {
      const vk = vkeys.get(i);
      const pk = vk.vkey().public_key();
      if (!pk.verify(hashBytes, vk.signature())) {
        throw new WitnessMergeError("a wallet signature does not verify over this transaction");
      }
      added.push(keyHashHex(pk));
      if (present.has(pk.to_hex())) continue;
      present.add(pk.to_hex());
      fixed.add_vkey_witness(vk);
    }
    for (const need of opts.requireKeyHashes ?? []) {
      if (!added.includes(need)) {
        throw new WitnessMergeError(`the wallet did not sign with the expected key ${need}`);
      }
    }
    const after = fixed.transaction_hash().to_hex();
    if (after !== before || !Buffer.from(fixed.raw_body()).equals(bodyBefore)) {
      throw new WitnessMergeError("the merge changed the transaction body");
    }
    return { txHex: fixed.to_hex(), txHash: after, added };
  } finally {
    ws.free();
    fixed.free();
  }
}

/** Key hashes of the vkey witnesses whose signature verifies over this transaction's hash. */
export function verifiedSigners(txHex: string): string[] {
  const fixed = parseTx(txHex, "the transaction");
  try {
    const hash = fixed.transaction_hash().to_bytes();
    const vkeys = fixed.witness_set().vkeys();
    const out: string[] = [];
    for (let i = 0; i < (vkeys?.len() ?? 0); i++) {
      const vk = vkeys?.get(i);
      const pk = vk?.vkey().public_key();
      if (vk && pk?.verify(hash, vk.signature())) out.push(keyHashHex(pk));
    }
    return out;
  } finally {
    fixed.free();
  }
}

export interface TxOutputSummary {
  address: string;
  lovelace: string;
  assets: { policyId: string; assetNameHex: string; quantity: string }[];
}

export interface TxSummary {
  txHash: string;
  feeLovelace: string;
  ttlSlot: string | null;
  validFromSlot: string | null;
  inputs: string[];
  outputs: TxOutputSummary[];
  requiredSigners: string[];
  vkeyWitnesses: number;
}

function addressText(a: CSL.Address): string {
  try {
    return a.to_bech32();
  } catch {
    const byron = CSL.ByronAddress.from_address(a);
    return byron ? byron.to_base58() : a.to_hex();
  }
}

/**
 * What a transaction does, decoded from its bytes: shown to the holder before their wallet's
 * own confirmation screen, and recorded with each funding step.
 */
export function summarizeTx(txHex: string): TxSummary {
  const fixed = parseTx(txHex, "the transaction");
  try {
    const body = fixed.body();
    const inputs: string[] = [];
    const ins = body.inputs();
    for (let i = 0; i < ins.len(); i++) {
      const input = ins.get(i);
      inputs.push(`${input.transaction_id().to_hex()}#${input.index()}`);
    }
    const outputs: TxOutputSummary[] = [];
    const outs = body.outputs();
    for (let i = 0; i < outs.len(); i++) {
      const o = outs.get(i);
      const amount = o.amount();
      const assets: TxOutputSummary["assets"] = [];
      const ma = amount.multiasset();
      const policies = ma?.keys();
      for (let p = 0; p < (policies?.len() ?? 0); p++) {
        const policy = policies?.get(p);
        const named = policy ? ma?.get(policy) : undefined;
        const names = named?.keys();
        for (let n = 0; n < (names?.len() ?? 0); n++) {
          const name = names?.get(n);
          const q = name ? named?.get(name) : undefined;
          if (policy && name && q) {
            assets.push({
              policyId: policy.to_hex(),
              assetNameHex: Buffer.from(name.name()).toString("hex"),
              quantity: q.to_str(),
            });
          }
        }
      }
      outputs.push({ address: addressText(o.address()), lovelace: amount.coin().to_str(), assets });
    }
    const signers: string[] = [];
    const rs = body.required_signers();
    for (let i = 0; i < (rs?.len() ?? 0); i++) {
      const s = rs?.get(i);
      if (s) signers.push(s.to_hex());
    }
    return {
      txHash: fixed.transaction_hash().to_hex(),
      feeLovelace: body.fee().to_str(),
      ttlSlot: body.ttl_bignum()?.to_str() ?? null,
      validFromSlot: body.validity_start_interval_bignum()?.to_str() ?? null,
      inputs,
      outputs,
      requiredSigners: signers,
      vkeyWitnesses: fixed.witness_set().vkeys()?.len() ?? 0,
    };
  } finally {
    fixed.free();
  }
}
