import { notionalRate, steps, ticks } from "@ballast/core";
import { Grid } from "@ballast/market";
import { L3Book } from "@ballast/strike-client";
import { describe, expect, it } from "vitest";
import { aheadAt, matchCrossingBid, matchTakerBuy, type SimOrder } from "../src/index.js";

const g = {
  tick: new Grid("0.000001"),
  step: new Grid("1"),
  rate: notionalRate(new Grid("0.000001"), new Grid("1")),
};

function book(asks: [string, [string, string][]][]): L3Book {
  const b = new L3Book("NIGHT-USD");
  b.applySnapshot({
    type: "l3_snapshot",
    symbol: "NIGHT-USD",
    last_sequence: 1,
    timestamp: 0,
    bids: [{ price: "0.0383", orders: [{ order_id: "bid-1", size: "100000" }] }],
    asks: asks.map(([price, orders]) => ({
      price,
      orders: orders.map(([order_id, size]) => ({ order_id, size })),
    })),
  });
  return b;
}

const ours = (over: Partial<SimOrder>): SimOrder => ({
  id: 1n,
  clientOrderId: "bal_a",
  accountId: "a",
  level: 1,
  px: ticks(38_446n),
  qty: steps(7_000n),
  ahead: new Set(),
  seq: 0,
  ...over,
});

describe("fill model: queue place and FIFO re-matching", () => {
  it("a taker buy takes Ballast's cheaper ask before the house ladder (same size)", () => {
    const b = book([["0.03875", [["h1", "13000"]]]]);
    const fills = matchTakerBuy(
      b.asks,
      [ours({})],
      { maxPx: ticks(38_750n), qty: steps(9_000n), notionalScaled: 0n },
      "size",
      g,
    );
    expect(fills.map((f) => [f.order.id, f.qty, f.px])).toEqual([[1n, 7_000n, 38_446n]]);
  });

  it("never trades past the taker's max price", () => {
    const b = book([["0.03875", [["h1", "13000"]]]]);
    const high = ours({ px: ticks(38_760n) });
    expect(
      matchTakerBuy(
        b.asks,
        [high],
        { maxPx: ticks(38_750n), qty: steps(20_000n), notionalScaled: 0n },
        "size",
        g,
      ),
    ).toEqual([]);
  });

  it("joins the tail of its level: house orders resting there first fill first", () => {
    const b = book([
      [
        "0.038446",
        [
          ["h1", "1000"],
          ["h2", "500"],
        ],
      ],
    ]);
    const o = ours({ ahead: aheadAt(b.asks, "0.0384460") });
    expect([...o.ahead]).toEqual(["h1", "h2"]);
    const r = (q: bigint) =>
      matchTakerBuy(
        b.asks,
        [o],
        { maxPx: ticks(38_446n), qty: steps(q), notionalScaled: 0n },
        "size",
        g,
      );
    expect(r(1_500n)).toEqual([]);
    expect(r(2_000n).map((f) => f.qty)).toEqual([500n]);
  });

  it("moves up as the orders ahead of it leave, and stays ahead of later arrivals", () => {
    const b = book([
      [
        "0.038446",
        [
          ["h1", "1000"],
          ["h2", "500"],
        ],
      ],
    ]);
    const o = ours({ ahead: new Set(["h1", "h2"]) });
    // h1 cancels, a new house order h3 arrives behind us.
    b.onUpdate({
      type: "l3_update",
      symbol: "NIGHT-USD",
      action: "cancel",
      order_id: "h1",
      side: "sell",
      price: "0.038446",
      remaining_size: "0",
      sequence: 2,
      timestamp: 1,
    });
    b.onUpdate({
      type: "l3_update",
      symbol: "NIGHT-USD",
      action: "open",
      order_id: "h3",
      side: "sell",
      price: "0.038446",
      remaining_size: "9000",
      sequence: 3,
      timestamp: 2,
    });
    const fills = matchTakerBuy(
      b.asks,
      [o],
      { maxPx: ticks(38_446n), qty: steps(1_000n), notionalScaled: 0n },
      "size",
      g,
    );
    expect(fills.map((f) => f.qty)).toEqual([500n]);
  });

  it("same-notional mode buys more of Ballast's cheaper asks", () => {
    const b = book([["0.03875", [["h1", "100000"]]]]);
    // $300 that bought 7,742 NIGHT at 0.03875 buys 7,803 at 0.038446.
    const notional = 7_742n * 38_750n;
    const big = ours({ qty: steps(10_000n) });
    const size = matchTakerBuy(
      b.asks,
      [big],
      { maxPx: ticks(38_750n), qty: steps(7_742n), notionalScaled: notional },
      "size",
      g,
    );
    const same = matchTakerBuy(
      b.asks,
      [big],
      { maxPx: ticks(38_750n), qty: steps(7_742n), notionalScaled: notional },
      "notional",
      g,
    );
    expect(size[0]?.qty).toBe(7_742n);
    expect(same[0]?.qty).toBe(7_803n);
  });

  it("a bid that opens at or over Ballast's ask takes it, cheapest first", () => {
    const a = ours({ id: 1n, px: ticks(38_446n), qty: steps(1_000n), seq: 1 });
    const c = ours({ id: 2n, px: ticks(38_440n), qty: steps(1_000n), seq: 2 });
    const fills = matchCrossingBid([a, c], ticks(38_446n), steps(1_500n));
    expect(fills.map((f) => [f.order.id, f.qty])).toEqual([
      [2n, 1_000n],
      [1n, 500n],
    ]);
    expect(matchCrossingBid([a], ticks(38_445n), steps(1_500n))).toEqual([]);
  });
});
