import { Decimal } from "decimal.js";

/**
 * Exact decimal arithmetic that rounds the way Strike's backend does.
 *
 * The backend uses govalues/decimal: a 19-digit coefficient with a scale of at most 19. Every
 * operation therefore rounds half-to-even to at most 19 significant digits AND at most 19
 * decimal places. decimal.js's own `precision: 19` (the strike-calculations recipe) keeps 19
 * significant digits below 1 too, and reproduces only 57 of 430 recorded `fundingRate` values;
 * this module reproduces all 430. Intermediates run at 80 digits, so each public operation
 * rounds once.
 */
const Wide = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -60,
  toExpPos: 60,
});

export type Dec = Decimal;
/** Numbers are accepted only as safe integers (leverage, bps); prices and sizes come as strings. */
export type DecInput = Dec | string | bigint | number;

export const STRIKE_DIGITS = 19;
const PLAIN_DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

export function dec(v: DecInput): Dec {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) {
      throw new TypeError(`dec: ${v} is not a safe integer; pass a decimal string`);
    }
    return new Wide(v);
  }
  if (typeof v === "bigint") return new Wide(v.toString());
  if (typeof v === "string") {
    if (!PLAIN_DECIMAL.test(v)) throw new TypeError(`dec: not a plain decimal string: "${v}"`);
    return new Wide(v);
  }
  return v.constructor === Wide ? v : new Wide(v);
}

export const ZERO = dec(0);
export const ONE = dec(1);
export const BPS = dec(10_000);

/** Rounds to Strike's representable precision (see the module comment). */
export function strikeRound(x: Dec): Dec {
  if (x.isZero()) return ZERO;
  if (!x.isFinite()) throw new RangeError("strikeRound: non-finite value");
  const dp = x.e >= 0 ? STRIKE_DIGITS - 1 - x.e : STRIKE_DIGITS;
  if (dp < 0) throw new RangeError(`strikeRound: ${x.toFixed()} has more than 19 integer digits`);
  return x.toDecimalPlaces(dp, Decimal.ROUND_HALF_EVEN);
}

export const add = (a: DecInput, b: DecInput): Dec => strikeRound(dec(a).plus(dec(b)));
export const sub = (a: DecInput, b: DecInput): Dec => strikeRound(dec(a).minus(dec(b)));
export const mul = (a: DecInput, b: DecInput): Dec => strikeRound(dec(a).times(dec(b)));
export function div(a: DecInput, b: DecInput): Dec {
  const d = dec(b);
  if (d.isZero()) throw new RangeError("div: division by zero");
  return strikeRound(dec(a).div(d));
}

export function sum(xs: Iterable<DecInput>): Dec {
  let s = ZERO;
  for (const x of xs) s = add(s, x);
  return s;
}

export const min = (a: Dec, b: Dec): Dec => (a.lte(b) ? a : b);
export const max = (a: Dec, b: Dec): Dec => (a.gte(b) ? a : b);
export const clamp = (x: Dec, lo: Dec, hi: Dec): Dec => min(max(x, lo), hi);

// Math.min/max reject bigints; these are their integer-unit counterparts.
export function minBig(a: bigint, b: bigint): bigint {
  if (a < b) return a;
  return b;
}
export function maxBig(a: bigint, b: bigint): bigint {
  if (a > b) return a;
  return b;
}

export type Median3 = 0 | 1 | 2;

/** Median of three, plus which argument it was (the first one on ties). */
export function median3(a: Dec, b: Dec, c: Dec): { value: Dec; which: Median3 } {
  if ((a.gte(b) && a.lte(c)) || (a.lte(b) && a.gte(c))) return { value: a, which: 0 };
  if ((b.gte(a) && b.lte(c)) || (b.lte(a) && b.gte(c))) return { value: b, which: 1 };
  return { value: c, which: 2 };
}

/** Half-to-even rounding to `dp` decimals: Strike's "round to quote_prec". */
export const roundHalfEven = (x: DecInput, dp: number): Dec =>
  dec(x).toDecimalPlaces(dp, Decimal.ROUND_HALF_EVEN);
export const floorTo = (x: DecInput, dp: number): Dec =>
  dec(x).toDecimalPlaces(dp, Decimal.ROUND_FLOOR);
export const ceilTo = (x: DecInput, dp: number): Dec =>
  dec(x).toDecimalPlaces(dp, Decimal.ROUND_CEIL);

/** Signed distance of `x` from `ref` in basis points, (x − ref) / ref × 10⁴. */
export function bpsFrom(x: DecInput, ref: DecInput): Dec {
  return div(mul(sub(x, ref), BPS), ref);
}

/** `x × (1 + bps/10⁴)`. */
export function plusBps(x: DecInput, bps: DecInput): Dec {
  return mul(x, add(ONE, div(bps, BPS)));
}

export class OffGridError extends Error {
  constructor(
    readonly value: string,
    readonly unit: string,
  ) {
    super(`${value} is not a multiple of ${unit}`);
    this.name = "OffGridError";
  }
}

/**
 * An exact integer grid such as a market's price tick or size step. Conversions go through
 * scaled bigints, never floats, and `toUnits` rejects values that are not on the grid.
 */
export class Grid {
  readonly unit: Dec;
  /** Decimal places of the unit. */
  readonly scale: number;
  private readonly unitInt: bigint;

  constructor(unit: DecInput) {
    this.unit = dec(unit);
    if (!this.unit.isPositive() || this.unit.isZero())
      throw new RangeError("Grid: unit must be > 0");
    this.scale = this.unit.decimalPlaces();
    this.unitInt = scaledInt(this.unit, this.scale);
  }

  /** Exact conversion to grid units; throws OffGridError for an off-grid value. */
  toUnits(v: DecInput): bigint {
    const { q, r } = this.divmod(v);
    if (r !== 0n) throw new OffGridError(dec(v).toFixed(), this.unit.toFixed());
    return q;
  }

  isOnGrid(v: DecInput): boolean {
    return this.divmod(v).r === 0n;
  }

  floorUnits(v: DecInput): bigint {
    const { q, r } = this.divmod(v);
    return r < 0n ? q - 1n : q;
  }

  ceilUnits(v: DecInput): bigint {
    const { q, r } = this.divmod(v);
    return r > 0n ? q + 1n : q;
  }

  fromUnits(n: bigint): Dec {
    return dec(n).times(this.unit);
  }

  private divmod(v: DecInput): { q: bigint; r: bigint } {
    let num: bigint;
    let den = this.unitInt;
    if (typeof v === "string" && PLAIN_DECIMAL.test(v)) {
      const frac = v.includes(".") ? v.length - v.indexOf(".") - 1 : 0;
      const s = Math.max(frac, this.scale);
      num = parseScaled(v, s);
      den = this.unitInt * 10n ** BigInt(s - this.scale);
    } else {
      const d = dec(v);
      const s = Math.max(d.decimalPlaces(), this.scale);
      num = scaledInt(d, s);
      den = this.unitInt * 10n ** BigInt(s - this.scale);
    }
    return { q: num / den, r: num % den };
  }
}

function scaledInt(d: Dec, scale: number): bigint {
  return BigInt(d.times(dec(10).pow(scale)).toFixed(0));
}

/** "0.0384" at scale 6 → 38400n, without going through floats. */
function parseScaled(s: string, scale: number): bigint {
  const neg = s.startsWith("-");
  const body = s.replace(/^[+-]/, "");
  const [intPart = "", fracPart = ""] = body.split(".");
  const digits = `${intPart || "0"}${fracPart.padEnd(scale, "0")}`;
  const n = BigInt(digits);
  return neg ? -n : n;
}
