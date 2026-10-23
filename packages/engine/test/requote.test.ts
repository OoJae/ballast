import { steps, ticks } from "@ballast/core";
import { dec } from "@ballast/market";
import { describe, expect, it } from "vitest";
import {
  NIGHT_CAPS,
  planRequote,
  protocolTakerRoom,
  type RequoteAccount,
  type RequoteInput,
} from "../src/index.js";
import { INDEX, MARK, NIGHT, nightBook, POLICY, POLICY_HASH, T0 } from "./helpers.js";

const acct = (id: string, over: Partial<RequoteAccount> = {}): RequoteAccount => ({
  id,
  holder0: false,
  coverSteps: steps(100_000n),
  rBps: 5_000n,
  shortSteps: steps(0n),
  resting: [],
  maxShortMicroUsd: null,
  lastReplaceBatchMs: null,
  allowCreates: true,
  ...over,
});

const input = (over: Partial<RequoteInput> = {}): RequoteInput => ({
  market: NIGHT,
  caps: NIGHT_CAPS,
  policy: POLICY,
  policyHash: POLICY_HASH,
  book: nightBook(),
  index: INDEX,
  mark: MARK,
  positions: [],
  positionsAgeMs: 1_000,
  replicaP99Bps: dec("0.77"),
  p2: { mode: "blind" },
  accounts: [acct("a"), acct("b"), acct("h0", { holder0: true })],
  nowMs: T0,
  seq: 1n,
  ...over,
});

describe("planRequote", () => {
  it("splits L1 between the outside accounts; holder #0 gets nothing while they have room", () => {
    const p = planRequote(input());
    expect(p.governor.ok).toBe(true);
    const by = (id: string) => p.accounts.find((x) => x.accountId === id);
    expect(by("a")?.desired).toHaveLength(1);
    expect(by("b")?.desired).toHaveLength(1);
    expect(by("h0")?.desired).toEqual([]);
    for (const id of ["a", "b"]) {
      const d = by(id)?.diff;
      if (d?.kind !== "replace-batch") throw new Error(String(d?.kind));
      expect(d.creates[0]?.client_order_id).toMatch(/^bal_[0-9a-f]{6}_[0-9a-f]{6}_1_1$/);
    }
  });

  it("a stand-down cancels what rests and creates nothing", () => {
    const resting = [
      {
        clientOrderId: "bal_x",
        orderId: 9n,
        px: ticks(38_446n),
        qty: steps(3_000n),
        status: "open" as const,
      },
    ];
    const p = planRequote(
      input({ book: nightBook({ asks: [] }), accounts: [acct("a", { resting })] }),
    );
    expect(p.governor).toMatchObject({ ok: false, reason: "no-reference-ask" });
    const d = p.accounts[0]?.diff;
    if (d?.kind !== "replace-batch") throw new Error(String(d?.kind));
    expect(d.creates).toEqual([]);
    expect(d.cancels).toEqual([9n]);
  });

  it("the protocol-as-taker budget caps total asks and, once spent, stops creates", () => {
    expect(
      protocolTakerRoom(
        { dayCapacitySteps: steps(100_000n), filledSteps: steps(20_000n), waived: false },
        2_500n,
      ),
    ).toBe(5_000n);
    expect(
      protocolTakerRoom(
        { dayCapacitySteps: steps(100_000n), filledSteps: steps(30_000n), waived: false },
        2_500n,
      ),
    ).toBe(0n);
    expect(
      protocolTakerRoom(
        { dayCapacitySteps: steps(100_000n), filledSteps: steps(90_000n), waived: true },
        2_500n,
      ),
    ).toBeNull();
    const capped = planRequote(
      input({
        protocolTaker: {
          dayCapacitySteps: steps(100_000n),
          filledSteps: steps(21_000n),
          waived: false,
        },
      }),
    );
    const total = capped.allocation.allocations.reduce((s, x) => s + x.qty, 0n);
    expect(total <= 4_000n).toBe(true);
    const spent = planRequote(
      input({
        protocolTaker: {
          dayCapacitySteps: steps(100_000n),
          filledSteps: steps(25_000n),
          waived: false,
        },
      }),
    );
    expect(spent.allocation.allocations).toEqual([]);
    expect(spent.protocolTakerRoom).toBe(0n);
  });
});
