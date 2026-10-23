import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, inspect } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  AnchorWalletKey,
  DaemonKey,
  HostKek,
  OperatorKey,
  openSealedKey,
  readSealedKey,
  SIG_DOMAIN,
  StrikeKey,
  scrubSecrets,
  signPolicy,
  verifyDomainSignature,
  writeSealedKey,
} from "../src/index.js";
import { samplePolicy, seed } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "ballast-keys-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HASH = "ab".repeat(32);

describe("three keys that cannot be confused", () => {
  it("each role signs only its own domains, and signatures do not cross domains", () => {
    const op = OperatorKey.fromSeed(seed("op"));
    const dm = DaemonKey.fromSeed(seed("dm"));
    const policySig = op.signPolicyHash(HASH);
    expect(verifyDomainSignature(op.publicKeyHex, SIG_DOMAIN.policy, HASH, policySig)).toBe(true);
    expect(verifyDomainSignature(op.publicKeyHex, SIG_DOMAIN.decision, HASH, policySig)).toBe(
      false,
    );
    expect(
      verifyDomainSignature(op.publicKeyHex, SIG_DOMAIN.renewalEnvelope, HASH, policySig),
    ).toBe(false);
    const decisionSig = dm.signDecisionHash(HASH);
    expect(verifyDomainSignature(dm.publicKeyHex, SIG_DOMAIN.decision, HASH, decisionSig)).toBe(
      true,
    );
    expect(verifyDomainSignature(dm.publicKeyHex, SIG_DOMAIN.policy, HASH, decisionSig)).toBe(
      false,
    );
    expect(verifyDomainSignature(dm.publicKeyHex, SIG_DOMAIN.criticReport, HASH, decisionSig)).toBe(
      false,
    );
    // A daemon has no method that signs policies; the compiler refuses one where an operator goes.
    // @ts-expect-error DaemonKey is not an OperatorKey
    expect(() => signPolicy(samplePolicy(), dm)).toThrow(/operator/);
    // @ts-expect-error a StrikeKey is not an AnchorWalletKey
    const _wrong: AnchorWalletKey = StrikeKey.fromSeed(seed("strike"));
    expect(_wrong.role).toBe("strike");
  });

  it("only signs lowercase 64-hex hashes", () => {
    const op = OperatorKey.fromSeed(seed("op"));
    expect(() => op.signPolicyHash("AB".repeat(32))).toThrow(/64-hex/);
    expect(() => op.signPolicyHash("not a hash")).toThrow(/64-hex/);
  });

  it("lends seeds only synchronously and wipes the loan", () => {
    const sk = StrikeKey.fromSeed(seed("strike"));
    let loaned: Uint8Array | undefined;
    sk.useSeed((s) => {
      loaned = s;
      expect(Buffer.from(s).equals(seed("strike"))).toBe(true);
    });
    expect(loaned && Buffer.from(loaned).every((b) => b === 0)).toBe(true);
    expect(() => sk.useSeed(async () => 1)).toThrow(/synchronous/);
  });
});

describe("keys at rest (AES-256-GCM under a per-host KEK)", () => {
  it("round-trips each role and binds the role and public key into the tag", () => {
    const kek = HostKek.generate();
    for (const key of [
      OperatorKey.generate(),
      DaemonKey.generate(),
      StrikeKey.generate(),
      AnchorWalletKey.generate(),
    ]) {
      const sealed = key.seal(kek, 1);
      const opened = openSealedKey(sealed, kek, key.role);
      expect(opened.publicKeyHex).toBe(key.publicKeyHex);
      expect(opened.role).toBe(key.role);
    }
    const op = OperatorKey.generate();
    const sealed = op.seal(kek);
    // Asking for another role is refused before decryption.
    expect(() => openSealedKey(sealed, kek, "daemon")).toThrow(/refusing to open a operator key/);
    // Relabeling the file's role breaks the GCM tag (AAD), so it cannot be smuggled in either.
    expect(() => openSealedKey({ ...sealed, role: "daemon" }, kek, "daemon")).toThrow(
      /wrong KEK or tampered/,
    );
    expect(() =>
      openSealedKey(
        { ...sealed, publicKeyHex: DaemonKey.generate().publicKeyHex },
        kek,
        "operator",
      ),
    ).toThrow(/wrong KEK or tampered/);
    const ct = Buffer.from(sealed.ct, "base64");
    ct[0] = (ct[0] as number) ^ 1;
    expect(() => openSealedKey({ ...sealed, ct: ct.toString("base64") }, kek, "operator")).toThrow(
      /tampered/,
    );
    expect(() => openSealedKey(sealed, HostKek.generate(), "operator")).toThrow(/wrong KEK/);
  });

  it("creates the KEK file 0600, never overwrites it, and refuses a readable one", () => {
    const path = join(dir, "host.kek");
    const kek = HostKek.create(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => HostKek.create(path)).toThrow();
    const again = HostKek.load(path);
    const sealed = OperatorKey.fromSeed(seed("op")).seal(kek);
    expect(openSealedKey(sealed, again, "operator").publicKeyHex).toBe(
      OperatorKey.fromSeed(seed("op")).publicKeyHex,
    );
    chmodSync(path, 0o644);
    expect(() => HostKek.load(path)).toThrow(/group- or world-accessible/);
  });

  it("writes sealed key files 0600 and reads them back", () => {
    const kek = HostKek.generate();
    const path = join(dir, "daemon.key.json");
    const dm = DaemonKey.generate();
    writeSealedKey(path, dm.seal(kek));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(openSealedKey(readSealedKey(path), kek, "daemon").publicKeyHex).toBe(dm.publicKeyHex);
  });
});

describe("invariant 25: key material is never logged", () => {
  it("log-fixture grep: no seed, KEK or DER bytes in any rendering of any key", () => {
    const seeds = {
      operator: seed("scrub-operator"),
      daemon: seed("scrub-daemon"),
      strike: seed("scrub-strike"),
      anchor: seed("scrub-anchor"),
    };
    const kekBytes = seed("scrub-kek");
    const kek = HostKek.fromBytes(kekBytes);
    const keys = [
      OperatorKey.fromSeed(seeds.operator),
      DaemonKey.fromSeed(seeds.daemon),
      StrikeKey.fromSeed(seeds.strike),
      AnchorWalletKey.fromSeed(seeds.anchor),
    ];
    const sealed = keys.map((k) => k.seal(kek));
    let failure = "";
    try {
      openSealedKey(sealed[0] as (typeof sealed)[0], HostKek.generate(), "operator");
    } catch (err) {
      failure = String(err instanceof Error ? err.stack : err);
    }

    // Everything a careless log line could contain: JSON (pino calls toJSON), inspect, format
    // strings, template literals, error stacks, and the sealed files themselves.
    const lines: string[] = [];
    for (const k of keys) {
      lines.push(JSON.stringify({ msg: "key loaded", key: k, nested: { k } }));
      lines.push(inspect(k, { depth: 10, showHidden: true }));
      lines.push(format("%o %O %s %j", k, k, k, k));
      lines.push(`${k}`);
    }
    lines.push(JSON.stringify({ kek }), inspect(kek, { showHidden: true }), `${kek}`, failure);
    lines.push(...sealed.map((s) => JSON.stringify(s)));
    const fixture = join(dir, "scrub.log");
    writeFileSync(fixture, `${lines.join("\n")}\n`);
    const log = readFileSync(fixture, "utf8");

    const forms = (b: Buffer) => [
      b.toString("hex"),
      b.toString("hex").toUpperCase(),
      b.toString("base64"),
      b.toString("base64url"),
      Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), b]).toString("hex"),
    ];
    for (const b of [...Object.values(seeds), kekBytes]) {
      for (const f of forms(b)) expect(log.includes(f), `leaked ${f.slice(0, 8)}…`).toBe(false);
    }
    // Public keys are fine to log; they are what auditors check signatures against.
    for (const k of keys) expect(log).toContain(k.publicKeyHex);
  });

  it("scrubSecrets removes hex and base64 renderings from free text", () => {
    const s = seed("x");
    const text = `seed=${s.toString("hex")} b64=${s.toString("base64")} url=${s.toString("base64url")}`;
    const out = scrubSecrets(text, [s]);
    expect(out).toBe("seed=[redacted] b64=[redacted] url=[redacted]");
    expect(scrubSecrets("token sk-ant-xyz123456 end", ["sk-ant-xyz123456"])).toBe(
      "token [redacted] end",
    );
  });
});
