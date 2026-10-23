import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import { describe, expect, it } from "vitest";
import {
  mergeWalletWitnesses,
  rawBodyHex,
  summarizeTx,
  txHashOf,
  WitnessMergeError,
} from "../src/index.js";
import {
  buildPaymentTx,
  cbor,
  independentTxHash,
  TestWallet,
  txBodyBytes,
} from "../src/testing/index.js";

const VAULT = new TestWallet().address;

async function unsignedDeposit(w: TestWallet, nonCanonical = true): Promise<string> {
  return buildPaymentTx({
    utxosHex: await w.getUtxos(),
    changeAddress: w.address,
    outputs: [{ address: VAULT, lovelace: 25_000_000n }],
    ttlSlot: 180_000_000,
    nonCanonical,
  });
}

describe("FixedTransaction witness merge", () => {
  it("adds the wallet's witness without changing a byte of the body or its hash", async () => {
    const w = new TestWallet();
    const unsigned = await unsignedDeposit(w);
    const bodyBefore = Buffer.from(txBodyBytes(unsigned)).toString("hex");
    const hashBefore = independentTxHash(unsigned);
    expect(txHashOf(unsigned)).toBe(hashBefore);

    const ws = await w.signTx(unsigned, true);
    const merged = mergeWalletWitnesses(unsigned, ws, { requireKeyHashes: [w.paymentKeyHash] });

    expect(merged.txHash).toBe(hashBefore);
    expect(independentTxHash(merged.txHex)).toBe(hashBefore);
    expect(Buffer.from(txBodyBytes(merged.txHex)).toString("hex")).toBe(bodyBefore);
    expect(rawBodyHex(merged.txHex)).toBe(bodyBefore);
    expect(merged.added).toEqual([w.paymentKeyHash]);

    // The merged witness verifies over the hash the wallet saw, with the library's own check.
    const tx = CSL.FixedTransaction.from_hex(merged.txHex);
    const vk = tx.witness_set().vkeys()?.get(0);
    expect(vk?.vkey().public_key().verify(Buffer.from(hashBefore, "hex"), vk.signature())).toBe(
      true,
    );
    expect(summarizeTx(merged.txHex).vkeyWitnesses).toBe(1);
  });

  it("the test transaction really is non-canonical: re-serializing it would change the hash", async () => {
    const w = new TestWallet();
    const unsigned = await unsignedDeposit(w);
    const canonical = await unsignedDeposit(w, false);
    const top = cbor.decode(Buffer.from(unsigned, "hex"));
    const body = top.value.t === "array" ? top.value.v[0] : undefined;
    expect(body?.t).toBe("map");
    if (body?.t === "map") {
      expect(body.v[0]?.[0]).not.toEqual(cbor.uint(0));
      const inputs = body.v.find(([k]) => k.t === "uint" && k.v === 0n)?.[1];
      const indefinite =
        (inputs?.t === "array" && inputs.indefinite) ||
        (inputs?.t === "tag" && inputs.v.t === "array" && inputs.v.indefinite);
      expect(indefinite).toBe(true);
    }
    // Same semantic body, different bytes, different id: only byte-preserving merges are safe.
    expect(independentTxHash(unsigned)).not.toBe(independentTxHash(canonical));
    // A naive merge through CSL.Transaction re-encodes the body: the wallet's signature would
    // then cover a transaction that no longer exists.
    const reserialized = Buffer.from(CSL.Transaction.from_hex(unsigned).to_bytes()).toString("hex");
    expect(independentTxHash(reserialized)).not.toBe(independentTxHash(unsigned));
  });

  it("keeps witnesses already present and does not duplicate the wallet's", async () => {
    const w = new TestWallet();
    const unsigned = await unsignedDeposit(w);
    const once = mergeWalletWitnesses(unsigned, await w.signTx(unsigned, true));
    const twice = mergeWalletWitnesses(once.txHex, await w.signTx(once.txHex, true));
    expect(twice.txHash).toBe(once.txHash);
    expect(summarizeTx(twice.txHex).vkeyWitnesses).toBe(1);
  });

  it("refuses a witness for another transaction, a stranger's key and non-vkey witnesses", async () => {
    const w = new TestWallet();
    const unsigned = await unsignedDeposit(w);
    const other = await unsignedDeposit(w, false);
    expect(() => mergeWalletWitnesses(unsigned, "a0")).toThrow(WitnessMergeError);
    const wrongTx = await w.signTx(other, true);
    expect(() => mergeWalletWitnesses(unsigned, wrongTx)).toThrow(/does not verify/);
    const stranger = new TestWallet();
    const theirs = await stranger.signTx(unsigned, true);
    expect(() =>
      mergeWalletWitnesses(unsigned, theirs, { requireKeyHashes: [w.paymentKeyHash] }),
    ).toThrow(/expected key/);
    const scripts = cbor.encode(
      cbor.map([
        [cbor.uint(1), cbor.array([cbor.array([cbor.uint(0), cbor.bytes(new Uint8Array(28))])])],
      ]),
    );
    expect(() => mergeWalletWitnesses(unsigned, Buffer.from(scripts).toString("hex"))).toThrow(
      /other than vkey/,
    );
    const mine = await w.signTx(unsigned, true);
    expect(() => mergeWalletWitnesses("00", mine)).toThrow(/not a Cardano transaction/);
  });

  it("summarizes what the holder is about to sign", async () => {
    const w = new TestWallet();
    const unsigned = await unsignedDeposit(w);
    const s = summarizeTx(unsigned);
    expect(s.outputs[0]).toMatchObject({ address: VAULT, lovelace: "25000000" });
    expect(s.outputs.some((o) => o.address === w.address)).toBe(true);
    expect(s.ttlSlot).toBe("180000000");
    expect(Number(s.feeLovelace)).toBeGreaterThan(155_381);
    expect(s.vkeyWitnesses).toBe(0);
  });
});
