/**
 * `pnpm watchdog [--mainnet]` on host B. CANCEL_ONLY: the only writes this process can make are
 * symbol-scoped cancel-alls (and the per-order cancel route the profile also admits).
 *
 * HOSTING RULE: run only on a host outside Strike's restricted jurisdictions
 * (strikefinance.org/restricted), never through a VPN or proxy; it signs Strike requests.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { bindableStake, CoverOracle, KoiosClient, loadCoverConfig } from "@ballast/cover";
import { openEvidenceDb } from "@ballast/evidence/db";
import { HostKek, openSealedKey, readSealedKey } from "@ballast/governance";
import {
  createDeadMan,
  createTelegramNotifier,
  HeartbeatMonitor,
  safeNotifier,
  startHealthServer,
  startHeartbeatReceiver,
} from "@ballast/ops";
import {
  ApiWalletSigner,
  apiTimeSource,
  CancelOnlyClient,
  createPublicHttp,
  createPublicReads,
  RateLimiter,
  ServerClock,
  UserStream,
} from "@ballast/strike-client/cancel-only";
import pino from "pino";
import { loadWatchdogConfig, parseWatchdogAccounts } from "./config.js";
import { LiveWatchdogCover, LiveWatchdogMarket } from "./views.js";
import { createWatchdog, type Watchdog, type WatchdogAccountPorts } from "./watchdog.js";

async function main(): Promise<void> {
  const cfg = loadWatchdogConfig(process.env, process.argv.slice(2));
  const coverCfg = loadCoverConfig(process.env);
  const logger = pino({ level: cfg.logLevel, base: { app: "watchdog" } });
  logger.info(
    { mode: cfg.mode, symbol: cfg.symbol, daemons: cfg.trustedDaemons.length },
    "watchdog starting",
  );

  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const db = openEvidenceDb(cfg.dbPath);
  const http = createPublicHttp({ baseUrl: cfg.apiUrl, userAgent: cfg.userAgent });
  const reads = createPublicReads(http);
  const entries = cfg.accountsFile
    ? parseWatchdogAccounts(JSON.parse(readFileSync(cfg.accountsFile, "utf8")))
    : [];
  const clock = new ServerClock({ fetchServerTimeMs: apiTimeSource(http) });
  if (entries.length > 0) {
    await clock.sync();
    clock.start();
  }
  const kek = entries.length > 0 ? HostKek.load(cfg.kekPath) : null;
  const rate = new RateLimiter();
  let wd: Watchdog | null = null;
  const streams: UserStream[] = [];
  const ports: WatchdogAccountPorts[] = entries.map((a) => {
    const key = openSealedKey(readSealedKey(a.strikeKeyFile), kek as HostKek, "strike");
    const signer = key.useSeed((seed) => ApiWalletSigner.fromSeed(seed));
    const client = new CancelOnlyClient({
      baseUrl: cfg.apiUrl,
      userAgent: cfg.userAgent,
      signer,
      clock,
      rate,
      account: a.accountId,
    });
    // VERIFY: D8 — whether Strike accepts a second /ws/user-api logon for the same key while
    // the keeper holds one; the watchdog falls back to REST resyncs every 5 s (FRICTION).
    const stream = new UserStream({
      url: `${cfg.wsOrigin}/ws/user-api`,
      userAgent: cfg.userAgent,
      signer,
      clock,
      expectedAccountId: a.accountId,
      onEvent: (ev) => wd?.onUserEvent(a.accountId, ev),
      onResyncNeeded: () => wd?.onUserResync(a.accountId),
    });
    streams.push(stream);
    return {
      cfg: {
        accountId: a.accountId,
        stakeAddress: bindableStake(a.stakeAddress),
        rBps: BigInt(a.rBps),
      },
      client,
      streamLive: () => stream.live,
    };
  });

  const market = new LiveWatchdogMarket({
    wsOrigin: cfg.wsOrigin,
    userAgent: cfg.userAgent,
    symbol: cfg.symbol,
    reads,
    logger,
  });
  const koios = new KoiosClient({
    baseUrl: coverCfg.koiosUrl,
    ...(coverCfg.koiosToken ? { token: coverCfg.koiosToken } : {}),
  });
  const cover = new LiveWatchdogCover({
    oracle: new CoverOracle(koios),
    subjects: ports.map((p) => ({ accountId: p.cfg.accountId, stakeAddress: p.cfg.stakeAddress })),
    onError: (id, err) => logger.warn({ account: id, err }, "watchdog cover read failed"),
  });
  const monitor = new HeartbeatMonitor({
    trustedDaemons: cfg.trustedDaemons,
    deadlineMs: cfg.heartbeat.deadlineMs,
  });
  const receiver = await startHeartbeatReceiver({
    monitor,
    host: cfg.heartbeat.host,
    port: cfg.heartbeat.port,
    onVerdict: (v) => {
      if (!v.ok) logger.warn({ reason: v.reason }, "heartbeat refused");
    },
  });
  const secrets = [cfg.telegram.botToken, coverCfg.koiosToken].filter((s): s is string => !!s);
  const notifier = safeNotifier(
    createTelegramNotifier({ ...cfg.telegram, logger, secrets }),
    logger,
  );
  mkdirSync(dirname(cfg.killLog), { recursive: true });

  wd = createWatchdog({
    config: {
      mode: cfg.mode,
      dryRun: cfg.dryRun,
      symbol: cfg.symbol,
      deadlineMs: cfg.heartbeat.deadlineMs,
      replicaP99Bps: cfg.replicaP99Bps,
    },
    market,
    cover,
    accounts: ports,
    monitor,
    notifier,
    logger,
    clock: { now: () => Date.now() },
    db,
    killLog: (e) => appendFileSync(cfg.killLog, `${JSON.stringify(e)}\n`),
  });
  const health = await startHealthServer({
    report: () => (wd as Watchdog).health(),
    ...cfg.health,
  });
  const deadman = createDeadMan({ ...(cfg.deadmanUrl ? { url: cfg.deadmanUrl } : {}) });
  const dm = setInterval(() => void deadman.ping((wd as Watchdog).health().ok), 30_000);
  dm.unref();

  market.start();
  cover.start();
  for (const s of streams) s.start();
  wd.start();
  logger.info({ heartbeat: receiver.url, health: health.url }, "watchdog running");

  const shutdown = async (sig: string) => {
    logger.warn({ sig }, "watchdog stopping (it never cancels on its own shutdown)");
    wd?.stop();
    clearInterval(dm);
    for (const s of streams) s.stop();
    cover.stop();
    market.stop();
    clock.stop();
    await receiver.close();
    await health.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
