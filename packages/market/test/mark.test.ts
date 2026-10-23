import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type BookSample,
  type BookTop,
  basisSample,
  type Dec,
  DOCUMENTED_MARK_PARAMS,
  dec,
  fitMarkReplica,
  Grid,
  type MarkCycle,
  type MarkParams,
  MarkReplica,
  type MarkSeries,
  type MarkTick,
  markFromCycle,
  max,
  min,
  predictMark,
} from "../src/index.js";

const top = (bid: string | null, ask: string | null, ts: number | null = 0): BookTop => ({
  bestBid: bid === null ? null : dec(bid),
  bestAsk: ask === null ? null : dec(ask),
  impactBid: null,
  impactAsk: null,
  tsMs: ts,
});

const cycle = (over: Partial<MarkCycle>): MarkCycle => ({
  nowMs: 0,
  index: dec(100),
  nextFundingMs: 3_600_000,
  prevFundingRate: null,
  top: top("99", "101"),
  last: dec(100),
  prevMark: dec(100),
  basis: [],
  ...over,
});
const P = DOCUMENTED_MARK_PARAMS;
const mark = (c: MarkCycle, params: MarkParams = P) => {
  const m = markFromCycle(c, params, 10);
  if (!m) throw new Error("no mark");
  return m;
};

describe("mark construction (prices.md worked examples)", () => {
  it("P1: X = 20,000, F_prev = 0.01%/h, 30 min to funding → 20,001", () => {
    const m = mark(
      cycle({
        index: dec(20_000),
        prevFundingRate: dec("0.0001"),
        nowMs: 1_800_000,
        top: top("19000", "21000"),
        last: dec(20_500),
      }),
    );
    expect(m.p1.toFixed()).toBe("20001");
  });

  it("P2: three samples average +0.10 on top of X = 103", () => {
    const m = mark(cycle({ index: dec(103), basis: [dec("0.40"), dec("-0.20"), dec("0.10")] }));
    expect(m.p2.toFixed()).toBe("103.1");
  });

  it("P3: clamps the last trade into the spread and fills a missing ask", () => {
    const p3 = (bid: string | null, ask: string | null, last: string) =>
      mark(cycle({ top: top(bid, ask, 0), last: dec(last) })).p3.toFixed();
    expect(p3("99", "101", "100")).toBe("100");
    expect(p3("99", "101", "110")).toBe("101");
    expect(p3("99", "101", "90")).toBe("99");
    expect(p3("99", null, "100")).toBe("100");
  });

  it("P3: a stale snapshot swaps a deviant last price for the previous mark", () => {
    // The snapshot timestamp must be positive for the rule to apply.
    const book = top("99", "101", 1_000);
    const stale = mark(cycle({ nowMs: 7_000, top: book, last: dec(110) }));
    expect(stale.lastAdj.toFixed()).toBe("100");
    expect(stale.p3.toFixed()).toBe("100");
    const fresh = mark(cycle({ nowMs: 2_000, top: book, last: dec(110) }));
    expect(fresh.p3.toFixed()).toBe("101");
    // Exactly τ old counts as stale; exactly δ away does not trigger.
    expect(mark(cycle({ nowMs: 6_000, top: book, last: dec(110) })).lastAdj.toFixed()).toBe("100");
    expect(mark(cycle({ nowMs: 9_000, top: book, last: dec(105) })).lastAdj.toFixed()).toBe("105");
    expect(
      mark(cycle({ nowMs: 9_000, top: top("99", "101", 0), last: dec(110) })).p3.toFixed(),
    ).toBe("101");
  });

  it("P3: an empty book clamps the last price to M_prev × (1 ± δ) first", () => {
    const m = mark(cycle({ nowMs: 60_000, top: top(null, null, 0), last: dec(120) }));
    expect(m.lastAdj.toFixed()).toBe("105");
    expect(m.p3.toFixed()).toBe("105");
  });

  it("falls back to P2 when the candidate deviates more than δ from index", () => {
    const m = mark(
      cycle({
        top: top("110", "112"),
        last: dec(110),
        basis: [dec(10)],
        prevFundingRate: dec("0"),
      }),
    );
    expect(m.candidate.toFixed()).toBe("110");
    expect(m.fallbackToP2).toBe(true);
    expect(m.mark.toFixed()).toBe("110");
    const edge = mark(cycle({ top: top("105", "106"), last: dec(105), basis: [dec(5)] }));
    expect(edge.fallbackToP2).toBe(false);
  });

  it("the order-book sweep example stays at the funding-adjusted index (100.005)", () => {
    const zeros = Array.from({ length: 59 }, () => dec(0));
    // Asks cleared: the impact ask falls back to index; bids unchanged (impact bid 99.90).
    const sweep: BookTop = { ...top("99.95", null, 0), impactBid: dec("99.90"), impactAsk: null };
    const sample = basisSample(sweep, dec(100), "impact");
    expect(sample.toFixed()).toBe("-0.05");
    const m = mark(
      cycle({
        prevFundingRate: dec("0.0001"),
        nowMs: 1_800_000,
        top: sweep,
        last: dec(112),
        basis: [...zeros, sample],
      }),
    );
    expect(m.p1.toFixed()).toBe("100.005");
    expect(m.p2.toDecimalPlaces(3).toFixed()).toBe("99.999");
    expect(m.p3.toFixed()).toBe("112");
    expect(m.median).toBe("p1");
    expect(m.mark.toFixed()).toBe("100.005");
  });

  it("produces no mark without an index and no previous mark", () => {
    expect(markFromCycle(cycle({ index: dec(0), prevMark: null }), P, 8)).toBeNull();
    const z = mark(cycle({ index: dec(0), top: top("99", "101"), last: dec(150) }));
    expect(z.mark.toFixed()).toBe("101");
  });

  it("rounds the published mark half-even to quote_prec", () => {
    const m = markFromCycle(
      cycle({ index: dec("0.038372125"), top: top("0.0383", "0.0385"), last: dec("0.038372125") }),
      P,
      8,
    );
    expect(m?.mark.toFixed()).toBe("0.03837212");
  });
});

const price = fc.integer({ min: 9_000, max: 11_000 }).map((n) => dec(n).div(100));

describe("median lemma", () => {
  it("with no fallback, the mark lies between P1 and P2 whatever P3 is", () => {
    fc.assert(
      fc.property(
        price,
        price,
        price,
        price,
        fc.integer({ min: -50, max: 50 }),
        (bid, ask, last, x, b) => {
          const lo = min(bid, ask);
          const hi = max(bid, ask);
          const m = mark(
            cycle({
              index: x,
              top: top(lo.toFixed(), hi.eq(lo) ? hi.plus("0.01").toFixed() : hi.toFixed()),
              last,
              basis: [dec(b).div(100)],
              prevFundingRate: dec("0.0001"),
              nowMs: 1_000_000,
            }),
          );
          if (m.fallbackToP2) return;
          // A distorted P3 (or P2) alone cannot move the mark outside the other two legs.
          expect(m.candidate.gte(min(m.p1, m.p2)) && m.candidate.lte(max(m.p1, m.p2))).toBe(true);
          expect(m.candidate.gte(min(m.p1, m.p3)) && m.candidate.lte(max(m.p1, m.p3))).toBe(true);
        },
      ),
      { numRuns: 10_000 },
    );
  });
});

describe("MarkReplica and predictMark", () => {
  const market = {
    tick: new Grid("0.000001"),
    step: new Grid("1"),
    impactNotional: dec(1000),
    quotePrec: 8,
  };
  const book = {
    bids: [{ px: 38_300n, qty: 100_000n }],
    asks: [
      { px: 38_700n, qty: 1_000n },
      { px: 38_900n, qty: 100_000n },
    ],
  };

  it("keeps at most basisWindow samples", () => {
    const r = new MarkReplica({ ...P, basisWindow: 3 }, market);
    for (let i = 0; i < 5; i++) r.addBasis(top("0.0383", "0.0387"), dec("0.0384"));
    expect(r.snapshot().basis.length).toBe(3);
    const c = r.cycle(0, dec("0.0384"), 3_600_000, top("0.0383", "0.0387"));
    expect(r.state.prevMark?.eq(c?.mark ?? dec(-1))).toBe(true);
  });

  it("a taker buy that lifts the first ask moves the last price and the next basis sample", () => {
    const state = {
      basis: [dec("0.0001")],
      prevMark: dec("0.0383"),
      last: dec("0.0382"),
      prevFundingRate: null,
    };
    const cyc = { nowMs: 0, index: dec("0.0384"), nextFundingMs: 3_600_000 };
    const p = predictMark(state, book, cyc, market, P, { side: "ask", qtySteps: 1_000n });
    expect(p.fills).toEqual([{ px: 38_700n, qty: 1_000n }]);
    expect(p.before?.p3.toFixed()).toBe("0.0383");
    // Last = 0.0387, the remaining best ask 0.0389: P3 = clamp(0.0387, 0.0383, 0.0389).
    expect(p.after?.lastAdj.toFixed()).toBe("0.0387");
    expect(p.after?.p3.toFixed()).toBe("0.0387");
    // Lifting the cheap ask raises the impact ask, so P2 cannot fall.
    expect((p.after as { p2: Dec }).p2.gte((p.before as { p2: Dec }).p2)).toBe(true);
    // A limit below the first level fills nothing.
    const none = predictMark(state, book, cyc, market, P, {
      side: "ask",
      qtySteps: 10n,
      limitPx: 38_600n,
    });
    expect(none.fills).toEqual([]);
  });
});

/**
 * A synthetic series whose marks come from a known hypothesis; the fit must recover it. With
 * `everyMs`, basis samples run on their own clock (every `everyMs` from the first cycle's book
 * time) instead of one per published cycle.
 */
function synthetic(truth: { window: number; lagMs: number; everyMs?: number }): MarkSeries {
  const market = {
    tick: new Grid("0.000001"),
    step: new Grid("1"),
    impactNotional: dec(1000),
    quotePrec: 8,
  };
  let seed = 7;
  const rand = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % 2_000;
  };
  const books: BookSample[] = [];
  for (let t = 0; t <= 400_000; t += 100) {
    // P1 = X < P2 (impact mid ≈ X + 0.1%) < P3 ≥ best bid = X + 1%: P2 sets every mark.
    books.push({
      tMs: t,
      bestBid: dec("1.01"),
      bestAsk: dec("1.02"),
      impactBid: dec("0.99").plus(dec(rand()).div(1_000_000)),
      impactAsk: dec("1.012").plus(dec(rand()).div(1_000_000)),
      tsMs: t,
    });
  }
  const r = new MarkReplica({ ...P, basisWindow: truth.window }, market);
  const ticks: MarkTick[] = [];
  const at = (t: number) => books[Math.floor(t / 100)] as BookSample;
  let nextSample = Number.NaN;
  for (let e = 2_120; e < 400_000; e += 1_000) {
    const b = at(e - truth.lagMs);
    if (truth.everyMs) {
      if (Number.isNaN(nextSample)) nextSample = e - truth.lagMs;
      for (; nextSample <= e - truth.lagMs; nextSample += truth.everyMs) {
        r.addBasis(at(nextSample), dec(1));
      }
    } else {
      r.addBasis(b, dec(1));
    }
    const c = r.cycle(e, dec(1), 3_600_000, b);
    if (!c) throw new Error("no mark");
    ticks.push({ tMs: e, mark: c.mark, index: dec(1), rate: dec(0), nextFundingMs: 3_600_000 });
  }
  return {
    symbol: "SYN-USD",
    market,
    ticks,
    books,
    gridMs: 100,
    trades: [],
    initialLast: null,
    settled: new Map(),
  };
}

describe("fitMarkReplica", () => {
  it("recovers the window and book lag of a synthetic series exactly", () => {
    const s = synthetic({ window: 20, lagMs: 300 });
    const hypotheses = [10, 20, 40].flatMap((basisWindow) =>
      [0, 300, 600].map((bookLagMs) => ({ mid: "impact" as const, basisWindow, bookLagMs })),
    );
    const fit = fitMarkReplica(s, { hypotheses });
    expect(fit.best).toEqual({ mid: "impact", basisWindow: 20, bookLagMs: 300 });
    expect(fit.all?.max.toFixed()).toBe("0");
    expect(fit.heldOut?.n).toBeGreaterThan(100);
    expect(fit.legShare.p2).toBe(1);
    // The top-of-book mid explains the same ticks far worse.
    expect(fit.p2Ticks.top?.mean.gt(fit.p2Ticks.impact?.mean ?? dec(0))).toBe(true);
    expect((fit.hypotheses[1]?.train?.mean ?? dec(0)).gt(0)).toBe(true);
  });

  it("prefers per-cycle sampling when the series was built per cycle", () => {
    const s = synthetic({ window: 20, lagMs: 300 });
    const fit = fitMarkReplica(s, {
      hypotheses: [
        { mid: "impact", basisWindow: 20, bookLagMs: 300 },
        { mid: "impact", basisWindow: 20, bookLagMs: 300, sampleEveryMs: 1_500 },
      ],
    });
    expect(fit.best.sampleEveryMs).toBeUndefined();
  });

  it("recovers an own-clock sampling period (the structure chosen on the recordings)", () => {
    const s = synthetic({ window: 60, lagMs: 1_100, everyMs: 1_500 });
    const hypotheses = [undefined, 1_000, 1_500, 2_000].flatMap((every) =>
      [60, 90].map((basisWindow) => ({
        mid: "impact" as const,
        basisWindow,
        bookLagMs: 1_100,
        ...(every ? { sampleEveryMs: every } : {}),
      })),
    );
    const fit = fitMarkReplica(s, { hypotheses });
    expect(fit.best).toEqual({
      mid: "impact",
      basisWindow: 60,
      bookLagMs: 1_100,
      sampleEveryMs: 1_500,
    });
    expect(fit.all?.max.toFixed()).toBe("0");
    // Per-cycle sampling over the same ~90 s span (90 samples) is close but not exact.
    const perCycle = fit.hypotheses.find(
      (h) => h.hypothesis.basisWindow === 90 && h.hypothesis.sampleEveryMs === undefined,
    );
    expect(perCycle?.train?.mean.gt(0)).toBe(true);
  });
});
