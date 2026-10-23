/**
 * Exact decimal arithmetic on Strike's decimal strings ("79211.400000000000000000") as scaled
 * bigints. Only the operations reconciliation and order building need (add, subtract, compare);
 * there is no division, so nothing ever rounds.
 */
export interface Dec {
  /** value = m / 10^s */
  readonly m: bigint;
  readonly s: number;
}

export const ZERO: Dec = { m: 0n, s: 0 };

const DEC_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

export function isDecimalString(text: string): boolean {
  return DEC_RE.test(text);
}

export function parseDec(text: string): Dec {
  const match = DEC_RE.exec(text);
  if (!match) throw new TypeError(`not a plain decimal string: ${JSON.stringify(text)}`);
  const [, sign, int = "0", frac = ""] = match;
  const m = BigInt(int + frac);
  return normalize({ m: sign ? -m : m, s: frac.length });
}

function normalize(d: Dec): Dec {
  if (d.m === 0n) return ZERO;
  let { m, s } = d;
  while (s > 0 && m % 10n === 0n) {
    m /= 10n;
    s -= 1;
  }
  return { m, s };
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const s = Math.max(a.s, b.s);
  return [a.m * 10n ** BigInt(s - a.s), b.m * 10n ** BigInt(s - b.s), s];
}

export function addDec(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b);
  return normalize({ m: x + y, s });
}

export function subDec(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b);
  return normalize({ m: x - y, s });
}

export function negDec(a: Dec): Dec {
  return normalize({ m: -a.m, s: a.s });
}

export function cmpDec(a: Dec, b: Dec): -1 | 0 | 1 {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function maxDec(a: Dec, b: Dec): Dec {
  return cmpDec(a, b) >= 0 ? a : b;
}

export function minDec(a: Dec, b: Dec): Dec {
  return cmpDec(a, b) <= 0 ? a : b;
}

export function isZeroDec(a: Dec): boolean {
  return a.m === 0n;
}

export function sumDec(values: Iterable<Dec>): Dec {
  let total = ZERO;
  for (const v of values) total = addDec(total, v);
  return total;
}

export function decToString(d: Dec): string {
  const n = normalize(d);
  const neg = n.m < 0n;
  const digits = (neg ? -n.m : n.m).toString().padStart(n.s + 1, "0");
  const int = digits.slice(0, digits.length - n.s);
  const frac = digits.slice(digits.length - n.s);
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/** `units × unit` exactly, e.g. (385373n, "0.000001") → "0.385373". */
export function decFromUnits(units: bigint, unit: string): string {
  const u = parseDec(unit);
  return decToString({ m: units * u.m, s: u.s });
}

/** Compare two decimal strings exactly (sorting prices must never go through floats). */
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 {
  return cmpDec(parseDec(a), parseDec(b));
}
