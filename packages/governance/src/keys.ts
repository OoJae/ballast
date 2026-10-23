import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { inspect } from "node:util";
import { canonicalize } from "@ballast/core";
import { HEX64_RE, HEX128_RE } from "./types.js";

/**
 * Ballast's keys, kept apart by type and by signature domain (invariant 25 and §6):
 * - operator: offline; signs policies and renewal envelopes only;
 * - daemon: host A; signs decision records, Critic reports, renewals and heartbeats only;
 * - strike: one Strike API wallet per holder; handed to the Strike signer, never signs evidence;
 * - anchor: the CIP-20 hot wallet (≤ 20 ADA); handed to the anchor transaction builder only.
 * Each class carries a distinct `role` literal, so TypeScript refuses a DaemonKey where an
 * OperatorKey is expected, and the runtime re-checks the role before every use.
 * Key material never appears in toJSON, inspect or toString output.
 */
export type KeyRole = "operator" | "daemon" | "strike" | "anchor";

/** Signature domains: a signature made for one purpose never verifies for another. */
export const SIG_DOMAIN = {
  policy: "ballast/policy/v1",
  renewalEnvelope: "ballast/renewal-envelope/v1",
  renewal: "ballast/renewal/v1",
  criticReport: "ballast/critic-report/v1",
  decision: "ballast/decision/v1",
  heartbeat: "ballast/heartbeat/v1",
} as const;
export type SigDomain = (typeof SIG_DOMAIN)[keyof typeof SIG_DOMAIN];

// RFC 8410 DER wrappers so node:crypto's Ed25519 takes a raw 32-byte seed or public key.
const PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PUBLIC_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function keyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new TypeError("an Ed25519 seed is exactly 32 bytes");
  const der = Buffer.concat([PKCS8_SEED_PREFIX, seed]);
  try {
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } finally {
    der.fill(0);
  }
}

function rawPublicHex(key: KeyObject): string {
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return spki.subarray(SPKI_PUBLIC_PREFIX.length).toString("hex");
}

/** Copies the seed out of a KeyObject; the caller must wipe the returned buffer. */
function exportSeed(key: KeyObject): Buffer {
  const der = key.export({ format: "der", type: "pkcs8" });
  const seed = Buffer.from(der.subarray(PKCS8_SEED_PREFIX.length));
  der.fill(0);
  return seed;
}

function domainMessage(domain: SigDomain, hashHex: string): Buffer {
  if (!HEX64_RE.test(hashHex)) throw new TypeError("only a lowercase 64-hex hash is signed");
  return Buffer.from(`${domain}:${hashHex}`, "utf8");
}

/** Verifies an Ed25519 signature over `<domain>:<hash>` against a raw 64-hex public key. */
export function verifyDomainSignature(
  publicKeyHex: string,
  domain: SigDomain,
  hashHex: string,
  signatureHex: string,
): boolean {
  if (!HEX64_RE.test(publicKeyHex) || !HEX128_RE.test(signatureHex) || !HEX64_RE.test(hashHex)) {
    return false;
  }
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PUBLIC_PREFIX, Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    return verify(null, domainMessage(domain, hashHex), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

abstract class Ed25519Secret<R extends KeyRole> {
  abstract readonly role: R;
  readonly publicKeyHex: string;
  readonly #key: KeyObject;

  protected constructor(key: KeyObject) {
    this.#key = key;
    this.publicKeyHex = rawPublicHex(key);
  }

  protected signFor(domain: SigDomain, hashHex: string): string {
    return sign(null, domainMessage(domain, hashHex), this.#key).toString("hex");
  }

  /** Lends the raw seed to `fn` and wipes the copy afterwards. Synchronous use only. */
  protected lendSeed<T>(fn: (seed: Uint8Array) => T): T {
    const seed = exportSeed(this.#key);
    try {
      const out = fn(seed);
      if (out instanceof Promise) throw new TypeError("useSeed callbacks must be synchronous");
      return out;
    } finally {
      seed.fill(0);
    }
  }

  /** Encrypts this key under the host key-encryption key for storage at rest. */
  seal(kek: HostKek, nowMs: number = Date.now()): SealedKey {
    return this.lendSeed((seed) => kek.sealSeed(this.role, this.publicKeyHex, seed, nowMs));
  }

  toJSON(): { role: R; publicKeyHex: string } {
    return { role: this.role, publicKeyHex: this.publicKeyHex };
  }

  toString(): string {
    return `${this.constructor.name}(${this.publicKeyHex})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/** The offline operator key: the only key that can activate a policy. */
export class OperatorKey extends Ed25519Secret<"operator"> {
  readonly role = "operator" as const;

  static fromSeed(seed: Uint8Array): OperatorKey {
    return new OperatorKey(keyFromSeed(seed));
  }

  static generate(): OperatorKey {
    return withRandomSeed((s) => OperatorKey.fromSeed(s));
  }

  signPolicyHash(hashHex: string): string {
    return this.signFor(SIG_DOMAIN.policy, hashHex);
  }

  signRenewalEnvelopeHash(hashHex: string): string {
    return this.signFor(SIG_DOMAIN.renewalEnvelope, hashHex);
  }
}

/** The daemon key on host A: signs evidence, never policies. */
export class DaemonKey extends Ed25519Secret<"daemon"> {
  readonly role = "daemon" as const;

  static fromSeed(seed: Uint8Array): DaemonKey {
    return new DaemonKey(keyFromSeed(seed));
  }

  static generate(): DaemonKey {
    return withRandomSeed((s) => DaemonKey.fromSeed(s));
  }

  signDecisionHash(hashHex: string): string {
    return this.signFor(SIG_DOMAIN.decision, hashHex);
  }

  signCriticReportHash(hashHex: string): string {
    return this.signFor(SIG_DOMAIN.criticReport, hashHex);
  }

  signRenewalHash(hashHex: string): string {
    return this.signFor(SIG_DOMAIN.renewal, hashHex);
  }

  signHeartbeatHash(hashHex: string): string {
    return this.signFor(SIG_DOMAIN.heartbeat, hashHex);
  }
}

/** One holder's Strike API wallet. Only the Strike signer may borrow its seed. */
export class StrikeKey extends Ed25519Secret<"strike"> {
  readonly role = "strike" as const;

  static fromSeed(seed: Uint8Array): StrikeKey {
    return new StrikeKey(keyFromSeed(seed));
  }

  static generate(): StrikeKey {
    return withRandomSeed((s) => StrikeKey.fromSeed(s));
  }

  useSeed<T>(fn: (seed: Uint8Array) => T): T {
    return this.lendSeed(fn);
  }
}

/** The CIP-20 anchor hot wallet's payment key. Only the anchor builder may borrow its seed. */
export class AnchorWalletKey extends Ed25519Secret<"anchor"> {
  readonly role = "anchor" as const;

  static fromSeed(seed: Uint8Array): AnchorWalletKey {
    return new AnchorWalletKey(keyFromSeed(seed));
  }

  static generate(): AnchorWalletKey {
    return withRandomSeed((s) => AnchorWalletKey.fromSeed(s));
  }

  useSeed<T>(fn: (seed: Uint8Array) => T): T {
    return this.lendSeed(fn);
  }
}

function withRandomSeed<T>(fn: (seed: Uint8Array) => T): T {
  const seed = randomBytes(32);
  try {
    return fn(seed);
  } finally {
    seed.fill(0);
  }
}

/** A key at rest: AES-256-GCM under the host KEK, with role and public key bound as AAD. */
export interface SealedKey {
  v: 1;
  role: KeyRole;
  alg: "aes-256-gcm";
  publicKeyHex: string;
  iv: string;
  tag: string;
  ct: string;
  createdMs: number;
}

function sealedAad(s: Pick<SealedKey, "v" | "role" | "alg" | "publicKeyHex">): Buffer {
  return Buffer.from(
    canonicalize({ alg: s.alg, publicKeyHex: s.publicKeyHex, role: s.role, v: s.v }),
    "utf8",
  );
}

/**
 * The per-host key-encryption key (32 bytes). It lives in a 0600 file outside the repo; key
 * files are useless without it, and swapping a sealed key's role or public key breaks the GCM
 * tag, so a daemon key file can never be opened as an operator key.
 */
export class HostKek {
  readonly #bytes: Buffer;

  private constructor(bytes: Buffer) {
    this.#bytes = bytes;
  }

  static fromBytes(bytes: Uint8Array): HostKek {
    if (bytes.length !== 32) throw new TypeError("a host KEK is exactly 32 bytes");
    return new HostKek(Buffer.from(bytes));
  }

  static generate(): HostKek {
    return new HostKek(randomBytes(32));
  }

  /** Reads a KEK file (64 hex chars), refusing one that group or others can read. */
  static load(path: string): HostKek {
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
      throw new Error(`refusing host KEK ${path}: it must not be group- or world-accessible`);
    }
    const text = readFileSync(path, "utf8").trim();
    if (!HEX64_RE.test(text)) throw new Error(`host KEK ${path} must hold 64 lowercase hex chars`);
    return new HostKek(Buffer.from(text, "hex"));
  }

  /** Creates a new KEK file with mode 0600; never overwrites an existing one. */
  static create(path: string): HostKek {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const kek = HostKek.generate();
    writeFileSync(path, `${kek.#bytes.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    return kek;
  }

  /** @internal Used by Ed25519Secret.seal. */
  sealSeed(role: KeyRole, publicKeyHex: string, seed: Uint8Array, nowMs: number): SealedKey {
    const head = { v: 1 as const, role, alg: "aes-256-gcm" as const, publicKeyHex };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#bytes, iv);
    cipher.setAAD(sealedAad(head));
    const ct = Buffer.concat([cipher.update(seed), cipher.final()]);
    return {
      ...head,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
      createdMs: nowMs,
    };
  }

  /** @internal Decrypts a sealed seed into a buffer the caller must wipe. */
  openSeed(sealed: SealedKey): Buffer {
    const decipher = createDecipheriv("aes-256-gcm", this.#bytes, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(sealedAad(sealed));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    try {
      return Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]);
    } catch {
      // The underlying error says nothing secret, but a fixed message keeps logs uniform.
      throw new Error(`cannot open sealed ${sealed.role} key: wrong KEK or tampered file`);
    }
  }

  toJSON(): { kek: "[redacted]" } {
    return { kek: "[redacted]" };
  }

  toString(): string {
    return "HostKek([redacted])";
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

type KeyByRole = {
  operator: OperatorKey;
  daemon: DaemonKey;
  strike: StrikeKey;
  anchor: AnchorWalletKey;
};

const FACTORIES: { [R in KeyRole]: (seed: Uint8Array) => KeyByRole[R] } = {
  operator: (s) => OperatorKey.fromSeed(s),
  daemon: (s) => DaemonKey.fromSeed(s),
  strike: (s) => StrikeKey.fromSeed(s),
  anchor: (s) => AnchorWalletKey.fromSeed(s),
};

/** Opens a sealed key as exactly `role`; any other role is refused before decryption. */
export function openSealedKey<R extends KeyRole>(
  sealed: SealedKey,
  kek: HostKek,
  role: R,
): KeyByRole[R] {
  if (sealed.v !== 1 || sealed.alg !== "aes-256-gcm") throw new Error("unsupported sealed key");
  if (sealed.role !== role) {
    throw new Error(`refusing to open a ${sealed.role} key as a ${role} key`);
  }
  const seed = kek.openSeed(sealed);
  try {
    const key = FACTORIES[role](seed);
    if (key.publicKeyHex !== sealed.publicKeyHex) {
      throw new Error(`sealed ${role} key does not match its recorded public key`);
    }
    return key;
  } finally {
    seed.fill(0);
  }
}

export function writeSealedKey(path: string, sealed: SealedKey): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(sealed, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

export function readSealedKey(path: string): SealedKey {
  return JSON.parse(readFileSync(path, "utf8")) as SealedKey;
}

/** Replaces every occurrence of each secret (and its hex/base64 forms) in a log line. */
export function scrubSecrets(text: string, secrets: readonly (string | Uint8Array)[]): string {
  let out = text;
  for (const s of secrets) {
    const forms =
      typeof s === "string"
        ? [s]
        : [
            Buffer.from(s).toString("hex"),
            Buffer.from(s).toString("base64"),
            Buffer.from(s).toString("base64url"),
          ];
    for (const f of forms) if (f.length >= 8) out = out.split(f).join("[redacted]");
  }
  return out;
}
