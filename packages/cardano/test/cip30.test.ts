import { parseAddress, stakeAddressFor } from "@ballast/cover";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  addressHexToBech32,
  bech32ToAddressHex,
  connectWallet,
  discoverWallets,
  hexToUtf8,
  holderAddress,
  parseStrikeSignature,
  paymentKeyHashOf,
  paymentKeyHashOfAddressHex,
  samePaymentKey,
  stakeAddressOfAddressHex,
  utf8ToHex,
} from "../src/index.js";
import { TestWallet } from "../src/testing/index.js";

describe("wallet discovery", () => {
  it("lists only installed Lace and Eternl and never enables anything", () => {
    const enable = vi.fn();
    const root = {
      cardano: {
        lace: { name: "lace", icon: "data:x", enable },
        eternl: { enable },
        nami: { name: "Nami", enable },
        broken: undefined,
      },
    };
    expect(discoverWallets(root)).toEqual([
      { id: "lace", name: "lace", icon: "data:x" },
      { id: "eternl", name: "Eternl", icon: null },
    ]);
    expect(discoverWallets(undefined)).toEqual([]);
    expect(discoverWallets({})).toEqual([]);
    expect(enable).not.toHaveBeenCalled();
  });

  it("connect reads a mainnet base address and its stake key", async () => {
    const w = new TestWallet();
    const c = await connectWallet(w.root("eternl"), "eternl");
    expect(c).toMatchObject({
      id: "eternl",
      name: "Eternl",
      network: "mainnet",
      address: w.address,
      addressHex: w.addressHex,
      stakeAddress: w.stakeAddress,
    });
    expect(c.address.startsWith("addr1")).toBe(true);
    const testnet = new TestWallet({ network: "testnet" });
    await expect(connectWallet(testnet.root(), "lace")).rejects.toThrow(/switch Lace to mainnet/);
    await expect(connectWallet({}, "lace")).rejects.toThrow(/not installed/);
  });
});

describe("address encodings agree with @ballast/cover's parser", () => {
  it("property: hex ↔ bech32, stake address and payment key match cover for base addresses", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 28, maxLength: 28 }),
        fc.uint8Array({ minLength: 28, maxLength: 28 }),
        fc.constantFrom(0, 1, 2, 3),
        fc.constantFrom(0, 1),
        (pay, stake, type, net) => {
          const hex = Buffer.from([(type << 4) | net, ...pay, ...stake]).toString("hex");
          const bech = addressHexToBech32(hex);
          expect(bech32ToAddressHex(bech)).toBe(hex);
          expect(stakeAddressOfAddressHex(hex)).toBe(stakeAddressFor(bech));
          const p = parseAddress(bech);
          const want = p.type === "base" && p.payment.kind === "key" ? p.payment.hashHex : null;
          expect(paymentKeyHashOfAddressHex(hex)).toBe(want);
          expect(paymentKeyHashOf(bech)).toBe(want);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("holderAddress accepts only key/key base addresses", () => {
    const w = new TestWallet();
    expect(holderAddress(w.address)).toMatchObject({
      address: w.address,
      bytesHex: w.addressHex,
      paymentKeyHash: w.paymentKeyHash,
      stakeAddress: w.stakeAddress,
    });
    expect(() => holderAddress(w.stakeAddress)).toThrow(/base address/);
    const scriptPay = Buffer.from(w.addressHex, "hex");
    scriptPay[0] = 0x11;
    expect(() => holderAddress(addressHexToBech32(scriptPay.toString("hex")))).toThrow(/payment/);
    const enterprise = `61${w.paymentKeyHash}`;
    expect(samePaymentKey(addressHexToBech32(enterprise), w.address)).toBe(true);
    expect(samePaymentKey(new TestWallet().address, w.address)).toBe(false);
  });
});

describe("payload and signature encodings", () => {
  it("property: utf8 ↔ hex round-trips; bad UTF-8 throws", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (s) => {
        expect(hexToUtf8(utf8ToHex(s))).toBe(s);
      }),
    );
    expect(() => hexToUtf8("ff")).toThrow();
    expect(() => hexToUtf8("abc")).toThrow(/hex/);
  });

  it("parses Strike's two signature forms and nothing else", () => {
    expect(parseStrikeSignature("AB:cd")).toEqual({ signature: "ab", key: "cd" });
    expect(parseStrikeSignature('{"signature":"ab","key":"cd"}')).toEqual({
      signature: "ab",
      key: "cd",
    });
    for (const bad of ["ab", "ab:cd:ef", ":cd", "ab:", "xy:cd", '{"signature":1}', "{"]) {
      expect(() => parseStrikeSignature(bad), bad).toThrow();
    }
  });
});
