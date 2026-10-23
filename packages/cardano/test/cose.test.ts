import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  keyHashOf,
  parseStrikeSignature,
  signDataForStrike,
  toStrikeSignature,
  utf8ToHex,
  verifyCip8,
} from "../src/index.js";
import { blake2b, blake2b224, TestWallet } from "../src/testing/index.js";

describe("independent BLAKE2b", () => {
  it("matches Node's blake2b512 and the RFC 7693 vector", () => {
    for (const s of ["", "abc", "x".repeat(127), "y".repeat(128), "z".repeat(300)]) {
      const node = createHash("blake2b512").update(s).digest("hex");
      expect(Buffer.from(blake2b(Buffer.from(s), 64)).toString("hex")).toBe(node);
    }
    expect(Buffer.from(blake2b(new Uint8Array(), 32)).toString("hex")).toBe(
      "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8",
    );
  });

  it("gives the same key hash as the serialization library", () => {
    const w = new TestWallet();
    const pub = Buffer.from(w.paymentPublicKeyHex, "hex");
    expect(keyHashOf(pub)).toBe(Buffer.from(blake2b224(pub)).toString("hex"));
    expect(keyHashOf(pub)).toBe(w.paymentKeyHash);
  });
});

describe("CIP-8 round trip (keys generated in the test, no real wallet)", () => {
  it("verifies a signData over hex(utf8) text, in both of Strike's string forms", async () => {
    const w = new TestWallet();
    const payloadHex = utf8ToHex('Connect to Strike via builder "ballast".\nNonce: 1');
    const sig = await signDataForStrike(w, w.address, payloadHex);
    const v = verifyCip8(sig, { address: w.address, payloadHex });
    expect(v).toMatchObject({ ok: true, paymentKeyHash: w.paymentKeyHash, payloadHex });
    const ds = parseStrikeSignature(sig);
    expect(verifyCip8(JSON.stringify(ds), { address: w.address, payloadHex }).ok).toBe(true);
    expect(toStrikeSignature(ds)).toBe(sig);
  });

  it("property: any UTF-8 message round-trips and only verifies for its own payload", async () => {
    const w = new TestWallet();
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 400, unit: "grapheme" }), async (m) => {
        const payloadHex = utf8ToHex(m);
        const sig = await signDataForStrike(w, w.address, payloadHex);
        expect(verifyCip8(sig, { address: w.address, payloadHex }).ok).toBe(true);
        const other = utf8ToHex(`${m}.`);
        expect(verifyCip8(sig, { address: w.address, payloadHex: other }).ok).toBe(false);
      }),
      { numRuns: 60 },
    );
  });

  it("refuses wrong address, wrong key, hashed payloads, bad algorithm and tampering", async () => {
    const w = new TestWallet();
    const other = new TestWallet();
    const payloadHex = utf8ToHex("Ballast holder proof");
    const expect1 = { address: w.address, payloadHex };
    const cases: [string, TestWallet["nextSignData"], string][] = [
      ["header address", { headerAddressHex: other.addressHex }, "different address"],
      ["stake key", { key: "stake" }, "payment key"],
      ["stranger key", { key: "stranger" }, "payment key"],
      ["hashed payload", { hashed: true }, "hashed"],
      ["algorithm", { alg: -7 }, "EdDSA"],
      ["corrupt signature", { corrupt: true }, "does not verify"],
      ["other payload", { payloadHex: utf8ToHex("something else") }, "different payload"],
    ];
    for (const [name, tweak, reason] of cases) {
      w.nextSignData = tweak;
      const sig = await signDataForStrike(w, w.address, payloadHex);
      const v = verifyCip8(sig, expect1);
      expect(v.ok, name).toBe(false);
      if (!v.ok) expect(v.reason, name).toContain(reason);
    }
    const good = await signDataForStrike(w, w.address, payloadHex);
    expect(verifyCip8(good, { address: other.address, payloadHex }).ok).toBe(false);
    expect(verifyCip8("zz:yy", expect1).ok).toBe(false);
    expect(verifyCip8("8400:a0", expect1).ok).toBe(false);
    const [sig, key] = good.split(":") as [string, string];
    expect(verifyCip8(`${sig}:${key.slice(0, -2)}00`, expect1).ok).toBe(false);
  });

  it("the wallet itself refuses to sign for an address it does not hold", async () => {
    const w = new TestWallet();
    const other = new TestWallet();
    await expect(signDataForStrike(w, other.address, "00")).rejects.toThrow(/ProofGeneration/);
  });
});
