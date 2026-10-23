/**
 * A real watchdog (createWatchdog + its own L3/index view + CancelOnlyClient + UserStream)
 * beside a real keeper (apps/keeper/test/harness.ts), both against one fake Strike, with the
 * keeper's signed heartbeats pushed over HTTP to the watchdog's receiver.
 *
 * Test-only difference from production: the watchdog signs with a second API key registered on
 * the same fake account, because @ballast/strike-client allows one UserStream per key per
 * process and both daemons share this test process. In production they are separate hosts and
 * the watchdog uses the same key (plan section 5); whether Strike accepts a second socket for one
 * key is D8's question (FRICTION 2026-10-23).
 */
import { randomBytes } from "node:crypto";
import { type EvidenceDb, openEvidenceDb } from "@ballast/evidence/db";
import {
  HeartbeatMonitor,
  HeartbeatPublisher,
  type HeartbeatReceiver,
  httpHeartbeatSink,
  startHeartbeatReceiver,
} from "@ballast/ops";
import {
  ApiWalletSigner,
  CancelOnlyClient,
  createPublicHttp,
  createPublicReads,
  RateLimiter,
  UserStream,
} from "@ballast/strike-client/cancel-only";
import {
  captureNotifier,
  daemonKey,
  type KeeperHarness,
  SYMBOL,
  silentLogger,
  UA,
} from "../../keeper/test/harness.js";
import { LiveWatchdogCover, LiveWatchdogMarket } from "../src/views.js";
import {
  createWatchdog,
  type Watchdog,
  type WatchdogConfig,
  type WatchdogKillLog,
} from "../src/watchdog.js";

export interface WatchdogHarness {
  wd: Watchdog;
  monitor: HeartbeatMonitor;
  receiver: HeartbeatReceiver;
  heartbeat: HeartbeatPublisher;
  market: LiveWatchdogMarket;
  cover: LiveWatchdogCover;
  streams: UserStream[];
  keys: ApiWalletSigner[];
  db: EvidenceDb;
  killLog: WatchdogKillLog[];
  notifier: ReturnType<typeof captureNotifier>;
  /** Simulates a keeper crash: no more heartbeats, no more ticks, its sockets close. */
  crashKeeper(): Promise<void>;
  stop(): Promise<void>;
}

export async function startWatchdog(
  h: KeeperHarness,
  config: Partial<WatchdogConfig> = {},
): Promise<WatchdogHarness> {
  const fake = h.fake;
  const http = createPublicHttp({ baseUrl: fake.baseUrl, userAgent: UA, maxRetries: 0 });
  const logger = silentLogger();
  const monitor = new HeartbeatMonitor({
    trustedDaemons: [daemonKey.publicKeyHex],
    deadlineMs: config.deadlineMs ?? 2_000,
  });
  const receiver = await startHeartbeatReceiver({ monitor });
  const heartbeat = new HeartbeatPublisher({
    key: daemonKey,
    sink: httpHeartbeatSink([receiver.url]),
    snapshot: () => h.daemon.heartbeatSnapshot(),
    intervalMs: 200,
  });
  let wd: Watchdog | null = null;
  const market = new LiveWatchdogMarket({
    wsOrigin: fake.wsOrigin,
    userAgent: UA,
    symbol: SYMBOL,
    reads: createPublicReads(http),
    logger,
    pollEveryMs: 1_000,
    rebuildCooldownMs: 0,
  });
  const keys: ApiWalletSigner[] = [];
  const streams: UserStream[] = [];
  const rate = new RateLimiter();
  const accounts = h.accounts.map((a) => {
    const key = ApiWalletSigner.fromSeed(randomBytes(32));
    const acct = fake.engine.accounts.get(a.id);
    if (!acct) throw new Error(`no fake account ${a.id}`);
    fake.engine.accountsByKey.set(key.publicKeyHex, acct);
    keys.push(key);
    const client = new CancelOnlyClient({
      baseUrl: fake.baseUrl,
      userAgent: UA,
      signer: key,
      clock: h.clock,
      rate,
      account: a.id,
      sleep: async () => {},
      maxGetRetries: 0,
    });
    const stream = new UserStream({
      url: fake.wsUrl,
      userAgent: UA,
      signer: key,
      clock: h.clock,
      expectedAccountId: a.id,
      maxBackoffMs: 200,
      onEvent: (ev) => wd?.onUserEvent(a.id, ev),
      onResyncNeeded: () => wd?.onUserResync(a.id),
    });
    streams.push(stream);
    return {
      cfg: { accountId: a.id, stakeAddress: a.cfg.stakeAddress, rBps: a.cfg.rBps },
      client,
      streamLive: () => stream.live,
    };
  });
  // The watchdog reads cover through the same oracle interface as production; here the "chain"
  // is the keeper harness's synthetic proofs.
  const cover = new LiveWatchdogCover({
    oracle: {
      proof: async (subject) => {
        const a = h.accounts.find(
          (x) => subject.kind === "stake" && x.cfg.stakeAddress === subject.stakeAddress,
        );
        const st = a ? h.cover.view(a.id) : null;
        if (!st) throw new Error("no cover yet");
        return st.proof;
      },
    },
    subjects: accounts.map((a) => ({
      accountId: a.cfg.accountId,
      stakeAddress: a.cfg.stakeAddress,
    })),
    everyMs: 150,
  });
  const db = openEvidenceDb(":memory:");
  const killLog: WatchdogKillLog[] = [];
  const notifier = captureNotifier();
  wd = createWatchdog({
    config: {
      mode: "armed",
      dryRun: false,
      symbol: SYMBOL,
      deadlineMs: 2_000,
      tickMs: 100,
      resyncEveryMs: 500,
      reconcilerLagMs: 30,
      killRetryMs: 1_500,
      killEscalateMs: 3_000,
      ...config,
    },
    market,
    cover,
    accounts,
    monitor,
    notifier,
    logger,
    clock: { now: () => Date.now() },
    db,
    killLog: (e) => killLog.push(e),
  });
  market.start();
  cover.start();
  for (const s of streams) s.start();
  heartbeat.start();
  const w = wd;
  let crashed = false;
  return {
    wd: w,
    monitor,
    receiver,
    heartbeat,
    market,
    cover,
    streams,
    keys,
    db,
    killLog,
    notifier,
    async crashKeeper() {
      crashed = true;
      heartbeat.stop();
      await h.daemon.stop({ cancel: false });
      for (const a of h.accounts) a.stream.stop();
    },
    async stop() {
      if (!crashed) heartbeat.stop();
      w.stop();
      for (const s of streams) s.stop();
      cover.stop();
      market.stop();
      await receiver.close();
      db.close();
    },
  };
}

/** Requests the fake received from one API key. */
export function requestsBy(h: KeeperHarness, publicKeyHex: string) {
  return h.fake.requests.filter((r) => r.headers["x-api-wallet-public-key"] === publicKeyHex);
}
