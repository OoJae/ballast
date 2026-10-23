/** Display formatting. Numbers arrive from the API already measured; nothing is recomputed. */

const PRICE_DP: Record<string, number> = { "NIGHT-USD": 6, "ADA-USD": 5 };

export function priceDp(symbol: string): number {
  return PRICE_DP[symbol] ?? 6;
}

export function fmtPrice(x: number | null | undefined, symbol: string): string {
  return x === null || x === undefined ? "—" : x.toFixed(priceDp(symbol));
}

export function fmtUsd(x: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  if (opts.compact && Math.abs(x) >= 1_000) {
    return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(x)}`;
  }
  return `$${Math.round(x).toLocaleString("en-US")}`;
}

export function fmtBps(x: number | null | undefined, dp = 1): string {
  return x === null || x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(dp);
}

export function fmtQty(x: number): string {
  return Math.round(x).toLocaleString("en-US");
}

export function fmtInt(x: number | null | undefined): string {
  return x === null || x === undefined ? "—" : x.toLocaleString("en-US");
}

const two = (n: number) => String(n).padStart(2, "0");

export function fmtUtcTime(ms: number, seconds = true): string {
  const d = new Date(ms);
  const t = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
  return seconds ? `${t}:${two(d.getUTCSeconds())}` : t;
}

export function fmtUtcDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function fmtUtc(ms: number): string {
  return `${fmtUtcDate(ms)}, ${fmtUtcTime(ms)} UTC`;
}

export function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

export function shortHash(h: string | null | undefined, n = 10): string {
  if (!h) return "—";
  return h.length <= n * 2 ? h : `${h.slice(0, n)}…${h.slice(-4)}`;
}

/** Signed % distance from a reference, e.g. "+0.49%". */
export function fmtPctFrom(x: number, ref: number): string {
  const p = ((x - ref) / ref) * 100;
  return `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(2)}%`;
}
