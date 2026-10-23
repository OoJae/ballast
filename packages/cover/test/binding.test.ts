import { describe, expect, it } from "vitest";
import {
  BindingConflictError,
  bindableStake,
  type CoverProof,
  detectManualActivity,
  type MempoolSpend,
  type MempoolSpendSource,
  OgmiosMempoolStub,
  StakeBindings,
  sharedStakeKeys,
  spendsAgainstCover,
  watchCoverSpends,
} from "../src/index.js";
import { baseAddr, enterpriseAddr, h32, stakeAddr } from "./synth.js";

describe("invariant 16: one stake credential ↔ one account", () => {
  it("binds once; a second account on the same stake key, or a second key on one account, is refused", () => {
    const b = new StakeBindings();
    const s = b.bind(baseAddr("pay-1", "alice"), "acct-alice");
    expect(s).toBe(stakeAddr("alice"));
    // Same wallet, another base address on the same stake key: still the same binding.
    expect(b.bind(baseAddr("pay-2", "alice"), "acct-alice")).toBe(s);
    expect(() => b.bind(baseAddr("pay-3", "alice"), "acct-mallory")).toThrow(BindingConflictError);
    expect(() => b.bind(stakeAddr("alice"), "acct-mallory")).toThrow(
      /already bound to another account/,
    );
    expect(() => b.bind(baseAddr("pay-9", "bob"), "acct-alice")).toThrow(
      /already bound to another stake/,
    );
    expect(b.accountFor(baseAddr("pay-2", "alice"))).toBe("acct-alice");
    expect(b.stakeFor("acct-alice")).toBe(s);
  });

  it("refuses inputs without a key-hash stake credential", () => {
    expect(() => bindableStake(enterpriseAddr("solo"))).toThrow(/stake credential/);
    expect(() => bindableStake(baseAddr("p", "dao", ["key", "script"]))).toThrow(/script stake/);
  });

  it("detects base addresses that share a stake key", () => {
    const groups = sharedStakeKeys([
      baseAddr("pay-1", "alice"),
      baseAddr("pay-2", "alice"),
      baseAddr("pay-1", "bob"),
      baseAddr("pay-1", "alice"),
      enterpriseAddr("x"),
    ]);
    expect([...groups.keys()]).toEqual([stakeAddr("alice")]);
    expect(groups.get(stakeAddr("alice"))).toEqual([
      baseAddr("pay-1", "alice"),
      baseAddr("pay-2", "alice"),
    ]);
  });

  it("manual-activity detection: any non-bal_ order flags the account", () => {
    expect(detectManualActivity([{ clientOrderId: "bal_a1b2c3_d4e5f6_1_k" }])).toEqual({
      manual: false,
      foreign: [],
    });
    const r = detectManualActivity([
      { clientOrderId: "bal_a1b2c3_d4e5f6_1_k" },
      { clientOrderId: "web-1234" },
      { clientOrderId: null, orderId: "991" },
      { clientOrderId: "bal_" },
    ]);
    expect(r.manual).toBe(true);
    expect(r.foreign).toEqual(["web-1234", "order 991 (no client id)", "bal_"]);
  });
});

describe("mempool spend detection (stubbed source, real matcher)", () => {
  const proof = {
    subject: { kind: "stake", stakeAddress: stakeAddr("alice") },
    utxos: [
      {
        ref: `${h32("a")}#0`,
        address: baseAddr("pay-1", "alice"),
        quantity: "5",
        createdHeight: 1,
      },
      {
        ref: `${h32("b")}#2`,
        address: baseAddr("pay-1", "alice"),
        quantity: "7",
        createdHeight: 1,
      },
    ],
  } as unknown as CoverProof;

  it("a spend of any counted UTxO sets r = 0 for that subject; other spends do nothing", () => {
    const spend: MempoolSpend = {
      txId: h32("tx"),
      inputs: [{ txHash: h32("b"), index: 2 }],
      seenAtMs: 1,
    };
    expect(spendsAgainstCover(spend, [proof])).toEqual([
      { subject: proof.subject, txId: h32("tx"), spentRefs: [`${h32("b")}#2`], rBps: 0 },
    ]);
    expect(
      spendsAgainstCover({ ...spend, inputs: [{ txHash: h32("b"), index: 1 }] }, [proof]),
    ).toEqual([]);
  });

  it("wires a source to an alert callback; the stub never fires", () => {
    let emit: (s: MempoolSpend) => void = () => {};
    const source: MempoolSpendSource = {
      subscribe: (fn) => {
        emit = fn;
        return () => {};
      },
    };
    const alerts: unknown[] = [];
    watchCoverSpends(
      source,
      () => [proof],
      (a) => alerts.push(a),
    );
    emit({ txId: h32("tx2"), inputs: [{ txHash: h32("a"), index: 0 }], seenAtMs: 2 });
    expect(alerts).toHaveLength(1);
    const stubAlerts: unknown[] = [];
    watchCoverSpends(
      new OgmiosMempoolStub(),
      () => [proof],
      (a) => stubAlerts.push(a),
    )();
    expect(stubAlerts).toEqual([]);
  });
});
