import { SegmentWriter } from "@ballast/evidence";
import {
  createPublicHttp,
  createPublicReads,
  L3Feed,
  ReconnectingSocket,
} from "@ballast/strike-client";
import pino from "pino";
import { loadConfig } from "./config.js";
import { minimizeLivePositions } from "./minimize.js";

/**
 * Day-0 market recorder. Captures public NIGHT-USD / ADA-USD data from the start: the "before"
 * book that Book Health, the mark replica and every replay are measured against. It holds no
 * keys and makes no writes to Strike.
 */
const cfg = loadConfig();
const log = pino({ level: cfg.logLevel, base: { app: "recorder" } });

const writer = new SegmentWriter({
  root: cfg.dataDir,
  compress: true,
  onCompressError: (segment, err) =>
    log.error(
      { segment, err: err instanceof Error ? err.message : String(err) },
      "compress failed",
    ),
  onSeal: (e) =>
    log.info(
      { segment: e.segment, lines: e.lines, sha256: e.sha256, recovered: e.recovered },
      "segment sealed",
    ),
  onRoot: (r) =>
    log.info({ hour: r.hour, root: r.root, segments: r.segments.length }, "hour rooted"),
});
const reads = createPublicReads(
  createPublicHttp({ baseUrl: cfg.apiUrl, userAgent: cfg.userAgent }),
);

const counts = new Map<string, number>();
function record(stream: string, kind: string, data: unknown, recvMs = Date.now()): void {
  writer.write(stream, kind, data, recvMs);
  counts.set(`${stream}/${kind}`, (counts.get(`${stream}/${kind}`) ?? 0) + 1);
}

const l3 = new L3Feed({
  url: `${cfg.wsUrl}/ws/l3`,
  userAgent: cfg.userAgent,
  symbols: cfg.symbols,
  fetchSnapshot: (s) => reads.l3Snapshot(s),
  onUpdate: (u, t) => record("l3", "update", u, t),
  onSnapshot: (s, t) => record("l3", "snapshot", s, t),
  onRebuild: (symbol, reason, detail, t) => {
    record("l3", "rebuild", { symbol, reason, detail }, t);
    log.warn({ symbol, reason, detail }, "l3 rebuild");
  },
  onControl: (m, t) => record("l3", "control", m, t),
  onStateChange: (state, info) => {
    record("meta", "l3-socket", { state, ...info });
    log.info({ state, ...info }, "l3 socket");
  },
});

// @markprice@1s carries mark, index, funding rate and next funding time each engine tick; it must
// not share a socket with @markprice (identical payloads). @trade gives the last-trade leg.
const priceStreams = cfg.symbols.flatMap((s) => {
  const l = s.toLowerCase();
  return [`${l}@markprice@1s`, `${l}@trade`, `${l}@bookticker`];
});
const price = new ReconnectingSocket({
  url: `${cfg.wsUrl}/ws/price`,
  userAgent: cfg.userAgent,
  onOpen: (sock) => {
    sock.send({ method: "SUBSCRIBE", params: priceStreams, id: 1 });
  },
  onMessage: (m, t) => {
    const kind = typeof m === "object" && m !== null && "e" in m ? String(m.e) : "control";
    record("price", kind, m, t);
  },
  onBadFrame: (raw, t) => record("price", "bad-frame", raw, t),
  onStateChange: (state, info) => {
    record("meta", "price-socket", { state, ...info });
    log.info({ state, ...info }, "price socket");
  },
});

const timers: NodeJS.Timeout[] = [];
function poll(name: string, everyMs: number, run: () => Promise<void>): void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record("meta", "poll-error", { name, message });
      log.warn({ name, err: message }, "poll failed");
    } finally {
      busy = false;
    }
  };
  void tick();
  timers.push(setInterval(tick, everyMs));
}

poll("depth", cfg.intervals.depth, async () => {
  for (const symbol of cfg.symbols) {
    const t0 = Date.now();
    record("depth", "depth", { symbol, ...(await reads.depth(symbol, 1000)) }, t0);
  }
});
poll("premiumIndex", cfg.intervals.premiumIndex, async () => {
  for (const symbol of cfg.symbols)
    record("rest", "premium-index", await reads.premiumIndex(symbol));
});
poll("livePositions", cfg.intervals.livePositions, async () => {
  record("rest", "live-positions", minimizeLivePositions(await reads.livePositions(), cfg.symbols));
});
poll("markets", cfg.intervals.markets, async () => {
  const { markets } = await reads.markets();
  record("rest", "markets", Object.fromEntries(cfg.symbols.map((s) => [s, markets[s]])));
});
poll("ticker24h", cfg.intervals.ticker24h, async () => {
  record("rest", "ticker-24h", await reads.ticker24h());
});
poll("trades", cfg.intervals.trades, async () => {
  for (const symbol of cfg.symbols)
    record("rest", "trades", { symbol, trades: await reads.trades(symbol, 1000) });
});
poll("time", cfg.intervals.time, async () => {
  const sent = Date.now();
  const { serverTime } = await reads.time();
  const recv = Date.now();
  record(
    "rest",
    "time",
    { serverTime, sentMs: sent, recvMs: recv, offsetMs: serverTime - (sent + recv) / 2 },
    recv,
  );
});

timers.push(setInterval(() => writer.tick(), 5_000));
timers.push(
  setInterval(() => {
    const now = Date.now();
    const health = {
      counts: Object.fromEntries(counts),
      l3: [...l3.books.values()].map((b) => ({
        symbol: b.symbol,
        synced: b.synced,
        lastSequence: b.lastSequence,
        bestBid: b.bestBid() ?? null,
        bestAsk: b.bestAsk() ?? null,
        orders: b.orderCount(),
      })),
      l3SilentMs: now - l3.lastSeen,
      priceSilentMs: now - price.lastSeen,
      openSegments: writer.openSegments,
    };
    record("meta", "health", health, now);
    log.info(health, "health");
    counts.clear();
  }, cfg.intervals.health),
);

l3.start();
price.start();
log.info({ symbols: cfg.symbols, dataDir: cfg.dataDir, streams: priceStreams }, "recorder started");

let stopping = false;
function shutdown(reason: string, code: number): void {
  if (stopping) return;
  stopping = true;
  log.info({ reason }, "recorder stopping");
  for (const t of timers) clearInterval(t);
  l3.stop();
  price.stop();
  try {
    writer.close();
  } catch (err) {
    log.error({ err }, "writer close failed; startup recovery will seal the open segments");
  }
  // Compression is crash-safe and resumes on the next start, so waiting is only a courtesy.
  const deadline = new Promise<void>((r) => setTimeout(r, 30_000).unref());
  void Promise.race([writer.drain(), deadline]).finally(() => process.exit(code));
}
process.on("SIGINT", () => shutdown("SIGINT", 0));
process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("uncaughtException", (err) => {
  log.fatal({ err }, "uncaught exception");
  shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (err) => {
  log.fatal({ err }, "unhandled rejection");
  shutdown("unhandledRejection", 1);
});
