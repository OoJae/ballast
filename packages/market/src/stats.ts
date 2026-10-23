import { type Dec, div, sum, ZERO } from "./decimal.js";

export interface ErrorStats {
  n: number;
  mean: Dec;
  p50: Dec;
  p90: Dec;
  p99: Dec;
  max: Dec;
}

/** Nearest-rank percentile of an ascending array (p in (0, 1]). */
export function percentile(sorted: readonly Dec[], p: number): Dec {
  if (sorted.length === 0) return ZERO;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i] as Dec;
}

/** Summary of non-negative errors (e.g. |predicted − actual| in bps). Null when empty. */
export function errorStats(values: readonly Dec[]): ErrorStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  return {
    n: sorted.length,
    mean: div(sum(sorted), sorted.length),
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] as Dec,
  };
}

/** JSON-friendly view: decimals as fixed strings rounded to `dp` places. */
export function statsJson(s: ErrorStats | null, dp = 4): Record<string, number | string> | null {
  if (!s) return null;
  const f = (d: Dec) => d.toDecimalPlaces(dp).toFixed();
  return { n: s.n, mean: f(s.mean), p50: f(s.p50), p90: f(s.p90), p99: f(s.p99), max: f(s.max) };
}
