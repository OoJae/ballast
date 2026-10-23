import { refPrice } from "@ballast/core";
import { FakeEngine } from "@ballast/fake-strike";
import { dec } from "@ballast/market";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { STATIC_CHECKS, type StaticCheckId, validateCreate } from "../src/index.js";
import { ADA, NIGHT } from "./helpers.js";

/**
 * Invariant 8: every create passes the 8 static admission checks. validate.ts is checked against
 * an independent decimal oracle written straight from the rules, and its Strike-rule mode
 * against the fake server's own (independently written) static rejects.
 */
const markArb = fc.integer({ min: 30_000, max: 45_000 });
/** Mostly near the mark (where the band and notional checks bind), sometimes anywhere. */
const caseArb = markArb.chain((markMicro) =>
  fc.record({
    mark: fc.constant((markMicro / 1_000_000).toFixed(6)),
    price: fc.oneof(
      {
        weight: 6,
        arbitrary: fc
          .integer({ min: -600, max: 600 })
          .map((bps) => (Math.round(markMicro * (1 + bps / 10_000)) / 1_000_000).toFixed(6)),
      },
      {
        weight: 1,
        arbitrary: fc.integer({ min: 1, max: 800_000 }).map((n) => (n / 10_000_000).toFixed(7)),
      },
      {
        weight: 1,
        arbitrary: fc.constantFrom("0", "0.000001", "0.00001", "200", "200.000001", "0.0000001"),
      },
    ),
  }),
);
const sizeArb = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 0, max: 2_000 }).map(String) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 50_000_000 }).map(String) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 1_000_000 }).map((n) => (n / 10).toFixed(1)) },
  { weight: 1, arbitrary: fc.constantFrom("1", "40000000", "40000001", "0") },
);

function oracle(price: string, size: string, mark: string, reduceOnly: boolean, strike: boolean) {
  const p = dec(price);
  const q = dec(size);
  const m = dec(mark);
  const band = dec(strike ? "0.05" : "0.045");
  const minNotional = dec(strike ? "10" : "10.5");
  const out: Record<StaticCheckId, boolean> = {
    "price-tick": p.gt(0) && p.mod("0.000001").isZero(),
    "size-step": q.gt(0) && q.mod(1).isZero(),
    "size-min": q.gte(1),
    "size-max": q.lte(40_000_000),
    "price-min": p.gte("0.00001"),
    "price-max": p.lte(200),
    "price-band": p.gte(m.times(dec(1).minus(band))) && p.lte(m.times(dec(1).plus(band))),
    "min-notional": reduceOnly || p.times(q).gte(minNotional),
  };
  return out;
}

describe("invariant 8: static admission checks", () => {
  it("validate.ts matches an independent oracle on all 8 checks (Ballast and Strike rules)", () => {
    let passed = 0;
    fc.assert(
      fc.property(
        caseArb,
        sizeArb,
        fc.boolean(),
        fc.boolean(),
        ({ price, mark }, size, reduceOnly, strike) => {
          const r = validateCreate(NIGHT, { price, size, reduceOnly }, refPrice(NIGHT.tick, mark), {
            rules: strike ? "strike" : "ballast",
          });
          const want = oracle(price, size, mark, reduceOnly, strike);
          expect(r.checks.map((c) => c.id)).toEqual([...STATIC_CHECKS]);
          // Off-grid values are rounded the strict way for the bound checks, so only the
          // on-grid cases must agree check-by-check; the verdict must agree on every case where
          // the oracle passes everything, and never pass what the oracle fails.
          const onGrid = want["price-tick"] && want["size-step"];
          for (const c of r.checks) if (onGrid) expect(c.ok, c.id).toBe(want[c.id]);
          const all = Object.values(want).every(Boolean);
          expect(r.ok).toBe(all);
          if (all) passed += 1;
        },
      ),
      { numRuns: 10_000 },
    );
    expect(passed).toBeGreaterThan(2_000);
  });

  it("whatever passes Strike's rules here also passes the fake server's static checks", () => {
    const engine = new FakeEngine(
      () => 0,
      () => {},
      1n,
    );
    engine.addMarket({
      symbol: "NIGHT-USD",
      tickSize: "0.000001",
      stepSize: "1",
      minSize: "1",
      minNotional: "10",
      maxLeverage: 10,
    });
    let admitted = 0;
    fc.assert(
      fc.property(caseArb, sizeArb, ({ price, mark }, size) => {
        const r = validateCreate(
          NIGHT,
          { price, size, reduceOnly: false },
          refPrice(NIGHT.tick, mark),
          { rules: "strike" },
        );
        if (!r.ok) return;
        const code = engine.staticReject({
          client_order_id: "bal_x",
          symbol: "NIGHT-USD",
          side: "sell",
          type: "limit",
          size,
          price,
          post_only: true,
        });
        expect(code).toBeUndefined();
        admitted += 1;
      }),
      { numRuns: 10_000 },
    );
    expect(admitted).toBeGreaterThan(2_000);
  });

  it("fails closed without a mark, and on garbage input", () => {
    const r = validateCreate(NIGHT, { price: "0.0385", size: "1000", reduceOnly: false }, null);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === "price-band")?.ok).toBe(false);
    for (const [price, size] of [
      ["abc", "1000"],
      ["0.0385", "1e3"],
      ["-0.0385", "1000"],
      ["", ""],
    ] as const) {
      expect(
        validateCreate(NIGHT, { price, size, reduceOnly: false }, refPrice(NIGHT.tick, "0.0385"))
          .ok,
      ).toBe(false);
    }
  });

  it("uses each market's own grid (ADA tick 0.00001)", () => {
    const mark = refPrice(ADA.tick, "0.2128");
    expect(validateCreate(ADA, { price: "0.21291", size: "100", reduceOnly: false }, mark).ok).toBe(
      true,
    );
    expect(
      validateCreate(ADA, { price: "0.212915", size: "100", reduceOnly: false }, mark).checks.find(
        (c) => c.id === "price-tick",
      )?.ok,
    ).toBe(false);
  });
});
