/**
 * Facts for the engine and the Guard, derived from live state. Ported from the simulator's
 * `guardInput` (packages/sim), with every fact read from the reconciler, the cover oracle, the
 * market state and the registry instead of the replay. Fail-closed throughout: an unknown fact
 * becomes the value the Guard blocks on (null mark, zero equity, unknown margin, vault shares
 * assumed held until a read says otherwise, stale ages as Infinity).
 */
import {
  ceilDiv,
  type MicroUsd,
  maxBigint,
  microUsd,
  notionalCeil,
  type QuotePolicy,
  type RefPrice,
  refPrice,
  type Steps,
  steps,
  type Ticks,
  ticks,
} from "@ballast/core";
import {
  armDecision,
  committedSteps,
  DEFAULT_ARM_LIST,
  type EngineMarket,
  effectiveRBps,
  type MarketCaps,
  type RequotePlan,
  type RestingOrder,
} from "@ballast/engine";
import type { CriticReport, PolicyWindow, SignedPolicy } from "@ballast/governance";
import type {
  GuardAccountFact,
  GuardInput,
  GuardRateFact,
  GuardRequest,
  GuardRestingAsk,
} from "@ballast/guard";
import type { Dec, LevelBook } from "@ballast/market";
import { cmpDec, decToString, parseDec, subDec, ZERO } from "@ballast/strike-client";
import type { AccountRuntime } from "./account.js";
import type { CoverState } from "./cover-watch.js";
import type { MarketView } from "./market-state.js";

const TERMINAL = new Set(["filled", "canceled", "rejected", "expired", "dropped", "not-sent"]);

/** Exact decimal quantity → steps, rounded up (exposure is never understated). */
export function qtySteps(m: Pick<EngineMarket, "step">, qty: string): Steps {
  return steps(maxBigint(0n, m.step.ceilUnits(qty)));
}

export interface AccountBook {
  /** short + fills the position report may not show yet, rounded up. */
  shortSteps: Steps;
  /** Every live sell, as the differ sees it (unknown counts as resting). */
  resting: RestingOrder[];
  /** Confirmed open sells the Guard can see by price. */
  guardResting: GuardRestingAsk[];
  /** Live sells that are not confirmed open: they count as resting at the dearest price. */
  pendingSteps: Steps;
  /** All live sells' remaining size. */
  restingSteps: Steps;
  unknownOrders: number;
  upperBound: boolean;
  foreignOrders: number;
  foreignPosition: boolean;
  oldestUnconfirmedCreateAtMs: number | null;
}

/** The reconciler's view of one account on one symbol, in integer units. */
export function accountBook(rt: AccountRuntime, symbol: string, m: EngineMarket): AccountBook {
  const exp = rt.reconciler.exposure(symbol);
  const resting: RestingOrder[] = [];
  const guardResting: GuardRestingAsk[] = [];
  let pending = 0n;
  let live = 0n;
  for (const o of rt.reconciler.orders(symbol)) {
    if (o.side !== "sell" || TERMINAL.has(o.status)) continue;
    const left = subDec(o.size, o.z);
    const remaining = qtySteps(m, cmpDec(left, ZERO) > 0 ? decToString(left) : "0");
    let px: Ticks = ticks(0n);
    try {
      if (o.price !== undefined) px = ticks(m.tick.toUnits(o.price));
    } catch {
      px = ticks(0n);
    }
    const status: RestingOrder["status"] =
      o.status === "open" && o.orderId !== undefined
        ? "open"
        : o.status === "unknown"
          ? "unknown"
          : "pending";
    const orderId = o.orderId ?? null;
    resting.push({ clientOrderId: o.clientOrderId, orderId, px, qty: remaining, status });
    live += remaining;
    if (status === "open")
      guardResting.push({ clientOrderId: o.clientOrderId, orderId, px, qty: remaining });
    else pending += remaining;
  }
  const restingAll = qtySteps(m, exp.restingAskQty);
  // Whatever the reconciler counts beyond the orders' own remaining size may already be short.
  const extra = restingAll > live ? restingAll - live : 0n;
  const position = parseDec(rt.reconciler.position(symbol));
  const unconfirmed = rt.pending.unconfirmed(rt.id).filter((p) => p.symbol === symbol);
  return {
    shortSteps: steps(qtySteps(m, exp.shortQty) + qtySteps(m, exp.unaccountedFillQty) + extra),
    resting,
    guardResting,
    pendingSteps: steps(pending),
    restingSteps: steps(live),
    unknownOrders: exp.unknownOrders,
    upperBound: exp.upperBound,
    foreignOrders: exp.foreignOrders,
    // Ballast only ever shorts NIGHT: a long on the quoted symbol is not Ballast's.
    foreignPosition: cmpDec(position, ZERO) > 0,
    oldestUnconfirmedCreateAtMs:
      unconfirmed.length === 0 ? null : Math.min(...unconfirmed.map((p) => p.registeredAtMs)),
  };
}

/** Cover in the market's size steps (NIGHT base units are 6 dp; NIGHT-USD steps are 1). */
export function coverSteps(m: Pick<EngineMarket, "step">, cover: CoverState | null): Steps {
  if (!cover) return steps(0n);
  const base = cover.coverBase;
  const whole = base / 1_000_000n;
  const frac = (base % 1_000_000n).toString().padStart(6, "0");
  return steps(maxBigint(0n, m.step.floorUnits(`${whole}.${frac}`)));
}

/**
 * Cover the engine and the Guard may plan against: zero while an unconfirmed spend of counted
 * UTxOs is pending (r = 0 until a block proves the new cover, invariant 1).
 */
export function usableCoverSteps(m: Pick<EngineMarket, "step">, cover: CoverState | null): Steps {
  return cover?.mempoolSpend ? steps(0n) : coverSteps(m, cover);
}

/** qty × ref in µUSD, rounded down. */
export function refValue(ref: RefPrice, qty: Steps, m: EngineMarket): MicroUsd {
  return microUsd((ref.num * qty * m.rate.num) / (ref.den * m.rate.den));
}

/** qty × ref in µUSD, rounded up. */
export function refValueCeil(ref: RefPrice, qty: Steps, m: EngineMarket): MicroUsd {
  return microUsd(ceilDiv(ref.num * qty * m.rate.num, ref.den * m.rate.den));
}

export function decRef(m: EngineMarket, d: Dec | null | undefined): RefPrice | null {
  if (!d?.isPositive()) return null;
  return refPrice(m.tick, d.toFixed());
}

export interface ActivePolicy {
  window: PolicyWindow;
  signed: SignedPolicy<QuotePolicy>;
  report: CriticReport;
  signatureValid: boolean;
  reportValid: boolean;
}

export interface GuardContext {
  nowMs: number;
  flags: GuardInput["flags"];
  policy: ActivePolicy | null;
  market: EngineMarket;
  caps: MarketCaps;
  allowlist: readonly string[];
  mv: MarketView;
  /** The book without Ballast's orders (best bid and ask are read from it). */
  house: LevelBook;
  book: AccountBook;
  cover: CoverState | null;
  rt: AccountRuntime;
  others: GuardInput["market"]["others"];
  plan: RequotePlan | null;
  replicaP99Bps: Dec;
  rate: GuardRateFact;
  decisionSeq: bigint;
  usedClientOrderIds: ReadonlySet<string>;
  stakeBound: boolean;
  lossTodayMicroUsd: MicroUsd;
}

/** The GuardInput for one request, every fact injected (the Guard is pure). */
export function buildGuardInput(request: GuardRequest, c: GuardContext): GuardInput {
  const m = c.market;
  const index = decRef(m, c.mv.price?.index);
  const mark = decRef(m, c.mv.price?.mark);
  const p = c.policy;
  const floor = c.plan?.governor.floor ?? null;
  const cover = usableCoverSteps(m, c.cover);
  const r = p ? effectiveRBps(c.rt.cfg.rBps, p.signed.policy) : 0n;
  const committed = committedSteps(cover, r);
  const margin = c.rt.margin;
  const account: GuardAccountFact = {
    id: c.rt.id,
    holder0: c.rt.cfg.holder0,
    stakeBinding: { bound: c.stakeBound, unique: c.stakeBound },
    foreignOrders: c.book.foreignOrders,
    foreignPositions: c.book.foreignPosition,
    vaultShares: c.rt.vaultShares !== false,
    coverSteps: cover,
    rBps: c.rt.cfg.rBps,
    shortSteps: c.book.shortSteps,
    resting: c.book.guardResting,
    pendingSteps: c.book.pendingSteps,
    unknownOrders: c.book.unknownOrders,
    exposureUpperBound: c.book.upperBound,
    oldestUnconfirmedCreateAtMs: c.book.oldestUnconfirmedCreateAtMs,
    equityMicroUsd: margin ? margin.equityMicroUsd : microUsd(0n),
    marginRatioBps: margin ? margin.ratioBps : null,
    marginBand: c.rt.band.lastBand,
    maxShortMicroUsd: c.rt.cfg.maxShortMicroUsd,
    approvedBuilderBps: c.rt.cfg.approvedBuilderBps,
    lossTodayMicroUsd: c.lossTodayMicroUsd,
    lossHoldUntilMs: c.rt.loss.holdUntilMs,
    committedCoverMicroUsd: index ? refValue(index, committed, m) : microUsd(0n),
  };
  const bid = c.house.bids[0];
  const ask = c.house.asks[0];
  return {
    nowMs: c.nowMs,
    request,
    profile: "AUTONOMOUS",
    flags: c.flags,
    policy: p
      ? {
          policy: p.signed.policy,
          hash: p.window.policyHash,
          signatureValid: p.signatureValid,
          renewalsUsed: p.window.index,
        }
      : null,
    critic: p
      ? { verdict: p.report.verdict, policyHash: p.report.policyHash, reportValid: p.reportValid }
      : null,
    market: {
      spec: m,
      caps: c.caps,
      allowlist: c.allowlist,
      arm: armDecision(DEFAULT_ARM_LIST, m.symbol, { index, mark }),
      index,
      mark,
      bestBidTicks: bid ? ticks(bid.px) : null,
      bestAskTicks: ask ? ticks(ask.px) : null,
      floor: floor
        ? {
            ticks: ticks(floor.ticks),
            bLiqMicroBps: BigInt(floor.bLiqBps.times(1_000_000).toDecimalPlaces(0, 1).toFixed()),
            replicaP99MicroBps: BigInt(
              c.replicaP99Bps.times(1_000_000).toDecimalPlaces(0, 0).toFixed(),
            ),
            positionsStale: floor.stale,
          }
        : null,
      p2: c.plan?.governor.ok ? c.plan.governor.p2 : null,
      others: c.others,
      exitDepthMicroUsd: c.plan?.exitDepth ?? microUsd(0n),
      recyclingOptIn: false,
    },
    data: {
      indexAgeMs: c.mv.indexAgeMs,
      markAgeMs: c.mv.markAgeMs,
      l3Synced: c.mv.l3Synced,
      l3GapFree: c.mv.l3Synced,
      coverAgeMs: c.cover ? c.nowMs - c.cover.checkedAtMs : Number.POSITIVE_INFINITY,
      marketsAgeMs: c.mv.marketsAgeMs,
      userStreamConnected: c.rt.ports.streamLive(),
    },
    // VERIFY: no CEX reference feed is wired yet; "unavailable" passes only while the index is
    // fresh (reference-sanity), exactly as in the Critic's replay (FRICTION 2026-10-23).
    reference: { status: "unavailable", deviationBps: null },
    account,
    allocator: c.plan?.allocatorInput ?? null,
    rate: c.rate,
    decisionSeq: c.decisionSeq,
    usedClientOrderIds: c.usedClientOrderIds,
  };
}

/** Other accounts' short + asks on the symbol (valued as the Guard values this account's). */
export function othersFact(
  books: readonly { id: string; book: AccountBook }[],
  selfId: string,
  mark: RefPrice | null,
  m: EngineMarket,
  l1: Ticks | null,
): GuardInput["market"]["others"] {
  let exposure = 0n;
  let asks = 0n;
  let l1Steps = 0n;
  for (const o of books) {
    if (o.id === selfId) continue;
    if (mark) exposure += refValueCeil(mark, o.book.shortSteps, m);
    for (const r of o.book.resting) {
      // An unpriced (unknown) order is valued at the dearest price Strike would admit.
      const px = r.px > 0n || !mark ? r.px : ticks(ceilDiv(mark.num * 105n, mark.den * 100n));
      const usd = notionalCeil(px, r.qty, m.rate);
      exposure += usd;
      asks += usd;
      if (l1 !== null && r.px === l1) l1Steps += r.qty;
    }
  }
  return {
    exposureMicroUsd: microUsd(exposure),
    askMicroUsd: microUsd(asks),
    l1Steps: steps(l1Steps),
  };
}
