/**
 * The Ballast keeper: market state + cover → keeper safety → engine (planRequote) → Guard →
 * guardedSend → signer → reconcile (user stream + REST, silent drops) → signed decision records.
 *
 * createDaemon(deps) is fully dependency-injected (Ripcord's pattern), so the wiring tests can
 * drive real ticks with a maximally permissive engine and prove the signer is never reached on a
 * blocking condition. Every request to Strike goes through one of two Guard seams:
 * - `guardedSend` (the full Guard, all 28 rules) for anything that creates an ask;
 * - `guardedCancel` (the Guard's exempt path: route-allowlist + dry-run) for cancels, cancel-only
 *   replace-batches and the reduce-only IOC buy-back, so the kill path never waits on a fact that
 *   may itself have gone stale.
 *
 * DRY_RUN (the default) evaluates every rule as if armed, records a "would place" decision with
 * the full Guard result, and never sends: the dry-run rule is evaluated last and a dry-run
 * decision is never "execute".
 */
import {
  canonicalize,
  maxBigint,
  microUsd,
  minBigint,
  type QuotePolicy,
  refPlusBpsFloor,
  type Steps,
  safeParseQuotePolicy,
  sha256Hex,
  steps,
} from "@ballast/core";
import type { CoverProof } from "@ballast/cover";
import {
  capsFor,
  clientOrderId,
  committedSteps,
  DEFAULT_ARM_LIST,
  type EngineMarket,
  effectiveRBps,
  evaluateMarginBand,
  keeperStep,
  type MarketCaps,
  marginThresholds,
  matchOwnOrders,
  planRequote,
  R_MAX_BPS,
  type RequoteAccount,
  type RequotePlan,
} from "@ballast/engine";
import type { EvidenceDb, KillTrigger, OrderStatus } from "@ballast/evidence/db";
import {
  type CriticReport,
  type CriticRunner,
  checkPolicySignature,
  type DaemonKey,
  type DecisionDraft,
  DecisionLog,
  type DecisionOp,
  type DecisionRecord,
  type GateResult,
  PolicyRegistry,
  type RenewalOutcome,
  runCriticGate,
  SAFETY_CLASS_RULES,
  type SignedPolicy,
  type SignedRenewalEnvelope,
  verifyCriticReport,
} from "@ballast/governance";
import {
  checkGuard,
  checkRiskReducing,
  type GuardInput,
  type GuardRequest,
  type GuardResult,
  guardedCancel,
  guardedSend,
  HOLDER0_LOSS_STOP,
} from "@ballast/guard";
import { type Dec, dec, type Level, type LevelBook, levelsFromL3 } from "@ballast/market";
import { type HealthReport, type Kill, KillTracker, type Notifier } from "@ballast/ops";
import {
  type CreateOrderBody,
  type CreateOutcome,
  cancelAll,
  decToString,
  type OrderTradeUpdate,
  type PendingCreate,
  type RateLimiter,
  type ReplaceBatchBody,
  reduceOnlyBuyBack,
  resyncAccount,
  type UserStreamEvent,
} from "@ballast/strike-client";
import { type AccountPorts, AccountRuntime, type BalanceRow } from "./account.js";
import type { CoverSource } from "./cover-watch.js";
import {
  type AccountBook,
  type ActivePolicy,
  accountBook,
  buildGuardInput,
  coverSteps,
  decRef,
  othersFact,
  refValue,
  usableCoverSteps,
} from "./facts.js";
import type { MarketSource, MarketView } from "./market-state.js";

export interface DaemonLogger {
  child(bindings: Record<string, unknown>): DaemonLogger;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface Clock {
  now(): number;
}

export interface KeeperRuntimeConfig {
  mode: "dry-run" | "armed";
  dryRun: boolean;
  armed: boolean;
  /** Strike mainnet (the only venue NIGHT-USD trades on). */
  mainnet: boolean;
  quoteSymbol: string;
  /** Symbols the asset book allows (market-allowlist). */
  allowlist: readonly string[];
  trustedOperators: readonly string[];
  /** Must include this daemon's own key. */
  trustedDaemons: readonly string[];
  /** The mark replica's p99 error in bps (b_liq = liqBuffer + 2 × p99). */
  replicaP99Bps: string;
  minTickMs?: number;
  maxIdleMs?: number;
  requoteHeartbeatMs?: number;
  marginEveryMs?: number;
  marginMaxAgeMs?: number;
  vaultEveryMs?: number;
  renewEveryMs?: number;
  renewLeadMs?: number;
  criticTimeoutMs?: number;
  lockStaleMs?: number;
  supervisionAlertTicks?: number;
  /** Kill path step 2 (second cancel-all + per-order cancels) after this long unconfirmed. */
  killRetryMs?: number;
  killEscalateMs?: number;
  /** Reconciler settle gap between openOrders and positions on a resync (default 1 s). */
  reconcilerLagMs?: number;
  /** Rate budget the Guard is told about (RateLimiter's defaults). */
  ordersPerWindow?: number;
  cancelReserve?: number;
}

/** The Advisor's fire-and-forget front end (governance AdvisorService), structurally. */
export interface AdvisorPort {
  submit(subject: {
    kind: "policy" | "policy-diff" | "critic-report" | "guard-trip" | "book-health";
    subjectHash: string;
    deterministicText: string;
    facts?: unknown;
  }): void;
}

export interface WouldPlaceEntry {
  tsMs: number;
  seq: number;
  recordHash: string;
  accountId: string;
  symbol: string;
  ops: DecisionOp[];
  guard: GuardResult;
  facts: Record<string, unknown>;
}

export interface EnginePorts {
  plan: typeof planRequote;
  keeper: typeof keeperStep;
}

export interface KeeperDeps {
  config: KeeperRuntimeConfig;
  db: EvidenceDb;
  daemonKey: DaemonKey;
  market: MarketSource;
  cover: CoverSource;
  accounts: readonly AccountPorts[];
  rate: RateLimiter;
  notifier: Notifier;
  logger: DaemonLogger;
  clock: Clock;
  critic?: CriticRunner<QuotePolicy> | null;
  advisor?: AdvisorPort;
  /** Test seam: the engine is replaced by a maximally permissive one in the wiring tests. */
  engine?: Partial<EnginePorts>;
  /** Public vault-positions read per account; absent → shares assumed held (fail closed). */
  vaultCheck?: (accountId: string) => Promise<boolean>;
  /** DRY_RUN "would place" sink (main() writes JSONL). */
  wouldPlace?: (e: WouldPlaceEntry) => void;
  /** Defaults to the arm list's caps for the quoted symbol. */
  caps?: MarketCaps;
  pid?: number;
}

export interface KeeperState {
  ticks: number;
  lastTickMs: number | null;
  stale: string[];
  blindTicks: number;
  stopping: boolean;
  lastQuote: { index: Dec; atMs: number } | null;
  dirty: boolean;
}

export interface KeeperDaemon {
  runTick(): Promise<void>;
  start(): void;
  /** Graceful: stops ticking, cancels resting asks (armed), waits for confirmation. */
  stop(opts?: { cancel?: boolean; waitMs?: number }): Promise<void>;
  requestTick(reason: string): void;
  activatePolicy(signed: SignedPolicy<QuotePolicy>, report: CriticReport | null): GateResult;
  /** Run the Critic on a candidate, then try to activate it. */
  proposePolicy(
    signed: SignedPolicy<QuotePolicy>,
  ): Promise<{ report: CriticReport; result: GateResult }>;
  attachEnvelope(env: SignedRenewalEnvelope): boolean;
  renewIfDue(force?: boolean): Promise<RenewalOutcome | null>;
  onUserEvent(accountId: string, event: UserStreamEvent): void;
  onUserResync(accountId: string): void;
  onCoverProof(accountId: string, proof: CoverProof): void;
  heartbeatSnapshot(): {
    mode: "dry-run" | "armed";
    state: "starting" | "running" | "stopping";
    decisionHead: { seq: number; hash: string | null };
    accounts: { accountId: string; symbol: string; restingAsks: number; quoting: boolean }[];
  };
  health(): HealthReport;
  readonly state: KeeperState;
  readonly accounts: readonly AccountRuntime[];
  readonly log: DecisionLog;
  readonly kills: KillTracker;
  readonly registry: PolicyRegistry<QuotePolicy>;
}

const DAY_MS = 86_400_000;
const STALE = { indexMs: 3_000, coverMs: 60_000, marketsMs: 120_000 } as const;
const MICRO = 1_000_000n;

const hashOf = (v: unknown) => sha256Hex(canonicalize(v));
const str = (v: unknown): unknown =>
  typeof v === "bigint"
    ? v.toString()
    : Array.isArray(v)
      ? v.map(str)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, str(x)]),
          )
        : v;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Decimal string → micro-USD, rounded down (negative allowed, e.g. a rebate). */
function microOf(s: string | undefined): bigint | null {
  if (s === undefined || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const neg = s.startsWith("-");
  const [i = "0", f = ""] = s.replace(/^-/, "").split(".");
  const v = BigInt(i) * MICRO + BigInt(`${f}000000`.slice(0, 6));
  const exact = f.length <= 6 || /^0*$/.test(f.slice(6));
  return neg ? -(exact ? v : v + 1n) : v;
}

const STREAM_DB_STATUS: Record<string, OrderStatus> = {
  NEW: "pending",
  OPEN: "resting",
  PARTIALLY_FILLED: "partially_filled",
  FILLED: "filled",
  CANCELED: "canceled",
  REJECTED: "rejected",
  EXPIRED: "canceled",
};

function killTrigger(reason: string): KillTrigger {
  if (/cover|spend/.test(reason)) return "cover";
  if (/stale|L3|stream|index|mark/.test(reason)) return "stale-data";
  if (/margin|flatten|reduce:/.test(reason)) return "margin";
  if (/loss stop/.test(reason)) return "loss-stop";
  if (/shutdown/.test(reason)) return "operator";
  return "guard";
}

export function createDaemon(deps: KeeperDeps): KeeperDaemon {
  const { config: cfg, db, logger, clock, notifier, rate } = deps;
  const symbol = cfg.quoteSymbol;
  const caps = deps.caps ?? capsFor(DEFAULT_ARM_LIST, symbol);
  if (!caps) throw new Error(`${symbol} is not on the arm list`);
  if (!cfg.trustedDaemons.includes(deps.daemonKey.publicKeyHex)) {
    throw new Error("the daemon's own key must be among the trusted daemon keys");
  }
  const engine: EnginePorts = {
    plan: deps.engine?.plan ?? planRequote,
    keeper: deps.engine?.keeper ?? keeperStep,
  };
  const pid = deps.pid ?? process.pid;
  const p99 = dec(cfg.replicaP99Bps);
  const minTickMs = cfg.minTickMs ?? 250;
  const maxIdleMs = cfg.maxIdleMs ?? 1_000;
  const heartbeatMs = cfg.requoteHeartbeatMs ?? 30_000;
  const marginEveryMs = cfg.marginEveryMs ?? 5_000;
  const marginMaxAgeMs = cfg.marginMaxAgeMs ?? 30_000;
  const vaultEveryMs = cfg.vaultEveryMs ?? 60_000;
  const windowCap = cfg.ordersPerWindow ?? 300;
  const cancelReserve = cfg.cancelReserve ?? 60;

  const log = new DecisionLog({
    key: deps.daemonKey,
    head: db.decisionHead(),
    sink: db.decisionSink(),
    now: () => clock.now(),
  });
  const registry = new PolicyRegistry<QuotePolicy>({
    trustedOperators: cfg.trustedOperators,
    trustedDaemons: cfg.trustedDaemons,
  });
  const policies = new Map<
    string,
    { signed: SignedPolicy<QuotePolicy>; signatureValid: boolean }
  >();
  const reports = new Map<string, { report: CriticReport; valid: boolean }>();
  /** client order id → policy hash, for every create this daemon recorded. */
  const createdIds = new Map<string, string>();
  const usedIds = new Set<string>();

  const state: KeeperState = {
    ticks: 0,
    lastTickMs: null,
    stale: [],
    blindTicks: 0,
    stopping: false,
    lastQuote: null,
    dirty: true,
  };
  let phase: "starting" | "running" | "stopping" = "starting";
  let lastFloorTicks: bigint | null = null;
  let lastStandDown = false;
  let lastBlockedAlert = "";
  let lastBlockedAlertAt = Number.NEGATIVE_INFINITY;

  const safeNotify = (a: Parameters<Notifier["notify"]>[0]) => {
    void Promise.resolve()
      .then(() => notifier.notify({ ...a, dryRun: cfg.dryRun }))
      .catch((err) => logger.warn({ err: errText(err) }, "notifier failed"));
  };
  const advise = (s: Parameters<AdvisorPort["submit"]>[0]) => {
    try {
      deps.advisor?.submit(s);
    } catch {
      // The Advisor is never in the path: a throw changes nothing.
    }
  };

  const accounts: AccountRuntime[] = deps.accounts.map(
    (ports) =>
      new AccountRuntime(ports, {
        now: () => clock.now(),
        ...(cfg.reconcilerLagMs !== undefined ? { lagMs: cfg.reconcilerLagMs } : {}),
        onCreateOutcome: (rt, p, o) => onCreateOutcome(rt, p, o),
        onLateEvent: (rt, id) => {
          logger.warn(
            { account: rt.id, clientOrderId: id },
            "late event for a create declared gone",
          );
          state.dirty = true;
        },
        onAnomaly: (rt, a) => logger.warn({ account: rt.id, ...a }, "reconciler anomaly"),
      }),
  );
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const rt of accounts) {
    for (const row of db.orders(rt.id)) usedIds.add(String(row.client_order_id));
  }

  const kills = new KillTracker({
    now: () => clock.now(),
    ...(cfg.killRetryMs !== undefined ? { retryAfterMs: cfg.killRetryMs } : {}),
    ...(cfg.killEscalateMs !== undefined ? { escalateAfterMs: cfg.killEscalateMs } : {}),
    onConfirmed: (k, lat) => {
      if (k.dbId !== null) {
        try {
          db.confirmKill(k.dbId, {
            streamMs: k.streamConfirmedMs ?? clock.now(),
            l3Ms: k.l3ConfirmedMs ?? clock.now(),
          });
        } catch (err) {
          logger.error({ err: errText(err) }, "kill confirmation could not be recorded");
        }
      }
      logger.info({ account: k.accountId, ...lat }, "kill confirmed on stream and L3");
      safeNotify({
        kind: "kill-confirmed",
        source: "keeper",
        severity: "info",
        title: `cancel-all confirmed: stream +${lat.streamMs} ms, L3 +${lat.l3Ms} ms`,
        accountId: k.accountId,
        symbol: k.symbol,
      });
    },
    onRetry: (k) => void retryKill(k),
    onEscalate: (k) => {
      if (k.dbId !== null) {
        try {
          db.setKillStatus(k.dbId, "escalated");
        } catch {}
      }
      safeNotify({
        kind: "kill-escalated",
        source: "keeper",
        severity: "page",
        title: "cancel-all still unconfirmed after 10 s",
        detail: k.reason,
        accountId: k.accountId,
        symbol: k.symbol,
      });
    },
  });

  // ---- policies -------------------------------------------------------------------------

  function rememberReport(report: CriticReport): boolean {
    const valid = verifyCriticReport(report, cfg.trustedDaemons).length === 0;
    reports.set(report.hash, { report, valid });
    try {
      db.insertCriticReport(report);
    } catch (err) {
      if (!/UNIQUE|PRIMARY KEY/.test(errText(err))) throw err;
    }
    return valid;
  }

  function activatePolicy(
    signed: SignedPolicy<QuotePolicy>,
    report: CriticReport | null,
  ): GateResult {
    const now = clock.now();
    const parsed = safeParseQuotePolicy(signed.policy);
    if (!parsed.ok) {
      const result: GateResult = {
        ok: false,
        checks: [{ rule: "policy-schema", passed: false, detail: parsed.error }],
      };
      logger.warn({ policy: signed.hash, error: parsed.error }, "policy refused: schema");
      return result;
    }
    if (parsed.policy.market !== symbol) {
      return {
        ok: false,
        checks: [
          { rule: "policy-market", passed: false, detail: `policy is for ${parsed.policy.market}` },
        ],
      };
    }
    if (report) rememberReport(report);
    const result = registry.activate(signed, report, now);
    const signatureValid = checkPolicySignature(signed, cfg.trustedOperators).passed;
    try {
      db.insertPolicy(
        signed,
        result.ok ? "active" : "rejected",
        now,
        result.ok ? report?.hash : undefined,
      );
    } catch (err) {
      if (!/UNIQUE|PRIMARY KEY/.test(errText(err))) throw err;
      if (result.ok && report) db.setPolicyStatus(signed.hash, "active", report.hash);
    }
    if (result.ok && report) {
      policies.set(signed.hash, { signed, signatureValid });
      log.append({
        kind: "policy",
        policyHash: signed.hash,
        inputsDigest: report.hash,
        inputsRef: null,
      });
      state.dirty = true;
      logger.info({ policy: signed.hash.slice(0, 12) }, "policy activated");
      safeNotify({
        kind: "policy",
        source: "keeper",
        severity: "info",
        title: `policy ${signed.hash.slice(0, 12)}… activated (Critic PASS)`,
        symbol,
      });
      advise({
        kind: "policy",
        subjectHash: signed.hash,
        deterministicText: `Policy activated after a Critic PASS: ${report.reason}`,
      });
    } else {
      const failed = result.checks.filter((c) => !c.passed).map((c) => `${c.rule}: ${c.detail}`);
      if (report) {
        log.append({
          kind: "critic",
          policyHash: signed.hash,
          inputsDigest: report.hash,
          inputsRef: null,
        });
      }
      logger.warn({ policy: signed.hash.slice(0, 12), failed }, "policy refused");
      safeNotify({
        kind: "policy",
        source: "keeper",
        severity: "warn",
        title: `policy ${signed.hash.slice(0, 12)}… refused`,
        detail: failed.join("; "),
      });
    }
    return result;
  }

  async function proposePolicy(signed: SignedPolicy<QuotePolicy>) {
    const report = await runCriticGate({
      runner: deps.critic ?? null,
      signed,
      daemonKey: deps.daemonKey,
      now: () => clock.now(),
      ...(cfg.criticTimeoutMs !== undefined ? { timeoutMs: cfg.criticTimeoutMs } : {}),
    });
    return { report, result: activatePolicy(signed, report) };
  }

  function attachEnvelope(env: SignedRenewalEnvelope): boolean {
    const ok = registry.attachEnvelope(env);
    if (ok) {
      try {
        db.insertRenewalEnvelope(env);
      } catch (err) {
        if (!/UNIQUE|PRIMARY KEY/.test(errText(err))) throw err;
      }
    }
    return ok;
  }

  /** Re-applies the recorded activations and renewals at their recorded times (restart). */
  function rehydrate(): void {
    const stored = new Map(db.policies().map((p) => [p.signed.hash, p.signed]));
    for (const r of db.criticReports()) {
      reports.set(r.hash, {
        report: r,
        valid: verifyCriticReport(r, cfg.trustedDaemons).length === 0,
      });
    }
    const renewals = new Map(db.renewals().map((r) => [r.hash, r]));
    const envelopes = db.renewalEnvelopes();
    const trips = db.guardTrips().map((t) => ({ ruleId: t.ruleId, tsMs: t.tsMs }));
    for (const d of db.decisions()) {
      if (d.kind !== "policy") continue;
      const renewal = renewals.get(d.inputsDigest);
      if (renewal) {
        const env = envelopes.find((e) => e.hash === renewal.renewal.envelopeHash);
        if (env) registry.attachEnvelope(env);
        registry.applyRenewal(
          renewal,
          reports.get(renewal.renewal.criticReportHash)?.report,
          trips,
        );
        continue;
      }
      const sp = d.policyHash
        ? (stored.get(d.policyHash) as SignedPolicy<QuotePolicy> | undefined)
        : undefined;
      if (!sp) continue;
      const r = registry.activate(sp, reports.get(d.inputsDigest)?.report, d.tsMs);
      if (r.ok) {
        policies.set(sp.hash, {
          signed: sp,
          signatureValid: checkPolicySignature(sp, cfg.trustedOperators).passed,
        });
      }
    }
    const head = registry.headHash();
    if (head) {
      for (const env of envelopes)
        if (env.envelope.basePolicyHash === head) registry.attachEnvelope(env);
    }
  }

  function activePolicy(now: number): ActivePolicy | null {
    const w = registry.activeAt(now);
    if (!w) return null;
    const p = policies.get(w.policyHash);
    const r = reports.get(w.criticReportHash);
    if (!p || !r) return null;
    return {
      window: w,
      signed: p.signed,
      report: r.report,
      signatureValid: p.signatureValid,
      reportValid: r.valid,
    };
  }

  async function renewIfDue(force = false): Promise<RenewalOutcome | null> {
    const now = clock.now();
    const head = registry.headPolicy();
    const w = registry.activeAt(now);
    if (!head || !w || w.policyHash !== head.hash) return null;
    if (!force && w.validUntilMs - now > (cfg.renewLeadMs ?? 2 * 3_600_000)) return null;
    const report = await runCriticGate({
      runner: deps.critic ?? null,
      signed: head as SignedPolicy<QuotePolicy>,
      daemonKey: deps.daemonKey,
      now: () => clock.now(),
      ...(cfg.criticTimeoutMs !== undefined ? { timeoutMs: cfg.criticTimeoutMs } : {}),
    });
    rememberReport(report);
    const trips = db.guardTrips(w.validFromMs).map((t) => ({
      ruleId: t.ruleId,
      tsMs: t.tsMs,
      ...(t.accountId ? { accountId: t.accountId } : {}),
    }));
    const outcome = registry.renew(report, trips, clock.now(), deps.daemonKey);
    if (outcome.ok) {
      db.insertRenewal(outcome.signed);
      log.append({
        kind: "policy",
        policyHash: head.hash,
        inputsDigest: outcome.signed.hash,
        inputsRef: null,
      });
      safeNotify({
        kind: "renewal",
        source: "keeper",
        severity: "info",
        title: `policy renewed: window ${outcome.signed.renewal.index}`,
      });
      advise({
        kind: "critic-report",
        subjectHash: report.hash,
        deterministicText: `Renewal ${outcome.signed.renewal.index} issued: ${report.reason}`,
      });
    } else {
      log.append({
        kind: "critic",
        policyHash: head.hash,
        inputsDigest: report.hash,
        inputsRef: null,
      });
      const failed = outcome.checks.filter((c) => !c.passed).map((c) => `${c.rule}: ${c.detail}`);
      safeNotify({
        kind: "renewal",
        source: "keeper",
        severity: "warn",
        title: "renewal refused; the current window runs to its end",
        detail: failed.join("; "),
      });
    }
    return outcome;
  }

  // ---- stream events and silent drops ---------------------------------------------------

  function updateDbOrder(
    clientOrderId: string,
    patch: { status?: OrderStatus; filledSteps?: string; orderId?: string },
  ) {
    if (!createdIds.has(clientOrderId)) return;
    try {
      db.updateOrder(clientOrderId, patch, clock.now());
    } catch (err) {
      logger.debug({ clientOrderId, err: errText(err) }, "order row not updated");
    }
  }

  function onCreateOutcome(rt: AccountRuntime, p: PendingCreate, o: CreateOutcome): void {
    rt.reconciler.onCreateOutcome(p.clientOrderId, o);
    if (o.kind === "dropped") {
      updateDbOrder(p.clientOrderId, { status: "dropped" });
      logger.warn(
        { account: rt.id, clientOrderId: p.clientOrderId },
        "silent drop: GET /v2/order 404",
      );
      safeNotify({
        kind: "error",
        source: "keeper",
        severity: "warn",
        title: `silent drop detected for ${p.clientOrderId} (never resent)`,
        accountId: rt.id,
      });
    } else if (o.kind === "not-sent") {
      updateDbOrder(p.clientOrderId, { status: "rejected" });
    } else {
      updateDbOrder(p.clientOrderId, { orderId: o.orderId.toString() });
    }
    if (rt.buyBackInFlight === p.clientOrderId && o.kind !== "confirmed") rt.buyBackInFlight = null;
    state.dirty = true;
  }

  function recordFill(rt: AccountRuntime, u: OrderTradeUpdate): void {
    const now = clock.now();
    if (!u.c.startsWith("bal_")) {
      logger.error({ account: rt.id }, "fill on a non-Ballast order: account paused");
      try {
        db.flagManualActivity(rt.id, `fill on non-bal_ order ${u.c || `#${u.i}`}`, now);
      } catch {}
      safeNotify({
        kind: "error",
        source: "keeper",
        severity: "page",
        title: "paused: non-Ballast activity (a fill on a foreign order)",
        accountId: rt.id,
      });
      return;
    }
    const fact = {
      tradeId: u.t.toString(),
      clientOrderId: u.c,
      symbol: u.s,
      side: u.S,
      price: u.L,
      qty: u.l,
      maker: u.m,
      fee: u.n,
      builderFee: u.builder_fee ?? null,
      T: u.T,
    };
    const policyHash = createdIds.get(u.c);
    log.append({
      kind: "fill",
      accountId: rt.id,
      ...(policyHash ? { policyHash } : {}),
      inputsDigest: hashOf(fact),
      inputsRef: null,
    });
    const mv = deps.market.view(u.s);
    const m = mv.market;
    if (m && createdIds.has(u.c)) {
      try {
        db.insertFill({
          tradeId: u.t.toString(),
          clientOrderId: u.c,
          accountId: rt.id,
          side: u.S === "BUY" ? "buy" : "sell",
          role: u.m ? "maker" : "taker",
          priceTicks: m.tick.toUnits(u.L).toString(),
          sizeSteps: m.step.toUnits(u.l).toString(),
          feeMicroUsd: (microOf(u.n) ?? 0n).toString(),
          builderFeeMicroUsd: microOf(u.builder_fee)?.toString() ?? null,
          tsMs: u.T,
        });
      } catch (err) {
        logger.warn({ err: errText(err) }, "fill row not recorded");
      }
    }
    safeNotify({
      kind: "fill",
      source: "keeper",
      severity: "info",
      title: `${u.S === "BUY" ? "bought back" : "ask lifted"} ${u.l} @ ${u.L}${u.m ? " (maker)" : ""}`,
      accountId: rt.id,
      symbol: u.s,
    });
  }

  function onUserEvent(accountId: string, ev: UserStreamEvent): void {
    const rt = byId.get(accountId);
    if (!rt) return;
    try {
      rt.reconciler.apply(ev);
      if (ev.kind === "order" || ev.kind === "fill") {
        const u = ev.data;
        rt.pending.onOrderUpdate(u);
        const filled = typeof u.z === "string" && /[1-9]/.test(u.z);
        const status = u.X === "OPEN" && filled ? "partially_filled" : STREAM_DB_STATUS[u.X];
        updateDbOrder(u.c, {
          ...(status ? { status } : {}),
          ...(u.i > 0n ? { orderId: u.i.toString() } : {}),
        });
        if (ev.kind === "fill") recordFill(rt, u);
        if (
          rt.buyBackInFlight === u.c &&
          (u.X === "FILLED" || u.X === "CANCELED" || u.X === "EXPIRED" || u.X === "REJECTED")
        ) {
          rt.buyBackInFlight = null;
        }
        state.dirty = true;
      } else if (ev.kind === "position") {
        state.dirty = true;
      }
    } catch (err) {
      logger.error({ account: accountId, err: errText(err) }, "user event not applied: resync");
      rt.needsResync = true;
    }
    kills.check();
    requestTick("user-event");
  }

  function onUserResync(accountId: string): void {
    const rt = byId.get(accountId);
    if (rt) rt.needsResync = true;
    requestTick("user-resync");
  }

  function onCoverProof(accountId: string, proof: CoverProof): void {
    try {
      db.insertCoverCheck(proof, byId.has(accountId) ? accountId : null);
    } catch (err) {
      if (!/UNIQUE|FOREIGN KEY/.test(errText(err))) throw err;
    }
    log.append({ kind: "cover", accountId, inputsDigest: proof.hash, inputsRef: null });
    state.dirty = true;
    requestTick("cover");
  }

  // ---- per-account housekeeping ---------------------------------------------------------

  async function refreshMargin(rt: AccountRuntime, now: number): Promise<void> {
    if (rt.margin && now - rt.margin.atMs < marginEveryMs) return;
    try {
      const rows = await rt.ports.reads.get<BalanceRow[] | null>("/v2/balances");
      // VERIFY: user-api.yaml documents a one-element USDT array; which row carries the margin
      // of an ADA/USDM-funded cross account is unconfirmed (FRICTION 2026-10-23).
      const row = (rows ?? []).find((r) => r.asset === "USDT") ?? rows?.[0];
      const mb = microOf(row?.marginBalance);
      const mm = microOf(row?.maintMargin);
      if (mb === null || mm === null) throw new Error("balances row without marginBalance");
      rt.margin = {
        equityMicroUsd: microUsd(maxBigint(0n, mb)),
        ratioBps: mb > 0n ? (mm * 10_000n + mb - 1n) / mb : null,
        atMs: clock.now(),
      };
      rt.marginError = null;
    } catch (err) {
      rt.marginError = errText(err);
    }
  }

  async function refreshVault(rt: AccountRuntime, now: number): Promise<void> {
    if (!deps.vaultCheck || now - rt.vaultCheckedAtMs < vaultEveryMs) return;
    rt.vaultCheckedAtMs = now;
    try {
      rt.vaultShares = await deps.vaultCheck(rt.id);
    } catch (err) {
      logger.warn(
        { account: rt.id, err: errText(err) },
        "vault check failed (previous value kept)",
      );
    }
  }

  async function resync(rt: AccountRuntime): Promise<void> {
    if (!rt.needsResync || rt.resyncing || !rt.ports.streamLive()) return;
    rt.resyncing = true;
    try {
      // openOrders, a settle wait of the reconciler's lag, then positions (strike-userstream).
      await resyncAccount(rt.reconciler, rt.ports.reads, { symbol });
      rt.needsResync = false;
      state.dirty = true;
    } catch (err) {
      logger.warn({ account: rt.id, err: errText(err) }, "REST resync failed; retrying next tick");
    } finally {
      rt.resyncing = false;
    }
  }

  /** Off the tick path: a slow read must never delay a cancel. */
  function housekeeping(rt: AccountRuntime, now: number): void {
    if (rt.housekeeping) return;
    rt.housekeeping = true;
    void (async () => {
      await rt.pending.tick().catch(() => {});
      await resync(rt);
      await refreshMargin(rt, now);
      await refreshVault(rt, now);
    })()
      .catch((err) => logger.warn({ account: rt.id, err: errText(err) }, "housekeeping failed"))
      .finally(() => {
        rt.housekeeping = false;
        kills.check();
      });
  }

  // ---- market facts ---------------------------------------------------------------------

  /**
   * Finds our live orders on L3 by price + fingerprinted size; drops ids of ended orders. Every
   * live Ballast order is matched, confirmed or not: an unconfirmed create can already rest on L3,
   * and counting it as house liquidity would make the keeper chase its own ask.
   */
  function attribute(mv: MarketView): void {
    const book = mv.book;
    for (const rt of accounts) {
      const live = new Set<string>();
      const expected: { key: string; price: string; size: string }[] = [];
      for (const o of rt.reconciler.orders(symbol)) {
        if (o.side !== "sell" || !isLive(rt, o.clientOrderId)) continue;
        live.add(o.clientOrderId);
        if (!rt.l3Ids.has(o.clientOrderId) && o.price) {
          expected.push({ key: o.clientOrderId, price: o.price, size: decToString(o.size) });
        }
      }
      for (const k of [...rt.l3Ids.keys()]) if (!live.has(k) && !isLive(rt, k)) rt.l3Ids.delete(k);
      if (book && mv.l3Synced && expected.length > 0) {
        const taken = new Set(accounts.flatMap((a) => [...a.l3Ids.values()]));
        for (const [k, id] of matchOwnOrders(book.asks, expected, taken)) rt.l3Ids.set(k, id);
      }
    }
  }

  function isLive(rt: AccountRuntime, clientOrderId: string): boolean {
    const o = rt.reconciler.order(clientOrderId);
    return (
      o !== undefined &&
      !["filled", "canceled", "rejected", "expired", "dropped", "not-sent"].includes(o.status)
    );
  }

  /** The book without Ballast: attributed orders by L3 id, the rest by size at their price. */
  function houseBook(
    mv: MarketView,
    m: EngineMarket,
    books: { id: string; book: AccountBook }[],
  ): LevelBook {
    if (!mv.book || !mv.l3Synced) return { bids: [], asks: [] };
    const exclude = new Set(accounts.flatMap((a) => [...a.l3Ids.values()]));
    const lv = levelsFromL3(mv.book, m.spec, exclude);
    const minus = new Map<bigint, bigint>();
    for (const { id, book } of books) {
      const rt = byId.get(id);
      for (const r of book.resting) {
        if (r.status !== "open" || rt?.l3Ids.has(r.clientOrderId)) continue;
        minus.set(r.px, (minus.get(r.px) ?? 0n) + r.qty);
      }
    }
    const asks: Level[] = lv.asks
      .map((l) => ({ px: l.px, qty: maxBigint(0n, l.qty - (minus.get(l.px) ?? 0n)) }))
      .filter((l) => l.qty > 0n);
    return { bids: lv.bids, asks };
  }

  let lastRebuildSeen: number | null = null;

  function globalStale(mv: MarketView): string[] {
    const out: string[] = [];
    if (!mv.l3Synced) out.push("L3 not gap-free");
    // A gap or `clear` means the book could not be trusted for a while, however fast the rebuild:
    // asks priced off it are cancelled once, then quoting resumes on the rebuilt book.
    if (mv.l3RebuildAtMs !== null && mv.l3RebuildAtMs !== lastRebuildSeen) {
      lastRebuildSeen = mv.l3RebuildAtMs;
      out.push("L3 gap or clear: the book was rebuilt");
    }
    if (!mv.price || mv.indexAgeMs > STALE.indexMs)
      out.push(`index/mark > 3 s (${mv.indexAgeMs} ms)`);
    if (!mv.market || mv.marketsAgeMs > STALE.marketsMs) out.push("markets > 120 s");
    return out;
  }

  function rateFact(rt: AccountRuntime) {
    return {
      usedInWindow: rate.used(),
      windowCap,
      cancelReserve,
      lastReplaceBatchMs: rt.lastReplaceBatchMs,
      spacingMs: 2_000,
      pausedUntilMs: rate.pausedUntil,
    };
  }

  function guardFlags(): GuardInput["flags"] {
    // DRY_RUN evaluates every rule as if armed, so a "would place" record shows exactly what the
    // Guard would have decided; the dry-run rule (evaluated last) still guarantees no send.
    return cfg.dryRun
      ? { dryRun: true, armed: true, mainnet: cfg.mainnet }
      : { dryRun: false, armed: cfg.armed, mainnet: cfg.mainnet };
  }

  function guardSummary(g: GuardResult) {
    return {
      decision: g.decision,
      checksHash: hashOf(g.checks),
      violations: g.violations.map((v) => v.rule),
    };
  }

  function recordTrips(rt: AccountRuntime, g: GuardResult, seq: number): void {
    const now = clock.now();
    for (const v of g.violations) {
      try {
        db.insertGuardTrip({
          tsMs: now,
          accountId: rt.id,
          ruleId: v.rule,
          safetyClass: SAFETY_CLASS_RULES.has(v.rule),
          decisionSeq: seq,
          detail: v.detail.slice(0, 500),
        });
      } catch (err) {
        logger.warn({ err: errText(err) }, "guard trip not recorded");
      }
    }
    const key = `${rt.id}:${g.violations.map((v) => v.rule).join(",")}`;
    if (key !== lastBlockedAlert || now - lastBlockedAlertAt > 300_000) {
      lastBlockedAlert = key;
      lastBlockedAlertAt = now;
      safeNotify({
        kind: "guard-blocked",
        source: "keeper",
        severity: "warn",
        title: g.reason,
        accountId: rt.id,
        symbol,
      });
      advise({
        kind: "guard-trip",
        subjectHash: hashOf(g.violations),
        deterministicText: g.reason,
      });
    }
  }

  // ---- risk-reducing sends (exempt Guard path) ------------------------------------------

  function append(draft: DecisionDraft): DecisionRecord {
    return log.append(draft);
  }

  async function sendCancelAll(
    rt: AccountRuntime,
    reason: string,
    trigger?: KillTrigger,
  ): Promise<void> {
    const now = clock.now();
    if (kills.pending(rt.id, symbol)) return;
    const body = cancelAll(symbol);
    const request: GuardRequest = {
      method: "DELETE",
      path: "/v2/order/cancel-all",
      body,
      builderFeeBps: 0,
    };
    const g = checkRiskReducing({ request, profile: "AUTONOMOUS", flags: { dryRun: cfg.dryRun } });
    const liveIds = rt.reconciler
      .orders(symbol)
      .filter((o) => o.side === "sell" && isLive(rt, o.clientOrderId))
      .map((o) => o.clientOrderId);
    const l3At = liveIds.flatMap((id) => (rt.l3Ids.has(id) ? [rt.l3Ids.get(id) as string] : []));
    const cover = deps.cover.view(rt.id);
    const record = append({
      kind: "kill",
      accountId: rt.id,
      inputsDigest: hashOf({ reason, symbol, live: liveIds, cover: cover?.proof.hash ?? null }),
      inputsRef: null,
      ops: [{ route: "DELETE /v2/order/cancel-all" }],
      guard: guardSummary(g),
    });
    const t = trigger ?? killTrigger(reason);
    logger.warn({ account: rt.id, reason, decision: g.decision, seq: record.seq }, "cancel-all");
    if (g.decision !== "execute") {
      if (g.decision === "dry-run")
        logger.info({ account: rt.id, reason }, "DRY_RUN: would cancel-all");
      return;
    }
    let dbId: number | null = null;
    try {
      dbId = db.insertKill({
        accountId: rt.id,
        symbol,
        trigger: t,
        sentAtMs: now,
        decisionSeq: record.seq,
      });
    } catch (err) {
      logger.error({ err: errText(err) }, "kill row not recorded");
    }
    kills.track({
      accountId: rt.id,
      symbol,
      trigger: t,
      reason,
      sentAtMs: now,
      dbId,
      probe: {
        streamClear: () =>
          !rt.reconciler
            .orders(symbol)
            .some((o) => o.side === "sell" && isLive(rt, o.clientOrderId)),
        l3Clear: () => {
          const mv = deps.market.view(symbol);
          if (!mv.book || !mv.l3Synced) return false;
          const present = new Set<string>();
          for (const q of mv.book.asks.values()) for (const o of q) present.add(o.id);
          return l3At.every((id) => !present.has(id));
        },
      },
    });
    safeNotify({
      kind: "kill",
      source: "keeper",
      severity: t === "cover" || t === "loss-stop" ? "page" : "warn",
      title: `cancel-all sent: ${reason}`,
      accountId: rt.id,
      symbol,
    });
    try {
      await guardedCancel({ request, profile: "AUTONOMOUS", flags: { dryRun: cfg.dryRun } }, () =>
        rt.ports.signer.cancelAll(body),
      );
    } catch (err) {
      logger.error(
        { account: rt.id, err: errText(err) },
        "cancel-all failed; the kill tracker retries",
      );
    }
  }

  async function retryKill(k: Kill): Promise<void> {
    const rt = byId.get(k.accountId);
    if (!rt) return;
    if (k.dbId !== null) {
      try {
        db.setKillStatus(k.dbId, "retried");
      } catch {}
    }
    safeNotify({
      kind: "kill-escalated",
      source: "keeper",
      severity: "page",
      title: "cancel-all unconfirmed after 5 s: second cancel-all and per-order cancels",
      detail: k.reason,
      accountId: k.accountId,
      symbol: k.symbol,
    });
    const body = cancelAll(k.symbol);
    const request: GuardRequest = {
      method: "DELETE",
      path: "/v2/order/cancel-all",
      body,
      builderFeeBps: 0,
    };
    const g = checkRiskReducing({ request, profile: "AUTONOMOUS", flags: { dryRun: cfg.dryRun } });
    append({
      kind: "kill",
      accountId: rt.id,
      inputsDigest: hashOf({ retryOf: k.dbId, reason: k.reason, sentAtMs: k.sentAtMs }),
      inputsRef: null,
      ops: [{ route: "DELETE /v2/order/cancel-all" }],
      guard: guardSummary(g),
    });
    try {
      await guardedCancel({ request, profile: "AUTONOMOUS", flags: { dryRun: cfg.dryRun } }, () =>
        rt.ports.signer.cancelAll(body),
      );
    } catch (err) {
      logger.error({ err: errText(err) }, "second cancel-all failed");
    }
    try {
      const open = await rt.ports.reads.openOrders(k.symbol);
      if (open.orders.length > 0) {
        append({
          kind: "kill",
          accountId: rt.id,
          inputsDigest: hashOf({ retryOf: k.dbId, perOrder: open.orders.map((o) => String(o.ID)) }),
          inputsRef: null,
          ops: open.orders.map((o) => ({
            route: "DELETE /v2/order/cancel",
            cancelOrderId: String(o.ID),
          })),
          guard: guardSummary(g),
        });
      }
      for (const o of open.orders) {
        const cancel = { symbol: k.symbol, order_id: BigInt(o.ID) };
        const req: GuardRequest = {
          method: "DELETE",
          path: "/v2/order/cancel",
          body: cancel,
          builderFeeBps: 0,
        };
        await guardedCancel(
          { request: req, profile: "AUTONOMOUS", flags: { dryRun: cfg.dryRun } },
          () => rt.ports.signer.cancelOrder(cancel),
        ).catch((err) => logger.error({ err: errText(err) }, "per-order cancel failed"));
      }
    } catch (err) {
      logger.error({ err: errText(err) }, "openOrders for per-order cancels failed");
    }
    rt.needsResync = true;
  }

  async function sendBuyBack(
    rt: AccountRuntime,
    qty: Steps,
    reason: string,
    mv: MarketView,
    m: EngineMarket,
  ): Promise<void> {
    if (rt.buyBackInFlight !== null || qty <= 0n) return;
    const mark = decRef(m, mv.price?.mark);
    const policyHash = registry.headHash();
    if (!mark || !policyHash) {
      logger.error({ account: rt.id }, "buy-back due but no mark or no policy tag");
      return;
    }
    const seq = BigInt(log.head().seq + 1);
    const id = clientOrderId({ policyHash, accountId: rt.id, level: "x", seq });
    // IOC capped at mark + 4%, inside Ballast's ±4.5% static band (Strike allows 5%).
    const cap = refPlusBpsFloor(mark, 400n);
    const size = m.step.fromUnits(qty).toFixed();
    const price = m.tick.fromUnits(cap).toFixed();
    const body: CreateOrderBody = reduceOnlyBuyBack({ clientOrderId: id, symbol, size, price });
    const request: GuardRequest = { method: "POST", path: "/v2/order", body, builderFeeBps: 0 };
    const g = checkRiskReducing({ request, profile: "AUTONOMOUS", flags: { dryRun: cfg.dryRun } });
    const record = append({
      kind: "keeper",
      accountId: rt.id,
      policyHash,
      inputsDigest: hashOf({ reason, qty: qty.toString(), mark: mv.price?.mark.toFixed() ?? null }),
      inputsRef: null,
      ops: [
        {
          route: "POST /v2/order",
          clientOrderId: id,
          side: "buy",
          priceTicks: cap.toString(),
          sizeSteps: qty.toString(),
          builderBps: 0,
        },
      ],
      guard: guardSummary(g),
    });
    if (record.seq !== Number(seq)) {
      logger.error(
        { want: seq.toString(), got: record.seq },
        "decision seq moved: buy-back not sent",
      );
      return;
    }
    usedIds.add(id);
    if (g.decision !== "execute") {
      if (g.decision === "dry-run")
        logger.info({ account: rt.id, qty: qty.toString() }, "DRY_RUN: would buy back");
      return;
    }
    rt.buyBackInFlight = id;
    rt.reconciler.registerCreate({ clientOrderId: id, symbol, side: "buy", size, price });
    rt.pending.register(rt.id, symbol, id);
    createdIds.set(id, policyHash);
    try {
      db.insertOrder({
        clientOrderId: id,
        accountId: rt.id,
        decisionSeq: record.seq,
        policyHash,
        symbol,
        side: "buy",
        reduceOnly: true,
        priceTicks: cap.toString(),
        sizeSteps: qty.toString(),
        status: "pending",
        createdAtMs: clock.now(),
      });
    } catch (err) {
      logger.warn({ err: errText(err) }, "buy-back order row not recorded");
    }
    safeNotify({
      kind: "kill",
      source: "keeper",
      severity: "page",
      title: `reduce-only buy-back ${size} (${reason})`,
      accountId: rt.id,
      symbol,
    });
    try {
      await guardedCancel({ request, profile: "AUTONOMOUS", flags: { dryRun: cfg.dryRun } }, () =>
        rt.ports.signer.placeBuyBack(body),
      );
    } catch (err) {
      rt.pending.onSendError([id], err);
      logger.error({ account: rt.id, err: errText(err) }, "buy-back send failed");
    }
  }

  // ---- keeper enforcement ---------------------------------------------------------------

  function lossStop(
    rt: AccountRuntime,
    mv: MarketView,
    m: EngineMarket,
    book: AccountBook,
    policy: QuotePolicy | null,
  ): boolean {
    const now = clock.now();
    if (rt.loss.holdUntilMs !== null && now < rt.loss.holdUntilMs) return true;
    const index = decRef(m, mv.price?.index);
    if (!rt.margin || !index) return false;
    // Combined MTM PnL, integrated tick by tick: the perp equity's change (marginBalance holds the
    // short's PnL at mark) plus what the coins paired with the short earned at home over the step.
    // Buying the short back is not a loss: the coins simply stop being paired.
    // VERIFY: paired coins are valued at Strike's index, not a CEX/DEX mid (FRICTION 2026-10-23).
    const day = Math.floor(now / DAY_MS);
    if (day !== rt.loss.day) {
      rt.loss.day = day;
      rt.loss.pnl = 0n;
    }
    const prev = rt.loss.prev;
    if (prev) {
      const paired = refValue(index, prev.short, m) - refValue(prev.index, prev.short, m);
      rt.loss.pnl += rt.margin.equityMicroUsd - prev.equity + paired;
    }
    rt.loss.prev = { equity: rt.margin.equityMicroUsd, short: book.shortSteps, index };
    const loss = maxBigint(0n, -rt.loss.pnl);
    let limit: bigint = HOLDER0_LOSS_STOP;
    if (!rt.cfg.holder0) {
      if (!policy) return false;
      const cover = coverSteps(m, deps.cover.view(rt.id));
      const committed = committedSteps(cover, effectiveRBps(rt.cfg.rBps, policy));
      limit = (BigInt(policy.risk.lossStopBpsOfCover) * refValue(index, committed, m)) / 10_000n;
    }
    rt.lossToday = microUsd(loss);
    if (loss >= limit && limit > 0n) {
      rt.loss.holdUntilMs = now + DAY_MS;
      safeNotify({
        kind: "kill",
        source: "keeper",
        severity: "page",
        title: `loss stop: combined MTM loss ${loss} µUSD ≥ ${limit}; 24 h hold`,
        accountId: rt.id,
      });
      return true;
    }
    return false;
  }

  async function enforce(
    rt: AccountRuntime,
    mv: MarketView,
    m: EngineMarket,
    book: AccountBook,
    stale: readonly string[],
    active: ActivePolicy | null,
  ): Promise<void> {
    const now = clock.now();
    const policy =
      active?.signed.policy ?? (registry.headPolicy()?.policy as QuotePolicy | undefined) ?? null;
    const marginFresh = rt.margin !== null && now - rt.margin.atMs <= marginMaxAgeMs;
    const margin = evaluateMarginBand(
      marginFresh ? (rt.margin?.ratioBps ?? null) : null,
      policy
        ? marginThresholds(policy)
        : { warnBps: 4_000n, reduceBps: 5_000n, flattenBps: 6_000n, rearmBps: 3_500n },
      rt.band,
    );
    rt.band = margin.nextState;
    const cover = deps.cover.view(rt.id);
    const reasons = [...stale];
    if (!cover || now - cover.checkedAtMs > STALE.coverMs) reasons.push("cover > 60 s");
    if (!rt.ports.streamLive()) reasons.push("user stream down");
    if (!active) reasons.push("no policy in force");
    const r = policy ? effectiveRBps(rt.cfg.rBps, policy) : minBigint(rt.cfg.rBps, R_MAX_BPS);
    const k = engine.keeper({
      symbol,
      shortSteps: book.shortSteps,
      restingSteps: steps(book.restingSteps),
      unknownOrders: book.unknownOrders,
      coverSteps: coverSteps(m, cover),
      rBps: r,
      mempoolSpend: cover?.mempoolSpend ? { coverAfterSteps: null } : null,
      stale: reasons,
      margin,
      lossStop: lossStop(rt, mv, m, book, policy),
    });
    // Creates wait for the REST resync after a (re)subscribe: the stream has no replay.
    rt.allowCreates = k.allowCreates && active !== null && !rt.needsResync;
    for (const action of k.actions) {
      if (action.kind === "cancel-all") await sendCancelAll(rt, action.reason);
      // Cover unknown is not cover zero: no buy-back until a proof exists.
      else if (cover) await sendBuyBack(rt, action.qty, action.reason, mv, m);
    }
  }

  // ---- engine → Guard → signer ----------------------------------------------------------

  function requoteAccounts(
    books: { id: string; book: AccountBook }[],
    m: EngineMarket,
  ): RequoteAccount[] {
    return accounts.map((rt) => {
      const b = books.find((x) => x.id === rt.id)?.book;
      return {
        id: rt.id,
        holder0: rt.cfg.holder0,
        coverSteps: usableCoverSteps(m, deps.cover.view(rt.id)),
        rBps: rt.cfg.rBps,
        shortSteps: b?.shortSteps ?? steps(0n),
        resting: b?.resting ?? [],
        maxShortMicroUsd: rt.cfg.maxShortMicroUsd,
        lastReplaceBatchMs: rt.lastReplaceBatchMs,
        allowCreates: rt.allowCreates,
      };
    });
  }

  function feeBps(rt: AccountRuntime, policy: QuotePolicy): number {
    if (rt.cfg.holder0) return 0;
    const cap = Math.min(policy.fees.entryBuilderBps, Number(caps?.maxEntryBuilderBps ?? 0n));
    return Math.max(0, Math.min(cap, rt.cfg.approvedBuilderBps));
  }

  async function requote(
    mv: MarketView,
    m: EngineMarket,
    active: ActivePolicy | null,
    house: LevelBook,
  ): Promise<void> {
    const now = clock.now();
    const price = mv.price;
    const policy =
      active?.signed.policy ?? (registry.headPolicy()?.policy as QuotePolicy | undefined);
    const policyHash = active?.window.policyHash ?? registry.headHash();
    if (!price || !policy || !policyHash) return;
    const moved =
      !state.lastQuote ||
      price.index
        .minus(state.lastQuote.index)
        .abs()
        .times(10_000)
        .gte(state.lastQuote.index.times(policy.requote.indexMoveBps));
    const heartbeat = !state.lastQuote || now - state.lastQuote.atMs >= heartbeatMs;
    let triggered = state.dirty || moved || heartbeat || lastStandDown;
    // The trigger is consumed now; fills, cover and silent-drop outcomes during the round re-arm it.
    if (triggered) state.dirty = false;
    const markTicks = m.tick.ceilUnits(price.mark);
    let floorChanged = false;
    let deferred = false;
    for (const rt of accounts) {
      const books = accounts.map((a) => ({ id: a.id, book: accountBook(a, symbol, m) }));
      const seq = BigInt(log.head().seq + 1);
      const plan: RequotePlan = engine.plan({
        market: m,
        caps: caps as MarketCaps,
        policy,
        policyHash,
        book: house,
        index: price.index,
        mark: price.mark,
        positions: mv.positions,
        positionsAgeMs: mv.positionsAgeMs,
        replicaP99Bps: p99,
        // P2-blind until D6 validates the replica's P2 (plan section 5); the replica runs in
        // market state for drift monitoring only.
        p2: { mode: "blind" },
        accounts: requoteAccounts(books, m),
        nowMs: now,
        seq,
        // VERIFY: the protocol-as-taker fill budget needs to know which takers are the house;
        // the data policy forbids identifying them from private data, so it is not wired live
        // (FRICTION 2026-10-23). The P2-blind $300 cap bounds the same exposure meanwhile.
      });
      const floorTicks = plan.governor.floor?.ticks ?? 0n;
      if (lastFloorTicks !== floorTicks) floorChanged = true;
      lastFloorTicks = floorTicks;
      if (floorChanged) triggered = true;
      lastStandDown = !plan.governor.ok;
      const ap = plan.accounts.find((a) => a.accountId === rt.id);
      if (!ap) continue;
      const myBook = books.find((b) => b.id === rt.id)?.book as AccountBook;
      // P2-blind (until D6): L1 must clear the mark, so a resting ask below it is unsafe now.
      const mustClearMark = true;
      const unsafe =
        !plan.governor.ok ||
        !rt.allowCreates ||
        myBook.resting.some(
          (o) => o.px > 0n && (o.px < floorTicks || (mustClearMark && o.px < markTicks)),
        );
      if (!triggered && !unsafe) continue;
      if (ap.diff.kind === "replace-batch") {
        const ok = await sendReplaceBatch(
          rt,
          plan,
          ap.diff.body,
          ap.diff.creates,
          ap.diff.cancels,
          seq,
          {
            mv,
            m,
            active,
            house,
            books,
            myBook,
            policy,
            policyHash,
          },
        );
        if (!ok && unsafe && myBook.restingSteps > 0n)
          await sendCancelAll(rt, "requote blocked while orders are unsafe");
      } else if (ap.diff.kind !== "none") {
        // Throttled (2 s spacing) or waiting on an unconfirmed order: try again next tick.
        deferred = true;
        if (unsafe && myBook.restingSteps > 0n) {
          await sendCancelAll(rt, `requote ${ap.diff.kind} while orders are unsafe`);
        }
      }
    }
    if (triggered) {
      state.lastQuote = { index: price.index, atMs: now };
      // A Guard block does not re-arm (it would re-record every tick); a throttle or a wait does.
      if (deferred) state.dirty = true;
    }
  }

  async function sendReplaceBatch(
    rt: AccountRuntime,
    plan: RequotePlan,
    body: ReplaceBatchBody,
    creates: CreateOrderBody[],
    cancels: bigint[],
    seq: bigint,
    x: {
      mv: MarketView;
      m: EngineMarket;
      active: ActivePolicy | null;
      house: LevelBook;
      books: { id: string; book: AccountBook }[];
      myBook: AccountBook;
      policy: QuotePolicy;
      policyHash: string;
    },
  ): Promise<boolean> {
    const now = clock.now();
    const m = x.m;
    const fee = creates.length > 0 ? feeBps(rt, x.policy) : 0;
    const request: GuardRequest = {
      method: "POST",
      path: "/v2/order/replace-batch",
      body,
      builderFeeBps: fee,
    };
    const reducing = creates.length === 0;
    let input: GuardInput | null = null;
    let g: GuardResult;
    if (reducing) {
      g = checkRiskReducing({ request, profile: "AUTONOMOUS", flags: { dryRun: cfg.dryRun } });
    } else {
      const mark = decRef(m, x.mv.price?.mark);
      input = buildGuardInput(request, {
        nowMs: now,
        flags: guardFlags(),
        policy: x.active,
        market: m,
        caps: caps as MarketCaps,
        allowlist: cfg.allowlist,
        mv: x.mv,
        house: x.house,
        book: x.myBook,
        cover: deps.cover.view(rt.id),
        rt,
        others: othersFact(x.books, rt.id, mark, m, plan.governor.ok ? plan.governor.l1 : null),
        plan,
        replicaP99Bps: p99,
        rate: rateFact(rt),
        decisionSeq: seq,
        // A frozen copy: the Guard input must not change between evaluation and send.
        usedClientOrderIds: new Set(usedIds),
        stakeBound: db.account(rt.id)?.status === "active",
        lossTodayMicroUsd: rt.lossToday,
      });
      g = checkGuard(input);
    }
    const ops: DecisionOp[] = [
      ...cancels.map((id) => ({
        route: "POST /v2/order/replace-batch",
        cancelOrderId: id.toString(),
      })),
      ...creates.map((c) => ({
        route: "POST /v2/order/replace-batch",
        clientOrderId: c.client_order_id,
        side: c.side,
        priceTicks: m.tick.toUnits(c.price as string).toString(),
        sizeSteps: m.step.toUnits(c.size).toString(),
        builderBps: fee,
      })),
    ];
    const facts = {
      symbol,
      index: x.mv.price?.index.toFixed() ?? null,
      mark: x.mv.price?.mark.toFixed() ?? null,
      floorTicks: plan.governor.floor?.ticks.toString() ?? null,
      bestBid: x.house.bids[0]?.px.toString() ?? null,
      bestAsk: x.house.asks[0]?.px.toString() ?? null,
      governor: plan.governor.ok ? "ok" : plan.governor.reason,
      cover: deps.cover.view(rt.id)?.proof.hash ?? null,
      window: x.active ? `${x.active.window.windowHash}:${x.active.window.index}` : null,
    };
    const record = append({
      kind: "requote",
      policyHash: x.policyHash,
      accountId: rt.id,
      inputsDigest: hashOf(facts),
      inputsRef: null,
      ops,
      guard: guardSummary(g),
    });
    if (record.seq !== Number(seq)) {
      logger.error(
        { want: seq.toString(), got: record.seq },
        "decision seq moved: replace-batch not sent",
      );
      return false;
    }
    for (const c of creates) usedIds.add(c.client_order_id);
    if (g.decision === "blocked") {
      recordTrips(rt, g, record.seq);
      logger.warn(
        { account: rt.id, seq: record.seq, violations: g.violations.map((v) => v.rule) },
        "requote blocked by the Guard",
      );
      return false;
    }
    rt.lastReplaceBatchMs = now;
    if (g.decision === "dry-run") {
      logger.info(
        { account: rt.id, seq: record.seq, creates: creates.length, cancels: cancels.length },
        "DRY_RUN: would place",
      );
      try {
        deps.wouldPlace?.({
          tsMs: now,
          seq: record.seq,
          recordHash: record.hash,
          accountId: rt.id,
          symbol,
          ops,
          guard: g,
          facts: str({ ...facts, ladder: plan.governor.ok ? plan.governor.ladder : [] }) as Record<
            string,
            unknown
          >,
        });
      } catch (err) {
        logger.warn({ err: errText(err) }, "would-place log failed");
      }
      return true;
    }
    // execute: register every create as resting before it can reach Strike (invariant 14).
    for (const c of creates) {
      rt.reconciler.registerCreate({
        clientOrderId: c.client_order_id,
        symbol,
        side: "sell",
        size: c.size,
        price: c.price as string,
      });
      rt.pending.register(rt.id, symbol, c.client_order_id);
      createdIds.set(c.client_order_id, x.policyHash);
      try {
        db.insertOrder({
          clientOrderId: c.client_order_id,
          accountId: rt.id,
          decisionSeq: record.seq,
          policyHash: x.policyHash,
          symbol,
          side: "sell",
          reduceOnly: false,
          priceTicks: m.tick.toUnits(c.price as string).toString(),
          sizeSteps: m.step.toUnits(c.size).toString(),
          status: "pending",
          createdAtMs: now,
        });
      } catch (err) {
        logger.warn({ err: errText(err) }, "order row not recorded");
      }
    }
    const ids = creates.map((c) => c.client_order_id);
    try {
      if (reducing) {
        await guardedCancel({ request, profile: "AUTONOMOUS", flags: { dryRun: cfg.dryRun } }, () =>
          rt.ports.signer.replaceBatch(body),
        );
      } else {
        const sent = await guardedSend(input as GuardInput, () =>
          rt.ports.signer.replaceBatch(body, fee > 0 ? { builderFeeBps: fee } : {}),
        );
        if (sent.result.decision !== "execute") {
          // Impossible for a pure Guard on the same input; fail closed if it ever happens.
          rt.pending.onSendError(ids, new Error("guard changed its decision"));
          logger.error({ seq: record.seq }, "guard re-evaluation disagreed: nothing sent");
          return false;
        }
      }
    } catch (err) {
      rt.pending.onSendError(ids, err);
      logger.error({ account: rt.id, err: errText(err) }, "replace-batch failed (never resent)");
      rt.needsResync = true;
      return false;
    }
    return true;
  }

  // ---- the tick -------------------------------------------------------------------------

  let running: Promise<void> | null = null;
  const alertTicks = cfg.supervisionAlertTicks ?? 3;

  async function tickOnce(): Promise<void> {
    const now = clock.now();
    state.ticks += 1;
    state.lastTickMs = now;
    try {
      db.refreshDaemonLock(pid, now);
    } catch {}
    for (const rt of accounts) housekeeping(rt, now);
    const mv = deps.market.view(symbol);
    const m = mv.market;
    const stale = globalStale(mv);
    // Supervision ("blind sensor" doctrine): alarm on the loss of our own senses, once per streak.
    if (stale.length > 0) {
      state.blindTicks += 1;
      if (state.blindTicks === alertTicks) {
        safeNotify({
          kind: "supervision",
          source: "keeper",
          severity: "page",
          title: `blind for ${alertTicks} ticks: ${stale.join(", ")}; resting asks are cancelled`,
          symbol,
        });
      }
    } else {
      if (state.blindTicks >= alertTicks) {
        safeNotify({
          kind: "supervision",
          source: "keeper",
          severity: "info",
          title: "sight restored",
          symbol,
        });
      }
      state.blindTicks = 0;
    }
    state.stale = stale;
    const active = activePolicy(now);
    if (!m) {
      // Without market rules nothing can be valued; anything resting is cancelled.
      for (const rt of accounts) {
        const live = rt.reconciler
          .orders(symbol)
          .some((o) => o.side === "sell" && isLive(rt, o.clientOrderId));
        if (live) await sendCancelAll(rt, "stale: no usable /v2/markets rules");
      }
      kills.check();
      return;
    }
    attribute(mv);
    for (const rt of accounts) {
      await enforce(rt, mv, m, accountBook(rt, symbol, m), stale, active);
    }
    const books = accounts.map((a) => ({ id: a.id, book: accountBook(a, symbol, m) }));
    const house = houseBook(mv, m, books);
    if (!state.stopping) await requote(mv, m, active, house);
    kills.check();
  }

  async function runTick(): Promise<void> {
    if (running) return running;
    running = tickOnce()
      .catch((err) => logger.error({ err: errText(err) }, "tick crashed"))
      .finally(() => {
        running = null;
      });
    return running;
  }

  let timer: NodeJS.Timeout | null = null;
  let renewTimer: NodeJS.Timeout | null = null;
  let requested = false;
  let nextAt = 0;

  function schedule(delayMs: number): void {
    if (state.stopping) return;
    if (timer) clearTimeout(timer);
    nextAt = clock.now() + delayMs;
    timer = setTimeout(() => {
      timer = null;
      requested = false;
      const started = clock.now();
      void runTick().finally(() => {
        const spent = clock.now() - started;
        schedule(requested ? Math.max(0, minTickMs - spent) : maxIdleMs);
      });
    }, delayMs);
  }

  function requestTick(_reason: string): void {
    requested = true;
    if (!timer || state.stopping) return;
    // Self-scheduling chain (never overlapping): pull the next tick forward, never closer than
    // minTickMs to the previous one.
    const soonest = (state.lastTickMs ?? 0) + minTickMs;
    if (nextAt > Math.max(soonest, clock.now()) + 5) schedule(Math.max(0, soonest - clock.now()));
  }

  function start(): void {
    phase = "running";
    safeNotify({
      kind: "startup",
      source: "keeper",
      severity: "info",
      title: `keeper started in ${cfg.mode} mode on ${symbol}`,
    });
    schedule(0);
    renewTimer = setInterval(() => {
      void renewIfDue().catch((err) => logger.error({ err: errText(err) }, "renewal loop failed"));
    }, cfg.renewEveryMs ?? 300_000);
    renewTimer.unref();
  }

  async function stop(opts: { cancel?: boolean; waitMs?: number } = {}): Promise<void> {
    state.stopping = true;
    phase = "stopping";
    if (timer) clearTimeout(timer);
    timer = null;
    if (renewTimer) clearInterval(renewTimer);
    renewTimer = null;
    if (running) await running;
    if (opts.cancel !== false) {
      for (const rt of accounts) {
        const live = rt.reconciler
          .orders(symbol)
          .some((o) => o.side === "sell" && isLive(rt, o.clientOrderId));
        // Armed: always send one (it also clears anything our view missed). DRY_RUN: record only.
        if (live || !cfg.dryRun)
          await sendCancelAll(rt, "shutdown: cancel resting asks", "operator");
      }
      const deadline = clock.now() + (opts.waitMs ?? 5_000);
      while (kills.all().length > 0 && clock.now() < deadline) {
        kills.check();
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    safeNotify({ kind: "shutdown", source: "keeper", severity: "info", title: "keeper stopped" });
  }

  function heartbeatSnapshot() {
    return {
      mode: cfg.mode,
      state: phase,
      decisionHead: log.head(),
      accounts: accounts.map((rt) => ({
        accountId: rt.id,
        symbol,
        restingAsks: rt.reconciler
          .orders(symbol)
          .filter((o) => o.side === "sell" && isLive(rt, o.clientOrderId)).length,
        quoting: rt.allowCreates,
      })),
    };
  }

  function health(): HealthReport {
    const now = clock.now();
    const problems = [...state.stale];
    for (const rt of accounts) {
      const c = deps.cover.view(rt.id);
      if (!c || now - c.checkedAtMs > STALE.coverMs) problems.push(`${rt.id}: cover stale`);
      if (!rt.ports.streamLive()) problems.push(`${rt.id}: user stream down`);
    }
    if (state.lastTickMs === null || now - state.lastTickMs > 10_000)
      problems.push("no tick in 10 s");
    for (const k of kills.all())
      if (k.status !== "sent") problems.push(`${k.accountId}: kill ${k.status}`);
    const w = registry.activeAt(now);
    return {
      ok: problems.length === 0,
      role: "keeper",
      mode: cfg.mode,
      problems,
      decisionSeq: log.head().seq,
      policy: w ? { hash: w.policyHash, window: w.index, validUntilMs: w.validUntilMs } : null,
      openKills: kills.all().length,
    };
  }

  rehydrate();

  return {
    runTick,
    start,
    stop,
    requestTick,
    activatePolicy,
    proposePolicy,
    attachEnvelope,
    renewIfDue,
    onUserEvent,
    onUserResync,
    onCoverProof,
    heartbeatSnapshot,
    health,
    state,
    accounts,
    log,
    kills,
    registry,
  };
}
