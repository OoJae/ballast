import { DaemonKey, OperatorKey } from "@ballast/governance";
import { describe, expect, it, vi } from "vitest";
import {
  type Alert,
  createDeadMan,
  createTelegramNotifier,
  HeartbeatMonitor,
  HeartbeatPublisher,
  type HeartbeatSink,
  httpHeartbeatSink,
  renderAlert,
  type SignedHeartbeat,
  safeNotifier,
  signHeartbeat,
  startHealthServer,
  startHeartbeatReceiver,
} from "../src/index.js";

const daemon = DaemonKey.fromSeed(new Uint8Array(32).fill(3));
const other = DaemonKey.fromSeed(new Uint8Array(32).fill(4));
const T0 = 1_792_716_885_000;
const quiet = { debug: () => {}, info: () => {}, warn: () => {} };

function body(over: Partial<SignedHeartbeat> = {}) {
  return {
    v: 1 as const,
    kind: "ballast/heartbeat" as const,
    daemonPubkey: daemon.publicKeyHex,
    bootId: "00112233445566aa",
    seq: 1,
    tsMs: T0,
    mode: "dry-run" as const,
    state: "running" as const,
    decisionHead: { seq: 4, hash: "a".repeat(64) },
    accounts: [{ accountId: "acct-1", symbol: "NIGHT-USD", restingAsks: 2, quoting: true }],
    ...over,
  };
}

describe("signed heartbeats", () => {
  it("accept a fresh heartbeat from a trusted daemon, refuse tampering and other keys", () => {
    let now = T0 + 100;
    const mon = new HeartbeatMonitor({ trustedDaemons: [daemon.publicKeyHex], now: () => now });
    expect(mon.alive()).toBe(false);
    const hb = signHeartbeat(body(), daemon);
    expect(mon.offer(hb).ok).toBe(true);
    expect(mon.alive()).toBe(true);
    expect(mon.offer({ ...signHeartbeat(body({ seq: 2 }), daemon), state: "stopping" }).ok).toBe(
      false,
    );
    expect(
      mon.offer(signHeartbeat({ ...body({ seq: 3 }), daemonPubkey: other.publicKeyHex }, other)).ok,
    ).toBe(false);
    // An operator key cannot sign a heartbeat at all.
    expect(() =>
      signHeartbeat(body(), OperatorKey.fromSeed(new Uint8Array(32).fill(5)) as never),
    ).toThrow();
    now = T0 + 10_001;
    expect(mon.alive()).toBe(false);
  });

  it("refuse replays, reordering, future dates and already-dead heartbeats", () => {
    let now = T0;
    const mon = new HeartbeatMonitor({ trustedDaemons: [daemon.publicKeyHex], now: () => now });
    const first = signHeartbeat(body({ seq: 5 }), daemon);
    expect(mon.offer(first).ok).toBe(true);
    expect(mon.offer(first)).toMatchObject({ ok: false, reason: "replayed or reordered seq" });
    expect(mon.offer(signHeartbeat(body({ seq: 4 }), daemon)).ok).toBe(false);
    expect(mon.offer(signHeartbeat(body({ seq: 6, tsMs: T0 + 60_000 }), daemon)).ok).toBe(false);
    now = T0 + 20_000;
    expect(mon.offer(signHeartbeat(body({ seq: 7 }), daemon)).ok).toBe(false);
    // A new boot is accepted only if it is newer than the last accepted heartbeat.
    expect(
      mon.offer(signHeartbeat(body({ bootId: "ffeeddccbbaa9988", seq: 1, tsMs: now }), daemon)).ok,
    ).toBe(true);
    expect(
      mon.offer(signHeartbeat(body({ bootId: "0011223344556677", seq: 9, tsMs: now - 1 }), daemon))
        .ok,
    ).toBe(false);
  });

  it("publish every interval over HTTP to the watchdog's receiver", async () => {
    const mon = new HeartbeatMonitor({ trustedDaemons: [daemon.publicKeyHex] });
    const rx = await startHeartbeatReceiver({ monitor: mon });
    const pub = new HeartbeatPublisher({
      key: daemon,
      sink: httpHeartbeatSink([rx.url]),
      intervalMs: 20,
      snapshot: () => ({
        mode: "armed",
        state: "running",
        decisionHead: { seq: 1, hash: null },
        accounts: [],
      }),
    });
    pub.start();
    await vi.waitFor(() => expect(mon.latest()?.seq ?? 0).toBeGreaterThanOrEqual(3));
    pub.stop();
    await rx.close();
    expect(mon.latest()?.bootId).toBe(pub.bootId);
  });

  it("a failing sink never throws out of beat()", async () => {
    const errors: unknown[] = [];
    const sink: HeartbeatSink = { publish: async () => Promise.reject(new Error("down")) };
    const pub = new HeartbeatPublisher({
      key: daemon,
      sink,
      onError: (e) => errors.push(e),
      snapshot: () => ({
        mode: "dry-run",
        state: "running",
        decisionHead: { seq: 0, hash: null },
        accounts: [],
      }),
    });
    await expect(pub.beat()).resolves.toBeNull();
    expect(errors).toHaveLength(1);
  });
});

describe("telegram", () => {
  const alert: Alert = {
    kind: "kill",
    source: "watchdog",
    severity: "page",
    title: "no heartbeat for 10 s <b>",
    detail: "token 123456:SECRETSECRET and key deadbeefdeadbeef",
    accountId: "acct-1",
    symbol: "NIGHT-USD",
  };

  it("escapes HTML and scrubs the token and configured secrets from text and logs", async () => {
    const sent: string[] = [];
    const warns: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent.push(String(init?.body));
      return new Response("bad 123456:SECRETSECRET", { status: 500, statusText: String(url) });
    });
    const n = createTelegramNotifier({
      botToken: "123456:SECRETSECRET",
      chatId: "42",
      secrets: ["deadbeefdeadbeef"],
      logger: { ...quiet, warn: (o: unknown) => warns.push(o) },
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await n.notify(alert);
    expect(sent[0]).toContain("&lt;b&gt;");
    expect(sent[0]).not.toContain("SECRETSECRET");
    expect(sent[0]).not.toContain("deadbeefdeadbeef");
    expect(JSON.stringify(warns)).not.toContain("SECRETSECRET");
    expect(renderAlert(alert)).toContain("BALLAST watchdog [PAGE] kill");
  });

  it("is a no-op without configuration and safeNotifier absorbs hangs and throws", async () => {
    const fetchImpl = vi.fn();
    await createTelegramNotifier({ logger: quiet, fetch: fetchImpl as never }).notify(alert);
    expect(fetchImpl).not.toHaveBeenCalled();
    const hung = safeNotifier({ notify: () => new Promise(() => {}) }, quiet, 20);
    await expect(hung.notify(alert)).resolves.toBeUndefined();
    const throws = safeNotifier(
      {
        notify: () => {
          throw new Error("x");
        },
      },
      quiet,
    );
    await expect(throws.notify(alert)).resolves.toBeUndefined();
  });
});

describe("health and dead-man", () => {
  it("serves 200 when ok, 503 otherwise", async () => {
    let ok = true;
    const h = await startHealthServer({
      report: () => ({ ok, role: "keeper", mode: "dry-run", problems: ok ? [] : ["stale L3"] }),
    });
    expect((await fetch(h.url)).status).toBe(200);
    ok = false;
    const res = await fetch(h.url);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ problems: ["stale L3"] });
    await h.close();
  });

  it("pings success and /fail, throttled per state, and stays silent without a URL", async () => {
    let now = 0;
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      urls.push(String(u));
      return new Response(null, { status: 200 });
    });
    const dm = createDeadMan({
      url: "https://hc.example/abc/",
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => now,
      minIntervalMs: 1_000,
    });
    await dm.ping(true);
    await dm.ping(true);
    now = 500;
    await dm.ping(false);
    now = 1_600;
    await dm.ping(true);
    expect(urls).toEqual([
      "https://hc.example/abc",
      "https://hc.example/abc/fail",
      "https://hc.example/abc",
    ]);
    const off = vi.fn();
    await createDeadMan({ fetch: off as never }).ping(true);
    expect(off).not.toHaveBeenCalled();
  });
});
