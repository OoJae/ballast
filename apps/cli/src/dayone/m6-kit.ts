/**
 * Shared machinery for the M6 day-one scripts (D1, D2, D3, D6, D7, D8, D10; plan section 11).
 *
 * SAFETY CONTRACT (every script):
 * - `--dry-run` is the default. A dry run prints the exact plan and the pass condition, builds
 *   the exact request bodies it would send, writes them as evidence under data/dayone/, and makes
 *   no network call at all (no fetch, no socket).
 * - `--live` runs the procedure. It refuses unless the operator also passes `--yes-i-approve`
 *   and `--eligible-host` (HOSTING RULE: this host is not in a Strike-restricted jurisdiction,
 *   strikefinance.org/restricted; never via a VPN or proxy), and, for anything touching mainnet
 *   (Strike or Cardano), BALLAST_ARM=1 in the environment.
 * - Hosts are fixed per script (mainnet `api.strikefinance.org`, testnet
 *   `api-v2-testnet.strikefinance.org`). The only override accepted is a loopback address,
 *   which is how the tests run the live procedures against @ballast/fake-strike.
 * - Keys come from sealed key files under the host KEK; they are never printed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maxBigint } from "@ballast/core";
import { type EngineMarket, engineMarket, type StrikeMarketRules } from "@ballast/engine";
import { HostKek, openSealedKey, readSealedKey } from "@ballast/governance";
import { type Dec, dec, liquidationFloor } from "@ballast/market";
import {
  ApiWalletSigner,
  apiTimeSource,
  type CreateOrderBody,
  createPublicHttp,
  createPublicReads,
  limitOrder,
  type PublicHttp,
  type PublicReads,
  RateLimiter,
  ServerClock,
  SignedClient,
  UserStream,
  type UserStreamEvent,
} from "@ballast/strike-client";

export type DayOneNetwork = "strike-testnet" | "strike-mainnet" | "cardano-mainnet-read-only";

export interface DayOnePlan {
  id: "D1" | "D2" | "D3" | "D6" | "D7" | "D8" | "D9a" | "D10";
  title: string;
  network: DayOneNetwork;
  /** What the operator must have ready (accounts, funds, a probe, an Ogmios URL...). */
  prerequisites: string[];
  /** The exact procedure, in order. */
  steps: string[];
  /** The pass condition, as plan section 11 states it. */
  pass: string;
  /** What to do if it fails (section 11's fallback). */
  fallback: string;
  /** Rough cost and exposure of a live run. */
  exposure: string;
  /** Extra flags the script accepts. */
  options?: Record<string, string>;
}

export const HOSTS = {
  "strike-mainnet": { api: "https://api.strikefinance.org", ws: "wss://api.strikefinance.org" },
  // VERIFY: the testnet WebSocket origin is assumed to mirror the REST host (FRICTION 2026-10-23).
  "strike-testnet": {
    api: "https://api-v2-testnet.strikefinance.org",
    ws: "wss://api-v2-testnet.strikefinance.org",
  },
} as const;

export interface DayOneArgs {
  live: boolean;
  approve: boolean;
  eligibleHost: boolean;
  outDir: string;
  opts: Record<string, string>;
}

const BASE_FLAGS = new Set(["--dry-run", "--live", "--yes-i-approve", "--eligible-host"]);

/** Strict flag parsing: unknown flags fail; `--name value` for options. */
export function parseDayOneArgs(argv: readonly string[], plan: DayOnePlan): DayOneArgs {
  const args: DayOneArgs = {
    live: false,
    approve: false,
    eligibleHost: false,
    outDir: "data/dayone",
    opts: {},
  };
  let dry = false;
  const allowed = new Set(["--out", ...Object.keys(plan.options ?? {})]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") continue;
    if (BASE_FLAGS.has(a)) {
      if (a === "--dry-run") dry = true;
      if (a === "--live") args.live = true;
      if (a === "--yes-i-approve") args.approve = true;
      if (a === "--eligible-host") args.eligibleHost = true;
      continue;
    }
    if (!allowed.has(a)) throw new Error(`${plan.id}: unknown argument ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${plan.id}: ${a} needs a value`);
    i += 1;
    if (a === "--out") args.outDir = v;
    else args.opts[a.slice(2)] = v;
  }
  if (dry && args.live) throw new Error(`${plan.id}: choose --dry-run or --live, not both`);
  return args;
}

export const touchesMainnet = (p: DayOnePlan) => p.network !== "strike-testnet";

/** Refuses a live run unless every switch the plan needs is set; names what is missing. */
export function assertLiveAllowed(
  plan: DayOnePlan,
  args: DayOneArgs,
  env: NodeJS.ProcessEnv,
): void {
  if (!args.live) return;
  const missing: string[] = [];
  if (!args.approve) missing.push("--yes-i-approve");
  if (!args.eligibleHost) missing.push("--eligible-host (hosting-rule attestation)");
  if (touchesMainnet(plan) && env.BALLAST_ARM !== "1") missing.push("BALLAST_ARM=1");
  if (missing.length > 0) {
    throw new Error(
      `${plan.id} --live refused: missing ${missing.join(", ")}. A live run ${
        touchesMainnet(plan) ? "touches mainnet" : "signs testnet requests"
      }; present the plan to a human and get an explicit go-ahead first.`,
    );
  }
}

/** Fixed hosts; a loopback override exists only so tests can drive the fake Strike. */
export function hostsFor(plan: DayOnePlan, env: NodeJS.ProcessEnv): { api: string; ws: string } {
  if (plan.network === "cardano-mainnet-read-only") return { api: "", ws: "" };
  const fixed = HOSTS[plan.network];
  const api = env.BALLAST_DAYONE_API_URL;
  const ws = env.BALLAST_DAYONE_WS_URL;
  if (api === undefined && ws === undefined) return { api: fixed.api, ws: fixed.ws };
  const loopback = (u: string | undefined) => {
    try {
      const h = new URL(u ?? "").hostname;
      return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
    } catch {
      return false;
    }
  };
  if (!loopback(api) || !loopback(ws)) {
    throw new Error("BALLAST_DAYONE_API_URL/WS_URL may only point at a loopback test server");
  }
  return { api: api as string, ws: ws as string };
}

export function renderPlan(plan: DayOnePlan, mode: "dry-run" | "live"): string {
  const lines = [
    `${plan.id}: ${plan.title}`,
    `mode: ${mode.toUpperCase()}   network: ${plan.network}`,
    "",
    "prerequisites:",
    ...plan.prerequisites.map((p) => `  - ${p}`),
    "",
    "plan:",
    ...plan.steps.map((s, i) => `  ${i + 1}. ${s}`),
    "",
    `PASS CONDITION: ${plan.pass}`,
    `fallback: ${plan.fallback}`,
    `exposure: ${plan.exposure}`,
  ];
  if (plan.options) {
    lines.push("", "options:", ...Object.entries(plan.options).map(([k, v]) => `  ${k}: ${v}`));
  }
  if (mode === "dry-run") {
    lines.push(
      "",
      `DRY RUN: nothing was sent. To run it: --live --yes-i-approve --eligible-host${
        touchesMainnet(plan) ? " with BALLAST_ARM=1" : ""
      }, after a human go-ahead.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const jsonSafe = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

/** data/dayone/<id>-<mode>-<UTC stamp>.json */
export function writeEvidence(
  outDir: string,
  plan: DayOnePlan,
  mode: "dry-run" | "live",
  body: Record<string, unknown>,
  nowMs = Date.now(),
): string {
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date(nowMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const path = join(outDir, `${plan.id.toLowerCase()}-${mode}-${stamp}.json`);
  writeFileSync(
    path,
    `${jsonSafe({ id: plan.id, title: plan.title, mode, network: plan.network, pass: plan.pass, atMs: nowMs, ...body })}\n`,
  );
  return path;
}

// ---- live plumbing --------------------------------------------------------------------------

export interface StreamTap {
  events: { ev: UserStreamEvent; atMs: number }[];
  /** The first event (already seen or arriving) matching `pred`, or null after `timeoutMs`. */
  waitFor(
    pred: (ev: UserStreamEvent) => boolean,
    timeoutMs: number,
  ): Promise<UserStreamEvent | null>;
  stop(): void;
}

export interface LiveContext {
  api: string;
  ws: string;
  userAgent: string;
  http: PublicHttp;
  reads: PublicReads;
  clock: ServerClock;
  rate: RateLimiter;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /** An API wallet from a sealed StrikeKey file (host KEK from BALLAST_KEK_PATH). */
  signer(keyFile: string): ApiWalletSigner;
  client(
    signer: ApiWalletSigner,
    accountId: string,
    builderFeeCapBps?: number,
    fetchImpl?: typeof fetch,
  ): SignedClient;
  tap(signer: ApiWalletSigner, accountId: string): Promise<StreamTap>;
  close(): void;
}

export async function liveContext(
  plan: DayOnePlan,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): Promise<LiveContext> {
  const { api, ws } = hostsFor(plan, env);
  const userAgent = `ballast-dayone/${plan.id.toLowerCase()}`;
  const http = createPublicHttp({ baseUrl: api, userAgent });
  const clock = new ServerClock({ fetchServerTimeMs: apiTimeSource(http) });
  // A Cardano-only plan (D10) never talks to Strike: no clock, no keys.
  if (api) await clock.sync();
  const rate = new RateLimiter();
  const taps: StreamTap[] = [];
  let kek: HostKek | null = null;
  return {
    api,
    ws,
    userAgent,
    http,
    reads: createPublicReads(http),
    clock,
    rate,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
    signer(keyFile) {
      kek ??= HostKek.load(env.BALLAST_KEK_PATH ?? "data/keys/host.kek");
      const key = openSealedKey(readSealedKey(keyFile), kek, "strike");
      return key.useSeed((seed) => ApiWalletSigner.fromSeed(seed));
    },
    client(signer, accountId, builderFeeCapBps, fetchImpl) {
      return new SignedClient({
        baseUrl: api,
        userAgent,
        signer,
        clock,
        profile: "AUTONOMOUS",
        rate,
        account: accountId,
        ...(builderFeeCapBps !== undefined ? { builderFee: { capBps: builderFeeCapBps } } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
    },
    async tap(signer, accountId) {
      const events: StreamTap["events"] = [];
      const waiters = new Set<{
        pred: (e: UserStreamEvent) => boolean;
        resolve: (e: UserStreamEvent | null) => void;
      }>();
      let live: () => void = () => {};
      const ready = new Promise<void>((r) => {
        live = r;
      });
      const stream = new UserStream({
        url: `${ws}/ws/user-api`,
        userAgent,
        signer,
        clock,
        expectedAccountId: accountId,
        onEvent: (ev) => {
          events.push({ ev, atMs: Date.now() });
          for (const w of waiters) {
            if (w.pred(ev)) {
              waiters.delete(w);
              w.resolve(ev);
            }
          }
        },
        onResyncNeeded: () => live(),
      });
      stream.start();
      await Promise.race([ready, new Promise((r) => setTimeout(r, 15_000))]);
      if (!stream.live) throw new Error("user stream did not go live within 15 s");
      const t: StreamTap = {
        events,
        waitFor(pred, timeoutMs) {
          const hit = events.find((e) => pred(e.ev));
          if (hit) return Promise.resolve(hit.ev);
          return new Promise((resolve) => {
            const w = { pred, resolve };
            waiters.add(w);
            setTimeout(() => {
              if (waiters.delete(w)) resolve(null);
            }, timeoutMs).unref();
          });
        },
        stop: () => stream.stop(),
      };
      taps.push(t);
      return t;
    },
    close() {
      for (const t of taps) t.stop();
      clock.stop();
    },
  };
}

export const isOrderEvent = (cid: string, status?: string) => (ev: UserStreamEvent) =>
  (ev.kind === "order" || ev.kind === "fill") &&
  ev.data.c === cid &&
  (status === undefined || ev.data.X === status);

/** `bal_` ids for probes: unique, clearly tagged, and never a keeper ladder id. */
export function probeId(tag: string, n: number, nowMs = Date.now()): string {
  return `bal_${tag}_${nowMs.toString(36)}_${n.toString(36)}`;
}

export interface RunResult {
  evidencePath: string;
  pass: boolean | null;
}

/**
 * The script driver: print the plan; on a dry run, build the would-send evidence (no network);
 * on a live run, check every gate, run, and record the outcome. Never swallows a failure.
 */
export async function runDayOne(
  plan: DayOnePlan,
  hooks: {
    dryRun: (args: DayOneArgs) => Record<string, unknown> | Promise<Record<string, unknown>>;
    live: (
      ctx: LiveContext,
      args: DayOneArgs,
    ) => Promise<{ pass: boolean; evidence: Record<string, unknown> }>;
  },
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  out: (s: string) => void = (s) => process.stdout.write(s),
): Promise<RunResult> {
  const args = parseDayOneArgs(argv, plan);
  out(renderPlan(plan, args.live ? "live" : "dry-run"));
  if (!args.live) {
    const evidencePath = writeEvidence(args.outDir, plan, "dry-run", {
      wouldSend: await hooks.dryRun(args),
      opts: args.opts,
    });
    out(`evidence: ${evidencePath}\n`);
    return { evidencePath, pass: null };
  }
  assertLiveAllowed(plan, args, env);
  const lines: string[] = [];
  const log = (l: string) => {
    lines.push(l);
    out(`${l}\n`);
  };
  const ctx = await liveContext(plan, env, log);
  try {
    const r = await hooks.live(ctx, args);
    const evidencePath = writeEvidence(args.outDir, plan, "live", {
      pass: r.pass,
      log: lines,
      ...r.evidence,
      opts: args.opts,
    });
    out(`${r.pass ? "PASS" : "FAIL"}: ${plan.pass}\nevidence: ${evidencePath}\n`);
    return { evidencePath, pass: r.pass };
  } finally {
    ctx.close();
  }
}

// ---- NIGHT-USD facts for the mainnet probes ---------------------------------------------------

export interface NightState {
  market: EngineMarket;
  mark: Dec;
  index: Dec;
  /** The liquidation-aware floor F in ticks (0 when no live long sets one). */
  floorTicks: bigint;
  floorBinding: string;
  positionsAgeMs: number;
  bestBidTicks: bigint | null;
  bestAskTicks: bigint | null;
}

/** Rules, mark, index, floor and top of book, from public reads only. */
export async function nightState(ctx: LiveContext, symbol = "NIGHT-USD"): Promise<NightState> {
  const { markets } = await ctx.reads.markets();
  const rules = markets[symbol];
  if (!rules) throw new Error(`${symbol} is not listed`);
  const market = engineMarket(rules as StrikeMarketRules);
  const pi = await ctx.reads.premiumIndex(symbol);
  const mark = dec(pi.markPrice);
  const index = dec(pi.indexPrice);
  const lp = await ctx.reads.livePositions();
  const positionsAgeMs = ctx.now() - Number(lp.updated_at);
  const floor = liquidationFloor({
    positions: (lp.positions ?? [])
      .filter((p) => p.symbol === symbol)
      .map((p) => ({
        size: p.size,
        entryPrice: p.entry_price,
        markPrice: p.mark_price,
        liquidationPrice: p.liquidation_price,
      })),
    tiers: market.spec.tiers,
    positionsAgeMs,
    mark,
    replicaP99Bps: dec("0.77"),
    tick: market.tick,
  });
  const snap = await ctx.reads.l3Snapshot(symbol);
  const top = (lv: { price: string }[]) => (lv[0] ? market.tick.toUnits(lv[0].price) : null);
  return {
    market,
    mark,
    index,
    floorTicks: floor.ticks,
    floorBinding: floor.binding,
    positionsAgeMs,
    bestBidTicks: top(snap.bids),
    bestAskTicks: top(snap.asks),
  };
}

/** The largest of some tick prices (bigint has no Math.max). */
export function maxTicks(...xs: bigint[]): bigint {
  return xs.reduce(maxBigint);
}

/** ceil(mark × (1 + bps)) in ticks. */
export function markPlusBps(s: NightState, bps: number): bigint {
  return s.market.tick.ceilUnits(s.mark.times(dec(10_000 + bps)).div(10_000));
}

/** A ≈ $10.5 post-only ask at `pxTicks` (above Strike's $10 minimum, as Ballast's own rule). */
export function tenDollarAsk(m: EngineMarket, cid: string, pxTicks: bigint): CreateOrderBody {
  const px = m.tick.fromUnits(pxTicks);
  const size = m.step.fromUnits(m.step.ceilUnits(dec("10.5").div(px))).toFixed();
  return limitOrder({
    clientOrderId: cid,
    symbol: m.symbol,
    side: "sell",
    size,
    price: px.toFixed(),
    postOnly: true,
  });
}

export function requireOpt(args: DayOneArgs, name: string, plan: DayOnePlan): string {
  const v = args.opts[name];
  if (v === undefined) throw new Error(`${plan.id}: --${name} is required for a live run`);
  return v;
}
