import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AddressError,
  bech32Decode,
  bech32Encode,
  parseAddress,
  stakeAddressFor,
  stakeAddressOf,
} from "../src/index.js";

describe("bech32 (BIP-173)", () => {
  it("accepts the BIP-173 valid checksums", () => {
    for (const s of [
      "A12UEL5L",
      "a12uel5l",
      "an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs",
      "abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw",
      "split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w",
      "?1ezyfcl",
    ]) {
      expect(() => bech32Decode(s), s).not.toThrow();
    }
    expect(
      Buffer.from(bech32Decode("abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw").bytes).toString(
        "hex",
      ),
    ).toBe("00443214c74254b635cf84653a56d7c675be77df");
  });

  it("rejects missing separators, bad characters, mixed case and bad checksums", () => {
    for (const s of [
      "pzry9x0s0muk",
      "1pzry9x0s0muk",
      "x1b4n0q5v",
      "li1dgmt3",
      "A12uEL5L",
      "a12uel5m",
    ]) {
      expect(() => bech32Decode(s), s).toThrow();
    }
  });

  it("round-trips arbitrary bytes and detects every single-character substitution", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        fc.nat(),
        fc.nat(),
        (bytes, pos, sub) => {
          const s = bech32Encode("addr", bytes);
          expect(Buffer.from(bech32Decode(s).bytes).equals(Buffer.from(bytes))).toBe(true);
          const data = s.slice(5);
          const i = pos % data.length;
          const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
          const repl = alphabet[
            (alphabet.indexOf(data[i] as string) + 1 + (sub % 31)) % 32
          ] as string;
          const mutated = `addr1${data.slice(0, i)}${repl}${data.slice(i + 1)}`;
          expect(() => bech32Decode(mutated)).toThrow();
        },
      ),
      { numRuns: 500 },
    );
  });
});

const hash28 = fc.uint8Array({ minLength: 28, maxLength: 28 });
const credOf = (bytes: Uint8Array, script: boolean) =>
  script
    ? CSL.Credential.from_scripthash(CSL.ScriptHash.from_bytes(bytes))
    : CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_bytes(bytes));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("CIP-19 address parsing, cross-checked against cardano-serialization-lib", () => {
  it("base addresses: payment and stake credentials and their kinds", () => {
    fc.assert(
      fc.property(
        hash28,
        hash28,
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (pay, stake, ps, ss, mainnet) => {
          const net = mainnet ? 1 : 0;
          const addr = CSL.BaseAddress.new(net, credOf(pay, ps), credOf(stake, ss)).to_address();
          const bech = addr.to_bech32(undefined);
          const p = parseAddress(bech);
          expect(p).toEqual({
            type: "base",
            network: mainnet ? "mainnet" : "testnet",
            payment: { kind: ps ? "script" : "key", hashHex: hex(pay) },
            stake: { kind: ss ? "script" : "key", hashHex: hex(stake) },
          });
          const reward = CSL.RewardAddress.new(net, credOf(stake, ss))
            .to_address()
            .to_bech32(undefined);
          expect(stakeAddressFor(bech)).toBe(reward);
          expect(stakeAddressFor(reward)).toBe(reward);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("enterprise, reward and pointer addresses", () => {
    fc.assert(
      fc.property(hash28, fc.boolean(), fc.nat({ max: 2 ** 31 }), (h, script, slot) => {
        const ent = CSL.EnterpriseAddress.new(1, credOf(h, script))
          .to_address()
          .to_bech32(undefined);
        expect(parseAddress(ent)).toEqual({
          type: "enterprise",
          network: "mainnet",
          payment: { kind: script ? "script" : "key", hashHex: hex(h) },
        });
        expect(stakeAddressFor(ent)).toBeNull();
        const rew = CSL.RewardAddress.new(0, credOf(h, script)).to_address().to_bech32(undefined);
        expect(parseAddress(rew)).toEqual({
          type: "reward",
          network: "testnet",
          stake: { kind: script ? "script" : "key", hashHex: hex(h) },
        });
        expect(
          stakeAddressOf({ kind: script ? "script" : "key", hashHex: hex(h) }, "testnet"),
        ).toBe(rew);
        const ptr = CSL.PointerAddress.new(
          1,
          credOf(h, script),
          CSL.Pointer.new_pointer(
            CSL.BigNum.from_str(String(slot)),
            CSL.BigNum.from_str("2"),
            CSL.BigNum.from_str("3"),
          ),
        )
          .to_address()
          .to_bech32(undefined);
        expect(parseAddress(ptr)).toMatchObject({
          type: "pointer",
          payment: { kind: script ? "script" : "key", hashHex: hex(h) },
          pointer: { slot: BigInt(slot), txIndex: 2n, certIndex: 3n },
        });
      }),
      { numRuns: 200 },
    );
  });

  it("rejects a prefix that disagrees with the header, wrong lengths and garbage", () => {
    const pay = new Uint8Array(28).fill(7);
    const main = CSL.EnterpriseAddress.new(1, credOf(pay, false)).to_address();
    const asTest = bech32Encode("addr_test", main.to_bytes());
    expect(() => parseAddress(asTest)).toThrow(AddressError);
    expect(() => parseAddress(bech32Encode("addr", Uint8Array.from([0x61, 1, 2, 3])))).toThrow(
      /29 bytes/,
    );
    expect(() => parseAddress(bech32Encode("stake", main.to_bytes()))).toThrow(/prefix/);
    expect(() => parseAddress("not-an-address")).toThrow(AddressError);
    // Synthetic base58 string with the Byron prefix: recognized as Byron, never decoded.
    expect(parseAddress(`Ae2td${"1".repeat(40)}`)).toEqual({ type: "byron" });
  });
});
