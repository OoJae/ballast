import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEOFENCE_STATEMENT } from "@ballast/cardano";
import { signHolderProof, TestWallet } from "@ballast/cardano/testing";
import type { CoverProof } from "@ballast/cover";
import { type EvidenceDb, openEvidenceDb } from "@ballast/evidence/db";
import { FakeStrike, type FakeStrikeOptions } from "@ballast/fake-strike";
import { HostKek } from "@ballast/governance";
import { afterEach, describe, expect, it } from "vitest";
import { BookHealthService } from "../src/book-health.js";
import { RecordingsEvidence } from "../src/evidence.js";
import { loadHolderConfig } from "../src/holder/config.js";
import { HolderKeyStore } from "../src/holder/keystore.js";
import { createHolderHandler } from "../src/holder/routes.js";
import { HolderService, type HolderServiceDeps } from "../src/holder/service.js";
import type {
  ConnectFinishWire,
  ConnectStartWire,
  MeWire,
  SessionWire,
  SignRequestWire,
} from "../src/holder-types.js";
import { RecordingIndex } from "../src/recording-index.js";
import { createApiServer } from "../src/server.js";
import { ReplayBookSource } from "../src/sources.js";

const SYMBOLS = ["NIGHT-USD"];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function listen(s: Server): Promise<string> {
  return new Promise((r) =>
    s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)),
  );
}

const coverStub = {
  async proof(stakeAddress: string): Promise<CoverProof> {
    return {
      v: 1,
      subject: { kind: "stake", stakeAddress },
      asset: {
        policyId: "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa",
        assetNameHex: "4e49474854",
        decimals: 6,
      },
      height: 12_345_678,
      tipHash: "ab".repeat(32),
      tipSlot: 1,
      tipTime: 1,
      utxos: [
        {
          ref: `${"cd".repeat(32)}#0`,
          address: "addr1x",
          quantity: "25000000000",
          createdHeight: 1,
        },
      ],
      excluded: [],
      coverBase: "25000000000",
      lookalikeBase: "0",
      checkedAtMs: Date.now(),
      hash: "ef".repeat(32),
    };
  },
};

interface Rig {
  base: string;
  fake: FakeStrike;
  db: EvidenceDb;
  keyDir: string;
  wallet: TestWallet;
}

async function rig(
  opts: { fake?: FakeStrikeOptions; service?: Partial<HolderServiceDeps>; holder?: boolean } = {},
): Promise<Rig> {
  const wallet = new TestWallet();
  const fake = new FakeStrike({
    ...opts.fake,
    onboarding: { cardanoUtxos: () => wallet.utxosHex(), ...opts.fake?.onboarding },
  });
  await fake.start();
  cleanups.push(() => fake.stop());
  const dir = mkdtempSync(join(tmpdir(), "ballast-holder-"));
  const keyDir = join(dir, "keys");
  const db = openEvidenceDb(":memory:");
  cleanups.push(() => db.close());
  const service = new HolderService({
    strikeUrl: fake.baseUrl,
    userAgent: "ballast-test/0.1",
    builderCode: "ballast",
    feeShareBps: 10,
    fundingMode: "api-wallet",
    network: "mainnet",
    domain: "localhost",
    db,
    keys: new HolderKeyStore(keyDir, HostKek.generate()),
    cover: coverStub,
    ...opts.service,
  });
  const index = new RecordingIndex({ root: dir, symbols: SYMBOLS });
  const server = createApiServer({
    ...(opts.holder === false ? {} : { holder: createHolderHandler(service) }),
    symbols: SYMBOLS,
    cors: { origins: "*" },
    index,
    health: new BookHealthService(index, { root: dir, symbols: SYMBOLS, verified: () => null }),
    evidence: new RecordingsEvidence(dir),
    source: new ReplayBookSource(index, SYMBOLS),
  });
  const base = await listen(server);
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });
  return { base, fake, db, keyDir, wallet };
}

async function call<T = Record<string, unknown>>(
  r: Rig,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${r.base}/api/holder/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as T };
}

async function signIn(r: Rig, wallet = r.wallet): Promise<string> {
  const ch = await call<SignRequestWire>(r, "session/challenge", { address: wallet.address });
  expect(ch.status).toBe(200);
  expect(Buffer.from(ch.json.payload, "hex").toString()).toBe(ch.json.message);
  const ds = await wallet.signData(wallet.addressHex, ch.json.payload);
  const s = await call<SessionWire>(r, "session", {
    nonce: ch.json.nonce,
    signature: `${ds.signature}:${ds.key}`,
  });
  expect(s.status).toBe(200);
  return s.json.token;
}

const attest = (r: Rig, token: string) =>
  call(
    r,
    "attest",
    {
      attest: true,
      statementSha256: createHash("sha256").update(GEOFENCE_STATEMENT).digest("hex"),
    },
    token,
  );

async function connect(r: Rig, token: string, wallet = r.wallet): Promise<ConnectFinishWire> {
  const start = await call<ConnectStartWire>(r, "connect/start", {}, token);
  expect(start.status).toBe(200);
  const ds = await wallet.signData(wallet.addressHex, start.json.payload);
  const fin = await call<ConnectFinishWire>(
    r,
    "connect/finish",
    { nonce: start.json.nonce, signature: `${ds.signature}:${ds.key}` },
    token,
  );
  expect(fin.status).toBe(200);
  return fin.json;
}

describe("holder routes", () => {
  it("are disabled unless injected (HOLDER_ROUTES=1)", async () => {
    const r = await rig({ holder: false });
    const res = await call(r, "session/challenge", { address: r.wallet.address });
    expect(res.status).toBe(404);
    expect(res.json.error).toMatch(/disabled/);
    expect(loadHolderConfig({})).toBeNull();
    expect(loadHolderConfig({ HOLDER_ROUTES: "true" })).toBeNull();
    expect(() => loadHolderConfig({ HOLDER_ROUTES: "1" })).toThrow(/HOLDER_KEK_PATH/);
    const base = { HOLDER_ROUTES: "1", HOLDER_KEK_PATH: "/k", HOLDER_KEY_DIR: "/d" };
    expect(() => loadHolderConfig(base)).toThrow(/BALLAST_ARM=1/);
    expect(loadHolderConfig({ ...base, BALLAST_ARM: "1" })?.strikeUrl).toBe(
      "https://api.strikefinance.org",
    );
    expect(
      loadHolderConfig({
        ...base,
        HOLDER_STRIKE_URL: "http://127.0.0.1:9",
        HOLDER_FUNDING_MODE: "strike-app",
      }),
    ).toMatchObject({ fundingMode: "strike-app" });
    expect(() => loadHolderConfig({ ...base, HOLDER_STRIKE_URL: "http://evil.example" })).toThrow(
      /https/,
    );
  });

  it("connect → deposit → withdraw → consent → stop, every step signed by the holder's wallet", async () => {
    const r = await rig();
    const w = r.wallet;
    expect((await call(r, "me")).status).toBe(401);
    const token = await signIn(r);

    // Geofence first; the account must be new or clean.
    expect((await call(r, "connect/start", {}, token)).status).toBe(409);
    expect((await attest(r, token)).status).toBe(200);
    expect((await call(r, "account/check", {}, token)).json).toEqual({
      status: 404,
      accountId: null,
      foreign: [],
      boundToYou: false,
    });

    // Builder Connect: Strike sees only the public key; the sealed key lands on disk at finish.
    const start = await call<ConnectStartWire>(r, "connect/start", {}, token);
    expect(start.json.message).toContain(`API Key: ${start.json.apiPublicKey}`);
    expect(start.json.accountBefore).toBe(404);
    const sentToStrike = r.fake.requests.map((q) => q.body).join("\n");
    expect(sentToStrike).toContain(start.json.apiPublicKey);
    const ds = await w.signData(w.addressHex, start.json.payload);
    const fin = await call<ConnectFinishWire>(
      r,
      "connect/finish",
      { nonce: start.json.nonce, signature: `${ds.signature}:${ds.key}` },
      token,
    );
    expect(fin.json.flip).toMatchObject({ before: 404, after: 200 });
    const accountId = fin.json.accountId;
    const keyFile = join(r.keyDir, accountId, `${start.json.apiPublicKey}.json`);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const sealed = JSON.parse(readFileSync(keyFile, "utf8")) as Record<string, unknown>;
    expect(sealed).toMatchObject({
      role: "strike",
      alg: "aes-256-gcm",
      publicKeyHex: start.json.apiPublicKey,
    });
    expect(r.db.accountByStake(w.stakeAddress)?.accountId).toBe(accountId);

    const proof = (
      path: string,
      body: unknown,
      over: { issuedAtMs?: number; accountId?: string } = {},
    ) => signHolderProof(w, { accountId: over.accountId ?? accountId, path, body, ...over });
    const fund = (step: string, path: string, body: unknown) =>
      proof(path, body).then((p) =>
        call<Record<string, unknown>>(r, step, { body, proof: p }, token),
      );

    // Deposit 100 ADA in-app.
    const qb = { blockchain: "cardano", asset_symbol: "ADA", asset_amount: "100000000" };
    const quote = await fund("deposit/quote", "/v2/deposit/quote", qb);
    expect(quote.status).toBe(200);
    const requestId = quote.json.request_id as string;
    const stale = await proof("/v2/deposit/quote", qb, { issuedAtMs: Date.now() - 61_000 });
    expect(await call(r, "deposit/quote", { body: qb, proof: stale }, token)).toMatchObject({
      status: 403,
      json: { error: expect.stringMatching(/older than 60 s/) },
    });
    const otherAcct = await proof("/v2/deposit/quote", qb, {
      accountId: "02b255ed-38f5-817d-bd57-ad3d2f88e71c",
    });
    expect((await call(r, "deposit/quote", { body: qb, proof: otherAcct }, token)).status).toBe(
      403,
    );
    const reused = await proof("/v2/deposit/quote", qb);
    expect((await call(r, "deposit/quote", { body: qb, proof: reused }, token)).status).toBe(200);
    expect((await call(r, "deposit/quote", { body: qb, proof: reused }, token)).status).toBe(403);

    const bb = { request_id: requestId, user_address: w.address, utxos: await w.getUtxos() };
    const built = await fund("deposit/build", "/v2/deposit/build-tx", bb);
    expect(built.status).toBe(200);
    const unsigned = built.json.unsigned_tx as string;
    const summary = built.json.summary as { txHash: string; outputs: { lovelace: string }[] };
    expect(summary.outputs.some((o) => o.lovelace === "100000000")).toBe(true);
    const merged = await call<{ tx: string; txHash: string }>(
      r,
      "tx/merge",
      { tx: unsigned, witnessSet: await w.signTx(unsigned, true) },
      token,
    );
    expect(merged.json.txHash).toBe(summary.txHash);
    const txHash = await w.submitTx(merged.json.tx);
    expect(txHash).toBe(summary.txHash);
    const conf = await fund("deposit/confirm", "/v2/deposit", {
      request_id: requestId,
      tx_hash: txHash,
    });
    expect(conf.json).toMatchObject({ status: "pending", tx_hash: txHash });
    await r.fake.onboarding.settled();
    let me = (await call<MeWire>(r, "me", undefined, token)).json;
    expect(me.strike).toEqual({ status: 200, walletBalance: "35" });
    // The second quote (the one the replay check used) stays quoted: nothing was built for it.
    expect(me.funding.map((f) => [f.kind, f.status, f.txHash])).toEqual([
      ["deposit", "submitted", txHash],
      ["deposit", "quoted", null],
    ]);

    // Withdraw $20 back to the same wallet: message signed as-is plus the funding tx.
    const eb = { usd_value: "20", blockchain: "cardano", asset: "ADA" };
    expect((await fund("withdraw/estimate", "/v2/withdraw/estimate", eb)).status).toBe(200);
    const wb = { ...eb, wallet_address: w.address };
    const wq = await fund("withdraw/quote", "/v2/withdraw/quote", wb);
    expect(wq.json.message).toContain(`Wallet: ${w.address}`);
    const walletSig = await w.signData(w.addressHex, wq.json.message_to_sign as string);
    const fundingTx = await call<{ tx: string }>(
      r,
      "tx/merge",
      { tx: wq.json.tx_cbor, witnessSet: await w.signTx(wq.json.tx_cbor as string, true) },
      token,
    );
    const cb = {
      withdraw_id: wq.json.withdraw_id,
      wallet_signature: `${walletSig.signature}:${walletSig.key}`,
      signed_tx_cbor: fundingTx.json.tx,
    };
    expect((await fund("withdraw/confirm", "/v2/withdraw", cb)).json).toMatchObject({
      status: "pending",
    });
    await r.fake.onboarding.settled();
    me = (await call<MeWire>(r, "me", undefined, token)).json;
    expect(me.strike?.walletBalance).toBe("15");
    expect(me.funding.map((f) => `${f.kind}:${f.status}`)).toEqual([
      "deposit:submitted",
      "deposit:quoted",
      "withdrawal:submitted",
    ]);
    expect(me.cover?.coverBase).toBe("25000000000");
    expect(me.armed).toBe(false);

    // Consent: r = 0.5, max short 12,500 NIGHT; its hash is stored, r applied.
    const cs = await call<SignRequestWire>(
      r,
      "consent/start",
      { rBps: 5000, maxShortNight: "12500" },
      token,
    );
    expect(cs.json.message).toContain("Cover ratio r: 0.50 (5000 bps)");
    expect((await call(r, "consent/start", { rBps: 9500, maxShortNight: "1" }, token)).status).toBe(
      400,
    );
    const csig = await w.signData(w.addressHex, cs.json.payload);
    const consent = await call<{ hash: string }>(
      r,
      "consent/finish",
      { nonce: cs.json.nonce, signature: `${csig.signature}:${csig.key}` },
      token,
    );
    expect(consent.json.hash).toBe(createHash("sha256").update(cs.json.message).digest("hex"));
    me = (await call<MeWire>(r, "me", undefined, token)).json;
    expect(me.consent).toMatchObject({
      hash: consent.json.hash,
      rBps: 5000,
      maxShortBase: "12500000000",
    });
    expect(me.account?.status).toBe("onboarding");

    // Stop pauses the account.
    expect((await call(r, "stop", {}, token)).json).toEqual({ status: "paused" });
    me = (await call<MeWire>(r, "me", undefined, token)).json;
    expect(me.account).toMatchObject({ status: "paused", pausedReason: "stopped by the holder" });
  });

  it("reconnecting rotates the key: Strike revokes the old one and Ballast records the new one", async () => {
    const r = await rig();
    const token = await signIn(r);
    await attest(r, token);
    const first = await connect(r, token);
    const second = await connect(r, token);
    expect(second.accountId).toBe(first.accountId);
    expect(r.fake.revokedKeys.has(first.apiPublicKey)).toBe(true);
    expect(r.db.activeHolderWallet(first.accountId)?.publicKey).toBe(second.apiPublicKey);
    expect(readdirSync(join(r.keyDir, first.accountId)).sort()).toEqual(
      [`${first.apiPublicKey}.json`, `${second.apiPublicKey}.json`].sort(),
    );
  });

  it("refuses a Strike account with foreign activity", async () => {
    const r = await rig();
    r.fake.onboarding.seedAccount(r.wallet.address, "ab".repeat(32), "100");
    const token = await signIn(r);
    await attest(r, token);
    const check = await call(r, "account/check", {}, token);
    expect(check.json).toMatchObject({
      status: 200,
      boundToYou: false,
      foreign: ["wallet_balance is 100", "available_balance is 100", "margin_balance is 100"],
    });
    const start = await call(r, "connect/start", {}, token);
    expect(start.status).toBe(409);
    expect(start.json.error).toMatch(/not dedicated/);
  });

  it("offers the Strike-app path when funding is off, or when Strike refuses API wallets", async () => {
    const off = await rig({ service: { fundingMode: "strike-app" } });
    let token = await signIn(off);
    await attest(off, token);
    const a = await connect(off, token);
    const qb = { blockchain: "cardano", asset_symbol: "ADA", asset_amount: "100000000" };
    let p = await signHolderProof(off.wallet, {
      accountId: a.accountId,
      path: "/v2/deposit/quote",
      body: qb,
    });
    expect(await call(off, "deposit/quote", { body: qb, proof: p }, token)).toMatchObject({
      status: 409,
      json: { fallback: "strike-app" },
    });

    const jwt = await rig({ fake: { onboarding: { fundingAuth: "jwt-only" } } });
    token = await signIn(jwt);
    await attest(jwt, token);
    const b = await connect(jwt, token);
    p = await signHolderProof(jwt.wallet, {
      accountId: b.accountId,
      path: "/v2/deposit/quote",
      body: qb,
    });
    expect(await call(jwt, "deposit/quote", { body: qb, proof: p }, token)).toMatchObject({
      status: 502,
      json: {
        fallback: "strike-app",
        strike: { status: 401, error: "missing authorization header" },
      },
    });
  });

  it("sign-in refuses a signature from another wallet and a reused challenge", async () => {
    const r = await rig();
    const ch = await call<SignRequestWire>(r, "session/challenge", { address: r.wallet.address });
    const stranger = new TestWallet();
    const bad = await stranger.signData(stranger.addressHex, ch.json.payload);
    expect(
      (await call(r, "session", { nonce: ch.json.nonce, signature: `${bad.signature}:${bad.key}` }))
        .status,
    ).toBe(401);
    const good = await r.wallet.signData(r.wallet.addressHex, ch.json.payload);
    expect(
      (
        await call(r, "session", {
          nonce: ch.json.nonce,
          signature: `${good.signature}:${good.key}`,
        })
      ).status,
    ).toBe(400);
    expect((await call(r, "session/challenge", { address: r.wallet.stakeAddress })).status).toBe(
      400,
    );
    const testnet = new TestWallet({ network: "testnet" });
    expect((await call(r, "session/challenge", { address: testnet.address })).json.error).toMatch(
      /mainnet/,
    );
  });
});
