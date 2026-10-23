/**
 * Integer units for the engine and the Guard (invariant 7): prices in ticks, sizes in steps and
 * money in micro-USD, all bigint and branded so they cannot be mixed by accident.
 *
 * Decimal strings enter only through a `UnitGrid`, which `@ballast/market`'s `Grid` satisfies:
 * the exact on-grid conversion lives there and nowhere else. Core depends on no other package,
 * so it takes the grid structurally instead of importing it.
 *
 * Reference prices (index, mark) are off the tick grid by nature. They are kept as an exact
 * fraction of a tick (`RefPrice`) rather than rounded, so a bound such as "index + 38 bps" is
 * rounded once, in the direction that rule needs.
 */

declare const UNIT: unique symbol;
type Unit<B extends string> = bigint & { readonly [UNIT]: B };

export type Ticks = Unit<"Ticks">;
export type Steps = Unit<"Steps">;
export type MicroUsd = Unit<"MicroUsd">;

export const ticks = (n: bigint): Ticks => n as Ticks;
export const steps = (n: bigint): Steps => n as Steps;
export const microUsd = (n: bigint): MicroUsd => n as MicroUsd;

export const MICRO_PER_USD = 1_000_000n;
export const BPS = 10_000n;

/** What units.ts needs from a grid; market's `Grid` satisfies it. */
export interface UnitGrid {
  readonly unit: { toFixed(): string };
  toUnits(v: string): bigint;
  floorUnits(v: string): bigint;
  ceilUnits(v: string): bigint;
  isOnGrid(v: string): boolean;
  fromUnits(n: bigint): { toFixed(): string };
}

/** Exact price → ticks; throws when the price is off the tick grid. */
export const toTicks = (tick: UnitGrid, price: string): Ticks => ticks(tick.toUnits(price));
export const ceilTicks = (tick: UnitGrid, price: string): Ticks => ticks(tick.ceilUnits(price));
export const floorTicks = (tick: UnitGrid, price: string): Ticks => ticks(tick.floorUnits(price));
/** Exact size → steps; throws when the size is off the step grid. */
export const toSteps = (step: UnitGrid, size: string): Steps => steps(step.toUnits(size));
export const floorSteps = (step: UnitGrid, size: string): Steps => steps(step.floorUnits(size));

/** The decimal string Strike expects for a tick count ("0.038552"). */
export const priceString = (tick: UnitGrid, t: Ticks): string => tick.fromUnits(t).toFixed();
export const sizeString = (step: UnitGrid, s: Steps): string => step.fromUnits(s).toFixed();

const INT_RE = /^(0|[1-9]\d*)$/;

/** A non-negative integer string, as policies carry money ("300000000" = $300). */
export function microUsdFromString(s: string): MicroUsd {
  if (!INT_RE.test(s)) throw new TypeError(`not a non-negative integer string: "${s}"`);
  return microUsd(BigInt(s));
}

const UNIT_RE = /^(\d+)(?:\.(\d+))?$/;

/** A grid unit as m / 10^s. Units are positive plain decimals such as "0.000001" or "1". */
function unitFraction(g: UnitGrid): { m: bigint; s: number } {
  const text = g.unit.toFixed();
  const match = UNIT_RE.exec(text);
  if (!match) throw new TypeError(`grid unit is not a plain decimal: ${text}`);
  const [, int = "0", frac = ""] = match;
  const m = BigInt(int + frac);
  if (m <= 0n) throw new RangeError("grid unit must be > 0");
  return { m, s: frac.length };
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

const ceilDiv = (a: bigint, b: bigint): bigint => {
  if (b <= 0n) throw new RangeError("ceilDiv: divisor must be > 0");
  const q = a / b;
  return a % b !== 0n && a > 0n ? q + 1n : q;
};

const floorDiv = (a: bigint, b: bigint): bigint => {
  if (b <= 0n) throw new RangeError("floorDiv: divisor must be > 0");
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
};

export { ceilDiv, floorDiv };

/** Micro-USD per (1 tick × 1 step), as an exact fraction: NIGHT (0.000001 × 1) is 1/1. */
export interface NotionalRate {
  readonly num: bigint;
  readonly den: bigint;
}

export function notionalRate(tick: UnitGrid, step: UnitGrid): NotionalRate {
  const t = unitFraction(tick);
  const s = unitFraction(step);
  const num = t.m * s.m * MICRO_PER_USD;
  const den = 10n ** BigInt(t.s + s.s);
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

/** px × qty in micro-USD, rounded down (the conservative side for a minimum). */
export function notionalFloor(px: Ticks, qty: Steps, r: NotionalRate): MicroUsd {
  return microUsd(floorDiv(px * qty * r.num, r.den));
}

/** px × qty in micro-USD, rounded up (the conservative side for a cap). */
export function notionalCeil(px: Ticks, qty: Steps, r: NotionalRate): MicroUsd {
  return microUsd(ceilDiv(px * qty * r.num, r.den));
}

/** The largest quantity whose notional at `px` stays ≤ `budget`. */
export function stepsWithin(budget: MicroUsd, px: Ticks, r: NotionalRate): Steps {
  if (px <= 0n || budget <= 0n) return steps(0n);
  return steps(floorDiv(budget * r.den, px * r.num));
}

/** The smallest quantity whose notional at `px` is ≥ `minimum`. */
export function stepsAtLeast(minimum: MicroUsd, px: Ticks, r: NotionalRate): Steps {
  if (px <= 0n) throw new RangeError("stepsAtLeast: price must be > 0");
  if (minimum <= 0n) return steps(0n);
  return steps(ceilDiv(minimum * r.den, px * r.num));
}

/** `t × (1 + bps/10⁴)` rounded up to the grid; never equal to `t` for bps > 0. */
export function plusBpsCeil(t: Ticks, bps: bigint): Ticks {
  const v = ceilDiv(t * (BPS + bps), BPS);
  return ticks(bps > 0n && v <= t ? t + 1n : v);
}

/** `t × (1 − bps/10⁴)` rounded down to the grid. */
export function minusBpsFloor(t: Ticks, bps: bigint): Ticks {
  return ticks(floorDiv(t * (BPS - bps), BPS));
}

/** A reference price as an exact fraction of ticks: price = num / den ticks, den > 0. */
export interface RefPrice {
  readonly num: bigint;
  readonly den: bigint;
}

const PRICE_RE = /^(\d+)(?:\.(\d+))?$/;

/** An off-grid decimal price (an index such as "0.03828181") as an exact fraction of ticks. */
export function refPrice(tick: UnitGrid, price: string): RefPrice {
  const match = PRICE_RE.exec(price);
  if (!match) throw new TypeError(`refPrice: not a plain non-negative decimal: "${price}"`);
  const [, int = "0", frac = ""] = match;
  const t = unitFraction(tick);
  // price / unit = (pm / 10^ps) / (tm / 10^ts)
  const num = BigInt(int + frac) * 10n ** BigInt(t.s);
  const den = 10n ** BigInt(frac.length) * t.m;
  const g = gcd(num, den) || 1n;
  return { num: num / g, den: den / g };
}

export const refFromTicks = (t: Ticks): RefPrice => ({ num: t, den: 1n });

export const refCeil = (r: RefPrice): Ticks => ticks(ceilDiv(r.num, r.den));
export const refFloor = (r: RefPrice): Ticks => ticks(floorDiv(r.num, r.den));
export const refIsPositive = (r: RefPrice): boolean => r.num > 0n && r.den > 0n;

/** ceil(ref × (1 + bps/10⁴)) in ticks: a lower bound such as "index + 38 bps". */
export function refPlusBpsCeil(r: RefPrice, bps: bigint): Ticks {
  return ticks(ceilDiv(r.num * (BPS + bps), r.den * BPS));
}

/** floor(ref × (1 + bps/10⁴)) in ticks; bps may be negative: an upper bound. */
export function refPlusBpsFloor(r: RefPrice, bps: bigint): Ticks {
  return ticks(floorDiv(r.num * (BPS + bps), r.den * BPS));
}

/** Sign of (t − ref). */
export function cmpTicksRef(t: Ticks, r: RefPrice): -1 | 0 | 1 {
  const a = t * r.den;
  return a < r.num ? -1 : a > r.num ? 1 : 0;
}

/** ref ≥ other × (1 + bps/10⁴), exactly. */
export function refAtLeastBps(r: RefPrice, other: RefPrice, bps: bigint): boolean {
  return r.num * other.den * BPS >= other.num * r.den * (BPS + bps);
}

/** qty × ref in micro-USD, rounded up (exposure valued at a reference price). */
export function refNotionalCeil(ref: RefPrice, qty: Steps, r: NotionalRate): MicroUsd {
  return microUsd(ceilDiv(ref.num * qty * r.num, ref.den * r.den));
}

/** |a − b| / b in bps, rounded up; null when b is not positive. */
export function refDistanceBpsCeil(a: RefPrice, b: RefPrice): bigint | null {
  if (b.num <= 0n) return null;
  const diff = a.num * b.den - b.num * a.den;
  const abs = diff < 0n ? -diff : diff;
  return ceilDiv(abs * BPS, b.num * a.den);
}

export const minBigint = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const maxBigint = (a: bigint, b: bigint): bigint => (a > b ? a : b);
