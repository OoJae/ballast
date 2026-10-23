import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnchorWalletKey, HostKek, openSealedKey, readSealedKey } from "@ballast/governance";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keysMain } from "../src/keys.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ballast-keys-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("ballast keys new-strike", () => {
  it("seals a fresh key under a new 0600 KEK and prints only the public key", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const kek = join(dir, "host.kek");
    const out = join(dir, "d1.key.json");
    expect(keysMain(["new-strike", "--out", out, "--kek", kek])).toBe(0);
    expect(statSync(kek).mode & 0o777).toBe(0o600);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const sealed = readSealedKey(out);
    const key = openSealedKey(sealed, HostKek.load(kek), "strike");
    expect(key.publicKeyHex).toBe(sealed.publicKeyHex);
    const printed = log.mock.calls.flat().join("\n");
    expect(printed).toContain(sealed.publicKeyHex);
    expect(printed).not.toContain(readFileSync(kek, "utf8").trim());
    expect(printed).not.toContain(sealed.ct);
  });

  it("never overwrites an existing sealed key", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const kek = join(dir, "host.kek");
    const out = join(dir, "k.json");
    expect(keysMain(["new-strike", "--out", out, "--kek", kek])).toBe(0);
    expect(keysMain(["new-strike", "--out", out, "--kek", kek])).toBe(2);
    expect(err.mock.calls.flat().join(" ")).toMatch(/already exists/);
  });

  it("prints usage for unknown subcommands", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(keysMain(["export"])).toBe(2);
  });
});

describe("ballast keys new-anchor", () => {
  it("seals an anchor key and prints a preprod enterprise address that matches it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const kek = join(dir, "host.kek");
    const out = join(dir, "anchor.json");
    expect(keysMain(["new-anchor", "--network", "preprod", "--out", out, "--kek", kek])).toBe(0);
    const { anchorAddress } = await import("../src/keys.js");
    const key = openSealedKey(readSealedKey(out), HostKek.load(kek), "anchor") as AnchorWalletKey;
    const addr = anchorAddress(key, "preprod");
    expect(addr.startsWith("addr_test1")).toBe(true);
    expect(log.mock.calls.flat().join("\n")).toContain(addr);
  });

  it("requires a network", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(keysMain(["new-anchor", "--out", join(dir, "a.json"), "--kek", join(dir, "k")])).toBe(2);
  });
});
