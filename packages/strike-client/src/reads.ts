import type { PublicHttp } from "./http.js";
import type { L3Snapshot } from "./l3.js";

export interface DepthSnapshot {
  lastUpdateId: number;
  E: number;
  T: number;
  bids: [string, string][];
  asks: [string, string][];
}

export interface PremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  latestPremiumIndex: string;
  averagePremiumIndex: string;
  premiumIndexCount: number;
  fundingRate: string;
  nextFundingTime: number;
  interestRate: string;
  interestRateDampener: string;
  fundingMultiplier: string;
  time: number;
}

/** One row of `/stat/v1/stats/live-positions` (public; cached 3–10 min server-side). */
export interface LivePosition {
  id: number;
  create_timestamp: number;
  account_id: string;
  blockchain_address: string;
  ada_handle?: string;
  vault_id: string;
  symbol: string;
  margin_mode: string;
  leverage: number;
  size: string;
  entry_price: string;
  mark_price: string;
  margin: string;
  isolated_margin: string;
  cross_balance: string;
  accumulated_funding_fees: string;
  liquidation_price: string;
}

export interface LivePositions {
  positions: LivePosition[];
  updated_at: number;
}

export type PublicReads = ReturnType<typeof createPublicReads>;

/** Typed wrappers over Strike's public GET endpoints, with paths as the skills repo documents them. */
export function createPublicReads(http: PublicHttp) {
  return {
    time: () => http.getJson<{ serverTime: number }>("/v2/time"),
    markets: () => http.getJson<{ markets: Record<string, unknown> }>("/v2/markets"),
    depth: (symbol: string, limit = 1000) =>
      http.getJson<DepthSnapshot>("/price/v2/depth", { symbol, limit }),
    premiumIndex: (symbol: string) =>
      http.getJson<PremiumIndex>("/price/v2/premiumIndex", { symbol }),
    trades: (symbol: string, limit = 1000) =>
      http.getJson<unknown[]>("/price/v2/trades", { symbol, limit }),
    ticker24h: () => http.getJson<unknown[]>("/price/v2/ticker/24hr"),
    livePositions: () => http.getJson<LivePositions>("/stat/v1/stats/live-positions"),
    l3Snapshot: (symbol: string) => http.getJson<L3Snapshot>("/v2/l3/snapshot", { symbol }),
  };
}
