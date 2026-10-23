import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  type BookPremiumSample,
  dec,
  eightHourRate,
  FundingReplica,
  fundingParams,
  Grid,
  hourlyFundingRate,
  impactPrice,
  impliedIndex,
  type Level,
  type PremiumIndexRecord,
  PremiumWindow,
  premium,
  premiumSample,
  protectImpact,
  validateFunding,
} from "../src/index.js";

const records = gunzipSync(
  readFileSync(new URL("./fixtures/premium-index.jsonl.gz", import.meta.url)),
)
  .toString("utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    const { r, ...rest } = JSON.parse(l) as PremiumIndexRecord & { r: number };
    return { ...rest, recvMs: r } as PremiumIndexRecord;
  });

const params = (I: string, D: string, m = "1") =>
  fundingParams({ interestRate: I, interestRateDampener: D, fundingMultiplier: m });

describe("funding rate formula (funding-rates.md / prices.md worked examples)", () => {
  const cases: [string, string, string, string, string][] = [
    // P, I, D, F_8h, hourly
    ["0.000429", "0.0001", "0", "0.000529", "0.000066125"],
    ["0.0003", "0.0001", "0.0005", "0.0001", "0.0000125"],
    ["0.0003", "0", "0.0005", "0", "0"],
    ["0.0008", "0", "0.0005", "0.0003", "0.0000375"],
    ["-0.0008", "0", "0.0005", "-0.0003", "-0.0000375"],
    ["0.1", "0.0001", "0", "0.04", "0.005"],
  ];
  for (const [P, I, D, f8, hourly] of cases) {
    it(`P=${P} I=${I} D=${D}`, () => {
      expect(eightHourRate(dec(P), params(I, D)).toFixed()).toBe(dec(f8).toFixed());
      expect(hourlyFundingRate(dec(P), params(I, D)).toFixed()).toBe(dec(hourly).toFixed());
    });
  }
  it("treats D = 0 as additive, not as a zero-width clamp", () => {
    expect(eightHourRate(dec("0.002"), params("0.0001", "0")).toFixed()).toBe("0.0021");
  });
  it("scales premium and dampener by the multiplier", () => {
    // m·P = 0.0016; I − m·P = −0.0015 → clamp to −m·D = −0.001; F8 = 0.0006.
    expect(eightHourRate(dec("0.0008"), params("0.0001", "0.0005", "2")).toFixed()).toBe("0.0006");
  });
});

describe("premium index", () => {
  const X = dec(100);
  it("follows the prices.md examples", () => {
    expect(premium(dec("100.20"), dec("100.40"), X).toFixed()).toBe("0.002");
    expect(premium(dec("99.60"), dec("99.80"), X).toFixed()).toBe("-0.002");
    expect(premium(dec("99.90"), dec("100.10"), X).toFixed()).toBe("0");
  });
  it("protects each impact side against 80–120% of the reference", () => {
    expect(protectImpact(dec(78), X).toFixed()).toBe("100");
    expect(protectImpact(dec(80), X).toFixed()).toBe("80");
    expect(protectImpact(dec(120), X).toFixed()).toBe("120");
    expect(protectImpact(dec("120.01"), X).toFixed()).toBe("100");
    expect(protectImpact(dec(102), X).toFixed()).toBe("102");
    expect(protectImpact(null, X).toFixed()).toBe("100");
  });
  it("walks the impact notional, taking only part of the final level", () => {
    const spec = { tick: new Grid("0.01"), step: new Grid("1") };
    const asks: Level[] = [
      { px: 10_000n, qty: 4n },
      { px: 10_200n, qty: 10n },
    ];
    const ia = impactPrice(asks, dec(1000), spec);
    expect(ia?.toDecimalPlaces(8).toFixed()).toBe("101.19047619");
    expect(impactPrice(asks, dec(5000), spec)).toBeNull();
    // Only the first 50 levels count.
    const deep: Level[] = Array.from({ length: 60 }, (_, i) => ({
      px: 10_000n + BigInt(i),
      qty: 1n,
    }));
    expect(impactPrice(deep, dec(5_100), spec)).toBeNull();
    expect(impactPrice(deep, dec(4_000), spec)).not.toBeNull();
  });
  it("samples a book against the index", () => {
    const spec = { tick: new Grid("0.01"), step: new Grid("1"), impactNotional: dec(1000) };
    const s = premiumSample(
      { bids: [{ px: 10_020n, qty: 100n }], asks: [{ px: 10_040n, qty: 100n }] },
      X,
      spec,
      0,
    );
    expect(s.premium.toFixed()).toBe("0.002");
  });
});

describe("PremiumWindow and FundingReplica", () => {
  it("keeps one sample per 5 s slot and estimates with P = 0 before the first", () => {
    const w = new PremiumWindow(3_600_000);
    const p = params("0.0001", "0.0005");
    expect(w.estimate(p).toFixed()).toBe("0.0000125");
    expect(w.settle(p)).toBeNull();
    expect(w.add(3_600_000, dec("0.001"))).toBe(true);
    expect(w.add(3_604_999, dec("0.5"))).toBe(false);
    expect(w.add(3_605_000, dec("0.003"))).toBe(true);
    expect(w.add(7_200_000, dec("0.003"))).toBe(false);
    expect(w.average().toFixed()).toBe("0.002");
    expect(w.settle(p)?.toFixed()).toBe(hourlyFundingRate(dec("0.002"), p).toFixed());
  });
  it("settles at the hour and exposes F_prev", () => {
    const spec = { tick: new Grid("0.01"), step: new Grid("1"), impactNotional: dec(1000) };
    const book = { bids: [{ px: 10_020n, qty: 100n }], asks: [{ px: 10_040n, qty: 100n }] };
    const f = new FundingReplica(params("0.0001", "0.0005"));
    const at = (nowMs: number) => ({
      nowMs,
      index: dec(100),
      indexTsMs: nowMs,
      book,
      bookTsMs: nowMs - 1_000,
    });
    expect(f.onCycle(at(3_600_100), spec)?.premium.toFixed()).toBe("0.002");
    expect(f.onCycle(at(3_600_900), spec)).toBeNull();
    expect(f.count).toBe(1);
    expect(f.prevFundingRate).toBeNull();
    f.estimate(7_200_000);
    // F8 = 0.002 + clamp(0.0001 − 0.002, ±0.0005) = 0.0015; hourly 0.0001875.
    expect(f.prevFundingRate?.toFixed()).toBe("0.0001875");
    expect(f.count).toBe(0);
  });

  it("samples only an index from the current slot and a book ≤ 10 s before it (prices.md)", () => {
    const spec = { tick: new Grid("0.01"), step: new Grid("1"), impactNotional: dec(1000) };
    const book = { bids: [{ px: 10_020n, qty: 100n }], asks: [{ px: 10_040n, qty: 100n }] };
    const f = new FundingReplica(params("0.0001", "0.0005"));
    const cycle = (nowMs: number, indexTsMs: number, bookTsMs: number, index = dec(100)) => ({
      nowMs,
      index,
      indexTsMs,
      book,
      bookTsMs,
    });
    // An index from the previous slot, a book later than the index, a book 10.001 s older, no
    // index at all: each skipped, and the slot stays open for a later valid cycle.
    expect(f.onCycle(cycle(3_605_200, 3_604_900, 3_604_000), spec)).toBeNull();
    expect(f.onCycle(cycle(3_605_300, 3_605_100, 3_605_101), spec)).toBeNull();
    expect(f.onCycle(cycle(3_605_400, 3_605_100, 3_595_099), spec)).toBeNull();
    expect(f.onCycle(cycle(3_605_500, 3_605_500, 3_605_000, dec(0)), spec)).toBeNull();
    expect(f.onCycle(cycle(3_605_600, Number.NaN, 3_605_000), spec)).toBeNull();
    expect(f.skips).toEqual({ noIndex: 1, indexOutsideSlot: 2, bookMisaligned: 2 });
    expect(f.count).toBe(0);
    // Exactly 10 s and exactly 0 s of lag are both eligible.
    expect(f.onCycle(cycle(3_605_700, 3_605_100, 3_595_100), spec)).not.toBeNull();
    expect(f.onCycle(cycle(3_610_100, 3_610_000, 3_610_000), spec)).not.toBeNull();
    expect(f.count).toBe(2);
    // At 3,620,000 four slots (3,600,000 … 3,615,000) have elapsed, and two were sampled.
    expect(f.missedSlots(3_620_000)).toBe(2);
  });
});

describe("validateFunding from the book", () => {
  it("lists samples outside the index-rounding bound, with the index that would explain them", () => {
    const start = 3_600_000;
    const rec = (count: number, latest: string): PremiumIndexRecord => ({
      symbol: "SYN-USD",
      markPrice: "100",
      indexPrice: "100",
      interestRate: "0.0001",
      interestRateDampener: "0.0005",
      fundingMultiplier: "1",
      fundingRate: "0",
      averagePremiumIndex: latest,
      latestPremiumIndex: latest,
      premiumIndexCount: count,
      nextFundingTime: start + 3_600_000,
      time: start + count * 5_000 - 1,
      recvMs: start + count * 5_000,
    });
    const sample = (slot: number, ib: string, x: string): [number, BookPremiumSample] => {
      const index = dec(x);
      const impactBid = dec(ib);
      const impactAsk = dec("100.5");
      return [
        slot,
        {
          slotStartMs: slot,
          impactBid,
          impactAsk,
          index,
          premium: premium(impactBid, impactAsk, index),
          indexHalfUlp: dec("0.000000005"),
        },
      ];
    };
    // Slot 0: ours 0.002 matches. Slot 1: ours 0.002, recorded 0.001, and nothing explains it.
    // Slot 2: same miss, but the cycle-time book reproduces the recorded 0.001 exactly.
    const [k2, s2] = sample(start + 10_000, "100.2", "100");
    const v = validateFunding(
      [rec(1, "0.002"), rec(2, "0.001"), rec(3, "0.001")],
      new Map([
        sample(start, "100.2", "100"),
        sample(start + 5_000, "100.2", "100"),
        [k2, { ...s2, cycleBookPremium: dec("0.001") }],
      ]),
    );
    expect(v.fromBook?.compared).toBe(3);
    expect(v.fromBook?.withinIndexRounding).toBe(1);
    expect(v.fromBook?.explainedByCycleBook).toBe(1);
    const u = v.fromBook?.unexplained ?? [];
    expect(u.map((x) => [x.slotStartMs - start, x.explainedByCycleBook])).toEqual([
      [5_000, false],
      [10_000, true],
    ]);
    expect(u[0]?.errBps.toFixed()).toBe("10");
    expect(u[0]?.cycleBookErrBps).toBeNull();
    expect(u[1]?.cycleBookErrBps?.toFixed()).toBe("0");
    expect(u[0]?.impliedIndex?.toDecimalPlaces(10).toFixed()).toBe("100.0999000999");
    expect(impliedIndex({ impactBid: dec(1), impactAsk: dec(2) }, dec(0))).toBeNull();
    expect(
      impliedIndex({ impactBid: dec(99), impactAsk: dec("99.5") }, dec("-0.005"))?.toFixed(),
    ).toBe("100");
  });
});

describe("golden: funding replica vs recorded /price/v2/premiumIndex", () => {
  it("has data for both symbols across a settled window", () => {
    expect(records.filter((r) => r.symbol === "NIGHT-USD").length).toBeGreaterThan(200);
    expect(records.filter((r) => r.symbol === "ADA-USD").length).toBeGreaterThan(200);
  });
  for (const symbol of ["NIGHT-USD", "ADA-USD"]) {
    it(`${symbol}: every fundingRate is reproduced exactly from its average and parameters`, () => {
      const v = validateFunding(records.filter((r) => r.symbol === symbol));
      expect(v.rateFromAverage.checked).toBeGreaterThan(200);
      expect(v.rateFromAverage.exact).toBe(v.rateFromAverage.checked);
      expect(v.rateFromAverage.firstMismatch).toBeUndefined();
    });
    it(`${symbol}: every averagePremiumIndex is reproduced exactly from the recorded samples`, () => {
      const v = validateFunding(records.filter((r) => r.symbol === symbol));
      expect(v.averageFromSamples.windows).toBeGreaterThanOrEqual(1);
      expect(v.averageFromSamples.checked).toBeGreaterThan(50);
      expect(v.averageFromSamples.exact).toBe(v.averageFromSamples.checked);
      const settled = v.settlements.find((s) => s.complete);
      expect(settled?.count).toBe(720);
    });
  }
});
