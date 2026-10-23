import { randomBytes } from "node:crypto";
import { signHolderProof, TestWallet } from "@ballast/cardano/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  checkFundingRoute,
  checkHolderProof,
  HolderPresentClient,
  holderBodyHash,
} from "../src/funding.js";
import {
  ApiWalletSigner,
  checkRoute,
  FUNDING_ROUTES,
  ServerClock,
  StrikeRefusedError,
  sha256Hex,
  verifyEd25519,
} from "../src/index.js";

const ACCOUNT = "01a144dc-27e4-706c-ac46-9c2c1e77d60b";
const QUOTE_BODY = { blockchain: "cardano", asset_symbol: "ADA", asset_amount: "25000000" };

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

let wallet: TestWallet;
let signer: ApiWalletSigner;
let sent: Sent[];
let now: number;
let client: HolderPresentClient;

function fakeFetch(reply: unknown, status = 200): typeof fetch {
  return (async (url: URL | string, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: Buffer.from(init?.body as Uint8Array).toString("utf8"),
    });
    return new Response(JSON.stringify(reply), { status });
  }) as typeof fetch;
}

async function makeClient(reply: unknown = { request_id: "r1" }, status = 200) {
  const clock = new ServerClock({ fetchServerTimeMs: async () => now, now: () => now, samples: 1 });
  await clock.sync();
  client = new HolderPresentClient({
    baseUrl: "https://strike.invalid",
    userAgent: "ballast-test/0.1",
    signer,
    clock,
    accountId: ACCOUNT,
    holderAddress: wallet.address,
    fetch: fakeFetch(reply, status),
    now: () => now,
  });
}

const proofFor = (
  path: string,
  body: unknown,
  over: { issuedAtMs?: number; accountId?: string } = {},
) =>
  signHolderProof(wallet, {
    accountId: over.accountId ?? ACCOUNT,
    path,
    body,
    issuedAtMs: over.issuedAtMs ?? now,
  });

beforeEach(async () => {
  wallet = new TestWallet();
  signer = ApiWalletSigner.fromSeed(randomBytes(32));
  sent = [];
  now = Date.parse("2026-10-23T09:00:00.000Z");
  await makeClient();
});

describe("HOLDER_PRESENT signer profile", () => {
  it("signs a funding request only with a fresh proof for exactly that request", async () => {
    const proof = await proofFor("/v2/deposit/quote", QUOTE_BODY);
    await expect(client.depositQuote(QUOTE_BODY, proof)).resolves.toEqual({ request_id: "r1" });
    expect(sent).toHaveLength(1);
    const s = sent[0] as Sent;
    expect(s.url).toBe("https://strike.invalid/v2/deposit/quote");
    expect(JSON.parse(s.body)).toEqual(QUOTE_BODY);
    // Signed by the API wallet, with the strike-auth message, at server time − 1 s.
    const ts = Number(s.headers["X-API-Wallet-Timestamp"]);
    expect(ts).toBe(Math.floor(now / 1000) - 1);
    const msg = `POST:/v2/deposit/quote:${ts}:${s.headers["X-API-Wallet-Nonce"]}:${sha256Hex(s.body)}`;
    expect(
      verifyEd25519(signer.publicKeyHex, msg, s.headers["X-API-Wallet-Signature"] as string),
    ).toBe(true);
    expect(s.headers["User-Agent"]).toBe("ballast-test/0.1");
  });

  it("refuses a stale proof, a future proof, a replay, and nothing reaches Strike", async () => {
    const stale = await proofFor("/v2/deposit/quote", QUOTE_BODY, { issuedAtMs: now - 60_001 });
    await expect(client.depositQuote(QUOTE_BODY, stale)).rejects.toThrow(/older than 60 s/);
    const edge = await proofFor("/v2/deposit/quote", QUOTE_BODY, { issuedAtMs: now - 60_000 });
    await expect(client.depositQuote(QUOTE_BODY, edge)).resolves.toBeDefined();
    const future = await proofFor("/v2/deposit/quote", QUOTE_BODY, { issuedAtMs: now + 5_001 });
    await expect(client.depositQuote(QUOTE_BODY, future)).rejects.toThrow(/future/);
    const once = await proofFor("/v2/deposit/quote", QUOTE_BODY);
    await client.depositQuote(QUOTE_BODY, once);
    await expect(client.depositQuote(QUOTE_BODY, once)).rejects.toThrow(/already used/);
    expect(sent).toHaveLength(2);
  });

  it("refuses a proof for another account, another request or another body", async () => {
    const other = await proofFor("/v2/deposit/quote", QUOTE_BODY, {
      accountId: "02b255ed-38f5-817d-bd57-ad3d2f88e71c",
    });
    await expect(client.depositQuote(QUOTE_BODY, other)).rejects.toThrow(/another account/);
    const otherPath = await proofFor("/v2/withdraw/estimate", QUOTE_BODY);
    await expect(client.depositQuote(QUOTE_BODY, otherPath)).rejects.toThrow(/different request/);
    const more = { ...QUOTE_BODY, asset_amount: "250000000" };
    const otherBody = await proofFor("/v2/deposit/quote", QUOTE_BODY);
    await expect(client.depositQuote(more, otherBody)).rejects.toThrow(/different request body/);
    // Key order does not matter: the proof binds the canonical JSON.
    const reordered = { asset_amount: "25000000", asset_symbol: "ADA", blockchain: "cardano" };
    await expect(client.depositQuote(reordered, otherBody)).resolves.toBeDefined();
    expect(sent).toHaveLength(1);
  });

  it("refuses proofs signed by another wallet or with a bad signature", async () => {
    const stranger = new TestWallet();
    const payload = (await proofFor("/v2/deposit/quote", QUOTE_BODY)).payload;
    const theirs = await stranger.signData(stranger.address, payload);
    await expect(
      client.depositQuote(QUOTE_BODY, { payload, signature: `${theirs.signature}:${theirs.key}` }),
    ).rejects.toThrow(/holder proof signature/);
    wallet.nextSignData = { corrupt: true };
    const corrupt = await proofFor("/v2/deposit/quote", QUOTE_BODY);
    await expect(client.depositQuote(QUOTE_BODY, corrupt)).rejects.toThrow(/does not verify/);
    await expect(client.depositQuote(QUOTE_BODY, undefined)).rejects.toThrow(/is required/);
    await expect(
      client.depositQuote(QUOTE_BODY, { payload: "zz", signature: "a:b" }),
    ).rejects.toThrow(StrikeRefusedError);
    expect(sent).toHaveLength(0);
  });

  it("refuses bodies outside Ballast's funding subset before looking at the proof", async () => {
    const bad: [string, unknown][] = [
      ["/v2/deposit/quote", { ...QUOTE_BODY, mode: "collateral" }],
      ["/v2/deposit/quote", { ...QUOTE_BODY, asset_symbol: "USDC" }],
      ["/v2/deposit/quote", { ...QUOTE_BODY, blockchain: "ethereum" }],
      ["/v2/deposit/quote", { ...QUOTE_BODY, asset_amount: "1.5" }],
      ["/v2/deposit/quote", { ...QUOTE_BODY, sub_account_id: "x" }],
      [
        "/v2/deposit/build-tx",
        { request_id: "r", user_address: new TestWallet().address, utxos: ["00"] },
      ],
      ["/v2/deposit/build-tx", { request_id: "r", user_address: wallet.address, utxos: [] }],
      ["/v2/deposit", { request_id: "r", tx_hash: "abc" }],
      [
        "/v2/withdraw/quote",
        {
          usd_value: "10",
          blockchain: "cardano",
          asset: "ADA",
          wallet_address: new TestWallet().address,
        },
      ],
      [
        "/v2/withdraw/quote",
        {
          usd_value: "10",
          blockchain: "cardano",
          asset: "ADA",
          wallet_address: wallet.address,
          recipient_address: new TestWallet().address,
        },
      ],
      ["/v2/withdraw/estimate", { usd_value: "0", blockchain: "cardano", asset: "ADA" }],
      [
        "/v2/withdraw/estimate",
        { usd_value: "10", blockchain: "cardano", asset: "ADA", source: "staking_reward" },
      ],
    ];
    for (const [path, body] of bad) {
      const r = checkFundingRoute("POST", path, body, { address: wallet.address });
      expect(r.ok, `${path} ${JSON.stringify(body)}`).toBe(false);
    }
    expect(checkFundingRoute("POST", "/v2/order", {}, wallet).ok).toBe(false);
    expect(checkFundingRoute("GET", "/v2/deposit/quote", QUOTE_BODY, wallet).ok).toBe(false);
  });

  it("a withdrawal confirm must carry the holder's signature over the quoted message and tx", async () => {
    const wq = {
      usd_value: "10",
      blockchain: "cardano",
      asset: "ADA",
      wallet_address: wallet.address,
    };
    const messageHex = Buffer.from(
      "Authorize withdrawal from Strike Perpetuals.\n\nWallet: x",
    ).toString("hex");
    await makeClient({ withdraw_id: "w1", fee: "1", message_to_sign: messageHex });
    await client.withdrawQuote(wq, await proofFor("/v2/withdraw/quote", wq));
    const good = await wallet.signData(wallet.address, messageHex);
    const forgedText = Buffer.from("Authorize withdrawal of everything").toString("hex");
    const forged = await wallet.signData(wallet.address, forgedText);
    const confirm = (wallet_signature: string) => ({ withdraw_id: "w1", wallet_signature });
    const bad = confirm(`${forged.signature}:${forged.key}`);
    await expect(client.withdrawConfirm(bad, await proofFor("/v2/withdraw", bad))).rejects.toThrow(
      /wallet_signature/,
    );
    const unknown = { withdraw_id: "w2", wallet_signature: `${good.signature}:${good.key}` };
    await expect(
      client.withdrawConfirm(unknown, await proofFor("/v2/withdraw", unknown)),
    ).rejects.toThrow(/no withdraw quote/);
    const ok = confirm(`${good.signature}:${good.key}`);
    await expect(
      client.withdrawConfirm(ok, await proofFor("/v2/withdraw", ok)),
    ).resolves.toBeDefined();
    expect(sent.map((s) => new URL(s.url).pathname)).toEqual([
      "/v2/withdraw/quote",
      "/v2/withdraw",
    ]);
  });

  it("checkHolderProof accepts only Ballast holder-proof text", async () => {
    const proof = await proofFor("/v2/deposit/quote", QUOTE_BODY);
    const e = {
      accountId: ACCOUNT,
      address: wallet.address,
      path: "/v2/deposit/quote",
      body: QUOTE_BODY,
      nowMs: now,
    };
    expect(checkHolderProof(proof, e)).toMatchObject({ ok: true });
    const sig = await wallet.signData(wallet.address, Buffer.from("hello").toString("hex"));
    expect(
      checkHolderProof(
        { payload: Buffer.from("hello").toString("hex"), signature: `${sig.signature}:${sig.key}` },
        e,
      ),
    ).toMatchObject({ ok: false, reason: "not a Ballast holder proof" });
    expect(holderBodyHash(QUOTE_BODY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the keeper's allowlist still refuses every funding route under every profile", () => {
    for (const r of FUNDING_ROUTES) {
      const [m, p] = r.split(" ") as [string, string];
      for (const profile of ["AUTONOMOUS", "CANCEL_ONLY", "HOLDER_PRESENT"] as const) {
        expect(checkRoute(profile, m, p, QUOTE_BODY).ok).toBe(false);
      }
    }
  });
});
