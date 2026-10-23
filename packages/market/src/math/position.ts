import {
  add,
  type Dec,
  type DecInput,
  dec,
  div,
  mul,
  ONE,
  roundHalfEven,
  sub,
  ZERO,
} from "../decimal.js";
import { type MarginTier, tierIndexByNotional } from "./marginTiers.js";

/** One-way position: `size > 0` long, `size < 0` short. */
export interface PositionInput {
  size: DecInput;
  entryPrice: DecInput;
  leverage: number;
  marginMode: "cross" | "isolated";
  /** Isolated balance; ignored for cross positions. */
  isoBalance?: DecInput;
}

export interface DerivedPosition {
  size: Dec;
  /** The mark after the engine's own half-even rounding to quote_prec. */
  mark: Dec;
  notional: Dec;
  upnl: Dec;
  im: Dec;
  mm: Dec;
  tier: number;
}

/**
 * notional = mark × |size|, uPnL = (mark − entry) × size, IM = notional / leverage,
 * MM = notional × MMR − MA, each rounded half-even to quote_prec. The tier is looked up on the
 * unrounded notional (strike-calculations).
 */
export function derivePosition(
  p: PositionInput,
  markPx: DecInput,
  tiers: readonly MarginTier[],
  quotePrec: number,
): DerivedPosition {
  const size = dec(p.size);
  const mark = roundHalfEven(markPx, quotePrec);
  if (size.isZero()) return { size, mark, notional: ZERO, upnl: ZERO, im: ZERO, mm: ZERO, tier: 0 };
  const raw = mul(mark, size.abs());
  const tier = tierIndexByNotional(tiers, raw);
  const t = tiers[tier];
  if (!t) throw new Error("margin tiers: empty schedule");
  const r = (x: Dec) => roundHalfEven(x, quotePrec);
  return {
    size,
    mark,
    notional: r(raw),
    upnl: r(mul(sub(mark, p.entryPrice), size)),
    im: p.leverage > 0 ? r(div(raw, p.leverage)) : ZERO,
    mm: r(sub(mul(raw, t.mmr), t.ma)),
    tier,
  };
}

/** A margin profile: one isolated position, or every cross position of an account. */
export interface MarginProfile {
  /** Base balance: iso_balance, or wallet − Σ iso_balance for cross. */
  w: Dec;
  upnl: Dec;
  mm: Dec;
  /** Non-zero positions in the profile. */
  count: number;
}

export function isolatedProfile(p: PositionInput, d: DerivedPosition): MarginProfile {
  if (p.marginMode !== "isolated") throw new Error("isolatedProfile: position is not isolated");
  return { w: dec(p.isoBalance ?? 0), upnl: d.upnl, mm: d.mm, count: d.size.isZero() ? 0 : 1 };
}

/** Cross profile: W = wallet − Σ isolated balances; uPnL and MM summed over cross positions only. */
export function crossProfile(
  walletBalance: DecInput,
  rows: readonly { p: PositionInput; d: DerivedPosition }[],
): MarginProfile {
  let w = dec(walletBalance);
  let upnl = ZERO;
  let mm = ZERO;
  let count = 0;
  for (const { p, d } of rows) {
    if (p.marginMode === "isolated") {
      w = sub(w, p.isoBalance ?? 0);
      continue;
    }
    if (d.size.isZero()) continue;
    upnl = add(upnl, d.upnl);
    mm = add(mm, d.mm);
    count += 1;
  }
  return { w, upnl, mm, count };
}

/** TU and TM: the profile's uPnL and MM excluding this position, only for multi-position cross. */
function others(d: DerivedPosition, profile: MarginProfile): { tu: Dec; tm: Dec } {
  if (profile.count <= 1) return { tu: ZERO, tm: ZERO };
  return { tu: sub(profile.upnl, d.upnl), tm: sub(profile.mm, d.mm) };
}

/**
 * LP = (entry − (W + TU − TM + MA) / size) / (1 − dir × MMR), with MMR and MA from the
 * position's current notional tier. Unrounded. Returns null when LP ≤ 0 (no liquidation price).
 */
export function liquidationPrice(
  p: PositionInput,
  d: DerivedPosition,
  tiers: readonly MarginTier[],
  profile: MarginProfile,
): Dec | null {
  if (d.size.isZero() || profile.count === 0) return null;
  const t = tiers[d.tier];
  if (!t) throw new Error("margin tiers: tier out of range");
  const { tu, tm } = others(d, profile);
  const dir = d.size.isPositive() ? 1 : -1;
  const lp = div(
    sub(p.entryPrice, div(add(sub(add(profile.w, tu), tm), t.ma), d.size)),
    sub(ONE, mul(dir, t.mmr)),
  );
  return lp.gt(0) ? lp : null;
}

/** BP = entry − (W + TU) / size. Unrounded. Null when BP ≤ 0. */
export function bankruptcyPrice(
  p: PositionInput,
  d: DerivedPosition,
  profile: MarginProfile,
): Dec | null {
  if (d.size.isZero() || profile.count === 0) return null;
  const { tu } = others(d, profile);
  const bp = sub(p.entryPrice, div(add(profile.w, tu), d.size));
  return bp.gt(0) ? bp : null;
}

export type RiskLevel = "none" | "margin_call" | "reduce_only" | "liquidate" | "bankrupt";

/** Margin balance MB = W + uPnL; ratio MR = MM / MB. Bankruptcy is checked before dividing. */
export function riskLevel(profile: MarginProfile): RiskLevel {
  const mb = add(profile.w, profile.upnl);
  // VERIFY: liquidations.md also calls a nonpositive base balance bankrupt; the skill says only
  // MB ≤ 0, and a recorded isolated long lives on with a negative isolated_margin. Skill wins.
  if (mb.lte(0)) return profile.count === 0 ? "none" : "bankrupt";
  if (profile.mm.isZero()) return "none";
  if (profile.mm.gte(mb)) return "liquidate";
  if (profile.mm.gte(mul("0.9", mb))) return "reduce_only";
  if (profile.mm.gte(mul("0.7", mb))) return "margin_call";
  return "none";
}

export function marginRatio(profile: MarginProfile): Dec | null {
  const mb = add(profile.w, profile.upnl);
  return mb.lte(0) ? null : div(profile.mm, mb);
}

/** Funding transfer = −size × mark × hourlyRate (positive = received), unrounded. */
export function fundingTransfer(size: DecInput, markPx: DecInput, hourlyRate: DecInput): Dec {
  return mul(mul(dec(size).neg(), markPx), hourlyRate);
}
