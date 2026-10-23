import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CriticRunOutput,
  DaemonKey,
  DecisionLog,
  OperatorKey,
  runCriticGate,
  signPolicy,
  verifyDecisionChain,
} from "@ballast/governance";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import {
  AccountBindingError,
  acquireDaemonLockOrThrow,
  type EvidenceDb,
  type OrderStatus,
  openEvidenceDb,
} from "../src/db.js";

const T0 = Date.parse("2026-10-23T00:00:00Z");
const DAY = 86_400_000;
const seed = (l: string) => createHash("sha256").update(`ballast-evidence-test:${l}`).digest();
const operator = OperatorKey.fromSeed(seed("operator"));
const daemon = DaemonKey.fromSeed(seed("daemon"));
const dir = mkdtempSync(join(tmpdir(), "ballast-db-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const STAKE_A = `stake1u${"q".repeat(52)}`;
const STAKE_B = `stake1u${"p".repeat(52)}`;

const policy = (id = "P1") =>
  signPolicy(
    {
      v: 1,
      policyId: id,
      prevPolicyHash: null,
      validFromMs: T0,
      validUntilMs: T0 + DAY,
      renewals: 2,
    },
    operator,
  );

const output = (verdict: "PASS" | "FAIL"): CriticRunOutput => ({
  dataRoot: "a".repeat(64),
  simGitSha: "abcdef0",
  seed: "1",
  scenarios: [
    {
      id: "s",
      window: { fromMs: 0, toMs: 1 },
      violations: { cover: 0, floor: 0, p2: 0, static: 0, rate: 0 },
      fills: 0,
      armedHours: 0,
      maxCombinedDrawdownMicroUsd: "0",
    },
  ],
  verdict,
});

async function setup(): Promise<{
  db: EvidenceDb;
  log: DecisionLog;
  policyHash: string;
  seq: number;
}> {
  const db = openEvidenceDb(":memory:");
  const sp = policy();
  const report = await runCriticGate({
    runner: { run: async () => output("PASS") },
    signed: sp,
    daemonKey: daemon,
    now: () => T0,
  });
  db.insertCriticReport(report);
  db.insertPolicy(sp, "active", T0, report.hash);
  let t = T0;
  const log = new DecisionLog({ key: daemon, sink: db.decisionSink(), now: () => (t += 1000) });
  const d = log.append({
    kind: "requote",
    policyHash: sp.hash,
    inputsDigest: "b".repeat(64),
    inputsRef: null,
  });
  db.bindAccount({ accountId: "acct-1", stakeCred: STAKE_A, nowMs: T0 });
  return { db, log, policyHash: sp.hash, seq: d.seq };
}

function order(policyHash: string, seq: number, n: number, over: Record<string, unknown> = {}) {
  return {
    clientOrderId: `bal_test_${n}`,
    accountId: "acct-1",
    decisionSeq: seq,
    policyHash,
    symbol: "NIGHT-USD",
    side: "sell" as const,
    reduceOnly: false,
    priceTicks: "38700",
    sizeSteps: "100",
    status: "pending" as OrderStatus,
    createdAtMs: T0,
    ...over,
  };
}

describe("evidence DB: decisions are an append-only hash chain", () => {
  it("accepts the DecisionLog's records, verifies them, and survives a reopen", () => {
    const path = join(dir, "chain.sqlite");
    const db = openEvidenceDb(path);
    const log = new DecisionLog({ key: daemon, sink: db.decisionSink(), now: () => T0 });
    for (let i = 0; i < 5; i++)
      log.append({ kind: "cover", inputsDigest: `${i}`.repeat(64), inputsRef: null });
    db.close();
    const again = openEvidenceDb(path);
    const head = again.decisionHead();
    expect(head?.seq).toBe(5);
    const resumed = new DecisionLog({
      key: daemon,
      sink: again.decisionSink(),
      head,
      now: () => T0 + 1,
    });
    resumed.append({ kind: "kill", inputsDigest: "f".repeat(64), inputsRef: null });
    expect(verifyDecisionChain(again.decisions(), [daemon.publicKeyHex]).ok).toBe(true);
    again.close();
  });

  it("refuses a record that does not extend the chain, and any update or delete", async () => {
    const { db, log } = await setup();
    const next = log.append({ kind: "cover", inputsDigest: "c".repeat(64), inputsRef: null });
    expect(() => db.appendDecision({ ...next, seq: next.seq + 2 })).toThrow(/chain break/);
    const other = new DecisionLog({ key: daemon, head: { seq: next.seq, hash: "d".repeat(64) } });
    expect(() =>
      db.appendDecision(
        other.append({ kind: "cover", inputsDigest: "e".repeat(64), inputsRef: null }),
      ),
    ).toThrow(/chain break/);
    expect(() => db.raw.prepare("UPDATE decisions SET kind = 'kill' WHERE seq = 1").run()).toThrow(
      /append-only/,
    );
    expect(() => db.raw.prepare("DELETE FROM decisions WHERE seq = 2").run()).toThrow(
      /append-only/,
    );
    // When the DB refuses a record, the log does not advance, so no gap can be papered over.
    const stray = new DecisionLog({
      key: daemon,
      sink: db.decisionSink(),
      head: { seq: 40, hash: "9".repeat(64) },
    });
    expect(() =>
      stray.append({ kind: "cover", inputsDigest: "c".repeat(64), inputsRef: null }),
    ).toThrow(/chain break/);
    expect(stray.head()).toEqual({ seq: 40, hash: "9".repeat(64) });
    expect(db.decisionHead()?.seq).toBe(log.head().seq);
  });
});

describe("evidence DB: invariant 2 at the storage layer", () => {
  it("a policy can be active only with a stored PASS for exactly its hash", async () => {
    const db = openEvidenceDb(":memory:");
    const sp = policy("P2");
    const fail = await runCriticGate({
      runner: { run: async () => output("FAIL") },
      signed: sp,
      daemonKey: daemon,
      now: () => T0,
    });
    db.insertCriticReport(fail);
    expect(() => db.insertPolicy(sp, "active", T0, fail.hash)).toThrow(/Critic PASS/);
    expect(() => db.insertPolicy(sp, "active", T0)).toThrow(/CHECK|Critic PASS/);
    db.insertPolicy(sp, "candidate", T0);
    expect(() => db.setPolicyStatus(sp.hash, "active", fail.hash)).toThrow(/Critic PASS/);
    const otherPass = await runCriticGate({
      runner: { run: async () => output("PASS") },
      signed: policy("P3"),
      daemonKey: daemon,
      now: () => T0,
    });
    db.insertCriticReport(otherPass);
    expect(() => db.setPolicyStatus(sp.hash, "active", otherPass.hash)).toThrow(/Critic PASS/);
    const pass = await runCriticGate({
      runner: { run: async () => output("PASS") },
      signed: sp,
      daemonKey: daemon,
      now: () => T0,
    });
    db.insertCriticReport(pass);
    db.setPolicyStatus(sp.hash, "active", pass.hash);
    expect(db.policies()[0]).toMatchObject({ status: "active", criticReportHash: pass.hash });
  });

  it("an order needs an active policy and a recorded decision", async () => {
    const { db, policyHash, seq } = await setup();
    db.insertOrder(order(policyHash, seq, 1));
    db.setPolicyStatus(policyHash, "expired");
    expect(() => db.insertOrder(order(policyHash, seq, 2))).toThrow(/active policy/);
    db.setPolicyStatus(policyHash, "active");
    expect(() => db.insertOrder(order(policyHash, 99, 3))).toThrow(/FOREIGN KEY/);
    expect(() => db.insertOrder(order("e".repeat(64), seq, 4))).toThrow(
      /active policy|FOREIGN KEY/,
    );
  });

  it("every order is a bal_ order and every buy is reduce-only", async () => {
    const { db, policyHash, seq } = await setup();
    expect(() => db.insertOrder(order(policyHash, seq, 1, { clientOrderId: "web_1" }))).toThrow(
      /CHECK/,
    );
    expect(() => db.insertOrder(order(policyHash, seq, 2, { side: "buy" }))).toThrow(/CHECK/);
    db.insertOrder(order(policyHash, seq, 3, { side: "buy", reduceOnly: true }));
    expect(() => db.insertOrder(order(policyHash, seq, 4, { priceTicks: "1.5" }))).toThrow(/CHECK/);
    expect(() => db.insertOrder(order(policyHash, seq, 5, { sizeSteps: "0" }))).toThrow(/CHECK/);
  });
});

describe("evidence DB: invariant 14, unknown counts as resting", () => {
  it("exposure counts pending, resting, partially filled and unknown; never filled, canceled or dropped", async () => {
    const { db, policyHash, seq } = await setup();
    const statuses: OrderStatus[] = [
      "pending",
      "resting",
      "partially_filled",
      "unknown",
      "filled",
      "canceled",
      "rejected",
      "dropped",
    ];
    for (const [i, status] of statuses.entries()) {
      const filledSteps = status === "partially_filled" ? "40" : "0";
      db.insertOrder(order(policyHash, seq, i, { status, filledSteps }));
    }
    expect(db.exposure("acct-1", "NIGHT-USD").askSteps).toBe(100n + 100n + 60n + 100n);
    expect(db.exposure("acct-1", "ADA-USD").askSteps).toBe(0n);
  });

  it("a crash-stranded pending create becomes unknown and still counts", async () => {
    const { db, policyHash, seq } = await setup();
    db.insertOrder(order(policyHash, seq, 1));
    const before = db.exposure("acct-1", "NIGHT-USD").askSteps;
    expect(db.reconcileOrphanedPending(T0 + 5)).toBe(1);
    expect(db.exposure("acct-1", "NIGHT-USD")).toEqual({
      askSteps: before,
      byStatus: { unknown: 100n },
    });
    expect(db.reconcileOrphanedPending(T0 + 6)).toBe(0);
  });

  it("terminal statuses cannot be revived; a dropped create can (late event)", async () => {
    const { db, policyHash, seq } = await setup();
    db.insertOrder(order(policyHash, seq, 1, { status: "resting" }));
    db.updateOrder("bal_test_1", { status: "canceled" }, T0 + 1);
    expect(() => db.updateOrder("bal_test_1", { status: "resting" }, T0 + 2)).toThrow(/terminal/);
    db.insertOrder(order(policyHash, seq, 2, { status: "dropped" }));
    db.updateOrder("bal_test_2", { status: "resting" }, T0 + 3);
    expect(db.exposure("acct-1", "NIGHT-USD").askSteps).toBe(100n);
  });

  it("property: exposure is the open size of every order not proven gone", async () => {
    const { db, policyHash, seq } = await setup();
    let n = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            status: fc.constantFrom<OrderStatus>(
              "pending",
              "resting",
              "partially_filled",
              "unknown",
              "filled",
              "canceled",
              "dropped",
            ),
            size: fc.bigInt({ min: 1n, max: 10n ** 12n }),
            filledPct: fc.integer({ min: 0, max: 100 }),
          }),
          { maxLength: 15 },
        ),
        async (rows) => {
          const acct = `acct-p${n++}`;
          db.bindAccount({ accountId: acct, stakeCred: `stake1u_synthetic_${n}`, nowMs: T0 });
          let expected = 0n;
          rows.forEach((r, i) => {
            const filled = (r.size * BigInt(r.filledPct)) / 100n;
            db.insertOrder({
              ...order(policyHash, seq, i),
              clientOrderId: `bal_${acct}_${i}`,
              accountId: acct,
              status: r.status,
              sizeSteps: String(r.size),
              filledSteps: String(filled),
            });
            if (["pending", "resting", "partially_filled", "unknown"].includes(r.status))
              expected += r.size - filled;
          });
          return db.exposure(acct, "NIGHT-USD").askSteps === expected;
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("evidence DB: invariant 16, one stake credential ↔ one account, dedicated", () => {
  it("UNIQUE stake_cred and UNIQUE account_id", async () => {
    const { db } = await setup();
    expect(() => db.bindAccount({ accountId: "acct-2", stakeCred: STAKE_A, nowMs: T0 })).toThrow(
      AccountBindingError,
    );
    expect(() => db.bindAccount({ accountId: "acct-1", stakeCred: STAKE_B, nowMs: T0 })).toThrow(
      /already bound/,
    );
    expect(() =>
      db.bindAccount({ accountId: "acct-3", stakeCred: "addr1qxyz", nowMs: T0 }),
    ).toThrow(/CHECK/);
    expect(() =>
      db.bindAccount({ accountId: "acct-4", stakeCred: STAKE_B, rBps: 9500, nowMs: T0 }),
    ).toThrow(/CHECK/);
    db.bindAccount({ accountId: "acct-5", stakeCred: STAKE_B, nowMs: T0 });
    expect(db.accountByStake(STAKE_B)?.accountId).toBe("acct-5");
  });

  it("manual activity pauses the account and it cannot be re-activated while flagged", async () => {
    const { db } = await setup();
    db.setAccountStatus("acct-1", "active", null, T0);
    db.flagManualActivity("acct-1", "order web-1234", T0 + 1);
    expect(db.account("acct-1")).toMatchObject({
      status: "paused",
      manualActivity: true,
      pausedReason: "non-Ballast activity: order web-1234",
    });
    expect(() => db.setAccountStatus("acct-1", "active", null, T0 + 2)).toThrow(/CHECK/);
  });
});

describe("evidence DB: kills, cover checks, anchors, probes", () => {
  it("a kill is confirmed only once both the stream and L3 agree (invariant 11)", async () => {
    const { db } = await setup();
    const id = db.insertKill({
      accountId: "acct-1",
      symbol: "NIGHT-USD",
      trigger: "guard",
      sentAtMs: T0,
    });
    db.confirmKill(id, { streamMs: T0 + 80 });
    expect(db.kill(id)?.status).toBe("sent");
    db.confirmKill(id, { l3Ms: T0 + 400 });
    expect(db.kill(id)?.status).toBe("confirmed");
    expect(() =>
      db.raw
        .prepare(
          "INSERT INTO kills (account_id, symbol, trigger, sent_at_ms, status) VALUES ('a','b','guard',1,'confirmed')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("anchors need a tx hash once submitted; probes are labeled", async () => {
    const { db } = await setup();
    const rec = {
      v: 1 as const,
      root: "1".repeat(64),
      decisionsRoot: "2".repeat(64),
      segmentsRoot: "3".repeat(64),
      firstSeq: 1,
      lastSeq: 1,
      segments: [],
      network: "preprod" as const,
      txHash: null,
      createdMs: T0,
    };
    db.insertAnchor(rec, T0);
    db.setAnchorTx(rec.root, "4".repeat(64), "submitted");
    expect(db.anchors()[0]?.txHash).toBe("4".repeat(64));
    expect(() => db.raw.prepare("UPDATE anchors SET tx_hash = NULL").run()).toThrow(/CHECK/);
    db.insertProbe({
      tradeId: "t-1",
      probeAccount: "probe",
      notionalMicroUsd: "10000000",
      tsMs: T0,
    });
    expect(db.isProbe("t-1")).toBe(true);
    expect(db.isProbe("t-2")).toBe(false);
  });
});

describe("evidence DB: single-instance daemon lock (ported)", () => {
  const STALE = 180_000;
  it("refuses a second daemon, is re-entrant, takes over a stale lock, releases only for the holder", () => {
    const db = openEvidenceDb(":memory:");
    expect(db.acquireDaemonLock(101, T0, STALE)).toEqual({ acquired: true });
    expect(db.acquireDaemonLock(202, T0 + 60_000, STALE)).toEqual({
      acquired: false,
      holderPid: 101,
      heartbeatAgeMs: 60_000,
    });
    expect(db.acquireDaemonLock(101, T0 + 5_000, STALE).acquired).toBe(true);
    expect(db.acquireDaemonLock(202, T0 + 5_000 + STALE, STALE).acquired).toBe(false);
    expect(db.acquireDaemonLock(202, T0 + 5_001 + STALE, STALE)).toEqual({
      acquired: true,
      tookOverStalePid: 101,
    });
    db.releaseDaemonLock(101);
    expect(db.acquireDaemonLock(303, T0 + 6_000 + STALE, STALE).acquired).toBe(false);
    db.releaseDaemonLock(202);
    expect(() => acquireDaemonLockOrThrow(db, 303, T0, STALE)).not.toThrow();
    expect(() => acquireDaemonLockOrThrow(db, 404, T0 + 60_000, STALE)).toThrow(
      /pid 303.*60s ago/s,
    );
    db.close();
  });
});
