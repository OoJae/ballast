/**
 * How far the drawn hull lists. A ship heels from one-sided weight, so the angle comes from the
 * book's depth imbalance within ±0.5% of the mid, not from the (symmetric) spread:
 *
 *   heel = MAX_HEEL × (bid − ask) / (bid + ask)
 *
 * Positive heels to port (the bid side). NIGHT-USD's replayed book ($15,568 bid, $34 ask) lists
 * about 14.9°; ADA-USD's ($235,371 / $147,816) about 3.4°. The figure caption states the formula.
 */
export const MAX_HEEL_DEG = 15;

export function heelDeg(bidUsd: number, askUsd: number): number {
  const b = Math.max(0, bidUsd);
  const a = Math.max(0, askUsd);
  if (b + a === 0) return 0;
  return (MAX_HEEL_DEG * (b - a)) / (b + a);
}

/** The reader's what-if: the same book with `addedAskUsd` more covered asks within 0.5%. */
export function heelWithAddedAsks(bidUsd: number, askUsd: number, addedAskUsd: number): number {
  return heelDeg(bidUsd, askUsd + Math.max(0, addedAskUsd));
}

/** Added asks that would bring the drawing level (bid and ask depth equal). */
export function asksToLevel(bidUsd: number, askUsd: number): number {
  return Math.max(0, bidUsd - askUsd);
}

/** Real caps, from the signed policy: Ballast depth before D6, and one account's maximum short. */
export const PRE_D6_DEPTH_CAP_USD = 300;
export const PER_ACCOUNT_MAX_SHORT_USD = 2_000;
