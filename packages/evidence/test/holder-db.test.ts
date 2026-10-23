import { describe, expect, it } from "vitest";
import { bundleFromDb } from "../src/bundle.js";
import { openEvidenceDb } from "../src/db.js";

const T0 = Date.parse("2026-10-23T09:00:00Z");
const STAKE = `stake1u${"q".repeat(52)}`;
const OTHER = `stake1u${"p".repeat(52)}`;
const ADDR = `addr1q${"x".repeat(98)}`;
const H = (c: string) => c.repeat(64);

describe("holder onboarding rows", () => {
  it("stores geofence attestations without any IP data", () => {
    const db = openEvidenceDb(":memory:");
    db.insertAttestation({
      stakeCred: STAKE,
      address: ADDR,
      kind: "geofence",
      statementHash: H("a"),
      listUrl: "https://www.strikefinance.org/restricted",
      attestedAtMs: T0,
    });
    expect(db.attestations(STAKE)).toHaveLength(1);
    expect(() =>
      db.insertAttestation({
        stakeCred: STAKE,
        address: ADDR,
        kind: "geofence",
        statementHash: "nothex",
        listUrl: "https://x",
        attestedAtMs: T0,
      }),
    ).toThrow(/CHECK/);
    db.close();
  });

  it("keeps exactly one active API wallet per account; rotation revokes the old one", () => {
    const db = openEvidenceDb(":memory:");
    db.bindAccount({ accountId: "acct-1", stakeCred: STAKE, nowMs: T0 });
    db.rotateHolderWallet({
      publicKey: H("1"),
      accountId: "acct-1",
      address: ADDR,
      keyPath: "/keys/1.json",
      createdAtMs: T0,
    });
    db.rotateHolderWallet({
      publicKey: H("2"),
      accountId: "acct-1",
      address: ADDR,
      keyPath: "/keys/2.json",
      createdAtMs: T0 + 1,
    });
    expect(db.activeHolderWallet("acct-1")).toMatchObject({ publicKey: H("2"), status: "active" });
    expect(db.holderWallets("acct-1").map((w) => [w.publicKey, w.status, w.revokedAtMs])).toEqual([
      [H("1"), "revoked", T0 + 1],
      [H("2"), "active", null],
    ]);
    expect(() =>
      db.rotateHolderWallet({
        publicKey: H("2"),
        accountId: "acct-1",
        address: ADDR,
        keyPath: "/keys/2.json",
        createdAtMs: T0 + 2,
      }),
    ).toThrow(/UNIQUE/);
    // The failed rotation rolled back: the active key is unchanged.
    expect(db.activeHolderWallet("acct-1")?.publicKey).toBe(H("2"));
    db.close();
  });

  it("a consent must come from the bound stake credential and sets the account's r", () => {
    const db = openEvidenceDb(":memory:");
    db.bindAccount({ accountId: "acct-1", stakeCred: STAKE, nowMs: T0 });
    const consent = {
      hash: H("c"),
      accountId: "acct-1",
      stakeCred: STAKE,
      rBps: 7000,
      maxShortBase: "25000000000",
      feeShareBps: 10,
      signatureHash: H("d"),
      signedAtMs: T0,
    };
    expect(() => db.recordConsent({ ...consent, stakeCred: OTHER })).toThrow(
      /bound to the account/,
    );
    expect(() => db.recordConsent({ ...consent, rBps: 9500 })).toThrow(/CHECK/);
    db.recordConsent(consent);
    expect(db.latestConsent("acct-1")).toEqual(consent);
    expect(db.account("acct-1")?.rBps).toBe(7000);
    db.close();
  });

  it("advances one funding row per request and never lets another account touch it", () => {
    const db = openEvidenceDb(":memory:");
    db.bindAccount({ accountId: "acct-1", stakeCred: STAKE, nowMs: T0 });
    db.bindAccount({ accountId: "acct-2", stakeCred: OTHER, nowMs: T0 });
    const base = {
      accountId: "acct-1",
      kind: "deposit" as const,
      requestId: "r1",
      asset: "ADA" as const,
      amountBase: "100000000",
      usdValue: "35",
      txHash: null,
    };
    db.recordFunding({ ...base, status: "quoted", nowMs: T0 });
    db.recordFunding({
      ...base,
      amountBase: null,
      usdValue: null,
      txHash: H("e"),
      status: "submitted",
      nowMs: T0 + 5,
    });
    db.recordFunding({ ...base, accountId: "acct-2", status: "failed", nowMs: T0 + 9 });
    const rows = db.fundingEvents("acct-1");
    expect(rows).toEqual([
      { ...base, txHash: H("e"), status: "submitted", createdAtMs: T0, updatedAtMs: T0 + 5 },
    ]);
    expect(db.fundingEvents("acct-2")).toEqual([]);
    db.close();
  });

  it("none of these rows reaches the public evidence bundle", () => {
    const db = openEvidenceDb(":memory:");
    db.bindAccount({ accountId: "acct-1", stakeCred: STAKE, nowMs: T0 });
    db.insertAttestation({
      stakeCred: STAKE,
      address: ADDR,
      kind: "geofence",
      statementHash: H("a"),
      listUrl: "https://www.strikefinance.org/restricted",
      attestedAtMs: T0,
    });
    const text = JSON.stringify(bundleFromDb(db));
    expect(text).not.toContain(ADDR);
    expect(text).not.toContain(STAKE);
    db.close();
  });
});
