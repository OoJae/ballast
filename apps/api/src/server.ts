import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BadRequestError, type BookHealthService, NotReadyError } from "./book-health.js";
import type { RecordingsEvidence } from "./evidence.js";
import { CACHE, type CorsPolicy, corsHeaders, parseTime, sendError, sendJson } from "./http.js";
import type { IndexSnapshot, RecordingIndex } from "./recording-index.js";
import type { BookSource } from "./sources.js";
import type {
  CapacityResponse,
  HealthResponse,
  ReplayFrameResponse,
  ReplayIndexResponse,
} from "./types.js";

export interface ApiDeps {
  symbols: readonly string[];
  cors: CorsPolicy;
  index: RecordingIndex;
  health: BookHealthService;
  evidence: RecordingsEvidence;
  source: BookSource;
  /** Concurrent SSE clients allowed (default 500). */
  maxStreams?: number;
  heartbeatMs?: number;
  onError?: (err: unknown, path: string) => void;
}

const COVER_PENDING = "coming with the cover oracle";
const MAX_SERIES_POINTS = 5_000;
const DAY_MS = 86_400_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/**
 * Ballast's public API: read-only, keyless, GET only. Every number it serves is derived from
 * sealed recordings (or, with BOOK_SOURCE=live, the public L3 feed); nothing here can write
 * to Strike or reveal an order id, account or address.
 */
export function createApiServer(deps: ApiDeps): Server {
  let streams = 0;
  const maxStreams = deps.maxStreams ?? 500;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;

  const symbolOf = (raw: string | undefined): string => {
    const s = decodeURIComponent(raw ?? "").toUpperCase();
    if (!deps.symbols.includes(s)) throw new HttpError(404, `unknown symbol ${s || "(none)"}`);
    return s;
  };
  const indexed = (): IndexSnapshot => {
    const s = deps.index.current;
    if (!s) {
      throw new HttpError(503, "no sealed recording hours are indexed yet", {
        "Retry-After": "10",
      });
    }
    return s;
  };
  const time = (url: URL, name: string): number | undefined => {
    const t = parseTime(url.searchParams.get(name));
    if (t !== undefined && !Number.isFinite(t)) {
      throw new HttpError(400, `${name} must be an ISO time or epoch milliseconds`);
    }
    return t;
  };

  const routes: [
    RegExp,
    (
      req: IncomingMessage,
      res: ServerResponse,
      url: URL,
      m: RegExpExecArray,
    ) => Promise<void> | void,
  ][] = [
    [
      /^\/api\/health$/,
      (req, res) => {
        const s = deps.index.current;
        const body: HealthResponse = {
          ok: true,
          source: deps.source.kind,
          symbols: [...deps.symbols],
          indexed: s !== null,
          sealedThroughMs: s?.toMs ?? null,
          builtAt: s?.builtAt ?? null,
        };
        sendJson(req, res, 200, body, CACHE.none, corsHeaders(req, deps.cors));
      },
    ],
    [
      /^\/api\/book-health$/,
      async (req, res, url) => {
        const symbol = symbolOf(url.searchParams.get("symbol") ?? deps.symbols[0]);
        const to = time(url, "to");
        const body = await deps.health.window(symbol, time(url, "from"), to);
        // An explicit window inside the sealed range is fixed; an open end grows each hour.
        const cache = to !== undefined && to <= body.sealedThroughMs ? CACHE.sealed : CACHE.short;
        sendJson(req, res, 200, body, cache, corsHeaders(req, deps.cors));
      },
    ],
    [
      /^\/api\/book-health\/daily$/,
      (req, res, url) => {
        const symbol = symbolOf(url.searchParams.get("symbol") ?? deps.symbols[0]);
        sendJson(
          req,
          res,
          200,
          deps.health.daily(symbol),
          CACHE.short,
          corsHeaders(req, deps.cors),
        );
      },
    ],
    [
      /^\/api\/book\/([^/]+)$/,
      (req, res, _url, m) => {
        const symbol = symbolOf(m[1]);
        const frame = deps.source.current(symbol);
        if (!frame) throw new HttpError(503, "book not available yet", { "Retry-After": "5" });
        sendJson(req, res, 200, frame, CACHE.live, corsHeaders(req, deps.cors));
      },
    ],
    [
      /^\/api\/stream\/([^/]+)$/,
      (req, res, _url, m) => {
        const symbol = symbolOf(m[1]);
        if (streams >= maxStreams) {
          throw new HttpError(503, "too many streams", { "Retry-After": "30" });
        }
        streams += 1;
        res.writeHead(200, {
          ...corsHeaders(req, deps.cors),
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": CACHE.stream,
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write("retry: 3000\n\n");
        const send = (f: unknown) => {
          const seq = (f as { sequence?: number }).sequence;
          res.write(`event: book\nid: ${seq ?? ""}\ndata: ${JSON.stringify(f)}\n\n`);
        };
        const first = deps.source.current(symbol);
        if (first) send(first);
        const unsubscribe = deps.source.subscribe(symbol, send);
        const beat = setInterval(() => res.write(": keep-alive\n\n"), heartbeatMs);
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          streams -= 1;
          clearInterval(beat);
          unsubscribe();
        };
        req.on("close", close);
        res.on("error", close);
      },
    ],
    [
      /^\/api\/series\/([^/]+)$/,
      (req, res, url, m) => {
        const symbol = symbolOf(m[1]);
        const s = indexed();
        const idx = s.symbols.get(symbol);
        if (!idx) throw new HttpError(404, `no recordings for ${symbol}`);
        const openEnded = !url.searchParams.has("to");
        const to = Math.min(time(url, "to") ?? s.toMs, s.toMs);
        const from = Math.max(time(url, "from") ?? to - 3_600_000, s.fromMs);
        if (!(to > from)) throw new HttpError(400, "window is empty");
        const stepParam = url.searchParams.get("step");
        const step = stepParam
          ? Number(stepParam)
          : Math.max(1_000, Math.ceil((to - from) / 1_500 / 1_000) * 1_000);
        if (!Number.isFinite(step) || step < 1_000)
          throw new HttpError(400, "step must be ≥ 1000 ms");
        if ((to - from) / step > MAX_SERIES_POINTS) {
          throw new HttpError(400, `at most ${MAX_SERIES_POINTS} points; raise step`);
        }
        sendJson(
          req,
          res,
          200,
          idx.series.query(symbol, from, to, step),
          openEnded ? CACHE.short : CACHE.sealed,
          corsHeaders(req, deps.cors),
        );
      },
    ],
    [
      /^\/api\/replay\/([^/]+)$/,
      (req, res, url, m) => {
        const symbol = symbolOf(m[1]);
        const s = indexed();
        const idx = s.symbols.get(symbol);
        if (!idx) throw new HttpError(404, `no recordings for ${symbol}`);
        const at = time(url, "at");
        if (at === undefined) {
          const body: ReplayIndexResponse = {
            symbol,
            windows: idx.archive.windows(),
            frameMs: idx.archive.stepMs,
            fineWindows: idx.fine.windows(),
            sealedThroughMs: s.toMs,
          };
          sendJson(req, res, 200, body, CACHE.short, corsHeaders(req, deps.cors));
          return;
        }
        const fineExt = idx.fine.extent;
        const inFine = fineExt && at >= fineExt.fromMs && at < fineExt.toMs;
        const frame = inFine ? idx.fine.at(at) : idx.archive.at(at);
        if (!frame) throw new HttpError(404, "no recorded frame at that time");
        const body: ReplayFrameResponse = { requestedMs: at, frame };
        sendJson(req, res, 200, body, CACHE.sealed, corsHeaders(req, deps.cors));
      },
    ],
    [
      /^\/api\/recordings\/roots$/,
      (req, res) => {
        sendJson(req, res, 200, deps.evidence.roots(), CACHE.short, corsHeaders(req, deps.cors));
      },
    ],
    [
      /^\/api\/capacity\/([^/]+)$/,
      (req, res, _url, m) => {
        const symbol = symbolOf(m[1]);
        const s = indexed();
        const idx = s.symbols.get(symbol);
        if (!idx) throw new HttpError(404, `no recordings for ${symbol}`);
        const toMs = s.toMs;
        const fromMs = Math.max(s.fromMs, toMs - DAY_MS);
        const buys = idx.takerBuys.filter((b) => b.tMs >= fromMs && b.tMs < toMs);
        const depth = idx.series.query(symbol, fromMs, toMs, 1_000).askDepth2;
        const defined = depth.filter((d): d is number => d !== null);
        const body: CapacityResponse = {
          symbol,
          window: { fromMs, toMs },
          coverCommittedUsd: null,
          coverStatus: COVER_PENDING,
          takerBuyFlow: { usd: buys.reduce((a, b) => a + b.usd, 0), buys: buys.length },
          exitDepthUsd: defined.length ? defined.reduce((a, b) => a + b, 0) / defined.length : null,
          livePositions: idx.positions,
          ballast: {
            ordersResting: deps.source.current(symbol)?.ballastOrders ?? 0,
            holdersArmed: 0,
            armedMs: idx.report.armed.ms,
          },
        };
        sendJson(req, res, 200, body, CACHE.short, corsHeaders(req, deps.cors));
      },
    ],
    [
      /^\/api\/cover(\/.*)?$/,
      (req, res) => {
        sendJson(req, res, 501, { error: COVER_PENDING }, CACHE.short, corsHeaders(req, deps.cors));
      },
    ],
  ];

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...corsHeaders(req, deps.cors),
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendError(req, res, 405, "read-only API: GET, HEAD and OPTIONS only", {
        ...corsHeaders(req, deps.cors),
        Allow: "GET, HEAD, OPTIONS",
      });
      return;
    }
    for (const [re, fn] of routes) {
      const m = re.exec(url.pathname);
      if (!m) continue;
      try {
        await fn(req, res, url, m);
      } catch (err) {
        const cors = corsHeaders(req, deps.cors);
        if (err instanceof HttpError) {
          sendError(req, res, err.status, err.message, { ...cors, ...err.headers });
        } else if (err instanceof NotReadyError) {
          sendError(req, res, 503, err.message, { ...cors, "Retry-After": "10" });
        } else if (err instanceof BadRequestError) {
          sendError(req, res, 400, err.message, cors);
        } else {
          deps.onError?.(err, url.pathname);
          if (!res.headersSent) sendError(req, res, 500, "internal error", cors);
          else res.end();
        }
      }
      return;
    }
    sendError(req, res, 404, "not found", corsHeaders(req, deps.cors));
  };

  return createServer((req, res) => {
    void handle(req, res);
  });
}
