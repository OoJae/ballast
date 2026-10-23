import {
  type Dec,
  type DecInput,
  dec,
  div,
  floorTo,
  max,
  mul,
  ONE,
  roundHalfEven,
  sub,
  ZERO,
} from "../decimal.js";

/** commission = round(fillPrice × fillSize × rate), half-even to quote_prec. Negative = rebate. */
export function commission(
  fillPx: DecInput,
  fillSize: DecInput,
  rate: DecInput,
  quotePrec: number,
): Dec {
  return roundHalfEven(mul(mul(fillPx, fillSize), rate), quotePrec);
}

/**
 * Bracket taker/maker rate after discounts: rate × (1 − referral) × (1 − staking). Discounts
 * apply only to positive rates; a maker override (possibly negative) is final.
 */
export function effectiveRate(
  bracketRate: DecInput,
  referralDiscount: DecInput = 0,
  stakingDiscount: DecInput = 0,
): Dec {
  const r = dec(bracketRate);
  if (r.lte(0)) return r;
  return mul(mul(r, sub(ONE, referralDiscount)), sub(ONE, stakingDiscount));
}

/** builderFee = floor(fillPrice × fillSize × bps / 10000, 2 decimals), charged on every fill. */
export function builderFee(fillPx: DecInput, fillSize: DecInput, bps: number): Dec {
  if (!Number.isSafeInteger(bps) || bps < 0) throw new RangeError("builder fee bps must be ≥ 0");
  return floorTo(div(mul(mul(fillPx, fillSize), bps), 10_000), 2);
}

/**
 * Maker fee for one fill. A negative maker rate is a rebate, capped per trade at what the
 * protocol keeps from that trade's taker: takerFee − takerFee × referralRewardRate (0 without a
 * taker fee). Returns the signed fee the maker pays (negative = received).
 */
export function makerFee(opts: {
  fillPx: DecInput;
  fillSize: DecInput;
  makerRate: DecInput;
  quotePrec: number;
  takerFee: DecInput;
  referralRewardRate?: DecInput;
}): Dec {
  const fee = commission(opts.fillPx, opts.fillSize, opts.makerRate, opts.quotePrec);
  if (fee.gte(0)) return fee;
  const taker = dec(opts.takerFee);
  if (taker.lte(0)) return ZERO;
  // VERIFY: the skill does not say whether the cap itself is rounded to quote_prec.
  const cap = sub(taker, mul(taker, opts.referralRewardRate ?? 0));
  return max(fee, cap.neg());
}
