import {
  microUsd,
  minBigint,
  notionalCeil,
  steps,
  stepsAtLeast,
  stepsWithin,
  ticks,
} from "@ballast/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AllocAccount,
  type AllocLevel,
  allocate,
  BALLAST_MIN_NOTIONAL,
} from "../src/index.js";
import { NIGHT } from "./helpers.js";

/**
 * Invariant 20: water-filling to equal utilization (S_i + A_i)/C_i across outside accounts;
 * holder #0 only when they are full; deterministic; never above capacity.
 */
const accountArb = fc.record({
  committed: fc.bigInt({ min: 0n, max: 400_000n }),
  usedShare: fc.integer({ min: 0, max: 110 }),
  usdRoom: fc.bigInt({ min: 0n, max: 5_000_000_000n }),
});
const arb = fc.record({
  accounts: fc.array(accountArb, { minLength: 1, maxLength: 6 }),
  holder0: fc.option(fc.nat({ max: 5 }), { nil: null }),
  l1: fc.bigInt({ min: 38_000n, max: 39_000n }),
  gaps: fc.array(fc.bigInt({ min: 1n, max: 200n }), { minLength: 0, maxLength: 2 }),
  qty: fc.array(fc.bigInt({ min: 0n, max: 120_000n }), { minLength: 3, maxLength: 3 }),
  aggregate: fc.bigInt({ min: 0n, max: 12_000_000_000n }),
});

type Arb = typeof arb extends fc.Arbitrary<infer T> ? T : never;

function build(a: Arb): { accounts: AllocAccount[]; ladder: AllocLevel[] } {
  const accounts = a.accounts.map((x, i) => {
    const used = (x.committed * BigInt(x.usedShare)) / 100n;
    return {
      id: `acct-${String.fromCharCode(97 + ((i * 7) % 26))}${i}`,
      holder0: a.holder0 === i,
      committed: steps(x.committed),
      used: steps(used),
      room: steps(used >= x.committed ? 0n : x.committed - used),
      usdRoom: microUsd(x.usdRoom),
    };
  });
  let px = a.l1;
  const ladder: AllocLevel[] = [{ level: 1, px: ticks(px), qty: steps(a.qty[0] ?? 0n) }];
  for (const [i, g] of a.gaps.entries()) {
    px += g;
    ladder.push({ level: i + 2, px: ticks(px), qty: steps(a.qty[i + 1] ?? 0n) });
  }
  return { accounts, ladder };
}

const opts = (aggregate: bigint) => ({
  rate: NIGHT.rate,
  minNotional: BALLAST_MIN_NOTIONAL,
  aggregateRoom: microUsd(aggregate),
});

describe("invariant 20: allocator", () => {
  it("never exceeds cover, the account and aggregate caps, or the ladder; every order clears $10.50", () => {
    fc.assert(
      fc.property(arb, (a) => {
        const { accounts, ladder } = build(a);
        const r = allocate(accounts, ladder, opts(a.aggregate));
        let totalUsd = 0n;
        for (const acc of accounts) {
          const mine = r.allocations.filter((x) => x.accountId === acc.id);
          const qty = mine.reduce((s, x) => s + x.qty, 0n);
          const usd = mine.reduce((s, x) => s + notionalCeil(x.px, x.qty, NIGHT.rate), 0n);
          expect(qty <= acc.room).toBe(true);
          expect(usd <= acc.usdRoom).toBe(true);
          totalUsd += usd;
        }
        expect(totalUsd <= a.aggregate).toBe(true);
        for (const l of ladder) {
          const at = r.allocations.filter((x) => x.level === l.level);
          expect(at.reduce((s, x) => s + x.qty, 0n) <= l.qty).toBe(true);
          for (const x of at) {
            expect(x.px).toBe(l.px);
            expect(notionalCeil(x.px, x.qty, NIGHT.rate) >= BALLAST_MIN_NOTIONAL).toBe(true);
          }
        }
      }),
      { numRuns: 10_000 },
    );
  });

  it("gives holder #0 nothing at a level while any outside account still has room there", () => {
    let holder0Filled = 0;
    fc.assert(
      fc.property(arb, (a) => {
        const { accounts, ladder } = build(a);
        const r = allocate(accounts, ladder, opts(a.aggregate));
        const h0 = accounts.find((x) => x.holder0);
        if (!h0) return;
        // Replay level by level to know each outside account's room left at that level.
        const used = new Map(
          accounts.map((x) => [x.id, { room: x.room as bigint, usd: x.usdRoom as bigint }]),
        );
        for (const l of [...ladder].sort((x, y) => x.level - y.level)) {
          const at = r.allocations.filter((x) => x.level === l.level);
          for (const x of at) {
            const u = used.get(x.accountId);
            if (!u) throw new Error("unknown account");
            u.room -= x.qty;
            const usd = notionalCeil(x.px, x.qty, NIGHT.rate);
            u.usd -= usd;
          }
          const gotH0 = at.some((x) => x.accountId === h0.id && x.qty > 0n);
          if (!gotH0) continue;
          holder0Filled += 1;
          const minQty = stepsAtLeast(BALLAST_MIN_NOTIONAL, l.px, NIGHT.rate);
          for (const o of accounts.filter((x) => !x.holder0 && x.committed > 0n)) {
            const u = used.get(o.id);
            if (!u) throw new Error("unknown account");
            const room = minBigint(u.room, stepsWithin(microUsd(u.usd), l.px, NIGHT.rate));
            expect(room < minQty).toBe(true);
          }
        }
      }),
      { numRuns: 10_000 },
    );
    // The property is not vacuous: holder #0 was filled in a good share of the runs.
    expect(holder0Filled).toBeGreaterThan(300);
  });

  it("equalizes utilization across the outside accounts it fills", () => {
    fc.assert(
      fc.property(arb, (a) => {
        const { accounts, ladder } = build({ ...a, holder0: null, gaps: [] });
        const one = ladder.slice(0, 1);
        const r = allocate(accounts, one, opts(a.aggregate));
        const lvl = one[0];
        if (!lvl) return;
        const got = accounts
          .map((acc) => {
            const qty = r.allocations.find((x) => x.accountId === acc.id)?.qty ?? 0n;
            const bound0 = stepsWithin(acc.usdRoom, lvl.px, NIGHT.rate);
            const bound = minBigint(acc.room, bound0);
            return { acc, qty, bound };
          })
          .filter((x) => x.qty > 0n);
        // Two filled accounts below their bound sit within one step of the same water level.
        for (const i of got) {
          for (const j of got) {
            if (i === j || j.qty >= j.bound) continue;
            const ui = (i.acc.used + i.qty) * j.acc.committed;
            const uj = (j.acc.used + j.qty) * i.acc.committed;
            const slack = i.acc.committed + j.acc.committed;
            expect(ui - uj <= slack).toBe(true);
          }
        }
      }),
      { numRuns: 10_000 },
    );
  });

  it("is deterministic: account order does not change the result", () => {
    fc.assert(
      fc.property(arb, fc.integer({ min: 0, max: 1_000 }), (a, rot) => {
        const { accounts, ladder } = build(a);
        const k = rot % accounts.length;
        const rotated = [...accounts.slice(k), ...accounts.slice(0, k)].reverse();
        const r1 = allocate(accounts, ladder, opts(a.aggregate));
        const r2 = allocate(rotated, [...ladder].reverse(), opts(a.aggregate));
        expect(r2).toEqual(r1);
      }),
      { numRuns: 10_000 },
    );
  });

  it("fills one level to equal utilization: a worked example", () => {
    const acc = (id: string, c: bigint, s: bigint, holder0 = false): AllocAccount => ({
      id,
      holder0,
      committed: steps(c),
      used: steps(s),
      room: steps(c - s),
      usdRoom: microUsd(10n ** 12n),
    });
    // C = 100k and 300k, S = 0 and 60k: 40k at L1 → u* = 0.25 → A = 25k and 15k.
    const r = allocate(
      [acc("b", 300_000n, 60_000n), acc("a", 100_000n, 0n), acc("h0", 1_000_000n, 0n, true)],
      [{ level: 1, px: ticks(38_446n), qty: steps(40_000n) }],
      opts(10n ** 12n),
    );
    expect(r.allocations.map((x) => [x.accountId, x.qty])).toEqual([
      ["a", 25_000n],
      ["b", 15_000n],
    ]);
    // 500k at L1 is more than outside room (100k + 240k): holder #0 takes the remaining 160k.
    const big = allocate(
      [acc("a", 100_000n, 0n), acc("b", 300_000n, 60_000n), acc("h0", 1_000_000n, 0n, true)],
      [{ level: 1, px: ticks(38_446n), qty: steps(500_000n) }],
      opts(10n ** 12n),
    );
    expect(big.allocations.map((x) => [x.accountId, x.qty])).toEqual([
      ["a", 100_000n],
      ["b", 240_000n],
      ["h0", 160_000n],
    ]);
  });
});
