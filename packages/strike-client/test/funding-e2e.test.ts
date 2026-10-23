import { mergeWalletWitnesses, signDataForStrike, summarizeTx, utf8ToHex } from "@ballast/cardano";
import { signHolderProof, TestWallet } from "@ballast/cardano/testing";
import { FakeStrike } from "@ballast/fake-strike";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BuilderConnectClient, foreignActivity, HolderPresentClient } from "../src/funding.js";
import {
  ApiWalletSigner,
  apiTimeSource,
  createPublicHttp,
  ServerClock,
  StrikeApiError,
} from "../src/index.js";

const UA = "ballast-test/0.1";
let fake: FakeStrike;
let wallet: TestWallet;

beforeEach(async () => {
  wallet = new TestWallet();
  fake = new FakeStrike({ onboarding: { cardanoUtxos: () => wallet.utxosHex() } });
  await fake.start();
});
afterEach(async () => {
  await fake.stop();
});

describe("fake Strike end to end: connect → deposit → withdraw under HOLDER_PRESENT", () => {
  it("runs the whole holder flow with the holder's wallet signing every funding step", async () => {
    const bc = new BuilderConnectClient({ baseUrl: fake.baseUrl, userAgent: UA });
    // 1. Builder Connect: a fresh keeper-side key; only its public half goes to Strike.
    expect(await bc.accountByAddress(wallet.address)).toEqual({ status: 404 });
    const signer = ApiWalletSigner.fromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const ch = await bc.requestSignature({
      address: wallet.address,
      chain: "cardano",
      code: "ballast",
      fee_share_bps: 10,
      public_key: signer.publicKeyHex,
    });
    const sig = await signDataForStrike(wallet, wallet.address, utf8ToHex(ch.message_to_sign));
    const v = await bc.verifySignature(
      { nonce: ch.nonce, wallet_signature: sig },
      signer.publicKeyHex,
    );
    const after = await bc.accountByAddress(wallet.address);
    expect(after.status).toBe(200);
    if (after.status !== 200) return;
    expect(after.account.account_id).toBe(v.account_id);
    expect(foreignActivity(after.account)).toEqual([]);

    const clock = new ServerClock({
      fetchServerTimeMs: apiTimeSource(createPublicHttp({ baseUrl: fake.baseUrl, userAgent: UA })),
      samples: 2,
    });
    await clock.sync();
    const client = new HolderPresentClient({
      baseUrl: fake.baseUrl,
      userAgent: UA,
      signer,
      clock,
      accountId: v.account_id,
      holderAddress: wallet.address,
    });
    const proof = (path: string, body: unknown) =>
      signHolderProof(wallet, { accountId: v.account_id, path, body });

    // 2. Deposit 100 ADA: quote → build-tx → signTx(partial) → merge → submitTx → confirm.
    const qb = { blockchain: "cardano", asset_symbol: "ADA", asset_amount: "100000000" };
    const quote = await client.depositQuote(qb, await proof("/v2/deposit/quote", qb));
    expect(quote.quote.usd_value).toBe("35");
    const bb = {
      request_id: quote.request_id,
      user_address: wallet.address,
      utxos: await wallet.getUtxos(),
    };
    const built = await client.depositBuildTx(bb, await proof("/v2/deposit/build-tx", bb));
    const summary = summarizeTx(built.unsigned_tx);
    expect(summary.outputs.find((o) => o.lovelace === "100000000")).toBeDefined();
    const merged = mergeWalletWitnesses(
      built.unsigned_tx,
      await wallet.signTx(built.unsigned_tx, true),
      {
        requireKeyHashes: [wallet.paymentKeyHash],
      },
    );
    const txHash = await wallet.submitTx(merged.txHex);
    expect(txHash).toBe(summary.txHash);
    const cb = { request_id: quote.request_id, tx_hash: txHash };
    expect(await client.depositConfirm(cb, await proof("/v2/deposit", cb))).toMatchObject({
      status: "pending",
      tx_hash: txHash,
    });
    const again = await client
      .depositConfirm(cb, await proof("/v2/deposit", cb))
      .catch((e: unknown) => e);
    expect(again).toBeInstanceOf(StrikeApiError);
    expect((again as StrikeApiError).status).toBe(409);
    await fake.onboarding.settled();
    expect(fake.onboarding.balanceOf(v.account_id)).toBe("35");

    // 3. Withdraw $20: estimate → quote → signData(message as-is) + signTx(funding tx) → confirm.
    const eb = { usd_value: "20", blockchain: "cardano", asset: "ADA" };
    const est = await client.withdrawEstimate(eb, await proof("/v2/withdraw/estimate", eb));
    expect(est.withdraw_fee_usd).toBe("1");
    const wb = { ...eb, wallet_address: wallet.address };
    const wq = await client.withdrawQuote(wb, await proof("/v2/withdraw/quote", wb));
    expect(Buffer.from(wq.message_to_sign, "hex").toString()).toContain(
      `Wallet: ${wallet.address}`,
    );
    const walletSig = await signDataForStrike(wallet, wallet.address, wq.message_to_sign);
    const funding = mergeWalletWitnesses(
      wq.tx_cbor as string,
      await wallet.signTx(wq.tx_cbor as string, true),
    );
    const conf = {
      withdraw_id: wq.withdraw_id,
      wallet_signature: walletSig,
      signed_tx_cbor: funding.txHex,
    };
    expect(await client.withdrawConfirm(conf, await proof("/v2/withdraw", conf))).toMatchObject({
      request_id: wq.withdraw_id,
      status: "pending",
    });
    await fake.onboarding.settled();
    expect(fake.onboarding.balanceOf(v.account_id)).toBe("15");
    expect(fake.onboarding.events.map((e) => e.kind)).toEqual(["deposit", "withdrawal"]);
    // Every funding request was signed by the API wallet and approved by the wallet.
    const funded = fake.requests.filter((r) => /\/v2\/(deposit|withdraw)/.test(r.target));
    expect(funded.map((r) => r.status)).toEqual([200, 200, 200, 409, 200, 200, 201]);
    // connect 1 + deposit proofs 4 (one replay) + withdraw proofs 3 + the withdrawal message 1.
    expect(wallet.signDataCalls).toBe(9);
    expect(wallet.signTxCalls).toBe(2);
  });

  it("an account with foreign activity is visible before connecting", async () => {
    fake.onboarding.seedAccount(wallet.address, "ab".repeat(32), "512.5");
    const bc = new BuilderConnectClient({ baseUrl: fake.baseUrl, userAgent: UA });
    const r = await bc.accountByAddress(wallet.address);
    expect(r.status).toBe(200);
    if (r.status === 200) expect(foreignActivity(r.account)).toContain("wallet_balance is 512.5");
  });
});
