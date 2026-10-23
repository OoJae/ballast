import { type MarketSpec, marketSpec, type StrikeMarketPayload } from "@ballast/market";
import { createPublicHttp, createPublicReads, L3Feed } from "@ballast/strike-client";
import type { ApiConfig } from "./config.js";
import { LiveBookSource } from "./sources.js";

/**
 * The live book source: Strike's public L3 feed and `/v2/markets`, both unauthenticated GETs
 * or subscriptions. Constructed only when BOOK_SOURCE=live; nothing else in the API talks to
 * Strike. One connection serves every SSE client (Strike limits L3 connections per IP).
 */
export function createLiveSource(
  cfg: ApiConfig,
  onError: (err: unknown) => void,
): { source: LiveBookSource; stop: () => void } {
  const reads = createPublicReads(
    createPublicHttp({ baseUrl: cfg.strike.apiUrl, userAgent: cfg.strike.userAgent }),
  );
  const specs = new Map<string, MarketSpec>();
  const loadSpecs = async () => {
    try {
      const { markets } = await reads.markets();
      for (const s of cfg.symbols) {
        const m = markets[s];
        if (m) specs.set(s, marketSpec(m as StrikeMarketPayload));
      }
    } catch (err) {
      onError(err);
    }
  };
  void loadSpecs();
  const timer = setInterval(() => void loadSpecs(), 600_000);
  const feed = new L3Feed({
    url: `${cfg.strike.wsUrl}/ws/l3`,
    userAgent: cfg.strike.userAgent,
    symbols: cfg.symbols,
    fetchSnapshot: (s) => reads.l3Snapshot(s),
  });
  const source = new LiveBookSource(feed, cfg.symbols, { spec: (s) => specs.get(s) ?? null });
  return { source, stop: () => clearInterval(timer) };
}
