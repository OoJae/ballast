import {
  microUsd,
  notionalCeil,
  refNotionalCeil,
  refPlusBpsCeil,
  steps,
  ticks,
} from "@ballast/core";
import { clientOrderId, committedSteps, validateCreate } from "@ballast/engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkGuard, type GuardInput, guardedSend } from "../src/index.js";
import { ACCOUNT, baseInput, firstCreate, HASH, NIGHT, NOW, SEQ } from "./helpers.js";

/**
 * The Ripcord wiring pattern: a maximally permissive engine proposes anything, and the signer is
 * reached only through `guardedSend`. (1) Under any combination of known blocking conditions the
 * Guard never says "execute" and the signer spy is never called. (2) Whatever the permissive
 * engine proposes, an "execute" implies the invariants hold, re-derived here independently.
 */
type Mutation = [string, (i: GuardInput) => void];

const BLOCKING: Mutation[] = [
  ["no policy", (i) => (i.policy = null)],
  ["bad signature", (i) => (i.policy = i.policy && { ...i.policy, signatureValid: false })],
  ["policy expired", (i) => (i.nowMs = NOW + 24 * 3_600_000)],
  ["renewals exhausted", (i) => (i.policy = i.policy && { ...i.policy, renewalsUsed: 99 })],
  ["no critic", (i) => (i.critic = null)],
  ["critic FAIL", (i) => (i.critic = i.critic && { ...i.critic, verdict: "FAIL" })],
  ["mainnet unarmed", (i) => (i.flags = { ...i.flags, armed: false, mainnet: true })],
  ["not in asset book", (i) => (i.market.allowlist = [])],
  ["disarmed market", (i) => (i.market.arm = { armed: false, reason: "test" })],
  ["index stale", (i) => (i.data.indexAgeMs = 3_500)],
  ["mark stale", (i) => (i.data.markAgeMs = 3_500)],
  ["L3 gap", (i) => (i.data.l3GapFree = false)],
  ["cover stale", (i) => (i.data.coverAgeMs = 61_000)],
  ["markets stale", (i) => (i.data.marketsAgeMs = 121_000)],
  ["stream down", (i) => (i.data.userStreamConnected = false)],
  ["index divergent", (i) => (i.reference = { status: "divergent", deviationBps: 200n })],
  ["cover sold", (i) => (i.account.coverSteps = steps(1_000n))],
  ["unbound stake", (i) => (i.account.stakeBinding = { bound: false, unique: true })],
  ["manual order", (i) => (i.account.foreignOrders = 1)],
  ["vault shares", (i) => (i.account.vaultShares = true)],
  [
    "floor above the ladder",
    (i) => (i.market.floor = i.market.floor && { ...i.market.floor, ticks: ticks(39_000n) }),
  ],
  [
    "fragile long",
    (i) =>
      (i.market.p2 = { mode: "blind", fragileLong: true, capMicroUsd: microUsd(300_000_000n) }),
  ],
  ["no P2 projection", (i) => (i.market.p2 = null)],
  ["bid at the ask", (i) => (i.market.bestBidTicks = ticks(38_500n))],
  ["no equity", (i) => (i.account.equityMicroUsd = microUsd(0n))],
  ["margin reduce band", (i) => (i.account.marginRatioBps = 5_500n)],
  ["holder cap tiny", (i) => (i.account.maxShortMicroUsd = microUsd(1_000_000n))],
  ["no exit depth", (i) => (i.market.exitDepthMicroUsd = microUsd(0n))],
  ["fee over cap", (i) => (i.request = { ...i.request, builderFeeBps: 25 })],
  ["loss stop", (i) => (i.account.lossTodayMicroUsd = microUsd(10n ** 12n))],
  ["no allocator", (i) => (i.allocator = null)],
  ["rate exhausted", (i) => (i.rate.usedInWindow = 300)],
  ["429 pause", (i) => (i.rate.pausedUntilMs = NOW + 30_000)],
  [
    "id reused",
    (i) => (i.usedClientOrderIds = new Set([String(firstCreate(baseInput()).client_order_id)])),
  ],
  ["cancel-only profile", (i) => (i.profile = "CANCEL_ONLY")],
  ["unknown orders", (i) => (i.account.unknownOrders = 2)],
  ["unconfirmed create", (i) => (i.account.oldestUnconfirmedCreateAtMs = NOW - 6_000)],
  ["refused route", (i) => (i.request = { ...i.request, path: "/v2/order/replace" })],
];

describe("wiring: no blocking condition ever reaches the signer", () => {
  it("each blocking condition alone blocks", () => {
    for (const [name, mutate] of BLOCKING) {
      const i = baseInput();
      mutate(i);
      expect(checkGuard(i).decision, name).toBe("blocked");
    }
  });

  it("any combination of them, with or without DRY_RUN, never executes; the spy stays untouched", async () => {
    let calls = 0;
    const spy = async () => {
      calls += 1;
      return "sent";
    };
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(BLOCKING, { minLength: 1 }),
        fc.boolean(),
        async (muts, dryRun) => {
          const i = baseInput();
          i.flags = { ...i.flags, dryRun };
          for (const [, m] of muts) m(i);
          const { result, sent } = await guardedSend(i, spy);
          expect(result.decision).toBe("blocked");
          expect(sent).toBeNull();
          expect(result.violations.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 10_000 },
    );
    expect(calls).toBe(0);
    // And the unmutated base does reach it: the spy is wired, not dead.
    const ok = await guardedSend(baseInput(), spy);
    expect(ok.sent).toBe("sent");
    expect(calls).toBe(1);
  });
});

const createArb = fc.record({
  side: fc.constantFrom("sell", "sell", "sell", "sell", "buy"),
  dPx: fc.integer({ min: -60, max: 160 }),
  size: fc.integer({ min: 0, max: 12_000 }),
  postOnly: fc.boolean(),
  reduceOnly: fc.boolean(),
  level: fc.constantFrom<1 | 2 | 3 | "x">(1, 1, 1, 2, 3, "x"),
  seqOff: fc.constantFrom(0n, 0n, 0n, 1n),
  type: fc.constantFrom("limit", "limit", "limit", "market"),
});

/** Asks around L1; exit bids around the best bid (38300), so both sides can be admitted. */
const pxOf = (c: { side: string; dPx: number }): bigint =>
  c.side === "sell" ? 38_446n + BigInt(c.dPx) : 38_300n + BigInt(c.dPx % 40);

const permissiveArb = fc.record({
  useBase: fc.boolean(),
  creates: fc.array(createArb, { maxLength: 4 }),
  cancels: fc.array(fc.bigInt({ min: 1n, max: 20n }), { maxLength: 2 }),
  batch: fc.boolean(),
  fee: fc.integer({ min: 0, max: 12 }),
  short: fc.bigInt({ min: 0n, max: 60_000n }),
  cover: fc.bigInt({ min: 0n, max: 200_000n }),
  equity: fc.bigInt({ min: 0n, max: 600_000_000n }),
});

describe("wiring: a permissive engine cannot get an unsafe request executed", () => {
  it("execute ⇒ cover, floor, bids, static rules, caps, leverage and fees all hold", () => {
    let executed = 0;
    fc.assert(
      fc.property(permissiveArb, (a) => {
        const i = baseInput();
        const base = firstCreate(i);
        const creates = a.useBase
          ? [base]
          : a.creates.map((c) => ({
              client_order_id: clientOrderId({
                policyHash: HASH,
                accountId: ACCOUNT,
                level: c.level,
                seq: SEQ + c.seqOff,
              }),
              symbol: "NIGHT-USD",
              side: c.side,
              type: c.type,
              size: String(c.size),
              ...(c.type === "limit" ? { price: NIGHT.tick.fromUnits(pxOf(c)).toFixed() } : {}),
              ...(c.postOnly ? { post_only: true } : {}),
              ...(c.reduceOnly || c.side === "buy" ? { reduce_only: true } : {}),
            }));
        i.request = a.batch
          ? {
              method: "POST",
              path: "/v2/orders/batch",
              body: { orders: creates },
              builderFeeBps: a.fee,
            }
          : {
              method: "POST",
              path: "/v2/order/replace-batch",
              body: {
                replacements: [
                  ...creates.map((c) => ({ new_order: c })),
                  ...a.cancels.map((id) => ({ cancel: { order_id: id, symbol: "NIGHT-USD" } })),
                ],
              },
              builderFeeBps: a.fee,
            };
        i.account.shortSteps = steps(a.short);
        i.account.coverSteps = steps(a.cover);
        i.account.equityMicroUsd = microUsd(a.equity);
        const res = checkGuard(i);
        if (res.decision !== "execute") return;
        // Cancel-only batches are exempt by design: they only ever reduce exposure.
        if (res.riskReducing) {
          expect(creates).toHaveLength(0);
          return;
        }
        executed += 1;
        // Independent re-derivation of what an executed request must satisfy.
        const mark = i.market.mark;
        const index = i.market.index;
        if (!mark || !index || !i.market.floor) throw new Error("facts");
        const committed = committedSteps(steps(a.cover), 5_000n);
        let askQty = 0n;
        let askUsd = 0n;
        for (const c of creates) {
          const v = validateCreate(
            NIGHT,
            { price: String(c.price), size: String(c.size), reduceOnly: c.reduce_only === true },
            mark,
          );
          expect(v.ok).toBe(true);
          if (c.side === "sell") {
            expect(c.post_only).toBe(true);
            expect(v.px >= i.market.floor.ticks).toBe(true);
            expect(v.px >= refPlusBpsCeil(index, 38n)).toBe(true);
            expect(v.px > (i.market.bestBidTicks ?? 0n)).toBe(true);
            askQty += v.qty;
            askUsd += notionalCeil(v.px, v.qty, NIGHT.rate);
          } else {
            expect(c.reduce_only).toBe(true);
            expect(v.px < (i.market.bestBidTicks ?? 0n)).toBe(true);
          }
        }
        expect(a.short + askQty <= committed).toBe(true);
        const exposure = refNotionalCeil(mark, steps(a.short), NIGHT.rate) + askUsd;
        expect(exposure <= 2_000_000_000n).toBe(true);
        expect(exposure <= i.market.exitDepthMicroUsd).toBe(true);
        expect(exposure * 100n <= a.equity * 200n).toBe(true);
        expect(askUsd <= 300_000_000n).toBe(true);
        expect(creates.some((c) => c.side === "buy") ? a.fee === 0 : a.fee <= 10).toBe(true);
      }),
      { numRuns: 10_000 },
    );
    expect(executed).toBeGreaterThan(500);
  });
});
