import {
  BPS,
  type MicroUsd,
  notionalFloor,
  type RefPrice,
  refPlusBpsCeil,
  refPlusBpsFloor,
  type Steps,
  steps,
  type Ticks,
  ticks,
} from "@ballast/core";
import type { EngineMarket } from "./market.js";

/**
 * The engine's static admission checks, the rules whose failure makes a replace-batch apply
 * nothing (strike-trading: size/step, tick, price range/bound, min notional). Reimplemented from
 * the strike-trading skill's CloseReason table and the `/v2/markets` rule fields, on integer
 * units, with Ballast's tighter margins (±4.5% of mark, $10.50).
 */
export type StaticCheckId =
  | "price-tick"
  | "size-step"
  | "size-min"
  | "size-max"
  | "price-min"
  | "price-max"
  | "price-band"
  | "min-notional";

export const STATIC_CHECKS: readonly StaticCheckId[] = [
  "price-tick",
  "size-step",
  "size-min",
  "size-max",
  "price-min",
  "price-max",
  "price-band",
  "min-notional",
];

export interface StaticCheck {
  id: StaticCheckId;
  ok: boolean;
  detail: string;
}

export interface StaticResult {
  ok: boolean;
  checks: StaticCheck[];
  /** Grid units, rounded toward the stricter side when off-grid. */
  px: Ticks;
  qty: Steps;
}

export interface CreateToValidate {
  price: string;
  size: string;
  reduceOnly: boolean;
}

export interface ValidateOptions {
  /** Ballast's own band and minimum (default) or Strike's (what the exchange enforces). */
  rules?: "ballast" | "strike";
}

/**
 * Every check is evaluated (none short-circuits). An off-grid price or size fails its grid check
 * and the remaining checks see it rounded the conservative way for each bound. A missing or
 * non-positive mark fails the band check.
 */
export function validateCreate(
  m: EngineMarket,
  order: CreateToValidate,
  mark: RefPrice | null,
  opts: ValidateOptions = {},
): StaticResult {
  const strike = opts.rules === "strike";
  const checks: StaticCheck[] = [];
  const add = (id: StaticCheckId, ok: boolean, detail: string) => checks.push({ id, ok, detail });

  let pxLo: bigint;
  let pxHi: bigint;
  let qtyLo: bigint;
  let qtyHi: bigint;
  let priceOk = true;
  let sizeOk = true;
  try {
    pxLo = m.tick.floorUnits(order.price);
    pxHi = m.tick.ceilUnits(order.price);
    priceOk = pxLo === pxHi;
  } catch {
    pxLo = 0n;
    pxHi = 0n;
    priceOk = false;
  }
  try {
    qtyLo = m.step.floorUnits(order.size);
    qtyHi = m.step.ceilUnits(order.size);
    sizeOk = qtyLo === qtyHi;
  } catch {
    qtyLo = 0n;
    qtyHi = 0n;
    sizeOk = false;
  }
  add("price-tick", priceOk && pxLo > 0n, `price ${order.price} on tick ${m.tick.unit.toFixed()}`);
  add("size-step", sizeOk && qtyLo > 0n, `size ${order.size} on step ${m.step.unit.toFixed()}`);
  add("size-min", qtyLo >= m.minSizeSteps, `size ${qtyLo} ≥ min ${m.minSizeSteps} steps`);
  add(
    "size-max",
    m.maxSizeSteps > 0n && qtyHi <= m.maxSizeSteps,
    `size ${qtyHi} ≤ max ${m.maxSizeSteps} steps`,
  );
  add("price-min", pxLo >= m.minPriceTicks, `price ${pxLo} ≥ min ${m.minPriceTicks} ticks`);
  add("price-max", pxHi <= m.maxPriceTicks, `price ${pxHi} ≤ max ${m.maxPriceTicks} ticks`);

  const band = strike ? m.strikePriceBoundBps : m.ballastPriceBandBps;
  if (!mark || mark.num <= 0n || band <= 0n || band >= BPS) {
    add("price-band", false, "no usable mark for the price band");
  } else {
    // [ceil(mark × (1 − band)), floor(mark × (1 + band))]: both ends rounded inward.
    const lo = refPlusBpsCeil(mark, -band);
    const hi = refPlusBpsFloor(mark, band);
    add(
      "price-band",
      pxLo >= lo && pxHi <= hi,
      `price within ±${band} bps of mark: [${lo}, ${hi}] ticks`,
    );
  }

  const minNotional: MicroUsd = strike ? m.strikeMinNotional : m.ballastMinNotional;
  if (order.reduceOnly) {
    add("min-notional", true, "not checked for reduce-only orders");
  } else {
    const n = notionalFloor(ticks(pxLo), steps(qtyLo), m.rate);
    add("min-notional", n >= minNotional, `notional ${n} ≥ ${minNotional} micro-USD`);
  }
  return {
    ok: checks.every((c) => c.ok),
    checks,
    px: ticks(pxLo),
    qty: steps(qtyLo),
  };
}
