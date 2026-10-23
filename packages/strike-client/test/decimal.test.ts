import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDec,
  cmpDec,
  decFromUnits,
  decToString,
  parseDec,
  parseJsonExact,
  stringifyJsonExact,
  subDec,
  toOrderId,
} from "../src/index.js";

// A decimal as (integer, scale) so the reference arithmetic is plain bigint.
const decArb = fc
  .tuple(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), fc.integer({ min: 0, max: 18 }))
  .map(([m, s]) => ({ m, s, text: decToString({ m, s }) }));

const scaled = (m: bigint, s: number, to: number) => m * 10n ** BigInt(to - s);

describe("exact decimals", () => {
  it("property: parse/format round-trips and add/sub/compare match bigint arithmetic", () => {
    fc.assert(
      fc.property(decArb, decArb, (a, b) => {
        expect(decToString(parseDec(a.text))).toBe(a.text);
        const s = Math.max(a.s, b.s);
        const x = scaled(a.m, a.s, s);
        const y = scaled(b.m, b.s, s);
        expect(decToString(addDec(parseDec(a.text), parseDec(b.text)))).toBe(
          decToString({ m: x + y, s }),
        );
        expect(decToString(subDec(parseDec(a.text), parseDec(b.text)))).toBe(
          decToString({ m: x - y, s }),
        );
        expect(cmpDec(parseDec(a.text), parseDec(b.text))).toBe(x < y ? -1 : x > y ? 1 : 0);
      }),
      { numRuns: 2_000 },
    );
  });

  it("normalizes Strike's padded decimals and rejects anything that is not a plain decimal", () => {
    expect(decToString(parseDec("79211.400000000000000000"))).toBe("79211.4");
    expect(decToString(parseDec("-0.000"))).toBe("0");
    expect(decFromUnits(385373n, "0.000001")).toBe("0.385373");
    for (const bad of ["1e-6", "", ".5", "1.", "+1", " 1", "NaN"])
      expect(() => parseDec(bad)).toThrow();
  });
});

describe("exact JSON", () => {
  it("property: int64 ids survive serialize and parse exactly", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 2n ** 63n - 1n }), (id) => {
        const text = stringifyJsonExact({ order_id: id, symbol: "NIGHT-USD" });
        expect(text).toBe(`{"order_id":${id},"symbol":"NIGHT-USD"}`);
        const back = parseJsonExact(text) as { order_id: unknown };
        expect(toOrderId(back.order_id)).toBe(id);
      }),
    );
  });

  it("omits undefined members and refuses what JSON cannot carry", () => {
    expect(stringifyJsonExact({ a: 1, b: undefined, c: [true, null] })).toBe(
      '{"a":1,"c":[true,null]}',
    );
    expect(() => stringifyJsonExact({ a: Number.NaN })).toThrow();
    expect(() => stringifyJsonExact([undefined])).toThrow();
    expect(() => stringifyJsonExact(new Date())).toThrow();
    expect(parseJsonExact('{"x":1.5,"y":12}')).toEqual({ x: 1.5, y: 12 });
  });
});
