import { microUsd, steps, ticks, toSteps, toTicks } from "@ballast/core";
import { ADA_CAPS, clientOrderId, NIGHT_CAPS } from "@ballast/engine";
import { dec } from "@ballast/market";
import { RateLimiter } from "@ballast/strike-client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkGuard, type GuardInput, type GuardRuleId } from "../src/index.js";
import { ACCOUNT, baseInput, firstCreate, HASH, MARK, NIGHT, NOW, plan, SEQ } from "./helpers.js";

const passed = (i: GuardInput, rule: GuardRuleId): boolean => {
  const c = checkGuard(i).checks.find((x) => x.rule === rule);
  if (!c) throw new Error(`${rule} not evaluated`);
  return c.passed;
};

/** The base request's single ask, in ticks and steps. */
function baseAsk(i: GuardInput): { px: bigint; qty: bigint } {
  const c = firstCreate(i);
  return { px: toTicks(NIGHT.tick, String(c.price)), qty: toSteps(NIGHT.step, String(c.size)) };
}

describe("invariant 7: no bid ahead of the best non-Ballast bid; every buy reduce-only", () => {
  it("no-bid-ahead passes exactly when the bid is reduce-only and strictly below the best bid", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -30, max: 30 }),
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.bigInt({ min: 38_000n, max: 38_600n }), { nil: null }),
        (d, reduceOnly, optIn, bestBid) => {
          const i = baseInput();
          const px = (bestBid ?? 38_300n) + BigInt(d);
          i.market.bestBidTicks = bestBid === null ? null : ticks(bestBid);
          // An opt-in without the policy's at_best_bid_opt_in exit mode changes nothing.
          i.market.recyclingOptIn = optIn;
          i.request = {
            method: "POST",
            path: "/v2/orders/batch",
            body: {
              orders: [
                {
                  client_order_id: clientOrderId({
                    policyHash: HASH,
                    accountId: ACCOUNT,
                    level: "x",
                    seq: SEQ,
                  }),
                  symbol: "NIGHT-USD",
                  side: "buy",
                  type: "limit",
                  size: "1000",
                  price: NIGHT.tick.fromUnits(px).toFixed(),
                  ...(reduceOnly ? { reduce_only: true } : {}),
                },
              ],
            },
            builderFeeBps: 0,
          };
          const want = reduceOnly && bestBid !== null && px <= bestBid - 1n;
          expect(passed(i, "no-bid-ahead")).toBe(want);
          if (!want) expect(checkGuard(i).decision).not.toBe("execute");
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it("the engine itself only ever proposes post-only asks", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 2_000_000n }),
        fc.bigInt({ min: 0n, max: 40_000n }),
        (cover, short) => {
          for (const a of plan({ cover, short }).accounts) {
            if (a.diff.kind !== "replace-batch") continue;
            for (const c of a.diff.creates) {
              expect(c.side).toBe("sell");
              expect(c.post_only).toBe(true);
            }
          }
        },
      ),
      { numRuns: 10_000 },
    );
  });
});

describe("invariant 17: leverage ≤ 2x (NIGHT) / 3x (ADA) including resting asks", () => {
  it("leverage-cap passes exactly when short + asks at max(price, mark) ≤ cap × equity", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 80_000n }),
        fc.bigInt({ min: 0n, max: 2_000_000_000n }),
        fc.array(
          fc.record({
            px: fc.bigInt({ min: 38_000n, max: 39_000n }),
            qty: fc.bigInt({ min: 1n, max: 9_000n }),
          }),
          { maxLength: 2 },
        ),
        fc.boolean(),
        (short, equity, resting, ada) => {
          const i = baseInput();
          i.account.shortSteps = steps(short);
          i.account.equityMicroUsd = microUsd(equity);
          i.account.resting = resting.map((r, k) => ({
            clientOrderId: `bal_r${k}`,
            orderId: BigInt(100 + k),
            px: ticks(r.px),
            qty: steps(r.qty),
          }));
          if (ada) i.market.caps = { ...NIGHT_CAPS, maxLeverageX100: ADA_CAPS.maxLeverageX100 };
          // Independent USD arithmetic in decimal: NIGHT ticks are micro-USD.
          const m = dec(MARK);
          const ask = baseAsk(i);
          let usd = m.times(short.toString());
          for (const a of [...resting, ask]) {
            const px = dec(a.px.toString()).div(1_000_000);
            usd = usd.plus((px.gt(m) ? px : m).times(a.qty.toString()));
          }
          // The policy's 2x binds on both (ADA's 3x market cap sits above it).
          const want = equity > 0n && usd.times(1_000_000).lte(dec(equity.toString()).times(2));
          expect(passed(i, "leverage-cap")).toBe(want);
        },
      ),
      { numRuns: 10_000 },
    );
  });
});

describe("invariant 21: fee caps", () => {
  it("entries ≤ min(policy 10, market cap 10/2, holder-approved); holder #0 pays 0; exits 0", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 15 }),
        fc.integer({ min: 0, max: 15 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (fee, approved, holder0, ada, exit) => {
          const i = baseInput();
          i.request.builderFeeBps = fee;
          i.account.approvedBuilderBps = approved;
          i.account.holder0 = holder0;
          if (ada) {
            i.market.caps = { ...NIGHT_CAPS, maxEntryBuilderBps: ADA_CAPS.maxEntryBuilderBps };
          }
          if (exit) {
            const body = i.request.body as {
              replacements: { new_order?: Record<string, unknown> }[];
            };
            for (const r of body.replacements) if (r.new_order) r.new_order.reduce_only = true;
          }
          const marketCap = ada ? 2 : 10;
          const cap = holder0 ? 0 : Math.min(10, marketCap, approved);
          expect(passed(i, "fee-cap")).toBe(exit ? fee === 0 : fee <= cap);
        },
      ),
      { numRuns: 10_000 },
    );
  });
});

describe("invariant 22 (Guard side): aggregate short + asks ≤ min(policy, exit depth)", () => {
  it("aggregate-cap passes exactly at the bound", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 30_000_000_000n }),
        fc.bigInt({ min: 0n, max: 30_000_000_000n }),
        fc.bigInt({ min: 0n, max: 20_000n }),
        (others, depth, short) => {
          const i = baseInput();
          i.market.others = { ...i.market.others, exposureMicroUsd: microUsd(others) };
          i.market.exitDepthMicroUsd = microUsd(depth);
          i.account.shortSteps = steps(short);
          const ask = baseAsk(i);
          // NIGHT: 1 tick × 1 step = 1 µUSD; the short is valued at the mark (38,350 ticks).
          const total = others + short * 38_350n + ask.px * ask.qty;
          const cap = depth < 27_700_000_000n ? depth : 27_700_000_000n;
          expect(passed(i, "aggregate-cap")).toBe(total <= cap);
        },
      ),
      { numRuns: 10_000 },
    );
  });
});

describe("invariant 23: rate budget with a cancel reserve", () => {
  const reqArb = fc.record({
    dt: fc.integer({ min: 0, max: 4_000 }),
    account: fc.constantFrom("a", "b", "c"),
    kind: fc.constantFrom("create-rb", "create-rb", "cancel-rb", "cancel", "reduce", "429"),
    ops: fc.integer({ min: 1, max: 40 }),
  });

  it("creates never take the cancel reserve, non-cancels stay ≤ 300/60 s, RB spacing ≥ 2 s", () => {
    let createsAdmitted = 0;
    fc.assert(
      fc.property(fc.array(reqArb, { minLength: 1, maxLength: 80 }), (reqs) => {
        let now = NOW;
        const rl = new RateLimiter({ now: () => now });
        const spent: { at: number; ops: number }[] = [];
        const lastRb = new Map<string, number>();
        for (const r of reqs) {
          now += r.dt;
          if (r.kind === "429") {
            rl.record429();
            continue;
          }
          const create = r.kind === "create-rb";
          const rb = r.kind === "create-rb" || r.kind === "cancel-rb";
          const before = rl.used();
          const last = lastRb.get(r.account);
          // The Guard's rate-budget rule, on the limiter's own state.
          const i = baseInput();
          i.nowMs = now;
          i.request.body = {
            replacements: Array.from({ length: r.ops }, (_, k) => ({
              ...(k === 0 ? { new_order: firstCreate(baseInput()) } : {}),
              cancel: { order_id: BigInt(k + 1), symbol: "NIGHT-USD" },
            })),
          };
          i.rate = {
            usedInWindow: before,
            windowCap: 300,
            cancelReserve: 60,
            lastReplaceBatchMs: last ?? null,
            spacingMs: 2_000,
            pausedUntilMs: rl.pausedUntil,
          };
          const guardOk = passed(i, "rate-budget");
          const d = rl.acquire({
            account: r.account,
            rateClass: create ? "create" : r.kind === "reduce" ? "reduce" : "cancel",
            ops: create ? r.ops + 1 : r.ops,
            replaceBatch: rb,
          });
          if (create) {
            // Same request (1 create + ops − 1 cancels + 1 = ops + 1 tokens) through both.
            expect(d.ok).toBe(guardOk);
          } else if (r.kind === "reduce") {
            expect(d.ok).toBe(before + r.ops <= 300);
          } else {
            expect(d.ok).toBe(true);
          }
          if (!d.ok) continue;
          if (rb) lastRb.set(r.account, now);
          if (r.kind !== "cancel" && r.kind !== "cancel-rb") {
            spent.push({ at: now, ops: create ? r.ops + 1 : r.ops });
          }
          if (create) {
            createsAdmitted += 1;
            expect(last === undefined || now - last >= 2_000).toBe(true);
            expect(rl.used()).toBeLessThanOrEqual(240);
          }
          const window = spent.filter((s) => s.at > now - 60_000).reduce((a, s) => a + s.ops, 0);
          expect(window).toBeLessThanOrEqual(300);
        }
      }),
      { numRuns: 10_000 },
    );
    expect(createsAdmitted).toBeGreaterThan(5_000);
  });

  it("after three 429s in 60 s, creates pause 30 s while cancels still go", () => {
    let now = NOW;
    const rl = new RateLimiter({ now: () => now });
    for (let k = 0; k < 3; k++) {
      rl.record429();
      now += 1_000;
    }
    const create = { account: "a", rateClass: "create" as const, ops: 1, replaceBatch: false };
    expect(rl.acquire(create)).toMatchObject({ ok: false, reason: "paused-after-429" });
    expect(rl.acquire({ ...create, rateClass: "cancel" }).ok).toBe(true);
    now += 30_000;
    expect(rl.acquire(create).ok).toBe(true);
  });
});
