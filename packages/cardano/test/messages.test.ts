import { createHash } from "node:crypto";
import { canonicalize } from "@ballast/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bodySha256,
  canonicalJson,
  consentMessage,
  GEOFENCE_STATEMENT,
  holderProofMessage,
  parseHolderProofMessage,
  RISK_DISCLOSURE,
  sha256HexOf,
  signInMessage,
} from "../src/index.js";

const fields = {
  accountId: "01a144dc-27e4-706c-ac46-9c2c1e77d60b",
  address:
    "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x",
  method: "POST" as const,
  path: "/v2/deposit/quote",
  bodySha256: "a".repeat(64),
  issuedAtMs: Date.parse("2026-10-23T09:00:00.123Z"),
  nonce: "3b0f6f0e-1f7c-4c55-8d0e-6b2f7f9a4e21",
};

describe("holder proof message", () => {
  it("round-trips exactly", () => {
    const text = holderProofMessage(fields);
    expect(parseHolderProofMessage(text)).toEqual(fields);
    expect(text.split("\n")[0]).toBe("Ballast holder proof");
  });

  it("refuses any extra, missing, reordered or malformed line", () => {
    const text = holderProofMessage(fields);
    const lines = text.split("\n");
    const variants = [
      `${text}\n`,
      lines.slice(1).join("\n"),
      [lines[0], lines[2], lines[1], ...lines.slice(3)].join("\n"),
      text.replace("Version: 1", "Version: 2"),
      text.replace("POST /v2/deposit/quote", "GET /v2/deposit/quote"),
      text.replace("/v2/deposit/quote", "/v2/deposit/quote?x=1"),
      text.replace("a".repeat(64), "A".repeat(64)),
      text.replace(fields.nonce, fields.nonce.toUpperCase()),
      text.replace("09:00:00.123Z", "09:00:00Z"),
      signInMessage({
        domain: "ballast",
        address: fields.address,
        stakeAddress: "stake1x",
        nonce: fields.nonce,
        issuedAtMs: fields.issuedAtMs,
      }),
    ];
    for (const v of variants) expect("error" in parseHolderProofMessage(v), v).toBe(true);
  });
});

describe("canonical JSON", () => {
  it("matches @ballast/core's RFC 8785 canonicalize on the bodies Ballast signs", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string(),
          fc.oneof(fc.string(), fc.array(fc.string()), fc.boolean(), fc.integer()),
        ),
        (o) => {
          expect(canonicalJson(o)).toBe(canonicalize(o));
        },
      ),
      { numRuns: 500 },
    );
  });

  it("refuses values that do not serialize one way", () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
    expect(() => canonicalJson({ a: 1n })).toThrow();
    expect(() => canonicalJson(new Date())).toThrow();
    expect(canonicalJson({ b: "2", a: ["x"], c: undefined })).toBe('{"a":["x"],"b":"2"}');
  });

  it("hashes with WebCrypto exactly like node:crypto", async () => {
    const body = { blockchain: "cardano", asset_symbol: "ADA", asset_amount: "25000000" };
    const want = createHash("sha256").update(canonicalJson(body)).digest("hex");
    expect(await bodySha256(body)).toBe(want);
    expect(await sha256HexOf("")).toBe(createHash("sha256").update("").digest("hex"));
  });
});

describe("consent", () => {
  it("commits to r, max short, the attestation and the risk text hash", () => {
    const risk = createHash("sha256").update(RISK_DISCLOSURE).digest("hex");
    const text = consentMessage({
      accountId: fields.accountId,
      address: fields.address,
      stakeAddress: "stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw",
      rBps: 5000,
      maxShortBase: 12_500_500_000n,
      feeShareBps: 10,
      riskSha256: risk,
      nonce: fields.nonce,
      issuedAtMs: fields.issuedAtMs,
    });
    expect(text).toContain("Cover ratio r: 0.50 (5000 bps)");
    expect(text).toContain("Max short: 12500.5 NIGHT");
    expect(text).toContain(GEOFENCE_STATEMENT);
    expect(text).toContain(risk);
    expect(RISK_DISCLOSURE).toMatch(/Zero-funding line/);
  });
});
