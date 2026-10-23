import { microUsd, notionalCeil, refPrice, steps, ticks } from "@ballast/core";
import { dec, depthWithin, type LevelBook, midPx } from "@ballast/market";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  accountCapacity,
  aggregateCap,
  aggregateRoom,
  allocAccount,
  allocate,
  BALLAST_MIN_NOTIONAL,
  exitDepthMicroUsd,
  NIGHT_CAPS,
} from "../src/index.js";
import { NIGHT, policy } from "./helpers.js";

/** Invariant 22: aggregate short + asks ≤ live exit depth within 2% (Ballast excluded). */
const levelArb = fc.record({
  off: fc.integer({ min: 1, max: 600 }),
  qty: fc.bigInt({ min: 1n, max: 400_000n }),
});
const arb = fc.record({
  bidOff: fc.integer({ min: 0, max: 80 }),
  bids: fc.array(levelArb, { minLength: 0, maxLength: 4 }),
  asks: fc.array(levelArb, { minLength: 0, maxLength: 6 }),
  aggCapUsd: fc.bigInt({ min: 0n, max: 40_000n }),
  accounts: fc.array(
    fc.record({
      cover: fc.bigInt({ min: 0n, max: 3_000_000n }),
      rBps: fc.bigInt({ min: 0n, max: 9_000n }),
      shortShare: fc.integer({ min: 0, max: 100 }),
      holder0: fc.boolean(),
    }),
    { minLength: 1, maxLength: 5 },
  ),
  l1Qty: fc.bigInt({ min: 0n, max: 400_000n }),
});

function bookOf(a: {
  bidOff: number;
  bids: { off: number; qty: bigint }[];
  asks: { off: number; qty: bigint }[];
}): LevelBook {
  const center = 38_300n;
  const dedupe = (ls: { px: bigint; qty: bigint }[]) => {
    const m = new Map<bigint, bigint>();
    for (const l of ls) m.set(l.px, (m.get(l.px) ?? 0n) + l.qty);
    return [...m].map(([px, qty]) => ({ px, qty }));
  };
  const bids = dedupe(
    a.bids.map((b) => ({ px: center - BigInt(a.bidOff + b.off), qty: b.qty })),
  ).sort((x, y) => (x.px > y.px ? -1 : 1));
  const asks = dedupe(a.asks.map((b) => ({ px: center + BigInt(b.off), qty: b.qty }))).sort(
    (x, y) => (x.px < y.px ? -1 : 1),
  );
  return { bids, asks };
}

describe("invariant 22: aggregate cap", () => {
  it("exit depth is the asks within mid + 2%, matching the market model's depth", () => {
    fc.assert(
      fc.property(arb, (a) => {
        const book = bookOf(a);
        const ours = exitDepthMicroUsd(book, NIGHT.rate);
        const mid = midPx(book, NIGHT.tick);
        if (!mid) {
          expect(ours).toBe(0n);
          return;
        }
        // market's Dec depth, in micro-USD, floored per level the same way.
        const theirs = depthWithin(book.asks, "ask", mid, dec("0.02"), NIGHT.spec);
        const diff = dec(theirs.times(1_000_000).toFixed(0)).minus(dec(ours.toString())).abs();
        expect(diff.lte(book.asks.length)).toBe(true);
      }),
      { numRuns: 10_000 },
    );
  });

  it("Σ (short + allocated asks) never exceeds min(policy cap, exit depth)", () => {
    fc.assert(
      fc.property(arb, (a) => {
        const book = bookOf(a);
        const p = policy();
        const pol = {
          ...p,
          sizing: { ...p.sizing, aggregateMaxShortMicroUsd: (a.aggCapUsd * 1_000_000n).toString() },
        };
        const mark = refPrice(NIGHT.tick, "0.03835");
        const caps = a.accounts.map((x, i) => {
          const committed = (x.cover * x.rBps) / 10_000n;
          return accountCapacity(
            {
              id: `a${i}`,
              holder0: x.holder0,
              coverSteps: steps(x.cover),
              rBps: x.rBps,
              shortSteps: steps((committed * BigInt(x.shortShare)) / 100n),
              lockedSteps: steps(0n),
              maxShortMicroUsd: null,
            },
            pol,
            NIGHT_CAPS,
            mark,
            NIGHT.rate,
          );
        });
        const cap = aggregateCap(pol, exitDepthMicroUsd(book, NIGHT.rate));
        const room = aggregateRoom(cap, caps);
        const shorts = caps.reduce((s, c) => s + c.usdUsed, 0n);
        const r = allocate(
          caps.map(allocAccount),
          [{ level: 1, px: ticks(38_455n), qty: steps(a.l1Qty) }],
          { rate: NIGHT.rate, minNotional: BALLAST_MIN_NOTIONAL, aggregateRoom: room },
        );
        const asks = r.allocations.reduce((s, x) => s + notionalCeil(x.px, x.qty, NIGHT.rate), 0n);
        if (shorts <= cap) expect(shorts + asks <= cap).toBe(true);
        else expect(asks).toBe(0n);
        expect(room <= microUsd(cap)).toBe(true);
      }),
      { numRuns: 10_000 },
    );
  });
});
