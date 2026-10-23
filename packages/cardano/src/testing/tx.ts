import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import { bytesToHex, hexToBytes } from "../cip30.js";
import * as C from "./cbor.js";

/**
 * Unsigned payment transactions like the ones Strike's build-tx and withdraw quote return, for
 * the fake server and the witness tests. Balanced by the serialization library's builder, then
 * (by default) re-encoded the way a different CBOR encoder might write it: body keys out of
 * order and an indefinite-length inputs array. Both are valid CBOR for the same body, but a
 * merge that re-serializes the body would change its hash, which is what the tests must catch.
 */
export interface PaymentOutput {
  address: string;
  lovelace: bigint;
  assets?: { policyId: string; assetNameHex: string; quantity: bigint }[];
}

export interface PaymentTxInput {
  /** CIP-30 `getUtxos()` hex, the wallet's spendable outputs. */
  utxosHex: readonly string[];
  changeAddress: string;
  outputs: readonly PaymentOutput[];
  ttlSlot?: number;
  /** Re-encode the body non-canonically (default true). */
  nonCanonical?: boolean;
}

/** Mainnet protocol parameters as anchor.ts pins them (Koios epoch_params, 2026-10-23). */
const PARAMS = {
  minFeeA: 44,
  minFeeB: 155_381,
  maxTxSize: 16_384,
  maxValueSize: 5_000,
  keyDeposit: 2_000_000n,
  poolDeposit: 500_000_000n,
  coinsPerUtxoByte: 4_310n,
};

const big = (v: bigint | number) => CSL.BigNum.from_str(String(v));

function value(o: PaymentOutput): CSL.Value {
  const v = CSL.Value.new(big(o.lovelace));
  if (o.assets && o.assets.length > 0) {
    const ma = CSL.MultiAsset.new();
    for (const a of o.assets) {
      const policy = CSL.ScriptHash.from_hex(a.policyId);
      const assets = ma.get(policy) ?? CSL.Assets.new();
      assets.insert(CSL.AssetName.new(hexToBytes(a.assetNameHex)), big(a.quantity));
      ma.insert(policy, assets);
    }
    v.set_multiasset(ma);
  }
  return v;
}

export function buildPaymentTx(input: PaymentTxInput): string {
  const cfg = CSL.TransactionBuilderConfigBuilder.new()
    .fee_algo(CSL.LinearFee.new(big(PARAMS.minFeeA), big(PARAMS.minFeeB)))
    .pool_deposit(big(PARAMS.poolDeposit))
    .key_deposit(big(PARAMS.keyDeposit))
    .max_value_size(PARAMS.maxValueSize)
    .max_tx_size(PARAMS.maxTxSize)
    .coins_per_utxo_byte(big(PARAMS.coinsPerUtxoByte))
    .build();
  const tb = CSL.TransactionBuilder.new(cfg);
  const utxos = CSL.TransactionUnspentOutputs.new();
  for (const hex of input.utxosHex) utxos.add(CSL.TransactionUnspentOutput.from_hex(hex));
  for (const o of input.outputs) {
    tb.add_output(CSL.TransactionOutput.new(CSL.Address.from_bech32(o.address), value(o)));
  }
  if (input.ttlSlot !== undefined) tb.set_ttl_bignum(big(input.ttlSlot));
  const change = CSL.Address.from_bech32(input.changeAddress);
  tb.add_inputs_from(utxos, CSL.CoinSelectionStrategyCIP2.LargestFirstMultiAsset);
  if (!tb.add_change_if_needed(change)) throw new Error("inputs do not cover a change output");
  const tx = tb.build_tx();
  const hex = tx.to_hex();
  tx.free();
  return input.nonCanonical === false ? hex : reencodeBody(hex);
}

/** Same body, different bytes: keys reversed and the inputs array indefinite-length. */
export function reencodeBody(txHex: string): string {
  const top = C.decode(hexToBytes(txHex));
  if (top.value.t !== "array") throw new TypeError("not a transaction");
  const [body, ...rest] = top.value.v;
  if (body?.t !== "map") throw new TypeError("transaction body is not a map");
  const pairs: [C.Cbor, C.Cbor][] = body.v.map(([k, v]) => {
    const isInputs = k.t === "uint" && k.v === 0n;
    if (isInputs && v.t === "array") return [k, C.array(v.v, true)];
    if (isInputs && v.t === "tag" && v.v.t === "array")
      return [k, C.tag(v.tag, C.array(v.v.v, true))];
    return [k, v];
  });
  pairs.reverse();
  return bytesToHex(C.encode(C.array([C.map(pairs), ...rest])));
}
