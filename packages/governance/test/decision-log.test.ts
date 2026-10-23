import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type DecisionDraft,
  DecisionLog,
  type DecisionRecord,
  verifyDecisionChain,
} from "../src/index.js";
import { daemon, operator, strangerDaemon, T0, TRUST } from "./helpers.js";

const D = (i: number) => i.toString(16).padStart(64, "0");

function draft(i: number): DecisionDraft {
  return i % 3 === 0
    ? {
        kind: "requote",
        policyHash: D(1),
        accountId: "acct-1",
        inputsDigest: D(1000 + i),
        inputsRef: { segment: "2026-10-23/00/l3.0.jsonl", offset: i * 10 },
        ops: [
          { route: "POST /v2/order/replace-batch", cancelOrderId: String(9000 + i) },
          {
            route: "POST /v2/order/replace-batch",
            clientOrderId: `bal_aaaaaa_bbbbbb_1_${i.toString(36)}`,
            side: "sell",
            priceTicks: "38700",
            sizeSteps: "260",
            builderBps: 10,
          },
        ],
        guard: { decision: "dry-run", checksHash: D(77), violations: [] },
      }
    : { kind: i % 3 === 1 ? "cover" : "critic", inputsDigest: D(2000 + i), inputsRef: null };
}

function chain(n: number): DecisionRecord[] {
  let t = T0;
  const log = new DecisionLog({ key: daemon, now: () => (t += 1000) });
  return Array.from({ length: n }, (_, i) => log.append(draft(i)));
}

describe("decision log: hash-chained, JCS-hashed, daemon-signed", () => {
  it("verifies a fresh chain and continues it after a restart", () => {
    const records = chain(6);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(records[0]?.prevHash).toBeNull();
    expect(records[1]?.prevHash).toBe(records[0]?.hash);
    expect(verifyDecisionChain(records, TRUST.trustedDaemons)).toEqual({
      ok: true,
      checked: 6,
      failures: [],
    });

    const last = records.at(-1) as DecisionRecord;
    const restarted = new DecisionLog({
      key: daemon,
      head: { seq: last.seq, hash: last.hash },
      now: () => T0 + 99_000,
    });
    const next = restarted.append(draft(7));
    expect(next).toMatchObject({ seq: 7, prevHash: last.hash });
    expect(verifyDecisionChain([...records, next], TRUST.trustedDaemons).ok).toBe(true);
    // A slice verifies against the hash before it.
    expect(
      verifyDecisionChain(records.slice(2), TRUST.trustedDaemons, { startPrev: records[1]?.hash })
        .ok,
    ).toBe(true);
  });

  it("refuses malformed drafts and non-daemon keys", () => {
    const log = new DecisionLog({ key: daemon });
    expect(() => log.append({ kind: "fill", inputsDigest: "nope", inputsRef: null })).toThrow(
      /inputsDigest/,
    );
    expect(() =>
      log.append({ ...draft(3), ops: [{ route: "x", priceTicks: "1.5" }] } as DecisionDraft),
    ).toThrow(/integer string/);
    // @ts-expect-error an operator key cannot sign decision records
    expect(() => new DecisionLog({ key: operator })).toThrow(/daemon-signed/);
    expect(log.head()).toEqual({ seq: 0, hash: null });
  });

  it("a failed sink write does not advance the head", () => {
    let fail = true;
    const log = new DecisionLog({
      key: daemon,
      sink: {
        append: () => {
          if (fail) throw new Error("disk full");
        },
      },
    });
    expect(() => log.append(draft(1))).toThrow(/disk full/);
    expect(log.head().seq).toBe(0);
    fail = false;
    expect(log.append(draft(1)).seq).toBe(1);
  });

  it("tamper: modifying any field of any record fails verify", () => {
    const records = chain(9);
    const fields = [
      "seq",
      "prevHash",
      "tsMs",
      "kind",
      "inputsDigest",
      "inputsRef",
      "ops",
      "guard",
      "accountId",
      "hash",
      "sig",
    ] as const;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 8 }), fc.constantFrom(...fields), (idx, field) => {
        const copy = structuredClone(records);
        const r = copy[idx] as unknown as Record<string, unknown>;
        switch (field) {
          case "seq":
            r.seq = (r.seq as number) + 1;
            break;
          case "tsMs":
            r.tsMs = (r.tsMs as number) + 1;
            break;
          case "kind":
            r.kind = r.kind === "cover" ? "kill" : "cover";
            break;
          case "prevHash":
            r.prevHash = D(5);
            break;
          case "inputsRef":
            r.inputsRef = { segment: "forged", offset: 0 };
            break;
          case "ops":
            r.ops = [{ route: "POST /v2/order", clientOrderId: "bal_forged" }];
            break;
          case "guard":
            r.guard = { decision: "execute", checksHash: D(78), violations: [] };
            break;
          case "accountId":
            r.accountId = "acct-forged";
            break;
          case "hash":
          case "sig":
          case "inputsDigest": {
            const v = r[field] as string;
            r[field] = `${v.slice(0, -1)}${v.endsWith("0") ? "1" : "0"}`;
            break;
          }
        }
        return !verifyDecisionChain(copy, TRUST.trustedDaemons).ok;
      }),
      { numRuns: 300 },
    );
  });

  it("tamper: dropping, reordering, re-signing with another key, or splicing fails verify", () => {
    const records = chain(5);
    const drop = [...records.slice(0, 2), ...records.slice(3)];
    expect(verifyDecisionChain(drop, TRUST.trustedDaemons).ok).toBe(false);
    const swapped = [
      records[0],
      records[2],
      records[1],
      records[3],
      records[4],
    ] as DecisionRecord[];
    expect(verifyDecisionChain(swapped, TRUST.trustedDaemons).ok).toBe(false);
    const forger = new DecisionLog({ key: strangerDaemon, now: () => T0 + 1000 });
    const forged = chain(1).concat(forger.append(draft(1)));
    expect(verifyDecisionChain(forged, TRUST.trustedDaemons).ok).toBe(false);
    const truncatedStart = records.slice(1);
    expect(
      verifyDecisionChain(truncatedStart, TRUST.trustedDaemons, { startPrev: null, startSeq: 1 })
        .ok,
    ).toBe(false);
  });
});
