/**
 * The watchdog (plan section 5, kill path step 3), on host B. CANCEL_ONLY by construction: its
 * module graph has no create method and no order builder (apps/watchdog/test/import-graph.test.ts),
 * its client is CancelOnlyClient, and every send goes through the Guard's exempt path
 * (`guardedCancel`: route-allowlist under CANCEL_ONLY, then dry-run).
 *
 * It fires a per-account, symbol-scoped cancel-all when the keeper's signed heartbeat is missing
 * for 10 s, when a Ballast ask (found by its `bal_` id and fingerprinted size) sits on L3 below
 * the floor or below index + 20 bps, or when cover drops; then confirms the cancel on its own
 * user stream and its own L3 view and measures cancel → L3-removal latency.
 */
import { type RefPrice, refPlusBpsCeil, refPrice } from "@ballast/core";
import { parseClientOrderId } from "@ballast/engine/client-id";
import { FINGERPRINT_MODULUS, fingerprintCode, matchOwnOrders } from "@ballast/engine/fingerprint";
import type { EvidenceDb } from "@ballast/evidence/db";
import { type GuardRequest, guardedCancel } from "@ballast/guard/exempt";
import { dec, liquidationFloor } from "@ballast/market";
import {
  type HealthReport,
  type HeartbeatMonitor,
  type KillLatency,
  KillTracker,
  type Notifier,
} from "@ballast/ops";
import {
  AccountReconciler,
  type CancelAllBody,
  decToString,
  type OpenOrdersResponse,
  type PositionsResponse,
  resyncAccount,
  type UserStreamEvent,
} from "@ballast/strike-client/cancel-only";
import {
  type AccountFacts,
  evaluateWatchdog,
  type FireDecision,
  INDEX_GUARD_BPS,
  type WatchedAsk,
} from "./rules.js";
import type { WatchdogCover, WatchdogMarket } from "./views.js";

export interface WatchdogLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface WatchdogAccountConfig {
  accountId: string;
  stakeAddress: string;
  rBps: bigint;
}

/** What the watchdog may do per account: cancel, and read its own orders and position. */
export interface CancelOnlyPort {
  cancelAll(body: CancelAllBody): Promise<unknown>;
  openOrders(symbol?: string): Promise<OpenOrdersResponse>;
  positions(symbol?: string): Promise<PositionsResponse>;
}

export interface WatchdogAccountPorts {
  cfg: WatchdogAccountConfig;
  client: CancelOnlyPort;
  streamLive(): boolean;
}

export interface WatchdogConfig {
  mode: "dry-run" | "armed";
  dryRun: boolean;
  symbol: string;
  /** No verified heartbeat for this long fires (plan: 10 s). */
  deadlineMs?: number;
  replicaP99Bps?: string;
  tickMs?: number;
  /** REST resync of each account's orders and position (the stream may be refused, D8). */
  resyncEveryMs?: number;
  reconcilerLagMs?: number;
  killRetryMs?: number;
  killEscalateMs?: number;
}

export interface WatchdogKillLog {
  accountId: string;
  rule: string;
  reason: string;
  sentAtMs: number;
  decision: string;
  latency?: KillLatency;
}

export interface WatchdogDeps {
  config: WatchdogConfig;
  market: WatchdogMarket;
  cover: WatchdogCover;
  accounts: readonly WatchdogAccountPorts[];
  monitor: HeartbeatMonitor;
  notifier: Notifier;
  logger: WatchdogLogger;
  clock: { now(): number };
  db?: EvidenceDb | null;
  killLog?: (e: WatchdogKillLog) => void;
}

interface Watched {
  ports: WatchdogAccountPorts;
  rec: AccountReconciler;
  needsResync: boolean;
  resyncing: boolean;
  lastResyncAt: number;
  l3Ids: Map<string, string>;
  /** The rule that fired in the current episode, so a persisting condition fires once. */
  episode: { rule: FireDecision["rule"]; atMs: number } | null;
}

const LIVE = new Set(["sent", "pending", "open", "untriggered", "unknown"]);

export interface Watchdog {
  tick(): Promise<FireDecision[]>;
  start(): void;
  stop(): void;
  onUserEvent(accountId: string, ev: UserStreamEvent): void;
  onUserResync(accountId: string): void;
  health(): HealthReport;
  readonly kills: KillTracker;
  readonly fired: WatchdogKillLog[];
}

export function createWatchdog(deps: WatchdogDeps): Watchdog {
  const { config: cfg, logger, clock, notifier } = deps;
  const symbol = cfg.symbol;
  const deadlineMs = cfg.deadlineMs ?? 10_000;
  const p99 = dec(cfg.replicaP99Bps ?? "0.77");
  const startedAt = clock.now();
  const fired: WatchdogKillLog[] = [];
  const watched: Watched[] = deps.accounts.map((ports) => ({
    ports,
    rec: new AccountReconciler({
      accountId: ports.cfg.accountId,
      ...(cfg.reconcilerLagMs !== undefined ? { lagMs: cfg.reconcilerLagMs } : {}),
    }),
    needsResync: true,
    resyncing: false,
    lastResyncAt: Number.NEGATIVE_INFINITY,
    l3Ids: new Map(),
    episode: null,
  }));
  const byId = new Map(watched.map((w) => [w.ports.cfg.accountId, w]));

  const notify = (a: Parameters<Notifier["notify"]>[0]) => {
    void Promise.resolve()
      .then(() => notifier.notify({ ...a, dryRun: cfg.dryRun }))
      .catch(() => {});
  };

  const kills = new KillTracker({
    now: () => clock.now(),
    ...(cfg.killRetryMs !== undefined ? { retryAfterMs: cfg.killRetryMs } : {}),
    ...(cfg.killEscalateMs !== undefined ? { escalateAfterMs: cfg.killEscalateMs } : {}),
    onConfirmed: (k, latency) => {
      if (k.dbId !== null) {
        try {
          deps.db?.confirmKill(k.dbId, {
            streamMs: k.streamConfirmedMs ?? clock.now(),
            l3Ms: k.l3ConfirmedMs ?? clock.now(),
          });
        } catch {}
      }
      const entry = fired.find((f) => f.accountId === k.accountId && f.sentAtMs === k.sentAtMs);
      if (entry) {
        entry.latency = latency;
        deps.killLog?.(entry);
      }
      logger.info({ account: k.accountId, ...latency }, "watchdog kill confirmed on stream and L3");
      notify({
        kind: "kill-confirmed",
        source: "watchdog",
        severity: "warn",
        title: `watchdog cancel-all confirmed: L3 removal +${latency.l3Ms} ms`,
        accountId: k.accountId,
        symbol,
      });
    },
    onRetry: (k) => {
      const w = byId.get(k.accountId);
      if (w) void sendCancel(w, "retry", `${k.reason} (retry)`, true);
    },
    onEscalate: (k) =>
      notify({
        kind: "kill-escalated",
        source: "watchdog",
        severity: "page",
        title: "watchdog cancel-all unconfirmed after the escalation deadline",
        detail: k.reason,
        accountId: k.accountId,
        symbol,
      }),
  });

  /** The watchdog's own order view: its stream is live, or a REST resync succeeded lately. */
  function viewHealthy(w: Watched): boolean {
    return w.ports.streamLive() || clock.now() - w.lastResyncAt <= 3 * (cfg.resyncEveryMs ?? 5_000);
  }

  function live(w: Watched) {
    return w.rec.orders(symbol).filter((o) => o.side === "sell" && LIVE.has(o.status));
  }

  /** Attribute our open orders on L3: price + exact fingerprinted size, checked against the id. */
  function attribute(): void {
    const mv = deps.market.view();
    if (!mv.book || !mv.l3Synced) return;
    const taken = new Set(watched.flatMap((w) => [...w.l3Ids.values()]));
    for (const w of watched) {
      const open = live(w);
      const ids = new Set(open.map((o) => o.clientOrderId));
      for (const k of [...w.l3Ids.keys()]) if (!ids.has(k)) w.l3Ids.delete(k);
      const expected = open
        .filter((o) => o.status === "open" && o.price && !w.l3Ids.has(o.clientOrderId))
        .filter((o) => {
          const lvl = parseClientOrderId(o.clientOrderId)?.level;
          if (lvl === undefined) return false;
          const code = fingerprintCode(w.ports.cfg.accountId, lvl);
          const size = BigInt(decToString(o.size).split(".")[0] ?? "0");
          return size % FINGERPRINT_MODULUS === code;
        })
        .map((o) => ({
          key: o.clientOrderId,
          price: o.price as string,
          size: decToString(o.size),
        }));
      if (expected.length === 0) continue;
      for (const [k, id] of matchOwnOrders(mv.book.asks, expected, taken)) {
        w.l3Ids.set(k, id);
        taken.add(id);
      }
    }
  }

  function facts(): {
    accounts: AccountFacts[];
    floorTicks: bigint | null;
    index: RefPrice | null;
  } {
    const mv = deps.market.view();
    const spec = mv.spec;
    let floorTicks: bigint | null = null;
    let index: RefPrice | null = null;
    if (spec && mv.index && mv.mark) {
      index = refPrice(spec.tick, mv.index.toFixed());
      try {
        floorTicks = liquidationFloor({
          positions: mv.positions,
          tiers: spec.tiers,
          positionsAgeMs: mv.positionsAgeMs,
          mark: mv.mark,
          replicaP99Bps: p99,
          tick: spec.tick,
        }).ticks;
      } catch {
        floorTicks = null;
      }
    }
    const minIndexPx = index ? refPlusBpsCeil(index, INDEX_GUARD_BPS) : null;
    const accounts = watched.map((w): AccountFacts => {
      const asks: WatchedAsk[] = [];
      for (const o of live(w)) {
        if (!o.price || !spec) continue;
        let px: bigint;
        try {
          px = spec.tick.toUnits(o.price);
        } catch {
          continue;
        }
        asks.push({
          clientOrderId: o.clientOrderId,
          px,
          source: w.l3Ids.has(o.clientOrderId) ? "l3" : "view",
        });
      }
      // Blind fallback, only while the watchdog's own order view is down (no live stream and no
      // recent REST resync): L3 asks carrying this account's fingerprint below the index guard.
      // A healthy view needs no guessing, and a foreign ask that happens to share a fingerprint
      // must not trigger kills while the view can say whose it is.
      if (!viewHealthy(w) && mv.book && mv.l3Synced && spec && minIndexPx !== null) {
        const mine = new Set(w.l3Ids.values());
        const codes = new Set([1, 2, 3].map((l) => fingerprintCode(w.ports.cfg.accountId, l)));
        for (const [price, queue] of mv.book.asks) {
          let px: bigint;
          try {
            px = spec.tick.toUnits(price);
          } catch {
            continue;
          }
          if (px >= minIndexPx && (floorTicks === null || px >= floorTicks)) continue;
          for (const o of queue) {
            if (mine.has(o.id)) continue;
            const size = BigInt(o.size.split(".")[0] ?? "0");
            if (codes.has(size % FINGERPRINT_MODULUS))
              asks.push({ clientOrderId: `l3:${o.id}`, px, source: "fingerprint" });
          }
        }
      }
      const exp = w.rec.exposure(symbol);
      const steps = (q: string) => (spec ? spec.step.ceilUnits(q) : 0n);
      const exposureSteps =
        steps(exp.shortQty) + steps(exp.restingAskQty) + steps(exp.unaccountedFillQty);
      const c = deps.cover.view(w.ports.cfg.accountId);
      let capacitySteps: bigint | null = null;
      if (c && spec) {
        const whole = `${c.coverBase / 1_000_000n}.${(c.coverBase % 1_000_000n).toString().padStart(6, "0")}`;
        // r is capped at 0.9 whatever the account file says (plan section 5).
        const r = w.ports.cfg.rBps < 9_000n ? w.ports.cfg.rBps : 9_000n;
        capacitySteps = (spec.step.floorUnits(whole) * r) / 10_000n;
      }
      return {
        accountId: w.ports.cfg.accountId,
        asks,
        exposureSteps,
        capacitySteps,
        coverFell: c !== null && c.prevCoverBase !== null && c.coverBase < c.prevCoverBase,
      };
    });
    return { accounts, floorTicks, index };
  }

  async function sendCancel(
    w: Watched,
    rule: string,
    reason: string,
    retry = false,
  ): Promise<void> {
    const now = clock.now();
    const accountId = w.ports.cfg.accountId;
    const body: CancelAllBody = { symbol };
    const request: GuardRequest = {
      method: "DELETE",
      path: "/v2/order/cancel-all",
      body,
      builderFeeBps: 0,
    };
    const l3At = [...w.l3Ids.values()];
    // Only when blind do fingerprint matches stand in for the order view.
    const fp = facts().accounts.find((a) => a.accountId === accountId);
    for (const a of fp?.asks ?? [])
      if (a.source === "fingerprint") l3At.push(a.clientOrderId.slice(3));
    const entry: WatchdogKillLog = { accountId, rule, reason, sentAtMs: now, decision: "pending" };
    try {
      const { result } = await guardedCancel(
        { request, profile: "CANCEL_ONLY", flags: { dryRun: cfg.dryRun } },
        () => w.ports.client.cancelAll(body),
      );
      entry.decision = result.decision;
    } catch (err) {
      entry.decision = "error";
      logger.error(
        { account: accountId, err: err instanceof Error ? err.message : String(err) },
        "watchdog cancel-all failed",
      );
    }
    w.needsResync = true;
    if (retry) return;
    fired.push(entry);
    logger.warn(
      { account: accountId, rule, reason, decision: entry.decision },
      "watchdog fired cancel-all",
    );
    notify({
      kind: "watchdog-fire",
      source: "watchdog",
      severity: "page",
      title: `watchdog cancel-all (${rule}): ${reason}`,
      accountId,
      symbol,
    });
    // A dry run is only logged. A send that threw is still tracked, so it is retried and
    // escalated like any unconfirmed kill.
    if (entry.decision !== "execute" && entry.decision !== "error") {
      deps.killLog?.(entry);
      return;
    }
    let dbId: number | null = null;
    try {
      dbId = deps.db?.insertKill({ accountId, symbol, trigger: "watchdog", sentAtMs: now }) ?? null;
    } catch {}
    kills.track({
      accountId,
      symbol,
      trigger: "watchdog",
      reason,
      sentAtMs: now,
      dbId,
      probe: {
        streamClear: () => live(w).length === 0,
        l3Clear: () => {
          const mv = deps.market.view();
          if (!mv.book || !mv.l3Synced) return false;
          const present = new Set<string>();
          for (const q of mv.book.asks.values()) for (const o of q) present.add(o.id);
          return l3At.every((id) => !present.has(id));
        },
      },
    });
  }

  async function resync(w: Watched): Promise<void> {
    const now = clock.now();
    if (w.resyncing || (!w.needsResync && now - w.lastResyncAt < (cfg.resyncEveryMs ?? 5_000)))
      return;
    w.resyncing = true;
    try {
      await resyncAccount(w.rec, w.ports.client, { symbol });
      w.needsResync = false;
      w.lastResyncAt = clock.now();
    } catch (err) {
      logger.warn(
        { account: w.ports.cfg.accountId, err: err instanceof Error ? err.message : String(err) },
        "watchdog resync failed",
      );
    } finally {
      w.resyncing = false;
    }
  }

  let warnedUnguarded = false;

  async function tick(): Promise<FireDecision[]> {
    // An armed keeper watched by a dry-run watchdog has no safety net: page once.
    if (cfg.dryRun && deps.monitor.latest()?.mode === "armed" && !warnedUnguarded) {
      warnedUnguarded = true;
      notify({
        kind: "error",
        source: "watchdog",
        severity: "page",
        title: "the keeper is ARMED but this watchdog runs in DRY_RUN: no second kill path",
        symbol,
      });
    }
    for (const w of watched) void resync(w);
    attribute();
    const hb = deps.monitor;
    const f = facts();
    const decisions = evaluateWatchdog({
      // A stalled or stopping keeper heartbeats but no longer manages its asks.
      heartbeatAlive:
        hb.alive() && (hb.latest()?.state === "running" || hb.latest()?.state === "starting"),
      armedForHeartbeat: clock.now() - startedAt >= deadlineMs,
      heartbeatAgeMs: hb.ageMs(),
      floorTicks: f.floorTicks,
      index: f.index,
      accounts: f.accounts,
    });
    const firing = new Set(decisions.map((d) => d.accountId));
    for (const w of watched) if (!firing.has(w.ports.cfg.accountId)) w.episode = null;
    for (const d of decisions) {
      const w = byId.get(d.accountId);
      if (!w || kills.pending(d.accountId, symbol)) continue;
      const acct = f.accounts.find((a) => a.accountId === d.accountId);
      const anyAsks = (acct?.asks.length ?? 0) > 0 || live(w).length > 0;
      // A persisting condition fires once per episode, and again only if asks reappear.
      if (w.episode && !anyAsks) continue;
      w.episode = { rule: d.rule, atMs: clock.now() };
      await sendCancel(w, d.rule, d.reason);
    }
    kills.check();
    return decisions;
  }

  let timer: NodeJS.Timeout | null = null;
  let busy = false;
  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (busy) return;
        busy = true;
        void tick()
          .catch((err) => logger.error({ err: String(err) }, "watchdog tick crashed"))
          .finally(() => {
            busy = false;
          });
      }, cfg.tickMs ?? 250);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    onUserEvent(accountId, ev) {
      const w = byId.get(accountId);
      if (!w) return;
      try {
        w.rec.apply(ev);
      } catch {
        w.needsResync = true;
      }
      kills.check();
    },
    onUserResync(accountId) {
      const w = byId.get(accountId);
      if (w) w.needsResync = true;
    },
    health() {
      const problems: string[] = [];
      const mv = deps.market.view();
      if (!mv.l3Synced) problems.push("watchdog L3 not synced");
      if (!mv.spec) problems.push("watchdog has no market rules: price and cover rules are off");
      if (mv.indexAgeMs > 3_000) problems.push("watchdog index stale");
      if (!deps.monitor.alive()) problems.push("keeper heartbeat missing");
      if (cfg.dryRun && deps.monitor.latest()?.mode === "armed") {
        problems.push("keeper armed, watchdog in DRY_RUN");
      }
      for (const w of watched)
        if (!w.ports.streamLive()) problems.push(`${w.ports.cfg.accountId}: watchdog stream down`);
      return {
        ok: problems.length === 0,
        role: "watchdog",
        mode: cfg.mode,
        problems,
        fired: fired.length,
      };
    },
    kills,
    fired,
  };
}
