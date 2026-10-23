import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { signDataForStrike, utf8ToHex } from "@ballast/cardano";
import { TestWallet } from "@ballast/cardano/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeStrike } from "../src/index.js";

// API-wallet signing written from strike-auth alone, as in fake.test.ts.
function keypair() {
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), randomBytes(32)]),
    format: "der",
    type: "pkcs8",
  });
  const pub = createPublicKey(key)
    .export({ format: "der", type: "spki" })
    .subarray(12)
    .toString("hex");
  return { key, pub };
}

let fake: FakeStrike;
let wallet: TestWallet;

beforeEach(async () => {
  wallet = new TestWallet();
  fake = new FakeStrike({ onboarding: { cardanoUtxos: () => [] } });
  await fake.start();
});
afterEach(async () => {
  await fake.stop();
});

async function post(path: string, body: unknown) {
  const res = await fetch(`${fake.baseUrl}${path}`, {
    method: "POST",
    headers: { "User-Agent": "fake-test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function signed(
  kp: ReturnType<typeof keypair>,
  method: string,
  path: string,
  body?: unknown,
) {
  const text = body === undefined ? "" : JSON.stringify(body);
  const ts = Math.floor(fake.serverNow() / 1000) - 1;
  const nonce = randomUUID();
  const hash = createHash("sha256").update(text).digest("hex");
  const sig = sign(null, Buffer.from(`${method}:${path}:${ts}:${nonce}:${hash}`), kp.key).toString(
    "hex",
  );
  const res = await fetch(`${fake.baseUrl}${path}`, {
    method,
    headers: {
      "User-Agent": "fake-test",
      "X-API-Wallet-Public-Key": kp.pub,
      "X-API-Wallet-Signature": sig,
      "X-API-Wallet-Timestamp": String(ts),
      "X-API-Wallet-Nonce": nonce,
    },
    ...(body === undefined ? {} : { body: text }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const account = () => fetch(`${fake.baseUrl}/v2/account?blockchain_address=${wallet.address}`);

async function connect(kp = keypair()) {
  const ch = await post("/auth/builder/request-signature", {
    address: wallet.address,
    chain: "cardano",
    code: "ballast",
    fee_share_bps: 10,
    public_key: kp.pub,
  });
  expect(ch.status).toBe(200);
  const message = ch.json.message_to_sign as string;
  const sig = await signDataForStrike(wallet, wallet.address, utf8ToHex(message));
  const v = await post("/auth/builder/verify-signature", {
    nonce: ch.json.nonce,
    wallet_signature: sig,
  });
  return { kp, ch, v, message };
}

describe("fake Builder Connect", () => {
  it("creates the account on the first connect: /v2/account flips 404 → 200", async () => {
    expect((await account()).status).toBe(404);
    expect(await (await account()).json()).toEqual({ error: "user not found" });
    const { kp, v, message } = await connect();
    expect(message).toContain(`Wallet: ${wallet.address}`);
    expect(message).toContain(`API Key: ${kp.pub}`);
    expect(message).toContain("collect up to 0.1% fee");
    expect(v).toMatchObject({
      status: 200,
      json: { builder_code: "ballast", fee_share_bps: 10, api_wallet_public_key: kp.pub },
    });
    const after = await account();
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({
      account_id: v.json.account_id,
      blockchain: "cardano",
      blockchain_address: wallet.address,
      wallet_balance: "0",
      sub_accounts: [],
    });
    expect((await signed(kp, "GET", "/v2/account")).status).toBe(200);
  });

  it("reconnecting revokes the previous key and needs a fresh one", async () => {
    const first = await connect();
    const second = await connect();
    expect(second.v.json.account_id).toBe(first.v.json.account_id);
    expect(await signed(first.kp, "GET", "/v2/account")).toEqual({
      status: 401,
      json: { error: "wallet expired or revoked" },
    });
    expect((await signed(second.kp, "GET", "/v2/account")).status).toBe(200);
    const reuse = await connect(second.kp);
    expect(reuse.v).toEqual({ status: 500, json: { error: "failed to create API wallet" } });
  });

  it("decodes strictly and consumes a challenge on any verify attempt", async () => {
    const base = {
      address: wallet.address,
      chain: "cardano",
      code: "ballast",
      fee_share_bps: 10,
      public_key: keypair().pub,
    };
    expect(
      (await post("/auth/builder/request-signature", { ...base, max_fee_bps: 5 })).json,
    ).toEqual({
      error: 'json: unknown field "max_fee_bps"',
    });
    expect((await post("/auth/builder/request-signature", { ...base, code: "other" })).status).toBe(
      404,
    );
    expect(
      (await post("/auth/builder/request-signature", { ...base, fee_share_bps: 101 })).json,
    ).toEqual({
      error: "fee_share_bps must be 0-100",
    });
    expect(
      (await post("/auth/builder/request-signature", { ...base, public_key: "ab" })).json.error,
    ).toMatch(/64 hex/);
    const ch = await post("/auth/builder/request-signature", base);
    const stranger = new TestWallet();
    const wrong = await signDataForStrike(
      stranger,
      stranger.address,
      utf8ToHex(ch.json.message_to_sign as string),
    );
    expect(
      await post("/auth/builder/verify-signature", {
        nonce: ch.json.nonce,
        wallet_signature: wrong,
      }),
    ).toEqual({
      status: 401,
      json: { error: "wallet signature verification failed" },
    });
    const good = await signDataForStrike(
      wallet,
      wallet.address,
      utf8ToHex(ch.json.message_to_sign as string),
    );
    expect(
      await post("/auth/builder/verify-signature", {
        nonce: ch.json.nonce,
        wallet_signature: good,
      }),
    ).toEqual({
      status: 400,
      json: { error: "challenge not found or expired" },
    });
    expect((await account()).status).toBe(404);
  });

  it("answers funding routes as JWT-only when configured that way (the getting-started reading)", async () => {
    await fake.stop();
    fake = new FakeStrike({ onboarding: { fundingAuth: "jwt-only" } });
    await fake.start();
    const { kp } = await connect();
    const q = await signed(kp, "POST", "/v2/deposit/quote", {
      blockchain: "cardano",
      asset_symbol: "ADA",
      asset_amount: "10000000",
    });
    expect(q).toEqual({ status: 401, json: { error: "missing authorization header" } });
  });
});
