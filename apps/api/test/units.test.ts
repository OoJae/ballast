import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Grid, type GridSpec } from "@ballast/market";
import { L3Book, type L3Snapshot } from "@ballast/strike-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadApiConfig } from "../src/config.js";
import { FRAME_BAND, frameFromBook, unitsToNumber } from "../src/frames.js";
import { RecordingIndex } from "../src/recording-index.js";
import { type FeedLike, LiveBookSource, ReplayBookSource } from "../src/sources.js";
import { FrameList } from "../src/stores.js";
import type { BookFrame } from "../src/types.js";
import { cleanup, FIXTURE_FROM_MS, sealedFixtureRoot } from "./helpers.js";

const spec: GridSpec = { tick: new Grid("0.000001"), step: new Grid("1") };
const SYM = "NIGHT-USD";

function book(asks: [string, string, string][], seq = 7): L3Book {
  const b = new L3Book(SYM);
  const snap: L3Snapshot = {
    type: "l3_snapshot",
    symbol: SYM,
    last_sequence: seq,
    timestamp: 0,
    bids: [
      { price: "0.038300", orders: [{ order_id: "house-bid-1", size: "400000" }] },
      { price: "0.030000", orders: [{ order_id: "far-bid", size: "10" }] },
    ],
    asks: asks.map(([price, order_id, size]) => ({ price, orders: [{ order_id, size }] })),
  };
  b.applySnapshot(snap);
  return b;
}

describe("frames", () => {
  it("converts grid units exactly", () => {
    expect(unitsToNumber(38_372n, spec.tick)).toBe(0.038372);
    expect(unitsToNumber(5n, new Grid("0.5"))).toBe(2.5);
    expect(unitsToNumber(123n, spec.step)).toBe(123);
  });

  it("highlights Ballast's share of a level and measures the counterfactual book", () => {
    const b = book([
      ["0.038500", "bal-1", "1000"],
      ["0.038700", "house-ask", "5000"],
    ]);
    b.onUpdate({
      type: "l3_update",
      symbol: SYM,
      action: "open",
      order_id: "other-1",
      side: "sell",
      price: "0.038500",
      remaining_size: "300",
      sequence: 8,
      timestamp: 1,
    });
    const f = frameFromBook(SYM, b, spec, new Set(["bal-1"]), 1_000, { kind: "live" });
    expect(f.ballastOrders).toBe(1);
    expect(f.asks[0]).toEqual([0.0385, 1300, 1000]);
    expect(f.asks[1]).toEqual([0.0387, 5000, 0]);
    // Without bal-1 the best ask is still 0.0385 (other-1); both measured on the cf mid.
    expect(f.cfSpreadBps).toBe(f.spreadBps);
    expect(f.sequence).toBe(8);
    // The far bid sits outside the ±5% band around the reference mid.
    expect(f.bids.map(([px]) => px)).toEqual([0.0383]);
    expect(FRAME_BAND).toBe(0.05);
    const text = JSON.stringify(f);
    for (const id of ["bal-1", "house-ask", "house-bid-1", "other-1"]) {
      expect(text.includes(id)).toBe(false);
    }
  });

  it("keeps the yardstick fixed: Ballast's improvement shows as a narrower actual spread", () => {
    const b = book([
      ["0.038400", "bal-1", "1000"],
      ["0.038700", "house-ask", "5000"],
    ]);
    const f = frameFromBook(SYM, b, spec, new Set(["bal-1"]), 1_000, { kind: "live" });
    expect(f.ref).toBe(0.0385); // the counterfactual mid: (0.0383 + 0.0387) / 2
    expect(f.spreadBps).toBeCloseTo(((0.0384 - 0.0383) / 0.0385) * 1e4, 6);
    expect(f.cfSpreadBps).toBeCloseTo(((0.0387 - 0.0383) / 0.0385) * 1e4, 6);
  });
});

describe("FrameList", () => {
  const frame = (tMs: number) => ({ tMs, sequence: tMs }) as unknown as BookFrame;
  it("finds the latest frame at or before a time and reports contiguous windows", () => {
    const l = new FrameList(5_000);
    for (const t of [0, 5_000, 10_000, 30_000, 35_000]) l.push(frame(t));
    l.push(frame(1_000)); // out of order: ignored
    expect(l.at(7_000)?.tMs).toBe(5_000);
    expect(l.at(20_000)).toBeNull(); // inside a gap
    expect(l.at(20_000, Number.POSITIVE_INFINITY)?.tMs).toBe(10_000);
    expect(l.at(-1)).toBeNull();
    expect(l.windows()).toEqual([
      { fromMs: 0, toMs: 15_000 },
      { fromMs: 30_000, toMs: 40_000 },
    ]);
  });
});

describe("book sources", () => {
  const temps: string[] = [];
  let index: RecordingIndex;
  beforeAll(async () => {
    index = new RecordingIndex({ root: await sealedFixtureRoot(temps), symbols: [SYM, "ADA-USD"] });
    await index.refresh();
  });
  afterAll(() => cleanup(temps));

  it("replay: plays the last sealed hour in a loop, the same instant for every instance", () => {
    const ext = index.current?.symbols.get(SYM)?.fine.extent;
    if (!ext) throw new Error("no frames");
    const len = ext.toMs - ext.fromMs;
    const at = (now: number) => new ReplayBookSource(index, [SYM], { now: () => now });
    const a = at(len * 1_000 + 12_345).playhead(SYM);
    const b = at(len * 7_000 + 12_345).playhead(SYM);
    expect(a?.tMs).toBe(ext.fromMs + 12_345);
    expect(b?.tMs).toBe(a?.tMs);
    expect(at(len * 3 + 12_345).current(SYM)?.tMs).toBe(ext.fromMs + 12_000);
    expect(ext.fromMs).toBeGreaterThanOrEqual(FIXTURE_FROM_MS);
  });

  it("replay: publishes only when the frame changes, and survives a throwing subscriber", () => {
    let now = 0;
    const s = new ReplayBookSource(index, [SYM], { now: () => now });
    const seen: number[] = [];
    s.subscribe(SYM, () => {
      throw new Error("bad client");
    });
    const off = s.subscribe(SYM, (f) => seen.push(f.tMs));
    s.tick();
    s.tick();
    now += 2_000;
    s.tick();
    off();
    now += 2_000;
    s.tick();
    expect(seen.length).toBe(2);
  });

  it("live: measures synced books only, and starts and stops its feed", () => {
    const b = book([["0.038700", "house-ask", "5000"]], 42);
    const books = new Map([[SYM, b]]);
    const calls: string[] = [];
    const feed: FeedLike = {
      books,
      start: () => calls.push("start"),
      stop: () => calls.push("stop"),
    };
    let handle = 0;
    const live = new LiveBookSource(feed, [SYM], {
      spec: () => spec,
      now: () => 99,
      timers: { setInterval: () => ++handle, clearInterval: () => calls.push("clear") },
    });
    live.start();
    expect(live.current(SYM)).toMatchObject({ sequence: 42, tMs: 99, source: { kind: "live" } });
    b.reset();
    expect(live.current(SYM)).toBeNull();
    live.stop();
    expect(calls).toEqual(["start", "clear", "stop"]);
  });
});

describe("config", () => {
  it("defaults to the replay source on localhost", () => {
    const c = loadApiConfig({});
    expect(c).toMatchObject({
      port: 8787,
      host: "127.0.0.1",
      source: "replay",
      recordingsRoot: "data/recordings",
      symbols: ["NIGHT-USD", "ADA-USD"],
      corsOrigins: "*",
    });
  });

  it("parses overrides and refuses bad values", () => {
    const c = loadApiConfig({
      BOOK_SOURCE: "live",
      API_PORT: "9000",
      CORS_ORIGINS: "https://a.example, https://b.example",
      RECORDINGS_ROOT: "/srv/rec",
    });
    expect(c).toMatchObject({ source: "live", port: 9000, recordingsRoot: "/srv/rec" });
    expect(c.corsOrigins).toEqual(["https://a.example", "https://b.example"]);
    expect(() => loadApiConfig({ BOOK_SOURCE: "websocket" })).toThrow();
    expect(() => loadApiConfig({ API_SYMBOLS: "night" })).toThrow();
    expect(() => loadApiConfig({ ARCHIVE_FRAME_MS: "1500" })).toThrow();
  });
});

describe("network boundary", () => {
  it("only live.ts can reach Strike: every other module is offline by construction", () => {
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    const network =
      /\bnew (L3Feed|ReconnectingSocket|WebSocket)\b|\b(createPublicHttp|createPublicReads|fetch)\(/;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const text = readFileSync(`${dir}${f}`, "utf8");
      if (f === "live.ts") expect(network.test(text)).toBe(true);
      else expect({ file: f, network: network.test(text) }).toEqual({ file: f, network: false });
    }
    const main = readFileSync(`${dir}main.ts`, "utf8");
    // The live source is constructed only behind BOOK_SOURCE=live.
    expect(main).toMatch(/if \(cfg\.source === "live"\) \{\s+const live = createLiveSource/);
  });
});
