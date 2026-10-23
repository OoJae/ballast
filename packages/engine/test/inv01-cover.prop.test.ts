import { minBigint, type Steps, steps, toSteps, toTicks } from "@ballast/core";
import { dec } from "@ballast/market";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  committedSteps,
  DEFAULT_MARGIN_THRESHOLDS,
  effectiveRBps,
  evaluateMarginBand,
  keeperStep,
  NIGHT_CAPS,
  planRequote,
  type RestingOrder,
} from "../src/index.js";
import { NIGHT, nightBook, POLICY, POLICY_HASH, T0 } from "./helpers.js";

/**
 * Invariant 1: short + resting + pending ≤ r × cover, per account, after every enforcement.
 * Random sequences of fills, cover changes, price moves and requotes run through the real
 * requote pipeline and keeper; the invariant is checked after the keeper has acted on each event,
 * and every requote must stay inside capacity on its own (the keeper is the backstop, not the
 * mechanism).
 */
interface Acct {
  id: string;
  holder0: boolean;
  cover: Steps;
  rBps: bigint;
  short: Steps;
  resting: RestingOrder[];
}

const eventArb = fc.oneof(
  fc.record({ kind: fc.constant("fill" as const), qty: fc.bigInt({ min: 1n, max: 40_000n }) }),
  fc.record({
    kind: fc.constant("cover" as const),
    who: fc.nat({ max: 2 }),
    pct: fc.integer({ min: 0, max: 150 }),
  }),
  fc.record({ kind: fc.constant("price" as const), bps: fc.integer({ min: -80, max: 80 }) }),
  fc.record({ kind: fc.constant("requote" as const) }),
);

const arb = fc.record({
  accounts: fc.array(
    fc.record({
      cover: fc.bigInt({ min: 0n, max: 600_000n }),
      rBps: fc.bigInt({ min: 0n, max: 9_500n }),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  events: fc.array(eventArb, { minLength: 1, maxLength: 20 }),
});

const ok = { quoting: true, lastBand: "ok" as const };
const fresh = evaluateMarginBand(1_000n, DEFAULT_MARGIN_THRESHOLDS, ok);

function exposure(a: Acct): bigint {
  return a.short + a.resting.reduce((s, r) => s + r.qty, 0n);
}

/** Applies keeper actions until it has none left (cancels are confirmed instantly here). */
function enforce(a: Acct): void {
  for (let i = 0; i < 4; i++) {
    const d = keeperStep({
      symbol: NIGHT.symbol,
      shortSteps: a.short,
      restingSteps: steps(a.resting.reduce((s, r) => s + r.qty, 0n)),
      unknownOrders: 0,
      coverSteps: a.cover,
      // The keeper takes the effective r, already capped by the policy (rMax 0.5 here).
      rBps: effectiveRBps(a.rBps, POLICY),
      mempoolSpend: null,
      stale: [],
      margin: fresh,
      lossStop: false,
    });
    if (d.actions.length === 0) return;
    for (const act of d.actions) {
      if (act.kind === "cancel-all") a.resting = [];
      else a.short = steps(a.short - act.qty);
    }
  }
}

describe("invariant 1: cover", () => {
  it("never holds a post-enforcement breach, and requotes never create one", () => {
    const seen = { fills: 0, breaches: 0, creates: 0 };
    fc.assert(
      fc.property(arb, (a) => {
        let nextId = 1n;
        let nowMs = T0;
        let indexMicro = 38_300;
        const accts: Acct[] = a.accounts.map((x, i) => ({
          id: `acct-${i}`,
          holder0: i === 0,
          cover: steps(x.cover),
          rBps: x.rBps,
          short: steps(0n),
          resting: [],
        }));
        const cap = (x: Acct) => committedSteps(x.cover, effectiveRBps(x.rBps, POLICY));
        for (const [seq, ev] of a.events.entries()) {
          nowMs += 3_000;
          if (ev.kind === "fill") {
            let left = ev.qty;
            const all = accts
              .flatMap((x) => x.resting.map((r) => ({ x, r })))
              .sort((p, q) => (p.r.px < q.r.px ? -1 : p.r.px > q.r.px ? 1 : 0));
            for (const { x, r } of all) {
              if (left === 0n) break;
              const take = minBigint(r.qty, left);
              left -= take;
              x.short = steps(x.short + take);
              r.qty = steps(r.qty - take);
              seen.fills += 1;
            }
            for (const x of accts) x.resting = x.resting.filter((r) => r.qty > 0n);
          } else if (ev.kind === "cover") {
            const x = accts[ev.who % accts.length] as Acct;
            const before = x.cover;
            x.cover = steps((x.cover * BigInt(ev.pct)) / 100n);
            if (exposure(x) > cap(x) && x.cover < before) seen.breaches += 1;
          } else if (ev.kind === "price") {
            indexMicro = Math.max(30_000, indexMicro + Math.round((indexMicro * ev.bps) / 10_000));
          } else {
            const index = dec(indexMicro).div(1_000_000);
            const shift = BigInt(indexMicro - 38_300);
            const base = nightBook();
            const book = {
              bids: base.bids.map((l) => ({ ...l, px: l.px + shift })),
              asks: base.asks.map((l) => ({ ...l, px: l.px + shift })),
            };
            const plan = planRequote({
              market: NIGHT,
              caps: NIGHT_CAPS,
              policy: POLICY,
              policyHash: POLICY_HASH,
              book,
              index,
              mark: index,
              positions: [],
              positionsAgeMs: 1_000,
              replicaP99Bps: dec("0.77"),
              p2: { mode: "blind" },
              accounts: accts.map((x) => ({
                id: x.id,
                holder0: x.holder0,
                coverSteps: x.cover,
                rBps: x.rBps,
                shortSteps: x.short,
                resting: x.resting,
                maxShortMicroUsd: null,
                lastReplaceBatchMs: null,
                allowCreates: true,
              })),
              nowMs,
              seq: BigInt(seq + 1),
            });
            for (const p of plan.accounts) {
              const x = accts.find((y) => y.id === p.accountId) as Acct;
              if (p.diff.kind !== "replace-batch") continue;
              const cancels = new Set(p.diff.cancels);
              x.resting = x.resting.filter((r) => r.orderId === null || !cancels.has(r.orderId));
              for (const c of p.diff.creates) {
                x.resting.push({
                  clientOrderId: c.client_order_id,
                  orderId: nextId++,
                  px: toTicks(NIGHT.tick, c.price as string),
                  qty: toSteps(NIGHT.step, c.size),
                  status: "open",
                });
                seen.creates += 1;
              }
              // The engine alone (before any keeper action) stays inside capacity.
              expect(exposure(x) <= cap(x)).toBe(true);
            }
          }
          for (const x of accts) {
            enforce(x);
            expect(exposure(x) <= cap(x)).toBe(true);
          }
        }
      }),
      { numRuns: 10_000 },
    );
    expect(seen.creates).toBeGreaterThan(1_000);
    expect(seen.fills).toBeGreaterThan(300);
    expect(seen.breaches).toBeGreaterThan(300);
  });

  it("a cover drop cancels every ask before anything else, and stops creates", () => {
    const d = keeperStep({
      symbol: NIGHT.symbol,
      shortSteps: steps(5_000n),
      restingSteps: steps(7_000n),
      unknownOrders: 0,
      coverSteps: steps(10_000n),
      rBps: 5_000n,
      mempoolSpend: null,
      stale: [],
      margin: fresh,
      lossStop: false,
    });
    expect(d.actions.map((x) => x.kind)).toEqual(["cancel-all"]);
    expect(d.allowCreates).toBe(false);
    expect(d.breach).toBe(true);
    // The short above r × cover (5,000 = 0.5 × 10,000: none) waits for the cancel.
    expect(d.buyBackPending).toBe(0n);
    // Once the cancels are confirmed: a short above capacity is bought back reduce-only.
    const after = keeperStep({
      symbol: NIGHT.symbol,
      shortSteps: steps(5_000n),
      restingSteps: steps(0n),
      unknownOrders: 0,
      coverSteps: steps(6_000n),
      rBps: 5_000n,
      mempoolSpend: null,
      stale: [],
      margin: fresh,
      lossStop: false,
    });
    expect(after.actions).toEqual([
      { kind: "buy-back", symbol: NIGHT.symbol, qty: 2_000n, reason: "short above r × cover" },
    ]);
  });

  it("an unconfirmed spend freezes the account and counts the post-spend cover", () => {
    const d = keeperStep({
      symbol: NIGHT.symbol,
      shortSteps: steps(1_000n),
      restingSteps: steps(1_000n),
      unknownOrders: 0,
      coverSteps: steps(10_000n),
      rBps: 5_000n,
      mempoolSpend: { coverAfterSteps: steps(1_000n) },
      stale: [],
      margin: fresh,
      lossStop: false,
    });
    expect(d.capacity).toBe(500n);
    expect(d.actions.map((x) => x.kind)).toEqual(["cancel-all"]);
    expect(d.buyBackPending).toBe(500n);
    expect(d.allowCreates).toBe(false);
  });

  it("stale data cancels but never buys back", () => {
    const d = keeperStep({
      symbol: NIGHT.symbol,
      shortSteps: steps(1_000n),
      restingSteps: steps(0n),
      unknownOrders: 0,
      coverSteps: steps(10_000n),
      rBps: 5_000n,
      mempoolSpend: null,
      stale: ["index 3200 ms"],
      margin: fresh,
      lossStop: false,
    });
    expect(d.actions).toEqual([]);
    expect(d.allowCreates).toBe(false);
  });
});
