import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  dec,
  div,
  Grid,
  median3,
  mul,
  OffGridError,
  roundHalfEven,
  strikeRound,
} from "../src/index.js";

describe("strikeRound (govalues: ≤ 19 significant digits and ≤ 19 decimal places)", () => {
  it("caps the scale at 19 below 1", () => {
    // 0.0014777940583370465 / 8 = 0.000184724257292130812..., served as 19 decimals.
    expect(div("0.0014777940583370465", 8).toFixed()).toBe("0.0001847242572921308");
    expect(strikeRound(dec("0.12345678901234567891")).toFixed()).toBe("0.1234567890123456789");
  });
  it("keeps 19 significant digits at and above 1", () => {
    expect(div(1, 3).toFixed()).toBe("0.3333333333333333333");
    expect(div(10, 3).toFixed()).toBe("3.333333333333333333");
    expect(div(1_000_000, 7).toFixed()).toBe("142857.1428571428571");
  });
  it("rounds half to even", () => {
    expect(strikeRound(dec("0.00000000000000000025")).toFixed()).toBe("0.0000000000000000002");
    expect(strikeRound(dec("0.00000000000000000035")).toFixed()).toBe("0.0000000000000000004");
    expect(roundHalfEven("0.125", 2).toFixed()).toBe("0.12");
    expect(roundHalfEven("0.135", 2).toFixed()).toBe("0.14");
  });
  it("multiplies exactly when the result fits", () => {
    expect(mul("0.038372", "410977").toFixed()).toBe("15770.009444");
  });
});

describe("dec", () => {
  it("accepts strings, bigints and safe integers only", () => {
    expect(dec("0.038372").toFixed()).toBe("0.038372");
    expect(dec(10n).toFixed()).toBe("10");
    expect(dec(5).toFixed()).toBe("5");
    expect(() => dec(0.1)).toThrow(TypeError);
    expect(() => dec("1e5")).toThrow(TypeError);
    expect(() => dec("NaN")).toThrow(TypeError);
    expect(() => dec("0x10")).toThrow(TypeError);
  });
});

describe("median3", () => {
  it("returns the middle value and its position", () => {
    expect(median3(dec(1), dec(3), dec(2))).toMatchObject({ which: 2 });
    expect(median3(dec(2), dec(1), dec(3)).value.toFixed()).toBe("2");
    expect(median3(dec(5), dec(5), dec(1)).which).toBe(0);
  });
});

const units = ["0.000001", "0.00001", "0.01", "1", "0.5", "25"];

describe("Grid (tick and step conversion)", () => {
  it("round-trips every integer number of units exactly", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...units),
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        (u, n) => {
          const g = new Grid(u);
          const v = g.fromUnits(n);
          expect(g.toUnits(v)).toBe(n);
          expect(g.toUnits(v.toFixed())).toBe(n);
          expect(g.isOnGrid(v)).toBe(true);
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it("rejects off-grid values and brackets them with floor/ceil", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...units),
        fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
        fc.integer({ min: 1, max: 9 }),
        (u, n, digit) => {
          const g = new Grid(u);
          // One extra digit below the unit puts the value strictly between two grid points.
          const off = g.fromUnits(n).plus(g.unit.times(digit).div(10));
          expect(() => g.toUnits(off)).toThrow(OffGridError);
          expect(() => g.toUnits(off.toFixed())).toThrow(OffGridError);
          expect(g.isOnGrid(off)).toBe(false);
          const lo = g.floorUnits(off);
          const hi = g.ceilUnits(off);
          expect(hi - lo).toBe(1n);
          expect(g.fromUnits(lo).lt(off) && g.fromUnits(hi).gt(off)).toBe(true);
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it("parses Strike's trailing-zero spellings identically", () => {
    const tick = new Grid("0.000001");
    expect(tick.toUnits("0.038372")).toBe(38372n);
    expect(tick.toUnits("0.0383720")).toBe(38372n);
    expect(tick.toUnits("0.0377")).toBe(37700n);
    expect(() => tick.toUnits("0.0383725")).toThrow(OffGridError);
    expect(new Grid("1").toUnits("410977")).toBe(410977n);
    expect(new Grid("0.00001").toUnits("72247.30")).toBe(7224730000n);
  });

  it("refuses a non-positive unit", () => {
    expect(() => new Grid("0")).toThrow(RangeError);
    expect(() => new Grid("-1")).toThrow(RangeError);
  });
});
