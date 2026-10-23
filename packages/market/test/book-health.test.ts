import { L3Book, type L3Snapshot } from "@ballast/strike-client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BookHealthAggregator,
  DEPTH_BANDS,
  dec,
  Grid,
  healthPairOfLevels,
  type Level,
  levelsFromL3,
  measureBook,
  mergeLevels,
  realizedSavings,
  SLIPPAGE_SIZES,
} from "../src/index.js";

const spec = { tick: new Grid("0.000001"), step: new Grid("1") };
const lvl = (price: string, ...orders: [string, string][]) => ({
  price,
  orders: orders.map(([order_id, size]) => ({ order_id, size })),
});

function bookOf(asks: L3Snapshot["asks"]): L3Book {
  const b = new L3Book("NIGHT-USD");
  const st = b.applySnapshot({
    type: "l3_snapshot",
    symbol: "NIGHT-USD",
    last_sequence: 1,
    timestamp: 0,
    bids: [lvl("0.0380", ["A", "10000"]), lvl("0.0379", ["B", "20000"])],
    asks,
  });
  if (!st.ok) throw new Error("snapshot");
  return b;
}

const BALLAST = new Set(["BAL1", "BAL2"]);
const book = bookOf([
  lvl("0.0382", ["BAL1", "5000"], ["C", "1000"]),
  lvl("0.0385", ["D", "1000000"]),
]);
const mid = dec("0.0381");

describe("Book Health on a synthetic book", () => {
  const { actual, counterfactual, ballastOrders } = measureBook(book, BALLAST, spec);

  it("counts Ballast's orders and removes them for the counterfactual", () => {
    expect(ballastOrders).toBe(1);
    expect(actual.depthUsd?.ask["0.5%"].toFixed()).toBe("229.2");
    expect(counterfactual.depthUsd?.ask["0.5%"].toFixed()).toBe("38.2");
    // Bids are untouched.
    expect(counterfactual.depthUsd?.bid["2%"].eq(actual.depthUsd?.bid["2%"] ?? dec(-1))).toBe(true);
  });

  it("computes spread in bps of mid", () => {
    expect(actual.mid?.toFixed()).toBe("0.0381");
    const spread = dec("0.0002").div(mid).times(10_000);
    expect(actual.spreadBps?.toDecimalPlaces(12).eq(spread.toDecimalPlaces(12))).toBe(true);
  });

  it("sums USD depth inside ±0.5/1/2% of mid per side", () => {
    expect(actual.depthUsd?.bid["0.5%"].toFixed()).toBe("380");
    expect(actual.depthUsd?.bid["1%"].toFixed()).toBe("1138");
    expect(actual.depthUsd?.bid["2%"].toFixed()).toBe("1138");
    expect(actual.depthUsd?.ask["1%"].toFixed()).toBe("229.2");
    expect(actual.depthUsd?.ask["2%"].toFixed()).toBe("38729.2");
  });

  it("measures VWAP slippage of $1K/$10K/$25K market orders against mid", () => {
    // $1K buy: 6,000 @ 0.0382, then the rest at 0.0385.
    const vwap = dec(1000).div(dec(6000).plus(dec("770.8").div("0.0385")));
    const bps = vwap.minus(mid).div(mid).times(10_000);
    expect(actual.slippageBps?.buy["1000"]?.minus(bps).abs().lt("0.000000000001")).toBe(true);
    // Without Ballast only 1,000 rest at 0.0382.
    const cf = dec(1000).div(dec(1000).plus(dec("961.8").div("0.0385")));
    const cfBps = cf.minus(mid).div(mid).times(10_000);
    expect(counterfactual.slippageBps?.buy["1000"]?.minus(cfBps).abs().lt("0.000000000001")).toBe(
      true,
    );
    expect(
      counterfactual.slippageBps?.buy["1000"]?.gt(actual.slippageBps?.buy["1000"] ?? dec(0)),
    ).toBe(true);
    // $1K sell fills inside the bid side: 10,000 @ 0.0380 holds $380, then 0.0379.
    const sell = dec(1000).div(dec(10000).plus(dec(620).div("0.0379")));
    expect(
      actual.slippageBps?.sell["1000"]
        ?.minus(mid.minus(sell).div(mid).times(10_000))
        .abs()
        .lt("0.000000000001"),
    ).toBe(true);
    // Only $1,138 of bids: larger sells cannot be filled.
    expect(actual.slippageBps?.sell["10000"]).toBeNull();
    expect(actual.slippageBps?.buy["25000"]).not.toBeNull();
  });

  it("moves the best ask in the counterfactual when Ballast holds the whole level", () => {
    const b = bookOf([lvl("0.0381", ["BAL2", "3000"]), lvl("0.0382", ["C", "1000"])]);
    const r = measureBook(b, BALLAST, spec);
    expect(r.actual.bestAsk?.toFixed()).toBe("0.0381");
    expect(r.counterfactual.bestAsk?.toFixed()).toBe("0.0382");
    expect(r.counterfactual.spreadBps?.gt(r.actual.spreadBps ?? dec(0))).toBe(true);
  });

  it("measures both books against the counterfactual mid, so an improving ask reads as one", () => {
    // The review's case: a $299 Ballast ask inside a 98 bps spread.
    const b = new L3Book("NIGHT-USD");
    b.applySnapshot({
      type: "l3_snapshot",
      symbol: "NIGHT-USD",
      last_sequence: 1,
      timestamp: 0,
      bids: [lvl("0.03825", ["H1", "400000"])],
      asks: [lvl("0.03835", ["BAL1", "7800"]), lvl("0.03863", ["H2", "180000"])],
    });
    const r = measureBook(b, new Set(["BAL1"]), spec);
    expect(r.actual.ref?.toFixed()).toBe("0.03844");
    expect(r.counterfactual.ref?.toFixed()).toBe("0.03844");
    // Each book still reports its own mid.
    expect(r.actual.mid?.toFixed()).toBe("0.0383");
    expect(r.counterfactual.depthUsd?.ask["0.5%"].toFixed()).toBe("6953.4");
    expect(r.actual.depthUsd?.ask["0.5%"].toFixed()).toBe("7252.53");
    const buy = (h: typeof r.actual) => h.slippageBps?.buy["1000"] ?? dec(-1);
    expect(buy(r.actual).lt(buy(r.counterfactual))).toBe(true);
    expect(r.actual.vwap?.buy["1000"]?.lt(r.counterfactual.vwap?.buy["1000"] ?? dec(0))).toBe(true);
    expect(r.counterfactual.vwap?.buy["1000"]?.toFixed()).toBe("0.03863");
    expect(r.actual.spreadBps?.lt(r.counterfactual.spreadBps ?? dec(0))).toBe(true);
  });

  it("falls back to the actual mid when Ballast holds the whole ask side", () => {
    const b = bookOf([lvl("0.0382", ["BAL1", "5000"])]);
    const r = measureBook(b, BALLAST, spec);
    expect(r.counterfactual.mid).toBeNull();
    expect(r.counterfactual.ref?.toFixed()).toBe("0.0381");
    expect(r.counterfactual.depthUsd?.ask["2%"].toFixed()).toBe("0");
    expect(r.counterfactual.slippageBps?.buy["1000"]).toBeNull();
    expect(r.counterfactual.spreadBps).toBeNull();
    expect(r.actual.depthUsd?.ask["0.5%"].toFixed()).toBe("191");
  });

  it("reports nothing but the top for a one-sided book", () => {
    const b = bookOf([]);
    const r = measureBook(b, new Set(), spec);
    expect(r.actual.spreadBps).toBeNull();
    expect(r.actual.depthUsd).toBeNull();
    expect(r.counterfactual).toBe(r.actual);
  });
});

describe("Book Health (properties)", () => {
  const side = (lo: bigint, hi: bigint) =>
    fc.array(
      fc.record({
        px: fc.bigInt({ min: lo, max: hi }),
        qty: fc.bigInt({ min: 1n, max: 200_000n }),
      }),
      { maxLength: 8 },
    );
  it("adding non-crossing Ballast asks never lowers ask depth or raises a buy's VWAP", () => {
    fc.assert(
      fc.property(
        side(37_000n, 38_300n),
        side(38_301n, 40_000n),
        side(37_000n, 40_000n),
        (bidsRaw, houseRaw, ballastRaw) => {
          const bids = mergeLevels([], bidsRaw, "bid");
          const house = mergeLevels([], houseRaw, "ask");
          const best = bids[0]?.px ?? 0n;
          const ballast: Level[] = ballastRaw.filter((l) => l.px > best);
          const cf = { bids, asks: house };
          const actual = { bids, asks: mergeLevels(house, ballast, "ask") };
          const r = healthPairOfLevels(actual, cf, spec, ballast.length);
          expect(r.actual.ref?.toFixed() ?? null).toBe(r.counterfactual.ref?.toFixed() ?? null);
          const a = r.actual;
          const c = r.counterfactual;
          if (!c.ref || !a.depthUsd || !c.depthUsd) return;
          for (const band of DEPTH_BANDS) {
            expect(a.depthUsd.ask[band].gte(c.depthUsd.ask[band])).toBe(true);
            expect(a.depthUsd.bid[band].eq(c.depthUsd.bid[band])).toBe(true);
          }
          for (const size of SLIPPAGE_SIZES) {
            const cv = c.vwap?.buy[size];
            const av = a.vwap?.buy[size];
            if (cv) {
              expect(av?.lte(cv)).toBe(true);
              expect(a.slippageBps?.buy[size]?.lte(c.slippageBps?.buy[size] ?? dec(0))).toBe(true);
            }
            expect(a.vwap?.sell[size]?.toFixed() ?? null).toBe(
              c.vwap?.sell[size]?.toFixed() ?? null,
            );
          }
        },
      ),
      { numRuns: 2_000 },
    );
  });
});

describe("BookHealthAggregator", () => {
  it("time-weights, splits armed vs unarmed, and tracks coverage", () => {
    const one = measureBook(book, BALLAST, spec);
    const two = measureBook(bookOf([lvl("0.0383", ["C", "1000"])]), BALLAST, spec);
    const agg = new BookHealthAggregator();
    agg.add(one, 1_000, false);
    agg.add(two, 3_000, false);
    agg.add(one, 2_000, true);
    agg.add(one, 0, true);
    const rep = agg.report(12);
    expect(rep.unarmed.ms).toBe(4_000);
    expect(rep.armed.ms).toBe(2_000);
    const s1 = one.actual.spreadBps ?? dec(0);
    const s2 = two.actual.spreadBps ?? dec(0);
    const expected = s1.times(1_000).plus(s2.times(3_000)).div(4_000).toDecimalPlaces(12).toFixed();
    expect(rep.unarmed.actual.spreadBps?.mean).toBe(expected);
    expect(rep.armed.actual.spreadBps?.mean).toBe(s1.toDecimalPlaces(12).toFixed());
    expect(rep.armed.counterfactual["depthUsd.ask.0.5%"]?.mean).toBe("38.2");
    // Neither book could fill a $10K sell.
    expect(rep.unarmed.actual["slippageBps.sell.10000"]).toEqual({ mean: null, coverage: 0 });
    // A $25K buy fills on the first book only: a quarter of the unarmed time.
    expect(rep.unarmed.actual["slippageBps.buy.25000"]?.coverage).toBe(0.25);
  });
});

describe("realized savings", () => {
  it("is (counterfactual VWAP − actual VWAP) × size for a taker buy that hit Ballast", () => {
    const cfAsks = levelsFromL3(book, spec, BALLAST).asks;
    const s = realizedSavings(
      {
        takerOrderId: "T",
        tMs: 1,
        fills: [
          { orderId: "BAL1", px: 38_200n, qty: 5_000n },
          { orderId: "C", px: 38_200n, qty: 1_000n },
        ],
      },
      cfAsks,
      BALLAST,
      spec,
    );
    expect(s.touchedBallast).toBe(true);
    expect(s.actualVwap.toFixed()).toBe("0.0382");
    // Without Ballast: 1,000 @ 0.0382 + 5,000 @ 0.0385.
    expect(s.counterfactualVwap?.toFixed()).toBe("0.03845");
    expect(s.savingsUsd?.toFixed()).toBe("1.5");
  });
  it("is null when the counterfactual book cannot fill the size", () => {
    const s = realizedSavings(
      { takerOrderId: "T", tMs: 1, fills: [{ orderId: "BAL1", px: 38_200n, qty: 500_000n }] },
      [{ px: 38_200n, qty: 1_000n }],
      BALLAST,
      spec,
    );
    expect(s.savingsUsd).toBeNull();
  });
});
