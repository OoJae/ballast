import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQuotePolicy, type QuotePolicy } from "@ballast/core";
import {
  checkPolicySignature,
  HostKek,
  OperatorKey,
  type SignedPolicy,
  writeSealedKey,
} from "@ballast/governance";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newUlid, policyMain } from "../src/policy.js";

const T0 = Date.parse("2026-10-23T09:00:00Z");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ballast-policy-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function operatorFiles() {
  const kekPath = join(dir, "host.kek");
  const kek = HostKek.create(kekPath);
  const operator = OperatorKey.generate();
  const keyPath = join(dir, "operator.json");
  writeSealedKey(keyPath, operator.seal(kek));
  return { kekPath, keyPath, operator };
}

describe("newUlid", () => {
  it("is a valid ULID whose first 10 chars encode the time", () => {
    const a = newUlid(T0, () => new Uint8Array(10));
    expect(a).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(a.slice(10)).toBe("0".repeat(16));
    expect(newUlid(T0 + 1).slice(0, 10) > a.slice(0, 10)).toBe(true);
  });
});

describe("ballast policy draft + sign", () => {
  it("drafts the plan defaults and signs them into the keeper's policy directory", () => {
    const { kekPath, keyPath, operator } = operatorFiles();
    const draft = join(dir, "draft.json");
    expect(policyMain(["draft", "--out", draft, "--hours", "12"], {}, () => T0)).toBe(0);
    const p = parseQuotePolicy(JSON.parse(readFileSync(draft, "utf8")));
    expect(p.market).toBe("NIGHT-USD");
    expect(p.validUntilMs - p.validFromMs).toBe(12 * 3_600_000);
    expect(p.pricing.minOffsetBps).toBe(38);

    const outDir = join(dir, "policies");
    const args = [
      "sign",
      "--draft",
      draft,
      "--key",
      keyPath,
      "--out-dir",
      outDir,
      "--kek",
      kekPath,
    ];
    expect(policyMain(args, {}, () => T0)).toBe(0);
    const [file] = readdirSync(outDir);
    expect(file).toBe(`${p.policyId}.policy.json`);
    const signed = JSON.parse(
      readFileSync(join(outDir, file as string), "utf8"),
    ) as SignedPolicy<QuotePolicy>;
    expect(checkPolicySignature(signed, [operator.publicKeyHex]).passed).toBe(true);
    // Never overwritten.
    expect(policyMain(args, {}, () => T0)).toBe(2);
  });

  it("refuses to sign a policy the schema rejects, or one already expired", () => {
    const { kekPath, keyPath } = operatorFiles();
    const draft = join(dir, "draft.json");
    expect(policyMain(["draft", "--out", draft], {}, () => T0)).toBe(0);
    const p = JSON.parse(readFileSync(draft, "utf8"));
    const sign = (nowMs: number) =>
      policyMain(
        [
          "sign",
          "--draft",
          draft,
          "--key",
          keyPath,
          "--out-dir",
          join(dir, "out"),
          "--kek",
          kekPath,
        ],
        {},
        () => nowMs,
      );
    writeFileSync(draft, JSON.stringify({ ...p, pricing: { ...p.pricing, minOffsetBps: 10 } }));
    expect(sign(T0)).toBe(2);
    writeFileSync(draft, JSON.stringify(p));
    expect(sign(p.validUntilMs)).toBe(2);
    expect(sign(T0)).toBe(0);
  });
});

describe("ballast policy envelope", () => {
  it("pre-authorizes renewals of a signed policy, refusing a foreign operator or too many", () => {
    const { kekPath, keyPath } = operatorFiles();
    const draft = join(dir, "draft.json");
    const outDir = join(dir, "policies");
    expect(policyMain(["draft", "--out", draft], {}, () => T0)).toBe(0);
    expect(
      policyMain(
        ["sign", "--draft", draft, "--key", keyPath, "--out-dir", outDir, "--kek", kekPath],
        {},
        () => T0,
      ),
    ).toBe(0);
    const policyFile = join(outDir, readdirSync(outDir)[0] as string);
    const env = (n: string, key = keyPath) =>
      policyMain(
        [
          "envelope",
          "--policy",
          policyFile,
          "--renewals",
          n,
          "--key",
          key,
          "--out-dir",
          outDir,
          "--kek",
          kekPath,
        ],
        {},
        () => T0,
      );
    expect(env("8")).toBe(2);
    const other = join(dir, "other.json");
    writeSealedKey(other, OperatorKey.generate().seal(HostKek.load(kekPath)));
    expect(env("7", other)).toBe(2);
    expect(env("7")).toBe(0);
    const file = readdirSync(outDir).find((f) => f.endsWith(".envelope.json")) as string;
    const signed = JSON.parse(readFileSync(join(outDir, file), "utf8"));
    expect(signed.envelope.maxRenewals).toBe(7);
  });
});
