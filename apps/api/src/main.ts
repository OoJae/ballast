import pino from "pino";
import { BookHealthService } from "./book-health.js";
import { loadApiConfig } from "./config.js";
import { RecordingsEvidence } from "./evidence.js";
import { loadHolderConfig } from "./holder/config.js";
import { createLiveSource } from "./live.js";
import { RecordingIndex } from "./recording-index.js";
import { createApiServer, type HolderRoutes } from "./server.js";
import { type BookSource, ReplayBookSource } from "./sources.js";

/**
 * Ballast's public, read-only API. Holds no keys and makes no writes. By default every book it
 * serves is replayed from sealed recordings; BOOK_SOURCE=live switches the current book to
 * Strike's public L3 feed. HOLDER_ROUTES=1 adds the holder role (a signing role: see
 * holder/config.ts for the hosting rule).
 */
const cfg = loadApiConfig();
const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { app: "api" } });
const logError = (msg: string) => (err: unknown) =>
  log.error({ err: err instanceof Error ? err.message : String(err) }, msg);

const index = new RecordingIndex({
  root: cfg.recordingsRoot,
  symbols: cfg.symbols,
  archiveFrameMs: cfg.archiveFrameMs,
  archiveHours: cfg.archiveHours,
  onError: logError("index build failed"),
});
const evidence = new RecordingsEvidence(cfg.recordingsRoot, { onError: logError("verify failed") });
const health = new BookHealthService(index, {
  root: cfg.recordingsRoot,
  symbols: cfg.symbols,
  verified: () => evidence.status?.ok ?? null,
});

let stopLive = () => {};
let source: BookSource;
if (cfg.source === "live") {
  const live = createLiveSource(cfg, logError("live markets read failed"));
  source = live.source;
  stopLive = live.stop;
} else {
  source = new ReplayBookSource(index, cfg.symbols);
}

// The holder role loads only when asked for; otherwise this process stays keyless.
const holderCfg = loadHolderConfig();
let holder: HolderRoutes | undefined;
let closeHolder = () => {};
if (holderCfg) {
  const { createHolderRole } = await import("./holder/index.js");
  const role = createHolderRole(holderCfg, log);
  holder = role.handler;
  closeHolder = role.close;
  log.warn(
    { strike: holderCfg.strikeUrl, fundingMode: holderCfg.fundingMode },
    "holder routes ON: this process now signs Strike requests; run it only outside Strike's restricted jurisdictions",
  );
}

const server = createApiServer({
  ...(holder ? { holder } : {}),
  symbols: cfg.symbols,
  cors: { origins: cfg.corsOrigins },
  index,
  health,
  evidence,
  source,
  onError: (err, path) =>
    log.error({ path, err: err instanceof Error ? err.message : String(err) }, "request failed"),
});

async function refresh(): Promise<void> {
  const snap = await index.refresh();
  if (snap) {
    log.info(
      { sealedThrough: new Date(snap.toMs).toISOString(), lines: snap.lines, ms: snap.buildMs },
      "index ready",
    );
  }
  const v = await evidence.refresh();
  if (v) log.info({ ok: v.ok, segments: v.segmentsChecked, roots: v.rootsChecked }, "verified");
}

server.listen(cfg.port, cfg.host, () => {
  log.info(
    { port: cfg.port, host: cfg.host, root: cfg.recordingsRoot, source: source.kind },
    "api listening",
  );
});
source.start();
void refresh();
const timer = setInterval(() => void refresh(), cfg.indexRefreshMs);

function shutdown(reason: string): void {
  log.info({ reason }, "api stopping");
  clearInterval(timer);
  source.stop();
  stopLive();
  closeHolder();
  server.close();
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
