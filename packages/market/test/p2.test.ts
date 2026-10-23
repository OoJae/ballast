import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  basisSample,
  bookTop,
  consume,
  type Dec,
  DOCUMENTED_MARK_PARAMS,
  dec,
  Grid,
  type Level,
  type LevelBook,
  mergeLevels,
  type P2ProjectionInput,
  p2BlindMode,
  parseMarginTiers,
  projectP2,
  projectP2Path,
  type RawMarginTier,
} from "../src/index.js";

const NIGHT = parseMarginTiers(
  (
    JSON.parse(readFileSync(new URL("./fixtures/markets.json", import.meta.url), "utf8")) as {
      markets: Record<string, { margin_tiers: RawMarginTier[] }>;
    }
  ).markets["NIGHT-USD"]?.margin_tiers ?? [],
);

const market = {
  tick: new Grid("0.000001"),
  step: new Grid("1"),
  impactNotional: dec(1000),
  quotePrec: 8,
};
const params = { ...DOCUMENTED_MARK_PARAMS, basisWindow: 60 };

describe("projectP2Path", () => {
  it("rolls the newest samples in and the oldest out", () => {
    const path = projectP2Path([dec(1), dec(2), dec(3)], dec(6), dec(0), 3).map((d) => d.toFixed());
    expect(path).toEqual(["2", dec(11).div(3).toDecimalPlaces(18).toFixed(), "5", "6"]);
    const short = projectP2Path([dec(1), dec(2), dec(3)], dec(6), dec(0), 5).map((d) =>
      d.toFixed(),
    );
    expect(short.slice(0, 3)).toEqual(["2", "3", "3.6"]);
    expect(projectP2Path([], dec(1), dec(10), 2).map((d) => d.toFixed())).toEqual([
      "10",
      "11",
      "11",
    ]);
  });
});

// A NIGHT-like book: a deep bid near index, a thin ask ~1% up, the rest further out.
const book: LevelBook = {
  bids: [{ px: 38_300n, qty: 400_000n }],
  asks: [
    { px: 38_750n, qty: 600n },
    { px: 38_800n, qty: 5_000n },
    { px: 38_900n, qty: 50_000n },
  ],
};
const index = dec("0.0384");
const steady = basisSample(bookTop(book, market, 0), index, "impact");
const history = Array.from({ length: 60 }, () => steady);
const p2Now = index.plus(steady);
const ladder: Level[] = [
  { px: 38_600n, qty: 2_000n },
  { px: 38_640n, qty: 3_000n },
];
const base = (over: Partial<P2ProjectionInput> = {}): P2ProjectionInput => ({
  book,
  ladder,
  index,
  basis: history,
  basisGapFree: true,
  params,
  market,
  target: null,
  fragileLong: false,
  minL1Ticks: 38_450n,
  maxL1Ticks: 38_740n,
  ...over,
});

describe("projectP2 (Section 5's P2 constraint)", () => {
  it("stands down while a fragile long exists if P2 uses the top-of-book mid", () => {
    const r = projectP2(base({ fragileLong: true, params: { ...params, mid: "top" } }));
    expect(r).toMatchObject({
      ok: false,
      reason: "fragile-long-top-mid",
      detail: "a fragile long exists and P2 uses the top-of-book mid",
    });
  });

  it("stands down on a basis history that is not a full, gap-free window", () => {
    for (const n of [0, 1, 59]) {
      const r = projectP2(base({ basis: history.slice(0, n), target: index, fragileLong: true }));
      expect(r).toMatchObject({
        ok: false,
        reason: "basis-history-incomplete",
        detail: `${n}/60 samples`,
      });
    }
    expect(projectP2(base({ basisGapFree: false }))).toMatchObject({
      ok: false,
      reason: "basis-history-incomplete",
      detail: "60/60 samples, not gap-free",
    });
    // A longer history is fine: only the latest window counts.
    expect(projectP2(base({ basis: [...history, ...history] })).ok).toBe(true);
  });

  it("stands down when P2 without Ballast falls below the target (partial fills return there)", () => {
    // Asks short of the $1,000 impact notional: the impact ask falls back to the index, so the
    // book without Ballast projects a lower P2 than the book with Ballast's (fillable) ladder.
    const thin: LevelBook = { bids: book.bids, asks: [{ px: 38_900n, qty: 5_000n }] };
    const flat = basisSample(bookTop(thin, market, 0), index, "impact");
    const hist = Array.from({ length: 60 }, () => flat);
    const withLadder = basisSample(
      bookTop(
        { bids: thin.bids, asks: mergeLevels(thin.asks, [{ px: 38_600n, qty: 30_000n }], "ask") },
        market,
        0,
      ),
      index,
      "impact",
    );
    expect(withLadder.gt(flat)).toBe(true);
    const target = index.plus(flat).plus(withLadder.minus(flat).div(2));
    const r = projectP2(
      base({
        book: thin,
        basis: [...hist.slice(0, 30), ...Array.from({ length: 30 }, () => withLadder)],
        ladder: [{ px: 38_600n, qty: 30_000n }],
        target,
        minL1Ticks: 38_600n,
        maxL1Ticks: 38_600n,
      }),
    );
    expect(r).toMatchObject({ ok: false, reason: "p2-below-target" });
  });

  it("stands down when P2 is already below the target", () => {
    const r = projectP2(base({ target: p2Now.plus("0.000001") }));
    expect(r).toMatchObject({ ok: false, reason: "p2-below-target" });
  });

  it("without a liquidation target, the cheapest L1 is the bottom of the range, depth uncapped", () => {
    const r = projectP2(base());
    if (!r.ok) throw new Error(r.detail);
    expect(r.l1Ticks).toBe(38_450n);
    expect(r.depthCapped).toBe(true);
    expect(r.maxDepthNotional.gte(dec(1000))).toBe(true);
  });

  it("finds the cheapest safe L1 and the largest safe depth there", () => {
    const shiftTo = (l1: bigint, q: bigint): Level[] => [
      { px: l1, qty: q },
      ...ladder.slice(1).map((l) => ({ ...l, px: l.px - 38_600n + l1 })),
    ];
    // Target halfway between P2 without a ladder and P2 with it at the bottom of the range.
    const bottom = projectP2(base({ ladder: shiftTo(38_450n, 2_000n) }));
    if (!bottom.ok) throw new Error(bottom.detail);
    const t2 = p2Now.plus(bottom.proposed.minP2.minus(p2Now).div(2));
    const r = projectP2(base({ target: t2, fragileLong: true }));
    if (!r.ok) throw new Error(r.detail);
    expect(t2.lt(p2Now)).toBe(true);
    expect(r.minP2.gte(t2)).toBe(true);
    expect(r.l1Ticks > 38_450n && r.l1Ticks <= 38_740n).toBe(true);
    // One tick cheaper is not safe (the scan is exhaustive from the bottom).
    const cheaper = projectP2(base({ target: t2, maxL1Ticks: r.l1Ticks - 1n }));
    expect(cheaper).toMatchObject({ ok: false, reason: "infeasible" });
    // The reported depth at L1 is safe; one step more is not (unless the window is saturated).
    const at = (q: bigint) =>
      projectP2(
        base({
          target: t2,
          ladder: shiftTo(r.l1Ticks, q),
          minL1Ticks: r.l1Ticks,
          maxL1Ticks: r.l1Ticks,
        }),
      );
    const ok = at(r.maxDepthSteps);
    expect(ok.ok && ok.proposed.safe).toBe(true);
    if (!r.depthCapped) {
      const over = at(r.maxDepthSteps + 1n);
      expect(over.ok && over.proposed.safe).toBe(false);
    }
  });

  it("reports the proposed ladder's own projection", () => {
    const r = projectP2(base({ target: p2Now.times("0.999") }));
    if (!r.ok) throw new Error(r.detail);
    const merged = mergeLevels(book.asks, ladder, "ask");
    const next = basisSample(
      bookTop({ bids: book.bids, asks: merged }, market, 0),
      index,
      "impact",
    );
    // Over the horizon P2 converges to index + the ladder's basis.
    expect(r.proposed.minP2.toDecimalPlaces(12).eq(index.plus(next).toDecimalPlaces(12))).toBe(
      true,
    );
    expect(r.horizonSamples).toBe(60);
  });

  it("stands down when no L1 in range is safe, and on an empty ladder", () => {
    const r = projectP2(base({ target: p2Now, maxL1Ticks: 38_460n }));
    expect(r).toMatchObject({ ok: false, reason: "infeasible" });
    expect(projectP2(base({ ladder: [] }))).toMatchObject({ ok: false, reason: "empty-ladder" });
  });
});

describe("P2-blind mode (before D6)", () => {
  const safeLong = {
    size: "1000",
    entryPrice: "0.0384",
    markPrice: "0.0384",
    liquidationPrice: "0.0300",
  };
  const input = {
    floorTicks: 38_500n,
    mark: dec("0.03852"),
    index: dec("0.0384"),
    positions: [safeLong],
    tiers: NIGHT,
    bLiqBps: dec(12),
    ladder: [{ px: 38_600n, qty: 7_000n }],
    tick: market.tick,
    step: market.step,
  };
  it("admits a ladder within $300 with L1 ≥ max(F, mark)", () => {
    const r = p2BlindMode(input);
    if (!r.ok) throw new Error(r.detail);
    expect(r.minL1Ticks).toBe(38_520n);
    expect(r.maxTotalNotional.toFixed()).toBe("300");
    expect(r.ladderNotional.toFixed()).toBe("270.2");
    const highFloor = p2BlindMode({ ...input, floorTicks: 38_600n });
    expect(highFloor.ok && highFloor.minL1Ticks).toBe(38_600n);
  });
  it("stands down instead of returning ok for a ladder over $300 or priced below max(F, mark)", () => {
    expect(p2BlindMode({ ...input, ladder: [{ px: 38_600n, qty: 7_800n }] })).toMatchObject({
      ok: false,
      reason: "blind-ladder-too-large",
    });
    // The reviewer's case: a $38K ladder below the floor.
    expect(p2BlindMode({ ...input, ladder: [{ px: 38_000n, qty: 1_000_000n }] })).toMatchObject({
      ok: false,
    });
    expect(p2BlindMode({ ...input, ladder: [{ px: 38_510n, qty: 1_000n }] })).toMatchObject({
      ok: false,
      reason: "blind-l1-below-floor",
    });
    expect(
      p2BlindMode({
        ...input,
        ladder: [
          { px: 38_700n, qty: 1_000n },
          { px: 38_519n, qty: 1_000n },
        ],
      }),
    ).toMatchObject({ ok: false, reason: "blind-l1-below-floor" });
    expect(p2BlindMode({ ...input, floorTicks: 38_700n })).toMatchObject({
      ok: false,
      reason: "blind-l1-below-floor",
    });
    expect(p2BlindMode({ ...input, ladder: [] })).toMatchObject({
      ok: false,
      reason: "empty-ladder",
    });
  });
  it("ok always means admissible (property)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            px: fc.bigInt({ min: 38_000n, max: 39_500n }),
            qty: fc.bigInt({ min: 1n, max: 12_000n }),
          }),
          { maxLength: 4 },
        ),
        fc.bigInt({ min: 0n, max: 39_000n }),
        (ladder, floorTicks) => {
          const r = p2BlindMode({ ...input, ladder, floorTicks });
          if (!r.ok) return;
          expect(r.ladderNotional.lte(300)).toBe(true);
          for (const l of ladder) expect(l.px >= r.minL1Ticks && l.px >= floorTicks).toBe(true);
          expect(market.tick.fromUnits(r.minL1Ticks).gte(input.mark)).toBe(true);
        },
      ),
      { numRuns: 10_000 },
    );
  });
  it("stands down if any live long's trigger is ≥ index × (1 − b_liq)", () => {
    const r = p2BlindMode({
      ...input,
      positions: [{ ...safeLong, size: "1", liquidationPrice: "0.03836" }],
    });
    expect(r).toMatchObject({ ok: false, reason: "blind-fragile-long" });
  });
});

describe("projectP2 (properties)", () => {
  const n = 8;
  const small = { ...params, basisWindow: n };
  const arb = fc.record({
    bidQty: fc.bigInt({ min: 30_000n, max: 400_000n }),
    houseAsks: fc.array(
      fc.record({
        off: fc.bigInt({ min: 100n, max: 900n }),
        qty: fc.bigInt({ min: 100n, max: 60_000n }),
      }),
      { minLength: 1, maxLength: 3 },
    ),
    ladder: fc.array(
      fc.record({
        gap: fc.bigInt({ min: 0n, max: 30n }),
        qty: fc.bigInt({ min: 100n, max: 20_000n }),
      }),
      { minLength: 1, maxLength: 3 },
    ),
    basis: fc.array(fc.integer({ min: -200, max: 400 }), { minLength: n, maxLength: n }),
    targetBps: fc.integer({ min: -60, max: 5 }),
    range: fc.bigInt({ min: 0n, max: 12n }),
    q: fc.double({ min: 0, max: 1, noNaN: true }),
  });
  type Case = typeof arb extends fc.Arbitrary<infer T> ? T : never;
  const build = (a: Case) => {
    const book: LevelBook = {
      bids: [{ px: 38_300n, qty: a.bidQty }],
      asks: [...new Map(a.houseAsks.map((h) => [38_400n + h.off, h.qty]))]
        .map(([px, qty]) => ({ px, qty }))
        .sort((x, y) => (x.px < y.px ? -1 : 1)),
    };
    let px = 38_450n;
    const ladder: Level[] = a.ladder.map((l) => {
      px += l.gap + 1n;
      return { px, qty: l.qty };
    });
    const basis: Dec[] = a.basis.map((b) => index.times(b).div(100_000));
    const p2Now = index.plus(basis.reduce((x, y) => x.plus(y), dec(0)).div(n));
    const target = p2Now.times(dec(1).plus(dec(a.targetBps).div(10_000)));
    return {
      book,
      ladder,
      index,
      basis,
      basisGapFree: true,
      params: small,
      market,
      target,
      fragileLong: true,
      minL1Ticks: 38_450n,
      maxL1Ticks: 38_450n + a.range,
    } satisfies P2ProjectionInput;
  };
  const minP2Of = (input: P2ProjectionInput, ladder: Level[]) => {
    const asks = mergeLevels(input.book.asks, ladder, "ask");
    const next = basisSample(bookTop({ bids: input.book.bids, asks }, market, 0), index, "impact");
    return projectP2Path(input.basis, next, index, n).reduce((x, y) => (x.lt(y) ? x : y));
  };

  it("a plan is safe at its L1 and depth, at every smaller size (partial fills), and cheapest", () => {
    let planned = 0;
    fc.assert(
      fc.property(arb, (a) => {
        const input = build(a);
        const r = projectP2(input);
        const target = input.target;
        if (!r.ok) {
          if (r.reason === "infeasible") {
            const first = input.ladder[0]?.px ?? 0n;
            for (let px = input.minL1Ticks; px <= input.maxL1Ticks; px++) {
              const shifted = input.ladder.map((l) => ({ ...l, px: l.px - first + px }));
              expect(minP2Of(input, shifted).lt(target)).toBe(true);
            }
          }
          return;
        }
        planned += 1;
        const first = input.ladder[0]?.px ?? 0n;
        const rest = input.ladder.slice(1).map((l) => ({ ...l, px: l.px - first + r.l1Ticks }));
        const at = (qty: bigint) => minP2Of(input, [{ px: r.l1Ticks, qty }, ...rest]);
        expect(at(r.maxDepthSteps).gte(target)).toBe(true);
        expect(r.minP2.gte(target)).toBe(true);
        // Every partly filled state of the plan's ladder (a sweep takes Ballast's asks best-first)
        // stays safe, including the fully taken ladder.
        const plan = [{ px: r.l1Ticks, qty: r.maxDepthSteps }, ...rest];
        const total = plan.reduce((x, l) => x + l.qty, 0n);
        const left = consume(plan, "ask", BigInt(Math.floor(a.q * Number(total)))).rest;
        expect(minP2Of(input, left).gte(target)).toBe(true);
        expect(minP2Of(input, []).gte(target)).toBe(true);
        if (!r.depthCapped) expect(at(r.maxDepthSteps + 1n).lt(target)).toBe(true);
        if (r.l1Ticks > input.minL1Ticks) {
          const lower = input.ladder.map((l) => ({ ...l, px: l.px - first + r.l1Ticks - 1n }));
          expect(minP2Of(input, lower).lt(target)).toBe(true);
        }
      }),
      { numRuns: 10_000 },
    );
    expect(planned).toBeGreaterThan(1_000);
  });
});
