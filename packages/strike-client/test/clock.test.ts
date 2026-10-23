import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiTimeSource,
  ClockNotSyncedError,
  createPublicHttp,
  medianOffsetMs,
  offsetUncertaintyMs,
  ServerClock,
} from "../src/index.js";

describe("medianOffsetMs", () => {
  it("corrects each sample by RTT/2 and takes the median", () => {
    // Server is 5_000 ms ahead; symmetric trips of 40, 100 and 20 ms.
    const samples = [
      { sentMs: 1_000, serverMs: 6_020, receivedMs: 1_040 },
      { sentMs: 2_000, serverMs: 7_050, receivedMs: 2_100 },
      { sentMs: 3_000, serverMs: 8_010, receivedMs: 3_020 },
    ];
    expect(medianOffsetMs(samples)).toBe(5_000);
  });

  it("property: with symmetric trips the true offset is recovered despite outliers", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 3, maxLength: 9 }),
        fc.integer({ min: 0, max: 60_000 }),
        (offset, rtts, outlierDelay) => {
          let t = 1_700_000_000_000;
          const samples = rtts.map((rtt) => {
            const half = rtt - (rtt % 2);
            const s = { sentMs: t, serverMs: t + half / 2 + offset, receivedMs: t + half };
            t += 1_000;
            return s;
          });
          // One asymmetric outlier: the reply sat in a queue for `outlierDelay` ms.
          samples.push({ sentMs: t, serverMs: t + offset, receivedMs: t + outlierDelay });
          samples.push({ sentMs: t + 1, serverMs: t + 1 + offset, receivedMs: t + 1 });
          const est = medianOffsetMs(samples);
          expect(Math.abs(est - offset)).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it("rejects an empty sample set", () => {
    expect(() => medianOffsetMs([])).toThrow();
    expect(() => offsetUncertaintyMs([], 0)).toThrow();
  });
});

describe("offsetUncertaintyMs", () => {
  it("property: the true offset is always within the reported uncertainty of the median", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        fc.array(
          fc.record({
            out: fc.integer({ min: 0, max: 2_000 }),
            back: fc.integer({ min: 0, max: 2_000 }),
          }),
          { minLength: 1, maxLength: 9 },
        ),
        (offset, trips) => {
          let t = 1_700_000_000_000;
          // The server reads its clock (whole ms) `out` after the send, `back` before the reply.
          const samples = trips.map(({ out, back }) => {
            const s = { sentMs: t, serverMs: t + out + offset, receivedMs: t + out + back };
            t += 5_000;
            return s;
          });
          const est = medianOffsetMs(samples);
          expect(Math.abs(est - offset)).toBeLessThanOrEqual(offsetUncertaintyMs(samples, est));
        },
      ),
    );
  });

  it("is about half the round trip when one trip is short and symmetric", () => {
    const samples = [{ sentMs: 0, serverMs: 5_050, receivedMs: 100 }];
    expect(offsetUncertaintyMs(samples, medianOffsetMs(samples))).toBe(51);
  });
});

describe("ServerClock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("signs at floor(server-now seconds) − 1 and logs on at server-now − 1 s in ms", async () => {
    let local = 1_700_000_000_000;
    const server = () => local + 42_750;
    const clock = new ServerClock({ now: () => local, fetchServerTimeMs: async () => server() });
    expect(clock.synced).toBe(false);
    expect(() => clock.signingTimestampSec()).toThrow(ClockNotSyncedError);
    await clock.sync();
    expect(clock.offsetMs).toBe(42_750);
    for (const step of [0, 249, 1, 999, 1_000, 123_456]) {
      local += step;
      expect(clock.signingTimestampSec()).toBe(Math.floor(server() / 1000) - 1);
      expect(clock.logonTimestampMs()).toBe(server() - 1_000);
      // Never ahead of the server, never older than the 180 s window.
      const nowSec = Math.floor(server() / 1000);
      expect(clock.signingTimestampSec()).toBeLessThan(nowSec);
      expect(nowSec - clock.signingTimestampSec()).toBeLessThanOrEqual(2);
    }
  });

  it("resyncs on a signature-expired 401 and shares one sync among concurrent callers", async () => {
    let calls = 0;
    let skew = 0;
    const clock = new ServerClock({
      now: () => 1_000_000,
      samples: 3,
      fetchServerTimeMs: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 1));
        return 1_000_000 + skew;
      },
    });
    await clock.sync();
    expect(calls).toBe(3);
    skew = 90_000;
    await Promise.all([clock.onSignatureExpired(), clock.onSignatureExpired(), clock.sync()]);
    expect(calls).toBe(6);
    expect(clock.offsetMs).toBe(90_000);
  });

  it("reads GET /v2/time on the API host, never exchangeInfo", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ serverTime: 1_792_438_549_384 }), { status: 200 });
    }) as typeof fetch;
    const http = createPublicHttp({
      baseUrl: "https://api.example",
      userAgent: "t",
      fetch: fetchImpl,
    });
    const clock = new ServerClock({ fetchServerTimeMs: apiTimeSource(http), samples: 2 });
    await clock.sync();
    expect(urls).toEqual(["https://api.example/v2/time", "https://api.example/v2/time"]);
    expect(urls.some((u) => u.includes("exchangeInfo"))).toBe(false);
  });

  it("resyncs periodically once started, reports failures and keeps the last good offset", async () => {
    vi.useFakeTimers();
    let skew = 1_000;
    let fail = false;
    const errors: unknown[] = [];
    const clock = new ServerClock({
      now: () => 50_000,
      samples: 1,
      resyncIntervalMs: 60_000,
      fetchServerTimeMs: async () => {
        if (fail) throw new Error("time endpoint down");
        return 50_000 + skew;
      },
      onError: (e) => errors.push(e),
    });
    await clock.sync();
    clock.start();
    clock.start(); // idempotent
    skew = 4_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clock.offsetMs).toBe(4_000);
    fail = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toHaveLength(1);
    expect(clock.offsetMs).toBe(4_000);
    expect(clock.uncertaintyMs).toBe(1);
    clock.stop();
    fail = false;
    skew = 9_000;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(clock.offsetMs).toBe(4_000);
  });

  it("reports its age and uncertainty", async () => {
    let local = 1_000;
    const clock = new ServerClock({
      now: () => local,
      samples: 3,
      fetchServerTimeMs: async () => {
        local += 40;
        return local + 7_000;
      },
    });
    expect(clock.ageMs()).toBe(Number.POSITIVE_INFINITY);
    expect(clock.uncertaintyMs).toBe(Number.POSITIVE_INFINITY);
    await clock.sync();
    local += 500;
    expect(clock.ageMs()).toBe(500);
    expect(clock.uncertaintyMs).toBeLessThanOrEqual(41);
  });

  it("refuses a nonsense serverTime", async () => {
    const clock = new ServerClock({ fetchServerTimeMs: async () => Number.NaN });
    await expect(clock.sync()).rejects.toThrow(/invalid serverTime/);
    expect(clock.synced).toBe(false);
  });
});
