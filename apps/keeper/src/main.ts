/**
 * `pnpm keeper [--mainnet]`: wires the real components into createDaemon and runs it.
 *
 * Startup order is fail-closed: config refusals (half-armed, hosting attestation) → evidence DB
 * and the single-instance lock → keys (sealed under the host KEK) → clock sync → market state,
 * cover oracle, user streams → policies → the loop. A crash anywhere before the loop starts
 * leaves nothing resting, because nothing has been sent.
 *
 * HOSTING RULE: run this only on a host outside Strike's restricted jurisdictions
 * (strikefinance.org/restricted); it signs Strike requests. Never through a VPN or proxy.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { QuotePolicy } from "@ballast/core";
import {
  bindableStake,
  CoverOracle,
  KoiosClient,
  loadCoverConfig,
  OgmiosMempoolStub,
} from "@ballast/cover";
import { acquireDaemonLockOrThrow, openEvidenceDb } from "@ballast/evidence/db";
import {
  type CriticReport,
  HostKek,
  openSealedKey,
  readSealedKey,
  type SignedPolicy,
  type SignedRenewalEnvelope,
} from "@ballast/governance";
import {
  createDeadMan,
  createTelegramNotifier,
  fileHeartbeatSink,
  HeartbeatPublisher,
  type HeartbeatSink,
  httpHeartbeatSink,
  multiSink,
  safeNotifier,
  startHealthServer,
} from "@ballast/ops";
import { createSimCriticRunner } from "@ballast/sim";
import {
  ApiWalletSigner,
  apiTimeSource,
  createPublicHttp,
  createPublicReads,
  RateLimiter,
  ServerClock,
  SignedClient,
  UserStream,
} from "@ballast/strike-client";
import pino from "pino";
import type { AccountPorts } from "./account.js";
import { loadAccountsFile } from "./accounts-file.js";
import { describeKeeperConfig, loadKeeperConfig } from "./config.js";
import { CoverWatch } from "./cover-watch.js";
import {
  createDaemon,
  type DaemonLogger,
  type KeeperDaemon,
  type WouldPlaceEntry,
} from "./daemon.js";
import { LiveMarketState } from "./market-state.js";

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/** Signed policies, Critic reports and renewal envelopes the operator dropped in a directory. */
function readPolicyDir(dir: string) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
  const policies = files
    .filter((f) => f.endsWith(".policy.json"))
    .map((f) => read(f) as SignedPolicy<QuotePolicy>);
  const reports = files
    .filter((f) => f.endsWith(".critic.json"))
    .map((f) => read(f) as CriticReport);
  const envelopes = files
    .filter((f) => f.endsWith(".envelope.json"))
    .map((f) => read(f) as SignedRenewalEnvelope);
  return { policies, reports, envelopes };
}

async function main(): Promise<void> {
  const cfg = loadKeeperConfig(process.env, process.argv.slice(2));
  const coverCfg = loadCoverConfig(process.env);
  const secrets = [cfg.telegram.botToken, coverCfg.koiosToken].filter((s): s is string => !!s);
  const logger = pino({
    level: cfg.logLevel,
    base: { app: "keeper" },
    redact: { paths: ["*.seed", "*.secret", "*.token", "*.apiKey"], censor: "[redacted]" },
  }) as unknown as DaemonLogger;
  logger.info(describeKeeperConfig(cfg), `keeper starting (${cfg.mode})`);

  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const db = openEvidenceDb(cfg.dbPath);
  acquireDaemonLockOrThrow(db, process.pid, Date.now(), 15_000);
  const orphans = db.reconcileOrphanedPending(Date.now());
  if (orphans > 0)
    logger.warn({ orphans }, "creates stranded as pending by a crash are now unknown");

  const kek = HostKek.load(cfg.kekPath);
  const daemonKey = openSealedKey(readSealedKey(cfg.daemonKeyFile), kek, "daemon");
  const entries = cfg.accountsFile ? loadAccountsFile(cfg.accountsFile) : [];

  for (const a of entries) {
    const stake = bindableStake(a.stakeAddress);
    const row = db.account(a.accountId);
    if (!row) {
      db.bindAccount({
        accountId: a.accountId,
        stakeCred: stake,
        rBps: Number(a.rBps),
        nowMs: Date.now(),
        ...(a.label ? { label: a.label } : {}),
      });
      db.setAccountStatus(a.accountId, "active", null, Date.now());
    } else if (row.stakeCred !== stake) {
      throw new Error(`account ${a.accountId} is bound to another stake credential`);
    }
  }

  const http = createPublicHttp({ baseUrl: cfg.apiUrl, userAgent: cfg.userAgent });
  const reads = createPublicReads(http);
  const clock = new ServerClock({
    fetchServerTimeMs: apiTimeSource(http),
    onError: (err) => logger.warn({ err: String(err) }, "clock resync failed"),
  });
  if (entries.length > 0) {
    await clock.sync();
    clock.start();
  }
  const rate = new RateLimiter();
  let daemon: KeeperDaemon | null = null;

  const market = new LiveMarketState({
    wsOrigin: cfg.wsOrigin,
    userAgent: cfg.userAgent,
    symbols: cfg.symbols,
    reads,
    logger,
    onChange: () => daemon?.requestTick("market"),
  });

  const streams: UserStream[] = [];
  const ports: AccountPorts[] = entries.map((a) => {
    const strikeKey = openSealedKey(readSealedKey(a.strikeKeyFile), kek, "strike");
    const signer = strikeKey.useSeed((seed) => ApiWalletSigner.fromSeed(seed));
    const client = new SignedClient({
      baseUrl: cfg.apiUrl,
      userAgent: cfg.userAgent,
      signer,
      clock,
      profile: "AUTONOMOUS",
      rate,
      account: a.accountId,
      builderFee: { capBps: a.approvedBuilderBps },
      onAlarm: (alarm) => logger.error({ account: a.accountId, alarm }, "signed client alarm"),
    });
    const stream = new UserStream({
      url: `${cfg.wsOrigin}/ws/user-api`,
      userAgent: cfg.userAgent,
      signer,
      clock,
      expectedAccountId: a.accountId,
      onEvent: (ev) => daemon?.onUserEvent(a.accountId, ev),
      onResyncNeeded: () => daemon?.onUserResync(a.accountId),
      onAlarm: (alarm) => logger.error({ account: a.accountId, alarm }, "user stream alarm"),
      onFatal: (reason) => logger.error({ account: a.accountId, reason }, "user stream fatal"),
    });
    streams.push(stream);
    return { cfg: a, signer: client, reads: client, streamLive: () => stream.live };
  });

  const koios = new KoiosClient({
    baseUrl: coverCfg.koiosUrl,
    ...(coverCfg.koiosToken ? { token: coverCfg.koiosToken } : {}),
  });
  const cover = new CoverWatch({
    oracle: new CoverOracle(koios),
    subjects: entries.map((a) => ({
      accountId: a.accountId,
      stakeAddress: bindableStake(a.stakeAddress),
    })),
    onProof: (id, proof) => daemon?.onCoverProof(id, proof),
    onError: (id, err) => logger.warn({ account: id, err }, "cover read failed"),
    // VERIFY: D10 — Ogmios mempool spend detection is a stub until a node is provisioned.
    mempool: new OgmiosMempoolStub(),
  });

  const notifier = safeNotifier(
    createTelegramNotifier({ ...cfg.telegram, logger, secrets }),
    logger,
  );
  mkdirSync(dirname(cfg.wouldPlaceLog), { recursive: true });
  const wouldPlace = (e: WouldPlaceEntry) => appendFileSync(cfg.wouldPlaceLog, `${json(e)}\n`);

  daemon = createDaemon({
    config: {
      mode: cfg.mode,
      dryRun: cfg.dryRun,
      armed: cfg.armed,
      mainnet: true,
      quoteSymbol: cfg.quoteSymbol,
      allowlist: [cfg.quoteSymbol],
      trustedOperators: cfg.trustedOperators,
      trustedDaemons: [daemonKey.publicKeyHex, ...cfg.extraTrustedDaemons],
      replicaP99Bps: cfg.replicaP99Bps,
    },
    db,
    daemonKey,
    market,
    cover,
    accounts: ports,
    rate,
    notifier,
    logger,
    clock: { now: () => Date.now() },
    critic: createSimCriticRunner({
      segments: cfg.recordingsRoot ? { root: cfg.recordingsRoot } : null,
      simGitSha: cfg.simGitSha,
    }),
    // VERIFY: the public vault-positions read and its response shape (FRICTION 2026-10-23).
    vaultCheck: async (accountId) => {
      const r = await http.getJson<{ positions?: unknown[] | null } | unknown[] | null>(
        "/v2/vault/positions",
        { account_id: accountId },
      );
      const rows = Array.isArray(r) ? r : (r?.positions ?? null);
      return Array.isArray(rows) && rows.length > 0;
    },
    wouldPlace,
  });

  if (cfg.policyDir) {
    const { policies, reports, envelopes } = readPolicyDir(cfg.policyDir);
    for (const sp of policies) {
      if (daemon.registry.headHash() === sp.hash) continue;
      const report = reports.find((r) => r.policyHash === sp.hash && r.verdict === "PASS");
      if (report) daemon.activatePolicy(sp, report);
      else await daemon.proposePolicy(sp);
    }
    for (const env of envelopes) daemon.attachEnvelope(env);
  }

  const sinks: HeartbeatSink[] = [];
  if (cfg.heartbeatUrls.length > 0) {
    sinks.push(
      httpHeartbeatSink(cfg.heartbeatUrls, {
        onError: (url, err) => logger.warn({ url, err }, "heartbeat push failed"),
      }),
    );
  }
  if (cfg.heartbeatFile) sinks.push(fileHeartbeatSink(cfg.heartbeatFile));
  const heartbeat = new HeartbeatPublisher({
    key: daemonKey,
    sink: multiSink(sinks),
    snapshot: () => (daemon as KeeperDaemon).heartbeatSnapshot(),
    onError: (err) => logger.warn({ err: String(err) }, "heartbeat failed"),
  });
  const health = await startHealthServer({
    report: () => (daemon as KeeperDaemon).health(),
    host: cfg.health.host,
    port: cfg.health.port,
  });
  const deadman = createDeadMan({
    ...(cfg.deadmanUrl ? { url: cfg.deadmanUrl } : {}),
    onError: (err) => logger.warn({ err }, "dead-man ping failed"),
  });
  const deadmanTimer = setInterval(
    () => void deadman.ping((daemon as KeeperDaemon).health().ok),
    30_000,
  );
  deadmanTimer.unref();

  market.start();
  cover.start();
  for (const s of streams) s.start();
  heartbeat.start();
  daemon.start();
  logger.info({ health: health.url, accounts: entries.length }, "keeper running");

  let signals = 0;
  const shutdown = async (sig: string) => {
    signals += 1;
    if (signals > 1) process.exit(1);
    logger.warn({ sig }, "shutting down: cancelling resting asks first");
    await (daemon as KeeperDaemon).stop({ cancel: true });
    heartbeat.stop();
    clearInterval(deadmanTimer);
    for (const s of streams) s.stop();
    cover.stop();
    market.stop();
    clock.stop();
    await health.close();
    db.releaseDaemonLock(process.pid);
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
