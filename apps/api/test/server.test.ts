import { readFileSync, writeFileSync } from "node:fs";
import { get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { readRecordings, replay } from "@ballast/market";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BookHealthService } from "../src/book-health.js";
import { RecordingsEvidence } from "../src/evidence.js";
import { RecordingIndex } from "../src/recording-index.js";
import { createApiServer } from "../src/server.js";
import { ReplayBookSource } from "../src/sources.js";
import type {
  BookFrame,
  BookHealthResponse,
  CapacityResponse,
  DailyBookHealthResponse,
  ReplayFrameResponse,
  ReplayIndexResponse,
  RootsResponse,
  SeriesResponse,
} from "../src/types.js";
import {
  cleanup,
  FIXTURE_FROM_MS,
  FIXTURE_HOUR,
  FIXTURE_HOUR_MS,
  sealedFixtureRoot,
} from "./helpers.js";

const SYMBOLS = ["NIGHT-USD", "ADA-USD"];
const temps: string[] = [];
let root: string;
let server: Server;
let base: string;
let source: ReplayBookSource;
let clock = FIXTURE_FROM_MS;
let index: RecordingIndex;
let evidence: RecordingsEvidence;

function listen(s: Server): Promise<string> {
  return new Promise((resolve) => {
    s.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`),
    );
  });
}

beforeAll(async () => {
  root = await sealedFixtureRoot(temps);
  index = new RecordingIndex({ root, symbols: SYMBOLS });
  await index.refresh();
  evidence = new RecordingsEvidence(root);
  await evidence.refresh();
  const health = new BookHealthService(index, {
    root,
    symbols: SYMBOLS,
    verified: () => evidence.status?.ok ?? null,
  });
  source = new ReplayBookSource(index, SYMBOLS, { now: () => clock });
  source.tick();
  server = createApiServer({
    symbols: SYMBOLS,
    cors: { origins: "*" },
    index,
    health,
    evidence,
    source,
    heartbeatMs: 50,
  });
  base = await listen(server);
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
  cleanup(temps);
});

const json = async <T>(path: string, init?: RequestInit) => {
  const res = await fetch(`${base}${path}`, init);
  return { res, body: (await res.json()) as T };
};

describe("read-only API over sealed recordings", () => {
  it("reports health and the sealed range", async () => {
    const { res, body } = await json<{ indexed: boolean; sealedThroughMs: number; source: string }>(
      "/api/health",
    );
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ indexed: true, source: "replay" });
    expect(body.sealedThroughMs).toBe(FIXTURE_HOUR_MS + 3_600_000);
  });

  it("serves the sealed window's Book Health exactly as @ballast/market's replay computes it", async () => {
    const { res, body } = await json<BookHealthResponse>("/api/book-health?symbol=NIGHT-USD");
    expect(res.status).toBe(200);
    expect(body.method).toBe("index");
    const direct = await replay({
      root,
      symbols: SYMBOLS,
      fromMs: FIXTURE_HOUR_MS,
      toMs: FIXTURE_HOUR_MS + 3_600_000,
      slackMs: 0,
    });
    expect(body.report).toEqual(direct.symbols.get("NIGHT-USD")?.health.report());
    expect(Number(body.report.unarmed.actual.spreadBps?.mean)).toBeGreaterThan(0);
    expect(body.report.armed.ms).toBe(0);
    expect(body.provenance.hours).toEqual([
      { hour: FIXTURE_HOUR, root: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(body.provenance.verified).toBe(true);
    expect(res.headers.get("cache-control")).toContain("max-age=60");
  });

  it("replays a custom window on demand and caches it", async () => {
    const from = FIXTURE_FROM_MS + 10_000;
    const to = FIXTURE_FROM_MS + 40_000;
    const path = `/api/book-health?symbol=ADA-USD&from=${new Date(from).toISOString()}&to=${to}`;
    const { res, body } = await json<BookHealthResponse>(path);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ method: "replay", fromMs: from, toMs: to });
    const direct = await replay({ root, symbols: SYMBOLS, fromMs: from, toMs: to });
    expect(body.report).toEqual(direct.symbols.get("ADA-USD")?.health.report());
    expect(body.report.unarmed.ms).toBe(30_000);
    // An explicit window inside the sealed range cannot change.
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    const again = await json<BookHealthResponse>(path);
    expect(again.body.computedAt).toBe(body.computedAt);
  });

  it("splits the scorecard by UTC day and hour", async () => {
    const { body } = await json<DailyBookHealthResponse>("/api/book-health/daily?symbol=NIGHT-USD");
    expect(body.days.map((d) => d.key)).toEqual(["2026-10-23"]);
    const [day] = body.days;
    expect(day?.hours.map((h) => h.key)).toEqual([FIXTURE_HOUR]);
    const whole = await json<BookHealthResponse>("/api/book-health?symbol=NIGHT-USD");
    expect(day?.report).toEqual(whole.body.report);
  });

  it("serves the current replayed book without a single order id", async () => {
    const { res, body } = await json<BookFrame>("/api/book/night-usd");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=1");
    expect(body.source).toMatchObject({ kind: "replay", hour: FIXTURE_HOUR });
    expect(body.bids.length).toBeGreaterThan(5);
    expect(body.asks.length).toBeGreaterThan(0);
    expect(body.ballastOrders).toBe(0);
    expect(body.bids.every(([, , b]) => b === 0)).toBe(true);
    expect(body.bestBid).toBe(body.bids[0]?.[0]);
    expect(body.spreadBps).toBe(body.cfSpreadBps);

    const ids = new Set<string>();
    for await (const r of readRecordings(root, { streams: ["l3"] })) {
      const d = r.d as {
        order_id?: string;
        taker_order_id?: string;
        bids?: { orders: { order_id: string }[] }[];
        asks?: { orders: { order_id: string }[] }[];
      };
      if (d.order_id) ids.add(d.order_id);
      if (d.taker_order_id) ids.add(d.taker_order_id);
      for (const l of [...(d.bids ?? []), ...(d.asks ?? [])])
        for (const o of l.orders) ids.add(o.order_id);
    }
    expect(ids.size).toBeGreaterThan(100);
    const everything = [
      JSON.stringify(body),
      await (await fetch(`${base}/api/replay/NIGHT-USD?at=${FIXTURE_FROM_MS + 30_000}`)).text(),
      await (await fetch(`${base}/api/book-health/daily?symbol=ADA-USD`)).text(),
      await (await fetch(`${base}/api/capacity/NIGHT-USD`)).text(),
    ].join("\n");
    for (const id of ids) expect(everything.includes(id)).toBe(false);
  });

  it("returns the recorded book at a time, with its L3 sequence and hour root", async () => {
    const idx = await json<ReplayIndexResponse>("/api/replay/NIGHT-USD");
    expect(idx.body.frameMs).toBe(5_000);
    expect(idx.body.windows.length).toBeGreaterThan(0);
    const at = FIXTURE_FROM_MS + 30_500;
    const { res, body } = await json<ReplayFrameResponse>(`/api/replay/NIGHT-USD?at=${at}`);
    expect(res.status).toBe(200);
    expect(body.frame.tMs).toBe(FIXTURE_FROM_MS + 30_000);
    expect(body.frame.sequence).toBeGreaterThan(10_000_000);
    const roots = await json<RootsResponse>("/api/recordings/roots");
    expect(body.frame.source.root).toBe(roots.body.hours[0]?.root);
    // Later frames carry later sequences.
    const later = await json<ReplayFrameResponse>(`/api/replay/NIGHT-USD?at=${at + 20_000}`);
    expect(later.body.frame.sequence).toBeGreaterThan(body.frame.sequence);
    const none = await fetch(`${base}/api/replay/NIGHT-USD?at=${FIXTURE_HOUR_MS}`);
    expect(none.status).toBe(404);
  });

  it("serves aligned chart series", async () => {
    const from = FIXTURE_FROM_MS;
    const { body } = await json<SeriesResponse>(
      `/api/series/NIGHT-USD?from=${from}&to=${from + 60_000}&step=5000`,
    );
    expect(body.t.length).toBe(12);
    expect(body.mid.length).toBe(12);
    expect(body.spreadBps.filter((x) => x !== null).length).toBeGreaterThan(8);
    const bad = await fetch(`${base}/api/series/NIGHT-USD?step=10`);
    expect(bad.status).toBe(400);
  });

  it("publishes hourly roots with the independent verify result", async () => {
    const { body } = await json<RootsResponse>("/api/recordings/roots");
    expect(body.hours).toHaveLength(1);
    expect(body.hours[0]?.segments.map((s) => s.stream)).toEqual([
      "depth",
      "l3",
      "meta",
      "price",
      "rest",
    ]);
    expect(body.verify).toMatchObject({ ok: true, segmentsChecked: 5, rootsChecked: 1 });
  });

  it("detects a tampered segment", async () => {
    const copy = await sealedFixtureRoot(temps);
    const gz = join(copy, "2026-10-23/00/meta.1.jsonl.gz");
    const text = gunzipSync(readFileSync(gz)).toString("utf8").replace("connecting", "connectinG");
    writeFileSync(gz, gzipSync(text));
    const ev = new RecordingsEvidence(copy);
    const status = await ev.refresh();
    expect(status?.ok).toBe(false);
    expect(status?.failures.map((f) => f.reason)).toContain("sha256 mismatch");
  });

  it("reports capacity inputs, with cover pending the oracle", async () => {
    const { body } = await json<CapacityResponse>("/api/capacity/NIGHT-USD");
    expect(body).toMatchObject({
      coverCommittedUsd: null,
      coverStatus: "coming with the cover oracle",
      ballast: { ordersResting: 0, holdersArmed: 0, armedMs: 0 },
    });
    expect(body.exitDepthUsd).toBeGreaterThan(0);
    expect(body.livePositions === null || typeof body.livePositions.longs === "number").toBe(true);
  });

  it("answers cover requests with 501 until the cover oracle exists", async () => {
    for (const p of ["/api/cover", "/api/cover/addr1qxyz", "/api/cover/stake1u9/history"]) {
      const { res, body } = await json<{ error: string }>(p);
      expect(res.status).toBe(501);
      expect(body.error).toBe("coming with the cover oracle");
    }
  });

  it("is GET-only, with CORS and ETags", async () => {
    const post = await fetch(`${base}/api/book/NIGHT-USD`, { method: "POST", body: "{}" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    const pre = await fetch(`${base}/api/book-health`, {
      method: "OPTIONS",
      headers: { Origin: "https://judge.example", "Access-Control-Request-Method": "GET" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");

    const first = await fetch(`${base}/api/recordings/roots`);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^".+"$/);
    expect(first.headers.get("access-control-allow-origin")).toBe("*");
    const second = await fetch(`${base}/api/recordings/roots`, {
      headers: { "If-None-Match": etag ?? "" },
    });
    expect(second.status).toBe(304);
    const head = await fetch(`${base}/api/recordings/roots`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("rejects bad input with 400/404 and unknown paths with 404", async () => {
    expect((await fetch(`${base}/api/book-health?from=yesterday`)).status).toBe(400);
    expect((await fetch(`${base}/api/book-health?symbol=BTC-USD`)).status).toBe(404);
    expect((await fetch(`${base}/api/book/DOGE-USD`)).status).toBe(404);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    const empty = await fetch(`${base}/api/book-health?from=2030-01-01T00:00:00Z`);
    expect(empty.status).toBe(400);
  });

  it("streams book frames over SSE", async () => {
    const events: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = get(`${base}/api/stream/NIGHT-USD`, (res) => {
        expect(res.headers["content-type"]).toContain("text/event-stream");
        expect(res.headers["cache-control"]).toBe("no-cache, no-transform");
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (chunk: string) => {
          buf += chunk;
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const p of parts) if (p.startsWith("event: book")) events.push(p);
          if (events.length === 1) {
            // Advance the playhead: the next tick publishes a later recorded frame.
            clock += 7_000;
            source.tick();
          }
          if (events.length >= 2) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on("error", reject);
    });
    const frames = events.map(
      (e) =>
        JSON.parse(
          e
            .split("\n")
            .find((l) => l.startsWith("data: "))
            ?.slice(6) ?? "",
        ) as BookFrame,
    );
    expect(frames[1]?.tMs).toBeGreaterThan(frames[0]?.tMs ?? Number.POSITIVE_INFINITY);
    expect(frames[1]?.sequence).toBeGreaterThanOrEqual(frames[0]?.sequence ?? 0);
  });
});

describe("before any hour is sealed", () => {
  it("answers 503 with Retry-After instead of guessing", async () => {
    const t: string[] = [];
    const emptyRoot = await sealedFixtureRoot(t);
    writeFileSync(join(emptyRoot, "roots.jsonl"), "");
    const idx = new RecordingIndex({ root: emptyRoot, symbols: SYMBOLS });
    await idx.refresh();
    const s = createApiServer({
      symbols: SYMBOLS,
      cors: { origins: ["https://ballast.example"] },
      index: idx,
      health: new BookHealthService(idx, { root: emptyRoot, symbols: SYMBOLS }),
      evidence: new RecordingsEvidence(emptyRoot),
      source: new ReplayBookSource(idx, SYMBOLS),
    });
    const b = await listen(s);
    try {
      const res = await fetch(`${b}/api/book-health`, {
        headers: { Origin: "https://evil.example" },
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("10");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      const ok = await fetch(`${b}/api/health`, { headers: { Origin: "https://ballast.example" } });
      expect(ok.headers.get("access-control-allow-origin")).toBe("https://ballast.example");
      expect((await fetch(`${b}/api/book/NIGHT-USD`)).status).toBe(503);
      expect((await fetch(`${b}/api/replay/NIGHT-USD`)).status).toBe(503);
    } finally {
      s.close();
      cleanup(t);
    }
  });
});
