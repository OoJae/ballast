import { createPublicKey, verify } from "node:crypto";
import * as MS from "@emurgo/cardano-message-signing-nodejs";
import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import { addressBytesHex, paymentKeyHashOf } from "./address.js";
import { type DataSignature, hexToBytes, parseStrikeSignature, WalletError } from "./cip30.js";

/**
 * Server-side CIP-8 / CIP-30 `signData` verification: the checks Strike documents for Builder
 * Connect and withdrawals, applied before anything is forwarded or trusted.
 * - COSE_Sign1 with EdDSA in the protected header and the signer's `address` there too;
 * - the payload is attached, unhashed and byte-equal to what was asked for;
 * - the COSE_Key is an OKP Ed25519 key whose blake2b-224 hash is the address's payment key;
 * - the address is exactly the one expected (Strike: "sign with the same address you sent");
 * - the Ed25519 signature verifies over the COSE Sig_structure ("Signature1").
 */
export type CoseVerdict =
  | { ok: true; address: string; publicKeyHex: string; paymentKeyHash: string; payloadHex: string }
  | { ok: false; reason: string };

export interface CoseExpectation {
  /** The bech32 address the signature must bind to. */
  address: string;
  /** The exact payload the wallet was asked to sign. */
  payloadHex: string;
}

const COSE_KTY_OKP = 1;
const COSE_ALG_EDDSA = -8;
const COSE_CRV_ED25519 = 6;
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

const intLabel = (n: number) => MS.Label.new_int(MS.Int.new_i32(n));
const labelInt = (l: MS.Label | undefined): number | undefined => l?.as_int()?.as_i32();

function fail(reason: string): CoseVerdict {
  return { ok: false, reason };
}

/** blake2b-224 of a raw Ed25519 public key: a Cardano key hash. */
export function keyHashOf(publicKey: Uint8Array): string {
  const pk = CSL.PublicKey.from_bytes(publicKey);
  try {
    const h = pk.hash();
    try {
      return h.to_hex();
    } finally {
      h.free();
    }
  } finally {
    pk.free();
  }
}

function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519, publicKey]),
      format: "der",
      type: "spki",
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

/** Accepts a DataSignature or either string form Strike accepts. */
export function verifyCip8(
  signature: DataSignature | string,
  expect: CoseExpectation,
): CoseVerdict {
  let ds: DataSignature;
  try {
    ds = typeof signature === "string" ? parseStrikeSignature(signature) : signature;
  } catch (err) {
    return fail(err instanceof WalletError ? err.message : "unreadable signature");
  }
  let wantAddress: string;
  let wantPayment: string | null;
  let wantPayload: Uint8Array;
  try {
    wantAddress = addressBytesHex(expect.address);
    wantPayment = paymentKeyHashOf(expect.address);
    wantPayload = hexToBytes(expect.payloadHex);
  } catch {
    return fail("the expected address or payload is malformed");
  }
  if (wantPayment === null) return fail("the expected address has no payment key");

  let sign1: MS.COSESign1;
  let key: MS.COSEKey;
  try {
    sign1 = MS.COSESign1.from_bytes(hexToBytes(ds.signature));
  } catch {
    return fail("signature is not a COSE_Sign1");
  }
  try {
    key = MS.COSEKey.from_bytes(hexToBytes(ds.key));
  } catch {
    sign1.free();
    return fail("key is not a COSE_Key");
  }
  try {
    const headers = sign1.headers();
    const prot = headers.protected().deserialized_headers();
    if (labelInt(prot.algorithm_id()) !== COSE_ALG_EDDSA) {
      return fail("protected header must name EdDSA");
    }
    const addr = prot.header(MS.Label.new_text("address"))?.as_bytes();
    if (!addr) return fail("protected header has no address");
    const addrHex = Buffer.from(addr).toString("hex");
    if (addrHex !== wantAddress) return fail("signed with a different address");
    const hashed = headers.unprotected().header(MS.Label.new_text("hashed"))?.as_special();
    // VERIFY: Lace and Eternl send hashed=false; a hashed payload (blake2b-224 of the message)
    // is refused because Strike's docs describe only the plain payload (FRICTION 2026-10-23).
    if (hashed?.as_bool() === true) return fail("hashed payloads are not accepted");
    const payload = sign1.payload();
    if (!payload) return fail("payload is detached");
    if (!Buffer.from(payload).equals(Buffer.from(wantPayload))) {
      return fail("signed a different payload");
    }

    if (labelInt(key.key_type()) !== COSE_KTY_OKP) return fail("COSE_Key must be an OKP key");
    const alg = key.algorithm_id();
    if (alg !== undefined && labelInt(alg) !== COSE_ALG_EDDSA) {
      return fail("COSE_Key algorithm must be EdDSA");
    }
    const crv = key.header(intLabel(-1))?.as_int()?.as_i32();
    if (crv !== COSE_CRV_ED25519) return fail("COSE_Key curve must be Ed25519");
    const x = key.header(intLabel(-2))?.as_bytes();
    if (x?.length !== 32) return fail("COSE_Key has no 32-byte Ed25519 public key");
    const keyHash = keyHashOf(x);
    if (keyHash !== wantPayment) return fail("the key is not this address's payment key");

    const toVerify = sign1.signed_data().to_bytes();
    if (!ed25519Verify(x, toVerify, sign1.signature())) return fail("signature does not verify");
    return {
      ok: true,
      address: expect.address.trim().toLowerCase(),
      publicKeyHex: Buffer.from(x).toString("hex"),
      paymentKeyHash: keyHash,
      payloadHex: Buffer.from(payload).toString("hex"),
    };
  } catch (err) {
    return fail(`malformed COSE structure: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    sign1.free();
    key.free();
  }
}
