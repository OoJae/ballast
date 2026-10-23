import { defaultQuotePolicy, type QuotePolicy, quotePolicyHash } from "@ballast/core";
import { type Dec, dec, type FloorPosition, type LevelBook } from "@ballast/market";
import { engineMarket, REFERENCE_MARKETS } from "../src/index.js";

export const T0 = 1_792_716_885_000;
export const NIGHT = engineMarket(REFERENCE_MARKETS["NIGHT-USD"]);
export const ADA = engineMarket(REFERENCE_MARKETS["ADA-USD"]);

export function policy(over: Partial<QuotePolicy> = {}): QuotePolicy {
  return {
    ...defaultQuotePolicy({ policyId: "01JC0FFEE00000000000000000", validFromMs: T0 }),
    ...over,
  };
}
export const POLICY = policy();
export const POLICY_HASH = quotePolicyHash(POLICY);

/** The NIGHT regime of Oct 22–23: a deep bid near index, asks ~1% up. */
export function nightBook(over: Partial<LevelBook> = {}): LevelBook {
  return {
    bids: [
      { px: 38_300n, qty: 400_000n },
      { px: 38_250n, qty: 200_000n },
    ],
    asks: [
      { px: 38_750n, qty: 30_000n },
      { px: 38_800n, qty: 100_000n },
      { px: 39_000n, qty: 400_000n },
    ],
    ...over,
  };
}

export const INDEX: Dec = dec("0.0383");
export const MARK: Dec = dec("0.03835");

/** A live long row whose served LP is `lp` in the first tier (isolated, no tier uplift). */
export function longAt(lp: string, size = "10000", entry = "0.0384"): FloorPosition {
  return { size, entryPrice: entry, markPrice: "0.0384", liquidationPrice: lp };
}
