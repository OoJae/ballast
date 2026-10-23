import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signDataForStrike, utf8ToHex } from "@ballast/cardano";
import { TestWallet } from "@ballast/cardano/testing";
import type { KoiosReader, KoiosUtxo } from "@ballast/cover";
import { openEvidenceDb } from "@ballast/evidence/db";
import { FakeStrike } from "@ballast/fake-strike";
import { HostKek, StrikeKey, writeSealedKey } from "@ballast/governance";
import { BuilderConnectClient } from "@ballast/strike-client/funding";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DayoneArgs, parseDayoneArgs } from "../src/dayone/common.js";
import { d4Main, runD4 } from "../src/dayone/d4-builder-connect.js";
import { d5Main, runD5 } from "../src/dayone/d5-deposit.js";
import { d9Main, runD9 } from "../src/dayone/d9-withdraw.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const wallet = new TestWallet();
const ARGV = ["--address", wallet.address];

function collect() {
  const parts: string[] = [];
  return { out: (s: string) => void parts.push(s), text: () => parts.join("") };
}

describe("day-one gating", () => {
  it("is a dry run unless both --yes-i-approve and BALLAST_ARM=1 are given", () => {
    expect(parseDayoneArgs(ARGV, {}).live).toBe(false);
    expect(parseDayoneArgs(ARGV, { BALLAST_ARM: "1" }).live).toBe(false);
    expect(parseDayoneArgs([...ARGV, "--dry-run"], { BALLAST_ARM: "1" }).live).toBe(false);
    expect(() => parseDayoneArgs([...ARGV, "--yes-i-approve"], {})).toThrow(/BALLAST_ARM=1/);
    expect(() =>
      parseDayoneArgs([...ARGV, "--yes-i-approve", "--dry-run"], { BALLAST_ARM: "1" }),
    ).toThrow(/contradict/);
    expect(parseDayoneArgs([...ARGV, "--yes-i-approve"], { BALLAST_ARM: "1" }).live).toBe(true);
    expect(() => parseDayoneArgs([], {})).toThrow(/--address/);
    expect(() => parseDayoneArgs(["--address", wallet.stakeAddress], {})).toThrow(/base address/);
  });

  it("dry runs print the exact plan and the requests, and send nothing", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("no request may be sent in a dry run");
    });
    for (const [main, id] of [
      [d4Main, "D4"],
      [d5Main, "D5"],
      [d9Main, "D9"],
    ] as const) {
      const c = collect();
      const code = await main([...ARGV, "--check-revoked"], {
        fetch: fetchSpy as unknown as typeof fetch,
        out: c.out,
        env: {},
      });
      expect(code).toBe(0);
      const text = c.text();
      expect(text).toContain(`${id} · `);
      expect(text).toContain("DRY RUN: nothing is sent");
      expect(text).toContain("DRY RUN: no request was sent.");
      expect(text).toContain(
        `GET https://api.strikefinance.org/v2/account?blockchain_address=${wallet.address}`,
      );
      expect(text).toMatch(/You, with Lace/);
      expect(text).toMatch(/Evidence to capture/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

async function liveRig() {
  const fake = new FakeStrike();
  await fake.start();
  cleanups.push(() => fake.stop());
  const dir = mkdtempSync(join(tmpdir(), "ballast-dayone-"));
  const dbPath = join(dir, "evidence.sqlite");
  const args: DayoneArgs = {
    live: true,
    address: wallet.address,
    stakeAddress: wallet.stakeAddress,
    strike: fake.baseUrl,
    api: "http://127.0.0.1:1",
    db: dbPath,
    out: join(dir, "out.json"),
    timeoutMs: 10_000,
    pollMs: 10,
    checkRevoked: true,
  };
  return { fake, dir, dbPath, args };
}

/** What the holder role does on connect/finish, done directly so the watcher has something to see. */
async function humanConnects(fake: FakeStrike, dbPath: string, kek: HostKek, dir: string) {
  const key = StrikeKey.generate();
  const bc = new BuilderConnectClient({ baseUrl: fake.baseUrl, userAgent: "t" });
  const ch = await bc.requestSignature({
    address: wallet.address,
    chain: "cardano",
    code: "ballast",
    fee_share_bps: 10,
    public_key: key.publicKeyHex,
  });
  const sig = await signDataForStrike(wallet, wallet.address, utf8ToHex(ch.message_to_sign));
  const v = await bc.verifySignature({ nonce: ch.nonce, wallet_signature: sig }, key.publicKeyHex);
  const db = openEvidenceDb(dbPath);
  try {
    if (!db.accountByStake(wallet.stakeAddress)) {
      db.bindAccount({
        accountId: v.account_id,
        stakeCred: wallet.stakeAddress,
        nowMs: Date.now(),
      });
    }
    const keyPath = join(dir, "keys", `${key.publicKeyHex}.json`);
    writeSealedKey(keyPath, key.seal(kek));
    db.rotateHolderWallet({
      publicKey: key.publicKeyHex,
      accountId: v.account_id,
      address: wallet.address,
      keyPath,
      createdAtMs: Date.now(),
    });
  } finally {
    db.close();
  }
  return v.account_id;
}

describe("day-one live watchers, against fake Strike", () => {
  it("D4 records the 404 → 200 flip and proves the old key is revoked after a reconnect", async () => {
    const { fake, dir, dbPath, args } = await liveRig();
    const kekPath = join(dir, "kek");
    const kek = HostKek.create(kekPath);
    const c = collect();
    const run = runD4(args, { out: c.out, env: { HOLDER_KEK_PATH: kekPath } });
    await new Promise((r) => setTimeout(r, 50));
    await humanConnects(fake, dbPath, kek, dir);
    await new Promise((r) => setTimeout(r, 50));
    await humanConnects(fake, dbPath, kek, dir);
    expect(await run).toBe(0);
    const record = JSON.parse(readFileSync(args.out as string, "utf8"));
    expect(record).toMatchObject({
      id: "D4",
      before: { status: 404 },
      after: { status: 200 },
      revokedKeyCheck: { status: 401, error: "wallet expired or revoked" },
      passed: true,
    });
    expect(record.flipMs).toBeGreaterThanOrEqual(0);
    expect(c.text()).toContain("PASS");
  });

  it("D5 waits for the submitted deposit and the credit, and records time-to-credit", async () => {
    const { fake, dir, dbPath, args } = await liveRig();
    const accountId = await humanConnects(fake, dbPath, HostKek.generate(), dir);
    const c = collect();
    const run = runD5({ ...args, checkRevoked: false }, { out: c.out });
    await new Promise((r) => setTimeout(r, 50));
    const db = openEvidenceDb(dbPath);
    db.recordFunding({
      accountId,
      kind: "deposit",
      requestId: "r1",
      asset: "USDM",
      amountBase: "20000000",
      usdValue: "20",
      txHash: "ab".repeat(32),
      status: "submitted",
      nowMs: Date.now(),
    });
    db.close();
    await new Promise((r) => setTimeout(r, 50));
    const w = fake.onboarding.wallets.get(wallet.address);
    if (w) w.walletBalance += 20n * 10n ** 18n;
    expect(await run).toBe(0);
    const record = JSON.parse(readFileSync(args.out as string, "utf8"));
    expect(record).toMatchObject({
      id: "D5",
      asset: "USDM",
      creditedMicroUsd: "20000000",
      conversionCostMicroUsd: "0",
      passed: true,
    });
    expect(record.timeToCreditMs).toBeGreaterThanOrEqual(0);
  });

  it("D9 waits for the debit and the payout UTxO, ignoring the funding tx's own change", async () => {
    const { fake, dir, dbPath, args } = await liveRig();
    const accountId = await humanConnects(fake, dbPath, HostKek.generate(), dir);
    const w = fake.onboarding.wallets.get(wallet.address);
    if (w) w.walletBalance = 50n * 10n ** 18n;
    const utxos: KoiosUtxo[] = [];
    const koios = { addressUtxos: async () => [...utxos] } as unknown as KoiosReader;
    const run = runD9({ ...args, checkRevoked: false }, { out: () => {}, koios, env: {} });
    await new Promise((r) => setTimeout(r, 50));
    const funding = "cd".repeat(32);
    const db = openEvidenceDb(dbPath);
    db.recordFunding({
      accountId,
      kind: "withdrawal",
      requestId: "w1",
      asset: "ADA",
      amountBase: null,
      usdValue: "20",
      txHash: funding,
      status: "submitted",
      nowMs: Date.now(),
    });
    db.close();
    if (w) w.walletBalance -= 20n * 10n ** 18n;
    const u = (tx: string): KoiosUtxo =>
      ({
        tx_hash: tx,
        tx_index: 0,
        address: wallet.address,
        value: "54000000",
        block_height: 9,
      }) as KoiosUtxo;
    utxos.push(u(funding));
    await new Promise((r) => setTimeout(r, 50));
    utxos.push(u("ef".repeat(32)));
    expect(await run).toBe(0);
    const record = JSON.parse(readFileSync(args.out as string, "utf8"));
    expect(record).toMatchObject({
      id: "D9",
      debitedMicroUsd: "20000000",
      fundingTxHash: funding,
      payout: { txHash: "ef".repeat(32) },
      passed: true,
    });
  });
});
