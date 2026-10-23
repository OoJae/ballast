import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { inspect } from "node:util";

// RFC 8410 DER wrappers, so Node's built-in Ed25519 can take a raw 32-byte seed or public key.
const PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PUBLIC_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** SHA-256 of empty input: the body hash for GETs and bodiless requests (never ""). */
export const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A 32-byte seed or 64-byte expanded key, as bytes or hex (Strike: "64 or 128 hex characters"). */
export type KeyMaterial = Uint8Array | string;

function keyBytes(key: KeyMaterial): Buffer {
  let bytes: Buffer;
  if (typeof key === "string") {
    if (!/^(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/.test(key)) {
      throw new TypeError("API wallet key must be 64 or 128 hex characters");
    }
    bytes = Buffer.from(key, "hex");
  } else {
    bytes = Buffer.from(key);
  }
  if (bytes.length !== 32 && bytes.length !== 64) {
    bytes.fill(0);
    throw new TypeError("API wallet key must be a 32-byte seed or a 64-byte expanded key");
  }
  return bytes;
}

function rawPublicKeyHex(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return spki.subarray(SPKI_PUBLIC_PREFIX.length).toString("hex");
}

function privateKeyFromSeed(key: KeyMaterial): KeyObject {
  const bytes = keyBytes(key);
  // An expanded key is seed ‖ public key (Go's ed25519.PrivateKey); only the seed signs.
  const der = Buffer.concat([PKCS8_SEED_PREFIX, bytes.subarray(0, 32)]);
  try {
    const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    // A mismatched second half means a corrupt or mispasted key: Go clients would sign with the
    // wrong public key, so refuse it rather than silently use a different identity.
    if (bytes.length === 64 && rawPublicKeyHex(privateKey) !== bytes.toString("hex", 32)) {
      throw new TypeError("expanded API wallet key: the public half does not match the seed");
    }
    return privateKey;
  } finally {
    bytes.fill(0);
    der.fill(0);
  }
}

/** The lowercase 64-hex public key Strike registers (it looks keys up by exact string). */
export function publicKeyHex(key: KeyMaterial): string {
  return rawPublicKeyHex(privateKeyFromSeed(key));
}

export function sha256Hex(body: Uint8Array | string | undefined): string {
  if (body === undefined || body.length === 0) return EMPTY_BODY_SHA256;
  return createHash("sha256").update(body).digest("hex");
}

/**
 * The REST signing message, per strike-auth: `{METHOD}:{PATH}:{TIMESTAMP}:{NONCE}:{BODY_HASH}`,
 * where PATH is the path plus `?` and the raw query exactly as sent.
 */
export function restSigningMessage(
  method: string,
  pathWithQuery: string,
  timestampSec: number,
  nonce: string,
  body: Uint8Array | string | undefined,
): string {
  if (method !== method.toUpperCase()) throw new TypeError("method must be uppercase as sent");
  if (!pathWithQuery.startsWith("/")) throw new TypeError("sign the path, not a URL");
  if (!Number.isSafeInteger(timestampSec)) throw new TypeError("timestamp must be whole seconds");
  return `${method}:${pathWithQuery}:${timestampSec}:${nonce}:${sha256Hex(body)}`;
}

/** The user-stream logon message, per strike-userstream: `session.logon:{timestamp_ms}:{apiKey}`. */
export function logonSigningMessage(timestampMs: number, apiKeyHex: string): string {
  if (!Number.isSafeInteger(timestampMs)) throw new TypeError("logon timestamp must be integer ms");
  return `session.logon:${timestampMs}:${apiKeyHex}`;
}

export interface SignedHeaders {
  "X-API-Wallet-Public-Key": string;
  "X-API-Wallet-Signature": string;
  "X-API-Wallet-Timestamp": string;
  "X-API-Wallet-Nonce": string;
}

export interface LogonParams {
  apiKey: string;
  signature: string;
  timestamp: number;
}

export interface RestSignInput {
  method: string;
  pathWithQuery: string;
  /** The exact bytes that will be sent; serialize once and pass the same buffer to fetch. */
  body: Uint8Array | undefined;
  timestampSec: number;
}

/**
 * Holds one API wallet key. The seed is wiped after import; the KeyObject never prints its
 * material, and toJSON/inspect show only the public key, so a stray log line cannot leak it.
 */
export class ApiWalletSigner {
  readonly publicKeyHex: string;
  readonly #key: KeyObject;

  private constructor(key: KeyObject) {
    this.#key = key;
    this.publicKeyHex = rawPublicKeyHex(key);
  }

  static fromSeed(key: KeyMaterial): ApiWalletSigner {
    return new ApiWalletSigner(privateKeyFromSeed(key));
  }

  /** Hex Ed25519 signature over the UTF-8 bytes of `message`. */
  signHex(message: string): string {
    return sign(null, Buffer.from(message, "utf8"), this.#key).toString("hex");
  }

  /** Signs one REST request with a fresh UUIDv4 nonce. Callers cannot choose or reuse a nonce. */
  signRest(input: RestSignInput): { headers: SignedHeaders; nonce: string; message: string } {
    const nonce = randomUUID();
    const message = restSigningMessage(
      input.method,
      input.pathWithQuery,
      input.timestampSec,
      nonce,
      input.body,
    );
    return {
      nonce,
      message,
      headers: {
        "X-API-Wallet-Public-Key": this.publicKeyHex,
        "X-API-Wallet-Signature": this.signHex(message),
        "X-API-Wallet-Timestamp": String(input.timestampSec),
        "X-API-Wallet-Nonce": nonce,
      },
    };
  }

  signLogon(timestampMs: number): LogonParams {
    return {
      apiKey: this.publicKeyHex,
      signature: this.signHex(logonSigningMessage(timestampMs, this.publicKeyHex)),
      timestamp: timestampMs,
    };
  }

  toJSON(): { publicKeyHex: string } {
    return { publicKeyHex: this.publicKeyHex };
  }

  [inspect.custom](): string {
    return `ApiWalletSigner(${this.publicKeyHex})`;
  }
}

/** Ed25519 verification against a raw 64-hex public key (used by tests and tooling). */
export function verifyEd25519(pubHex: string, message: string, signatureHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(pubHex) || !/^[0-9a-fA-F]{128}$/.test(signatureHex)) return false;
  const key = createPublicKey({
    key: Buffer.concat([SPKI_PUBLIC_PREFIX, Buffer.from(pubHex, "hex")]),
    format: "der",
    type: "spki",
  });
  return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureHex, "hex"));
}
