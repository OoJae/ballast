import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnchorWalletKey, StrikeKey } from "@ballast/governance";
import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AnchorUtxo,
  anchorMessage,
  anchorRoots,
  buildAnchorTx,
  CIP20_LABEL,
  chunkUtf8,
  cip20Metadata,
  PREPROD_PARAMS,
  parseCip20Anchor,
} from "../src/anchor.js";

const seed = (l: string) => createHash("sha256").update(`ballast-anchor-test:${l}`).digest();
const ROOT = "ab".repeat(32);

describe("CIP-20 payload: label 674, msg = [root, seq range, segment count], ≤ 64-byte strings", () => {
  it("chunks on UTF-8 boundaries: ≤ 64 bytes each, lossless, no split code points", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 400 }), (s) => {
        const chunks = chunkUtf8(s);
        for (const c of chunks) {
          if (Buffer.byteLength(c, "utf8") > 64) return false;
          if (Buffer.from(c, "utf8").toString("utf8") !== c) return false;
        }
        return chunks.join("") === s;
      }),
      { numRuns: 1_000 },
    );
    expect(chunkUtf8("a".repeat(64))).toHaveLength(1);
    expect(chunkUtf8("a".repeat(65))).toEqual(["a".repeat(64), "a"]);
    // A 4-byte emoji straddling the boundary moves whole to the next chunk.
    expect(chunkUtf8(`${"a".repeat(62)}🙂b`)).toEqual(["a".repeat(62), "🙂b"]);
  });

  it("the 64-hex root fits one entry; the message round-trips through tx metadata", () => {
    const p = { root: ROOT, firstSeq: 1, lastSeq: 2880, segmentCount: 24 };
    expect(anchorMessage(p)).toEqual([ROOT, "seq 1-2880", "segments 24"]);
    const md = cip20Metadata(p);
    expect(Object.keys(md)).toEqual(["674"]);
    // Koios tx_metadata returns labels as string keys.
    expect(parseCip20Anchor(JSON.parse(JSON.stringify(md)))).toEqual(p);
    expect(parseCip20Anchor({ "674": { msg: ["Minswap: Order Executed"] } })).toBeNull();
    expect(parseCip20Anchor({ "674": { msg: [ROOT, "seq 5-4", "segments 1"] } })).toBeNull();
    expect(parseCip20Anchor(null)).toBeNull();
    expect(() => anchorMessage({ ...p, root: "XY" })).toThrow(/root/);
  });

  it("the anchored root commits to every decision hash and every segment hash", () => {
    const d = ["1", "2", "3"].map((c) => c.repeat(64));
    const s = ["a", "b"].map((c) => c.repeat(64));
    const base = anchorRoots(d, s);
    expect(anchorRoots(d, s)).toEqual(base);
    expect(anchorRoots([...d.slice(0, 2), "4".repeat(64)], s).root).not.toBe(base.root);
    expect(anchorRoots(d, [s[0] as string, "c".repeat(64)]).root).not.toBe(base.root);
    expect(anchorRoots(d.slice(0, 2), s).root).not.toBe(base.root);
    // Decisions and segments cannot be swapped to give the same root.
    expect(anchorRoots(s, d).root).not.toBe(base.root);
  });
});

describe("anchor transaction builder (offline, preprod-format data, never submitted)", () => {
  const key = AnchorWalletKey.fromSeed(seed("anchor-wallet"));
  const keyHash = key.useSeed((s) => CSL.PrivateKey.from_normal_bytes(s).to_public().hash());
  const address = CSL.EnterpriseAddress.new(0, CSL.Credential.from_keyhash(keyHash))
    .to_address()
    .to_bech32(undefined);
  const txh = (l: string) => createHash("sha256").update(`preprod-utxo:${l}`).digest("hex");
  const utxos: AnchorUtxo[] = [
    { txHash: txh("small"), index: 1, address, lovelace: 1_200_000n },
    { txHash: txh("big"), index: 0, address, lovelace: 9_800_000n },
    {
      txHash: txh("tokens"),
      index: 2,
      address,
      lovelace: 1_500_000n,
      assets: [{ policyId: "c".repeat(56), assetNameHex: "74657374", quantity: 5n }],
    },
  ];
  const payload = { root: ROOT, firstSeq: 1, lastSeq: 2880, segmentCount: 24 };
  const build = (over: Partial<Parameters<typeof buildAnchorTx>[0]> = {}) =>
    buildAnchorTx({
      network: "preprod",
      utxos,
      changeAddress: address,
      signingKey: key,
      payload,
      params: PREPROD_PARAMS,
      ttlSlot: 137_045_000,
      ...over,
    });

  it("builds a balanced, signed self-send whose metadata is exactly the CIP-20 anchor", () => {
    expect(address.startsWith("addr_test1")).toBe(true);
    const built = build();
    const tx = CSL.FixedTransaction.from_hex(built.txHex);
    const body = tx.body();
    // Largest pure-ADA input first, and it alone suffices.
    expect(built.inputs).toEqual([`${txh("big")}#0`]);
    expect(body.inputs().len()).toBe(1);
    expect(body.outputs().len()).toBe(1);
    expect(body.outputs().get(0).address().to_bech32(undefined)).toBe(address);
    expect(body.ttl_bignum()?.to_str()).toBe("137045000");
    // Balanced: input = change + fee; the fee covers the signed size.
    expect(built.changeLovelace + built.feeLovelace).toBe(9_800_000n);
    const minFee = BigInt(
      CSL.min_fee(
        CSL.Transaction.from_bytes(tx.to_bytes()),
        CSL.LinearFee.new(CSL.BigNum.from_str("44"), CSL.BigNum.from_str("155381")),
      ).to_str(),
    );
    expect(built.feeLovelace >= minFee).toBe(true);
    expect(built.feeLovelace < 300_000n).toBe(true);
    // Metadata: label 674 with the exact msg, and the body commits to it.
    const aux = tx.auxiliary_data() as CSL.AuxiliaryData;
    const md = aux
      .metadata()
      ?.get(CSL.BigNum.from_str(String(CIP20_LABEL))) as CSL.TransactionMetadatum;
    expect(
      JSON.parse(CSL.decode_metadatum_to_json_str(md, CSL.MetadataJsonSchema.NoConversions)),
    ).toEqual({
      msg: anchorMessage(payload),
    });
    expect(body.auxiliary_data_hash()?.to_hex()).toBe(CSL.hash_auxiliary_data(aux).to_hex());
    // One vkey witness from the anchor key, valid over the transaction hash.
    const w = tx.witness_set().vkeys()?.get(0) as CSL.Vkeywitness;
    expect(w.vkey().public_key().hash().to_hex()).toBe(keyHash.to_hex());
    expect(w.vkey().public_key().verify(Buffer.from(built.txHash, "hex"), w.signature())).toBe(
      true,
    );
    expect(built.txHash).toBe(tx.transaction_hash().to_hex());
  });

  it("is deterministic for the same inputs", () => {
    expect(build().txHex).toBe(build().txHex);
  });

  it("refuses foreign inputs, the wrong key, the wrong network, a script address and too little ADA", () => {
    const other = CSL.EnterpriseAddress.new(
      0,
      CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_bytes(new Uint8Array(28).fill(9))),
    )
      .to_address()
      .to_bech32(undefined);
    expect(() =>
      build({
        utxos: [...utxos, { txHash: txh("x"), index: 0, address: other, lovelace: 5_000_000n }],
      }),
    ).toThrow(/every input/);
    expect(() => build({ signingKey: AnchorWalletKey.fromSeed(seed("someone-else")) })).toThrow(
      /does not own/,
    );
    expect(() => build({ network: "mainnet" })).toThrow(/not a mainnet address/);
    const script = CSL.EnterpriseAddress.new(
      0,
      CSL.Credential.from_scripthash(CSL.ScriptHash.from_bytes(new Uint8Array(28).fill(1))),
    )
      .to_address()
      .to_bech32(undefined);
    expect(() => build({ changeAddress: script, utxos: [] })).toThrow(/key-hash/);
    expect(() => build({ utxos: [utxos[0] as AnchorUtxo] })).toThrow(/at least 2000000/);
    // A Strike API key is never an anchor key, even if its bytes could sign.
    expect(() => build({ signingKey: StrikeKey.fromSeed(seed("anchor-wallet")) })).toThrow(
      /only the anchor wallet key/,
    );
  });

  it("the anchor module has no network path: no fetch, no submit", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../src/anchor.ts"), "utf8");
    expect(src).not.toMatch(/\bfetch\(|submittx|submitTx|https?:\/\//);
  });
});
