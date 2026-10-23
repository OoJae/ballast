/**
 * The Guard: the deterministic final authority over every request Ballast signs.
 *
 * Ported from Ripcord's checkGuard. PURE and synchronous: every fact (policy verification,
 * exposure, cover, margin, book, rate state) is injected; nothing here touches I/O, env or
 * clocks. Every rule is evaluated (no short-circuit), every evaluated rule lands in checks[] and
 * every failure in violations[]. Prices, sizes and money are integer ticks, steps and micro-USD.
 * Fail-closed throughout: a missing fact, an unparsable policy, an off-grid price, an unknown
 * order count, or a rule that throws while being evaluated all block.
 *
 * Risk-reducing requests (cancel, cancel-all, cancel-only replace-batches and the reduce-only
 * IOC buy-back) are checked only by route-allowlist and dry-run: the kill path must never wait
 * on a fact that may be the very thing that went stale.
 */

import {
  BPS,
  maxBigint,
  microUsd,
  minBigint,
  notionalCeil,
  plusBpsCeil,
  policyMoney,
  type QuotePolicy,
  quotePolicyHash,
  refCeil,
  refNotionalCeil,
  refPlusBpsCeil,
  type Steps,
  safeParseQuotePolicy,
  steps,
  type Ticks,
} from "@ballast/core";
import {
  accountTag,
  allocate,
  committedSteps,
  effectiveRBps,
  LEVEL_RATIONS,
  parseClientOrderId,
  policyRations,
  policyTag,
  type StaticResult,
  validateCreate,
} from "@ballast/engine";
import { checkRoute, type RouteCheck } from "@ballast/strike-client";
import type { GuardCheck, GuardInput, GuardResult, GuardRuleId, GuardViolation } from "./types.js";

/** Freshness limits (plan section 5): a breach cancels. */
export const FRESHNESS = {
  indexMs: 3_000,
  markMs: 3_000,
  coverMs: 60_000,
  marketsMs: 120_000,
} as const;
/** Any create unconfirmed this long blocks new creates for the account. */
export const UNCONFIRMED_CREATE_MS = 5_000;
/** P2-blind mode's total depth (plan section 5). */
export const P2_BLIND_CAP = microUsd(300_000_000n);
/** Holder #0's combined-MTM stop per day. */
export const HOLDER0_LOSS_STOP = microUsd(25_000_000n);
const MICRO_BPS = 1_000_000n;

interface CreateLeg {
  clientOrderId: string;
  symbol: string;
  side: string;
  type: string;
  price: string;
  size: string;
  postOnly: boolean;
  reduceOnly: boolean;
  tif: string | undefined;
}

interface Legs {
  creates: CreateLeg[];
  cancels: Set<bigint>;
  cancelAll: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toLeg(o: unknown): CreateLeg | null {
  if (!isRecord(o)) return null;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  return {
    clientOrderId: str("client_order_id") ?? "",
    symbol: str("symbol") ?? "",
    side: str("side") ?? "",
    type: str("type") ?? "",
    price: str("price") ?? "",
    size: str("size") ?? "",
    postOnly: o.post_only === true,
    reduceOnly: o.reduce_only === true,
    tif: str("time_in_force"),
  };
}

function orderIdOf(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  return null;
}

/** The request's legs, read from its body by path (also when the route itself is refused). */
function legsOf(path: string, body: unknown): Legs {
  const legs: Legs = { creates: [], cancels: new Set(), cancelAll: false };
  const p = path.split("?")[0];
  if (!isRecord(body)) return legs;
  if (p === "/v2/order/replace-batch" && Array.isArray(body.replacements)) {
    for (const item of body.replacements) {
      if (!isRecord(item)) continue;
      if (isRecord(item.cancel)) {
        const id = orderIdOf(item.cancel.order_id);
        if (id !== null) legs.cancels.add(id);
      }
      if (item.new_order !== undefined) {
        const leg = toLeg(item.new_order);
        if (leg) legs.creates.push(leg);
      }
    }
  } else if (p === "/v2/orders/batch" && Array.isArray(body.orders)) {
    for (const o of body.orders) {
      const leg = toLeg(o);
      if (leg) legs.creates.push(leg);
    }
  } else if (p === "/v2/order") {
    const leg = toLeg(body);
    if (leg) legs.creates.push(leg);
  } else if (p === "/v2/order/cancel") {
    const id = orderIdOf(body.order_id);
    if (id !== null) legs.cancels.add(id);
  } else if (p === "/v2/order/cancel-all") {
    legs.cancelAll = true;
  }
  return legs;
}

/** Cancels, cancel-all, cancel-only replace-batches and the reduce-only IOC buy-back. */
function riskReducing(route: RouteCheck): boolean {
  if (!route.ok) return false;
  if (route.route === "order.cancel" || route.route === "order.cancel-all") return true;
  if (route.route === "order.replace-batch") return route.cost.creates === 0;
  // checkRoute admits POST /v2/order only as a reduce-only IOC buy-back.
  return route.route === "order.exit";
}

const safeInt = (v: number, fallback: bigint): bigint =>
  Number.isSafeInteger(v) ? BigInt(v) : fallback;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function checkGuard(input: GuardInput): GuardResult {
  const checks: GuardCheck[] = [];
  const violations: GuardViolation[] = [];
  const record = (rule: GuardRuleId, passed: boolean, detail: string): void => {
    checks.push({ rule, passed, detail });
    if (!passed) violations.push({ rule, detail });
  };
  const rule = (id: GuardRuleId, fn: () => [boolean, string]): void => {
    try {
      const [passed, detail] = fn();
      record(id, passed === true, detail);
    } catch (e) {
      record(id, false, `evaluation error: ${errText(e)}`);
    }
  };

  let route: RouteCheck;
  try {
    route = checkRoute(input.profile, input.request.method, input.request.path, input.request.body);
  } catch (e) {
    route = { ok: false, reason: `route check threw: ${errText(e)}` };
  }
  const reducing = riskReducing(route);
  const routeRule = () =>
    rule("route-allowlist", () => {
      if (!route.ok) return [false, `route refused: ${route.reason}`];
      if (input.profile !== "AUTONOMOUS" && !reducing) {
        return [false, `${input.profile} may not create`];
      }
      return [true, `${route.route} allowed under ${input.profile}`];
    });
  if (reducing) routeRule();
  else quotingRules(input, route, rule, routeRule);

  // dry-run: evaluated LAST; it decides the outcome only when everything else passed.
  const dryRun = input.flags?.dryRun !== false;
  const dryRunDetail =
    violations.length > 0
      ? `DRY_RUN=${dryRun}; moot, blocked by ${violations.length} violation(s)`
      : dryRun
        ? "DRY_RUN held fire: all checks passed, nothing sent"
        : "DRY_RUN disabled: live execution authorized";
  checks.push({ rule: "dry-run", passed: true, detail: dryRunDetail });

  const decision: GuardResult["decision"] =
    violations.length > 0 ? "blocked" : dryRun ? "dry-run" : "execute";
  const first = violations[0];
  return {
    decision,
    violations,
    checks,
    reason:
      first !== undefined
        ? `blocked by ${first.rule}: ${first.detail}`
        : `all ${checks.length} safety checks passed`,
    riskReducing: reducing,
  };
}

interface Ask {
  clientOrderId: string;
  px: Ticks;
  qty: Steps;
}

interface Derived {
  legs: Legs;
  validated: { leg: CreateLeg; v: StaticResult }[];
  newAsks: Ask[];
  bids: { leg: CreateLeg; v: StaticResult }[];
  /** The account's asks after this request, cheapest first. */
  asks: Ask[];
  askQty: bigint;
  askUsd: bigint;
  /** short at mark; null without a mark. */
  shortUsd: bigint | null;
}

function derive(input: GuardInput): Derived {
  const { request, account: acct, market } = input;
  const legs = legsOf(request.path, request.body);
  const validated = legs.creates.map((leg) => ({
    leg,
    v: validateCreate(
      market.spec,
      { price: leg.price, size: leg.size, reduceOnly: leg.reduceOnly },
      market.mark,
    ),
  }));
  const newAsks = validated
    .filter((x) => x.leg.side === "sell")
    .map((x) => ({ clientOrderId: x.leg.clientOrderId, px: x.v.px, qty: x.v.qty }));
  const kept = acct.resting
    .filter((r) => !legs.cancelAll && (r.orderId === null || !legs.cancels.has(r.orderId)))
    .map((r) => ({ clientOrderId: r.clientOrderId, px: r.px, qty: r.qty }));
  const asks = [...kept, ...newAsks].sort((a, b) => (a.px < b.px ? -1 : a.px > b.px ? 1 : 0));
  const rate = market.spec.rate;
  return {
    legs,
    validated,
    newAsks,
    bids: validated.filter((x) => x.leg.side !== "sell"),
    asks,
    askQty: asks.reduce((s, a) => s + a.qty, 0n),
    askUsd: asks.reduce((s, a) => s + notionalCeil(a.px, a.qty, rate), 0n),
    shortUsd: market.mark ? refNotionalCeil(market.mark, acct.shortSteps, rate) : null,
  };
}

function quotingRules(
  input: GuardInput,
  route: RouteCheck,
  rule: (id: GuardRuleId, fn: () => [boolean, string]) => void,
  /** Records route-allowlist in its place in the rule order. */
  routeRule: () => void,
): void {
  const { request, account: acct, market, flags } = input;
  const { spec, caps } = market;
  const symbol = spec.symbol;
  const rate = spec.rate;
  const now = input.nowMs;

  let d: Derived | null = null;
  let deriveError = "";
  try {
    d = derive(input);
  } catch (e) {
    deriveError = errText(e);
  }
  /** Rules over the request's orders fail closed when they could not be read. */
  const withD = (fn: (d: Derived) => [boolean, string]) => (): [boolean, string] =>
    d ? fn(d) : [false, `could not read the request's orders: ${deriveError}`];

  // ---- policy ---------------------------------------------------------------------------
  let policy: QuotePolicy | null = null;
  rule("policy-signature", () => {
    const f = input.policy;
    if (!f) return [false, "no active policy"];
    const parsed = safeParseQuotePolicy(f.policy);
    if (!parsed.ok) return [false, `policy fails the strict schema: ${parsed.error}`];
    const hash = quotePolicyHash(parsed.policy);
    if (hash !== f.hash) return [false, `policy hash ${hash} ≠ signed hash ${f.hash}`];
    if (f.signatureValid !== true) return [false, "operator signature does not verify"];
    policy = parsed.policy;
    return [true, `operator-signed policy ${hash.slice(0, 12)}…`];
  });
  // Re-read through a typed alias: TypeScript cannot see the closure's assignment.
  const p = policy as QuotePolicy | null;
  rule("policy-window", () => {
    if (!p) return [false, "no verified policy"];
    if (now < p.validFromMs || now >= p.validUntilMs) {
      return [false, `now ${now} outside [${p.validFromMs}, ${p.validUntilMs})`];
    }
    const used = input.policy?.renewalsUsed ?? Number.NaN;
    if (!Number.isSafeInteger(used) || used < 0 || used > p.renewals) {
      return [false, `renewals used (${used}) exceed the ${p.renewals} pre-authorized`];
    }
    return [true, `valid until ${p.validUntilMs}, renewal ${used}/${p.renewals}`];
  });
  rule("critic-pass", () => {
    const c = input.critic;
    if (!c) return [false, "no Critic report"];
    if (c.verdict !== "PASS")
      return [false, `Critic verdict ${JSON.stringify(c.verdict)} is not PASS`];
    if (!input.policy || c.policyHash !== input.policy.hash) {
      return [false, "Critic report is for a different policy"];
    }
    if (c.reportValid !== true) return [false, "Critic report does not verify"];
    return [true, "Critic PASS for this policy"];
  });

  // ---- arming and market ----------------------------------------------------------------
  rule("arm-flag", () => {
    if (flags.mainnet !== false && flags.armed !== true) {
      return [false, "mainnet creates need BALLAST_ARM=1; not armed"];
    }
    return [true, flags.mainnet ? "mainnet explicitly armed" : "not mainnet"];
  });
  rule(
    "market-allowlist",
    withD((d) => {
      const problems: string[] = [];
      if (!market.allowlist.includes(symbol)) problems.push(`${symbol} is not in the asset book`);
      if (caps.symbol !== symbol) problems.push(`caps are for ${caps.symbol}`);
      if (!p || p.market !== symbol) problems.push(`policy is not for ${symbol}`);
      if (!market.arm.armed) problems.push(`not armed: ${market.arm.reason}`);
      for (const c of d.legs.creates) {
        if (c.symbol !== symbol) problems.push(`create on ${c.symbol || "(none)"}`);
      }
      return problems.length === 0
        ? [true, `${symbol} allowed and armed`]
        : [false, problems.join("; ")];
    }),
  );

  // ---- data -----------------------------------------------------------------------------
  const bad = (v: number) => !Number.isFinite(v) || v < 0;
  rule("data-freshness", () => {
    const x = input.data;
    const stale: string[] = [];
    if (bad(x.indexAgeMs) || x.indexAgeMs > FRESHNESS.indexMs)
      stale.push(`index ${x.indexAgeMs} ms`);
    if (bad(x.markAgeMs) || x.markAgeMs > FRESHNESS.markMs) stale.push(`mark ${x.markAgeMs} ms`);
    if (x.l3Synced !== true || x.l3GapFree !== true) stale.push("L3 not gap-free");
    if (bad(x.coverAgeMs) || x.coverAgeMs > FRESHNESS.coverMs)
      stale.push(`cover ${x.coverAgeMs} ms`);
    if (bad(x.marketsAgeMs) || x.marketsAgeMs > FRESHNESS.marketsMs) {
      stale.push(`markets ${x.marketsAgeMs} ms`);
    }
    if (x.userStreamConnected !== true) stale.push("user stream down");
    return stale.length === 0 ? [true, "all inputs fresh"] : [false, `stale: ${stale.join(", ")}`];
  });
  rule("reference-sanity", () => {
    const r = input.reference;
    if (r.status === "divergent") return [false, "index diverges from the CEX median"];
    if (r.deviationBps !== null && r.deviationBps > caps.referenceSanityBps) {
      return [
        false,
        `index ${r.deviationBps} bps from the CEX median > ${caps.referenceSanityBps}`,
      ];
    }
    if (r.status === "unavailable") {
      const fresh = !bad(input.data.indexAgeMs) && input.data.indexAgeMs <= FRESHNESS.indexMs;
      return fresh
        ? [true, "reference unavailable; continuing while the index is fresh"]
        : [false, "reference unavailable and the index is stale"];
    }
    if (r.status !== "ok") return [false, `unknown reference status ${String(r.status)}`];
    return [true, `index within ${caps.referenceSanityBps} bps of the CEX median`];
  });

  // ---- cover ----------------------------------------------------------------------------
  const r = p ? effectiveRBps(acct.rBps, p) : 0n;
  const committed = committedSteps(acct.coverSteps, r);
  rule(
    "cover-invariant",
    withD((d) => {
      const total = acct.shortSteps + d.askQty + acct.pendingSteps;
      const problems: string[] = [];
      if (!p) problems.push("no policy r cap");
      if (acct.exposureUpperBound !== true) problems.push("exposure is not a proven upper bound");
      if (acct.pendingSteps < 0n || acct.shortSteps < 0n) problems.push("negative exposure fact");
      if (total > committed) {
        problems.push(
          `short ${acct.shortSteps} + asks ${d.askQty} + pending ${acct.pendingSteps} > r × cover ${committed}`,
        );
      }
      return problems.length === 0
        ? [true, `short + asks + pending ${total} ≤ r × cover ${committed} (r ${r} bps)`]
        : [false, problems.join("; ")];
    }),
  );
  rule("stake-binding", () => {
    const b = acct.stakeBinding;
    if (b.bound !== true) return [false, "no bound stake credential"];
    if (b.unique !== true) return [false, "stake credential is bound to more than one account"];
    return [true, "one stake credential ↔ one account"];
  });
  rule("dedicated-account", () => {
    const problems: string[] = [];
    if (acct.foreignOrders !== 0) problems.push(`${acct.foreignOrders} non-Ballast order(s)`);
    if (acct.foreignPositions !== false) problems.push("a non-Ballast position");
    if (acct.vaultShares !== false) problems.push("vault shares");
    return problems.length === 0
      ? [true, "dedicated to Ballast"]
      : [false, `paused: non-Ballast activity (${problems.join(", ")})`];
  });

  // ---- prices ---------------------------------------------------------------------------
  const mark = market.mark;
  rule(
    "price-floor",
    withD((d) => {
      const problems: string[] = [];
      const f = market.floor;
      const index = market.index;
      if (!f) problems.push("no floor computed");
      if (!index || index.num <= 0n) problems.push("no index");
      if (f?.positionsStale && !mark) problems.push("positions stale and no mark");
      if (f) {
        const need = BigInt(p?.pricing.liqBufferBps ?? 10) * MICRO_BPS + 2n * f.replicaP99MicroBps;
        if (f.bLiqMicroBps < need) problems.push(`b_liq ${f.bLiqMicroBps} µbps < ${need}`);
      }
      const offset = maxBigint(BigInt(p?.pricing.minOffsetBps ?? 38), caps.minOffsetBps);
      const fromIndex = index && index.num > 0n ? refPlusBpsCeil(index, offset) : null;
      const fromMark = f?.positionsStale && mark ? refCeil(mark) : null;
      for (const a of d.asks) {
        if (f && a.px < f.ticks) problems.push(`${a.clientOrderId} ${a.px} < F ${f.ticks}`);
        if (fromMark !== null && a.px < fromMark) {
          problems.push(`${a.clientOrderId} ${a.px} < mark ${fromMark} (positions stale)`);
        }
        if (fromIndex !== null && a.px < fromIndex) {
          problems.push(`${a.clientOrderId} ${a.px} < index + ${offset} bps (${fromIndex})`);
        }
      }
      return problems.length === 0
        ? [true, `every ask ≥ max(F ${f?.ticks}, index + ${offset} bps${fromMark ? ", mark" : ""})`]
        : [false, problems.join("; ")];
    }),
  );
  rule(
    "p2-constraint",
    withD((d) => {
      const x = market.p2;
      const problems: string[] = [];
      const minAsk = d.asks[0]?.px ?? null;
      if (!x) return [false, "no P2 projection"];
      if (x.mode === "blind") {
        if (x.fragileLong !== false) problems.push("a fragile long exists: P2-blind stands down");
        let cap: bigint = minBigint(P2_BLIND_CAP, x.capMicroUsd);
        if (p) cap = minBigint(cap, policyMoney(p).preD6DepthCap);
        const total = market.others.askMicroUsd + d.askUsd;
        if (total > cap) problems.push(`Ballast asks ${total} µUSD > P2-blind cap ${cap}`);
        const floor = market.floor?.ticks ?? null;
        const markTicks = mark ? refCeil(mark) : null;
        if (floor === null || markTicks === null) problems.push("no floor or mark");
        else if (minAsk !== null && (minAsk < floor || minAsk < markTicks)) {
          problems.push(`L1 ${minAsk} < max(F ${floor}, mark ${markTicks})`);
        }
      } else if (x.mode === "replica") {
        if (x.safe !== true) problems.push("projected P2 falls below the liquidation target");
        if (minAsk !== null && minAsk < x.minL1Ticks) {
          problems.push(`L1 ${minAsk} < P2-safe L1 ${x.minL1Ticks}`);
        }
        const atL1 = d.asks.filter((a) => a.px === minAsk).reduce((s, a) => s + a.qty, 0n);
        const total = market.others.l1Steps + atL1;
        if (total > x.maxL1DepthSteps) {
          problems.push(`L1 depth ${total} > P2-safe ${x.maxL1DepthSteps} steps`);
        }
      } else problems.push("unknown P2 mode");
      return problems.length === 0
        ? [true, `P2 constraint holds (${x.mode})`]
        : [false, problems.join("; ")];
    }),
  );
  rule(
    "ladder-shape",
    withD((d) => {
      const problems: string[] = [];
      const maxLevels = Math.min(p?.pricing.maxLevels ?? 0, caps.maxLevels);
      const prices = new Set(d.asks.map((a) => a.px));
      if (d.asks.length > maxLevels) problems.push(`${d.asks.length} asks > ${maxLevels} levels`);
      if (prices.size !== d.asks.length) problems.push("more than one ask at a level");
      const rations = p ? policyRations(policyMoney(p).l1Refill) : [...LEVEL_RATIONS];
      const l1 = d.asks[0]?.px;
      for (const [i, a] of d.asks.entries()) {
        if (i > 0 && l1 !== undefined) {
          const spacing = p?.pricing.levelSpacingBps[i - 1];
          if (spacing === undefined) problems.push(`L${i + 1} has no spacing`);
          else if (a.px < plusBpsCeil(l1, BigInt(spacing))) {
            problems.push(`L${i + 1} ${a.px} < L1 + ${spacing} bps`);
          }
        }
        const ration = rations[i];
        const usd = notionalCeil(a.px, a.qty, rate);
        if (ration === undefined || usd > ration) {
          problems.push(`L${i + 1} ${usd} µUSD > ration ${ration ?? "(none)"}`);
        }
      }
      return problems.length === 0
        ? [true, `${d.asks.length} level(s) within the ladder shape`]
        : [false, problems.join("; ")];
    }),
  );
  rule(
    "no-bid-ahead",
    withD((d) => {
      const problems: string[] = [];
      const bestBid = market.bestBidTicks;
      // With Strike's written opt-in: at the best bid or one tick ahead. Otherwise strictly below.
      const ahead =
        market.recyclingOptIn === true && p?.exits.mode === "at_best_bid_opt_in" ? 1n : -1n;
      for (const { leg, v } of d.bids) {
        if (leg.side !== "buy") problems.push(`${leg.clientOrderId} has side "${leg.side}"`);
        if (!leg.reduceOnly) problems.push(`${leg.clientOrderId} is a buy without reduce_only`);
        if (bestBid === null) problems.push(`${leg.clientOrderId}: no best non-Ballast bid`);
        else if (v.px > bestBid + ahead) {
          problems.push(`${leg.clientOrderId} ${v.px} is ahead of the best bid ${bestBid}`);
        }
      }
      return problems.length === 0
        ? [true, `${d.bids.length} reduce-only bid(s), none ahead of the best bid`]
        : [false, problems.join("; ")];
    }),
  );
  rule(
    "static-rules",
    withD((d) => {
      const problems: string[] = [];
      for (const { leg, v } of d.validated) {
        const failed = v.checks.filter((c) => !c.ok).map((c) => c.id);
        if (failed.length > 0) problems.push(`${leg.clientOrderId}: ${failed.join(", ")}`);
        if (leg.type !== "limit") problems.push(`${leg.clientOrderId} is not a limit order`);
        if (leg.side === "sell") {
          if (!leg.postOnly) problems.push(`${leg.clientOrderId}: ask is not post-only`);
          if (leg.tif !== undefined && leg.tif !== "GTC") {
            problems.push(`${leg.clientOrderId}: ask is not GTC`);
          }
          if (market.bestBidTicks !== null && v.px <= market.bestBidTicks) {
            problems.push(`${leg.clientOrderId}: ask would cross the best bid`);
          }
        }
      }
      return problems.length === 0
        ? [true, `${d.validated.length} create(s) pass the 8 static checks`]
        : [false, problems.join("; ")];
    }),
  );

  // ---- leverage, margin and caps --------------------------------------------------------
  rule(
    "leverage-cap",
    withD((d) => {
      const cap = minBigint(BigInt(p?.risk.maxLeverageX100 ?? 0), caps.maxLeverageX100);
      if (!mark || d.shortUsd === null) return [false, "no mark to value the position"];
      // Resting asks count at the worse of their price and the mark.
      let usd = d.shortUsd;
      for (const a of d.asks) {
        usd += maxBigint(notionalCeil(a.px, a.qty, rate), refNotionalCeil(mark, a.qty, rate));
      }
      const ok = acct.equityMicroUsd > 0n && usd * 100n <= acct.equityMicroUsd * cap;
      return [ok, `(short + asks) ${usd} µUSD vs equity ${acct.equityMicroUsd} at ≤ ${cap}/100`];
    }),
  );
  rule("margin-band", () => {
    const ratio = acct.marginRatioBps;
    const reduce = BigInt(p?.risk.marginReduceBps ?? 0);
    if (ratio === null || ratio < 0n) return [false, "margin ratio unknown"];
    const bandOk = acct.marginBand === "ok" || acct.marginBand === "warn";
    return [
      ratio < reduce && bandOk,
      `margin ratio ${ratio} bps (${acct.marginBand}) vs reduce-only at ${reduce}`,
    ];
  });
  rule(
    "per-account-short",
    withD((d) => {
      let cap: bigint = p ? policyMoney(p).perAccountMaxShort : 0n;
      if (acct.maxShortMicroUsd !== null) cap = minBigint(cap, acct.maxShortMicroUsd);
      if (acct.holder0) cap = minBigint(cap, caps.holder0MaxShort);
      if (d.shortUsd === null) return [false, "no mark to value the short"];
      const usd = d.shortUsd + d.askUsd;
      const qty = acct.shortSteps + d.askQty + acct.pendingSteps;
      return [
        usd <= cap && qty <= committed,
        `short + asks ${usd} µUSD ≤ ${cap}; ${qty} ≤ r × cover ${committed}`,
      ];
    }),
  );
  rule(
    "aggregate-cap",
    withD((d) => {
      const cap = minBigint(p ? policyMoney(p).aggregateMaxShort : 0n, market.exitDepthMicroUsd);
      if (d.shortUsd === null) return [false, "no mark to value the short"];
      const total = market.others.exposureMicroUsd + d.shortUsd + d.askUsd;
      return [total <= cap, `Σ short + asks ${total} µUSD ≤ min(policy, exit depth) ${cap}`];
    }),
  );
  rule(
    "fee-cap",
    withD((d) => {
      const fee = request.builderFeeBps;
      const feeBps = safeInt(fee, 101n);
      const entries = d.legs.creates.some((c) => c.side === "sell" && !c.reduceOnly);
      const exits = d.legs.creates.some((c) => c.side === "buy" || c.reduceOnly);
      const problems: string[] = [];
      if (feeBps < 0n || feeBps > 100n) problems.push(`bad builder fee ${fee}`);
      if (entries) {
        let cap = minBigint(BigInt(p?.fees.entryBuilderBps ?? 0), caps.maxEntryBuilderBps);
        cap = minBigint(cap, maxBigint(0n, safeInt(acct.approvedBuilderBps, 0n)));
        // Holder #0 pays no builder fee to itself.
        if (acct.holder0) cap = 0n;
        if (feeBps > cap) problems.push(`entry fee ${fee} bps > cap ${cap}`);
      }
      if (exits && feeBps !== 0n) problems.push(`exit fee ${fee} bps ≠ 0`);
      return problems.length === 0
        ? [true, `builder fee ${fee} bps within caps`]
        : [false, problems.join("; ")];
    }),
  );
  rule("loss-stop", () => {
    if (acct.lossHoldUntilMs !== null && now < acct.lossHoldUntilMs) {
      return [false, `loss-stop hold until ${acct.lossHoldUntilMs}`];
    }
    const limit = acct.holder0
      ? HOLDER0_LOSS_STOP
      : (BigInt(p?.risk.lossStopBpsOfCover ?? 0) * acct.committedCoverMicroUsd) / BPS;
    return [
      acct.lossTodayMicroUsd < limit,
      `combined MTM loss ${acct.lossTodayMicroUsd} µUSD vs stop ${limit}`,
    ];
  });
  rule("holder0-unpaired", () => {
    if (!acct.holder0) return [true, "not holder #0"];
    if (!mark) return [false, "no mark to value unpaired cover"];
    const unpaired = refNotionalCeil(
      mark,
      steps(maxBigint(0n, acct.coverSteps - acct.shortSteps)),
      rate,
    );
    return [
      unpaired <= caps.holder0MaxUnpaired,
      `unpaired cover ${unpaired} µUSD ≤ ${caps.holder0MaxUnpaired}`,
    ];
  });
  rule(
    "allocator-conformance",
    withD((d) => {
      const a = input.allocator;
      if (!a) return [false, "no allocator inputs to recompute"];
      const mine = allocate(a.accounts, a.ladder, a.opts).allocations.filter(
        (x) => x.accountId === acct.id,
      );
      const problems: string[] = [];
      for (const ask of d.newAsks) {
        const lvl = parseClientOrderId(ask.clientOrderId)?.level;
        const slot = mine.find((x) => x.px === ask.px && x.level === lvl);
        if (!slot) problems.push(`${ask.clientOrderId}: no allocation at ${ask.px}`);
        else if (ask.qty > slot.qty)
          problems.push(`${ask.clientOrderId}: ${ask.qty} > ${slot.qty}`);
      }
      return problems.length === 0
        ? [true, "every create within its recomputed allocation"]
        : [false, problems.join("; ")];
    }),
  );
  rule(
    "rate-budget",
    withD((d) => {
      const rt = input.rate;
      const problems: string[] = [];
      const ops = route.ok ? route.cost.ops : d.legs.creates.length + d.legs.cancels.size;
      const limit = rt.windowCap - rt.cancelReserve;
      if (!(rt.usedInWindow + ops <= limit)) {
        problems.push(
          `${rt.usedInWindow} + ${ops} ops > ${limit} (cancel reserve ${rt.cancelReserve})`,
        );
      }
      if (!(now >= rt.pausedUntilMs))
        problems.push(`creates paused after 429s until ${rt.pausedUntilMs}`);
      const rb = route.ok ? route.cost.replaceBatch : request.path.includes("replace-batch");
      if (rb && rt.lastReplaceBatchMs !== null && !(now - rt.lastReplaceBatchMs >= rt.spacingMs)) {
        problems.push(
          `replace-batch ${now - rt.lastReplaceBatchMs} ms after the last (< ${rt.spacingMs})`,
        );
      }
      return problems.length === 0
        ? [true, `${ops} op(s) within the budget`]
        : [false, problems.join("; ")];
    }),
  );
  rule(
    "client-id-format",
    withD((d) => {
      const problems: string[] = [];
      const want = input.policy ? policyTag(input.policy.hash) : null;
      const acct6 = accountTag(acct.id);
      const ranks = [...new Set(d.asks.map((a) => a.px))];
      const seen = new Set<string>();
      for (const { leg: c, v } of d.validated) {
        const id = c.clientOrderId;
        const parts = parseClientOrderId(id);
        if (!parts) {
          problems.push(`${id || "(empty)"} is not bal_<policy6>_<acct6>_<lvl|x>_<seq36>`);
          continue;
        }
        if (want === null || parts.policy6 !== want) problems.push(`${id}: not this policy`);
        if (parts.acct6 !== acct6) problems.push(`${id}: not this account`);
        if (parts.seq !== input.decisionSeq) problems.push(`${id}: seq ≠ ${input.decisionSeq}`);
        if (c.side === "sell" && !c.reduceOnly) {
          const rank = ranks.indexOf(v.px) + 1;
          if (parts.level !== rank) problems.push(`${id}: level ≠ ladder rank ${rank}`);
        } else if (parts.level !== "x") problems.push(`${id}: exits use level x`);
        if (input.usedClientOrderIds.has(id) || seen.has(id)) problems.push(`${id} is reused`);
        seen.add(id);
      }
      return problems.length === 0
        ? [true, `${d.validated.length} well-formed, unused client id(s)`]
        : [false, problems.join("; ")];
    }),
  );
  routeRule();
  rule("unknown-orders", () => {
    const problems: string[] = [];
    if (acct.unknownOrders !== 0) problems.push(`${acct.unknownOrders} order(s) of unknown state`);
    if (acct.exposureUpperBound !== true) problems.push("exposure is not a proven upper bound");
    const oldest = acct.oldestUnconfirmedCreateAtMs;
    if (oldest !== null && !(now - oldest <= UNCONFIRMED_CREATE_MS)) {
      problems.push(`a create unconfirmed for ${now - oldest} ms`);
    }
    return problems.length === 0
      ? [true, "no unknown or overdue orders"]
      : [false, problems.join("; ")];
  });
}

/** The signer seam: `send` is reached only on an "execute" decision. */
export async function guardedSend<T>(
  input: GuardInput,
  send: (request: GuardInput["request"]) => Promise<T>,
): Promise<{ result: GuardResult; sent: T | null }> {
  const result = checkGuard(input);
  if (result.decision !== "execute") return { result, sent: null };
  return { result, sent: await send(input.request) };
}
