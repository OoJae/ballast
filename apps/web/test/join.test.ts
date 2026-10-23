import { mergeWalletWitnesses, txHashOf } from "@ballast/cardano";
import { buildPaymentTx, TestWallet } from "@ballast/cardano/testing";
import { checkHolderProof } from "@ballast/strike-client/funding";
import { describe, expect, it } from "vitest";
import {
  completeDeposit,
  completeWithdrawal,
  type Post,
  prepareDeposit,
  prepareWithdrawal,
} from "../src/lib/flows.js";
import {
  accountVerdict,
  capacityPreview,
  cexplorerTx,
  currentStep,
  EMPTY_PROGRESS,
  fmtCents,
  formatBase,
  JOIN_STEPS,
  marginTotals,
  parseDeposit,
  parseNight,
  parseR,
  parseWithdrawUsd,
  REVOCATION_STEPS,
} from "../src/lib/join.js";

describe("join inputs", () => {
  it("r: default 0.5, never above 0.9, never zero", () => {
    expect(parseR("0.5")).toEqual({ ok: true, value: 5000 });
    expect(parseR(".9")).toEqual({ ok: true, value: 9000 });
    expect(parseR("0.05")).toEqual({ ok: true, value: 500 });
    expect(parseR("0.1234")).toEqual({ ok: true, value: 1234 });
    for (const bad of ["0.95", "1", "0", "0.0", "", "abc", "0.12345", "-0.5", "0,5"]) {
      expect(parseR(bad).ok, bad).toBe(false);
    }
  });

  it("amounts parse to exact base units without floats", () => {
    expect(parseNight("12500.5")).toEqual({ ok: true, value: 12_500_500_000n });
    expect(parseNight("0").ok).toBe(false);
    expect(parseNight("1.1234567").ok).toBe(false);
    expect(parseDeposit("100", "ADA")).toEqual({ ok: true, value: "100000000" });
    expect(parseDeposit("0.000001", "USDM")).toEqual({ ok: true, value: "1" });
    expect(parseDeposit("1e3", "ADA").ok).toBe(false);
    expect(parseWithdrawUsd("4.99").ok).toBe(false);
    expect(parseWithdrawUsd("5")).toEqual({ ok: true, value: "5" });
    expect(parseWithdrawUsd("020.50")).toEqual({ ok: true, value: "20.50" });
    expect(parseWithdrawUsd("20.501").ok).toBe(false);
  });

  it("capacity is r × cover, capped by the max short", () => {
    const cover = 25_000_000_000n;
    expect(capacityPreview(cover, 5000, null)).toEqual({
      byCover: 12_500_000_000n,
      effective: 12_500_000_000n,
      limitedBy: "cover",
    });
    expect(capacityPreview(cover, 5000, 520_000_000n)).toMatchObject({
      effective: 520_000_000n,
      limitedBy: "max short",
    });
    expect(formatBase(12_500_500_000n)).toBe("12,500.5");
    expect(formatBase("0")).toBe("0");
  });
});

describe("join steps", () => {
  it("unlock strictly in order, with the deposit skippable", () => {
    let p = { ...EMPTY_PROGRESS };
    const seen = [currentStep(p)];
    p = { ...p, geofence: true };
    seen.push(currentStep(p));
    p = { ...p, risk: true };
    seen.push(currentStep(p));
    p = { ...p, signedIn: true };
    seen.push(currentStep(p));
    p = { ...p, accountId: "acct" };
    seen.push(currentStep(p));
    p = { ...p, depositSkipped: true };
    seen.push(currentStep(p));
    p = { ...p, rBps: 5000, maxShortBase: 1n };
    seen.push(currentStep(p));
    p = { ...p, consentHash: "h" };
    seen.push(currentStep(p));
    expect(seen).toEqual(JOIN_STEPS.map((s) => s.id));
    // Signing in without the geofence attestation does not skip it.
    expect(currentStep({ ...EMPTY_PROGRESS, signedIn: true, accountId: "a" })).toBe("geofence");
  });

  it("refuses an account with foreign activity and accepts a new, empty or own one", () => {
    expect(accountVerdict({ status: 404, foreign: [], boundToYou: false }).ok).toBe(true);
    expect(accountVerdict({ status: 200, foreign: [], boundToYou: false }).ok).toBe(true);
    expect(accountVerdict({ status: 200, foreign: [], boundToYou: true }).ok).toBe(true);
    const v = accountVerdict({ status: 200, foreign: ["wallet_balance is 5"], boundToYou: false });
    expect(v.ok).toBe(false);
    expect(v.text).toMatch(/dedicated/);
  });

  it("revocation guide: Stop comes before revoke", () => {
    const titles = REVOCATION_STEPS.map((s) => s.title);
    expect(titles[0]).toBe("Stop");
    expect(titles.at(-1)).toBe("Revoke");
    expect(titles.indexOf("Stop")).toBeLessThan(titles.indexOf("Revoke"));
  });

  it("margin totals count only submitted rows, in exact cents", () => {
    const t = marginTotals([
      { kind: "deposit", usdValue: "35", status: "submitted" },
      { kind: "deposit", usdValue: "10.555", status: "quoted" },
      { kind: "withdrawal", usdValue: "20.5", status: "submitted" },
    ]);
    expect(fmtCents(t.depositedCents)).toBe("$35.00");
    expect(fmtCents(t.withdrawnCents)).toBe("$20.50");
    expect(cexplorerTx("ab".repeat(32))).toBe(`https://cexplorer.io/tx/${"ab".repeat(32)}`);
  });
});

describe("browser flows (wallet and API injected)", () => {
  const ACCOUNT = "01a144dc-27e4-706c-ac46-9c2c1e77d60b";
  const PATHS: Record<string, string> = {
    "deposit/quote": "/v2/deposit/quote",
    "deposit/build": "/v2/deposit/build-tx",
    "deposit/confirm": "/v2/deposit",
    "withdraw/estimate": "/v2/withdraw/estimate",
    "withdraw/quote": "/v2/withdraw/quote",
    "withdraw/confirm": "/v2/withdraw",
  };

  /** A stand-in for the API that checks every proof the way HOLDER_PRESENT does. */
  function fakeApi(wallet: TestWallet) {
    const calls: string[] = [];
    const unsigned = buildPaymentTx({
      utxosHex: wallet.utxosHex(),
      changeAddress: wallet.address,
      outputs: [{ address: new TestWallet().address, lovelace: 25_000_000n }],
    });
    const post: Post = async <T>(path: string, body: unknown): Promise<T> => {
      calls.push(path);
      const b = body as { body: Record<string, unknown>; proof: unknown };
      if (path in PATHS) {
        const check = checkHolderProof(b.proof, {
          accountId: ACCOUNT,
          address: wallet.address,
          path: PATHS[path] as string,
          body: b.body,
          nowMs: Date.now(),
        });
        if (!check.ok) throw new Error(`proof refused for ${path}: ${check.reason}`);
      }
      const answer: Record<string, unknown> = {
        "deposit/quote": {
          request_id: "r1",
          quote: { usd_value: "8.75", exchange_rate: "0.35", expiration_at: 0 },
          deposit_address: "x",
        },
        "deposit/build": { unsigned_tx: unsigned, summary: { txHash: "" } },
        "deposit/confirm": { status: "pending" },
        "withdraw/estimate": { withdraw_fee_usd: "1" },
        "withdraw/quote": {
          withdraw_id: "w1",
          fee: "1",
          message_to_sign: Buffer.from("Authorize withdrawal").toString("hex"),
          message: "Authorize withdrawal",
          tx_cbor: unsigned,
          summary: null,
        },
        "withdraw/confirm": { status: "pending" },
      };
      if (path === "tx/merge") {
        const m = body as { tx: string; witnessSet: string };
        const r = mergeWalletWitnesses(m.tx, m.witnessSet);
        return { tx: r.txHex, txHash: r.txHash } as T;
      }
      return answer[path] as T;
    };
    return { post, calls, unsigned };
  }

  it("a deposit signs four times: quote proof, build proof, the tx, the confirm proof", async () => {
    const wallet = new TestWallet();
    const { post, calls, unsigned } = fakeApi(wallet);
    const w = { api: wallet, address: wallet.address };
    const prepared = await prepareDeposit(post, w, ACCOUNT, "ADA", "25000000");
    prepared.summary = { ...prepared.summary, txHash: txHashOf(unsigned) };
    const done = await completeDeposit(post, w, ACCOUNT, prepared);
    expect(done.txHash).toBe(txHashOf(unsigned));
    expect(wallet.submitted.map((s) => s.txHash)).toEqual([done.txHash]);
    expect(calls).toEqual(["deposit/quote", "deposit/build", "tx/merge", "deposit/confirm"]);
    expect(wallet.signDataCalls).toBe(3);
    expect(wallet.signTxCalls).toBe(1);
  });

  it("refuses to submit when the merged tx is not the one Strike built", async () => {
    const wallet = new TestWallet();
    const { post } = fakeApi(wallet);
    const w = { api: wallet, address: wallet.address };
    const prepared = await prepareDeposit(post, w, ACCOUNT, "ADA", "25000000");
    prepared.summary = { ...prepared.summary, txHash: "00".repeat(32) };
    await expect(completeDeposit(post, w, ACCOUNT, prepared)).rejects.toThrow(
      /not the one Strike built/,
    );
    expect(wallet.submitted).toEqual([]);
  });

  it("a withdrawal signs Strike's hex message as-is plus the funding tx, and Strike submits it", async () => {
    const wallet = new TestWallet();
    const { post, calls } = fakeApi(wallet);
    const w = { api: wallet, address: wallet.address };
    const prepared = await prepareWithdrawal(post, w, ACCOUNT, "ADA", "20");
    await completeWithdrawal(post, w, ACCOUNT, prepared);
    expect(calls).toEqual(["withdraw/estimate", "withdraw/quote", "tx/merge", "withdraw/confirm"]);
    expect(wallet.submitted).toEqual([]);
    expect(wallet.signTxCalls).toBe(1);
  });
});
