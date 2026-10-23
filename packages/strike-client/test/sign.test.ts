import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ApiWalletSigner,
  EMPTY_BODY_SHA256,
  logonSigningMessage,
  publicKeyHex,
  restSigningMessage,
  sha256Hex,
  verifyEd25519,
} from "../src/index.js";
import { RFC8032_PUBLIC, RFC8032_SEED } from "./helpers.js";

describe("Ed25519 key handling", () => {
  it("matches RFC 8032 test vector 1 through Node's built-in Ed25519", () => {
    const signer = ApiWalletSigner.fromSeed(RFC8032_SEED);
    expect(signer.publicKeyHex).toBe(RFC8032_PUBLIC);
    expect(signer.signHex("")).toBe(
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    );
  });

  it("accepts a 32-byte seed or a 64-byte expanded key, as bytes or hex", () => {
    const seed = Buffer.from(RFC8032_SEED, "hex");
    const expanded = Buffer.concat([seed, Buffer.from(RFC8032_PUBLIC, "hex")]);
    expect(publicKeyHex(seed)).toBe(RFC8032_PUBLIC);
    expect(publicKeyHex(expanded)).toBe(RFC8032_PUBLIC);
    expect(publicKeyHex(expanded.toString("hex"))).toBe(RFC8032_PUBLIC);
    expect(() => ApiWalletSigner.fromSeed(randomBytes(31))).toThrow(/32-byte/);
    expect(() => ApiWalletSigner.fromSeed("zz")).toThrow(/hex/);
  });

  it("refuses a 64-byte expanded key whose public half does not match its seed", () => {
    const seed = Buffer.from(RFC8032_SEED, "hex");
    const other = Buffer.from(publicKeyHex(randomBytes(32)), "hex");
    const corrupt = Buffer.concat([seed, other]);
    expect(() => ApiWalletSigner.fromSeed(corrupt)).toThrow(/public half/);
    expect(() => publicKeyHex(corrupt.toString("hex"))).toThrow(/public half/);
    const flipped = Buffer.concat([seed, Buffer.from(RFC8032_PUBLIC, "hex")]);
    flipped[63] = (flipped[63] as number) ^ 1;
    expect(() => ApiWalletSigner.fromSeed(flipped)).toThrow(/public half/);
  });

  it("never prints key material", () => {
    const seedHex = randomBytes(32).toString("hex");
    const signer = ApiWalletSigner.fromSeed(seedHex);
    const outputs = [JSON.stringify(signer), inspect(signer, { depth: 5 }), String(signer)];
    for (const out of outputs) expect(out).not.toContain(seedHex);
    expect(JSON.parse(JSON.stringify(signer))).toEqual({ publicKeyHex: signer.publicKeyHex });
  });
});

describe("REST signing message", () => {
  it("is METHOD:PATH?QUERY:TS:NONCE:sha256(body), and hashes an empty body as sha256('')", () => {
    expect(sha256Hex(undefined)).toBe(EMPTY_BODY_SHA256);
    expect(sha256Hex("")).toBe(EMPTY_BODY_SHA256);
    expect(
      restSigningMessage("GET", "/v2/openOrders?symbol=BTC-USD", 1704067200, "n", undefined),
    ).toBe(`GET:/v2/openOrders?symbol=BTC-USD:1704067200:n:${EMPTY_BODY_SHA256}`);
    const body = '{"symbol":"NIGHT-USD"}';
    expect(restSigningMessage("DELETE", "/v2/order/cancel-all", 1, "n", body)).toBe(
      `DELETE:/v2/order/cancel-all:1:n:${sha256Hex(body)}`,
    );
    expect(() => restSigningMessage("get", "/v2/x", 1, "n", undefined)).toThrow(/uppercase/);
    expect(() => restSigningMessage("GET", "https://h/v2/x", 1, "n", undefined)).toThrow(/path/);
  });

  it("round-trips: every signature verifies, and any change to a signed field breaks it", () => {
    const signer = ApiWalletSigner.fromSeed(randomBytes(32));
    fc.assert(
      fc.property(
        fc.constantFrom("GET", "POST", "DELETE"),
        fc.stringMatching(/^\/v2\/[a-z]{1,12}(\?[a-z]=[0-9]{1,4})?$/),
        fc.integer({ min: 1_600_000_000, max: 2_000_000_000 }),
        fc.option(fc.json(), { nil: undefined }),
        (method, path, ts, json) => {
          const body = json === undefined ? undefined : Buffer.from(json);
          const { headers, nonce, message } = signer.signRest({
            method,
            pathWithQuery: path,
            body,
            timestampSec: ts,
          });
          expect(headers["X-API-Wallet-Nonce"]).toBe(nonce);
          expect(nonce).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          expect(headers["X-API-Wallet-Timestamp"]).toBe(String(ts));
          const sig = headers["X-API-Wallet-Signature"];
          expect(verifyEd25519(signer.publicKeyHex, message, sig)).toBe(true);
          const tampered = restSigningMessage(method, path, ts + 1, nonce, body);
          expect(verifyEd25519(signer.publicKeyHex, tampered, sig)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("uses a fresh UUIDv4 nonce for every request", () => {
    const signer = ApiWalletSigner.fromSeed(randomBytes(32));
    const nonces = new Set<string>();
    for (let i = 0; i < 2_000; i++) {
      nonces.add(
        signer.signRest({
          method: "GET",
          pathWithQuery: "/v2/account",
          body: undefined,
          timestampSec: 1,
        }).nonce,
      );
    }
    expect(nonces.size).toBe(2_000);
  });
});

describe("user-stream logon signature", () => {
  it("signs session.logon:{timestamp_ms}:{apiKey}", () => {
    const signer = ApiWalletSigner.fromSeed(RFC8032_SEED);
    const ts = 1_792_440_000_000;
    const p = signer.signLogon(ts);
    expect(p).toMatchObject({ apiKey: RFC8032_PUBLIC, timestamp: ts });
    expect(logonSigningMessage(ts, RFC8032_PUBLIC)).toBe(`session.logon:${ts}:${RFC8032_PUBLIC}`);
    expect(
      verifyEd25519(RFC8032_PUBLIC, `session.logon:${ts}:${RFC8032_PUBLIC}`, p.signature),
    ).toBe(true);
    expect(() => signer.signLogon(1.5)).toThrow(/integer ms/);
  });
});
