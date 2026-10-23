import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiWalletSigner,
  batchOrders,
  ClientOrderIdFactory,
  classifyUserMessage,
  limitOrder,
  parseJsonExact,
  ServerClock,
  UserStream,
  type UserStreamAlarm,
  type UserStreamEvent,
  type UserStreamOptions,
  type UserStreamState,
} from "../src/index.js";
import { type Harness, startHarness, UA } from "./helpers.js";

let h: Harness | undefined;
const streams: UserStream[] = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.stop();
  await h?.stop();
  h = undefined;
});

const ids = new ClientOrderIdFactory("us");

function open(h: Harness, over: Partial<UserStreamOptions> = {}) {
  const events: UserStreamEvent[] = [];
  const resyncs: { accountId: string; connection: number }[] = [];
  const states: UserStreamState[] = [];
  const stream = new UserStream({
    url: h.fake.wsUrl,
    userAgent: UA,
    signer: h.signer,
    clock: h.clock,
    maxBackoffMs: 20,
    onEvent: (e) => events.push(e),
    onResyncNeeded: (info) => resyncs.push(info),
    onStateChange: (s) => states.push(s),
    ...over,
  });
  streams.push(stream);
  stream.start();
  return { stream, events, resyncs, states };
}

describe("UserStream", () => {
  it("logs on with a ms timestamp, subscribes, asks for a resync, then delivers events", async () => {
    h = await startHarness();
    const { stream, events, resyncs, states } = open(h, { expectedAccountId: h.accountId });
    await vi.waitFor(() => expect(stream.live).toBe(true));
    expect(resyncs).toEqual([{ accountId: h.accountId, connection: 1 }]);
    expect(states.slice(0, 4)).toEqual(["connecting", "logging-on", "subscribing", "live"]);
    expect(h.fake.logons).toEqual([{ ok: true, accountId: h.accountId, userAgent: UA }]);

    const order = limitOrder({
      clientOrderId: ids.next(),
      symbol: "NIGHT-USD",
      side: "sell",
      size: "300",
      price: "0.0389",
      postOnly: true,
    });
    await h.client.placeBatch(batchOrders([order]));
    await vi.waitFor(() => expect(events.filter((e) => e.kind === "order")).toHaveLength(2));
    const updates = events.flatMap((e) => (e.kind === "order" ? [e.data] : []));
    expect(updates.map((u) => [u.c, u.S, u.o, u.X])).toEqual([
      [order.client_order_id, "SELL", "LIMIT", "NEW"],
      [order.client_order_id, "SELL", "LIMIT", "OPEN"],
    ]);
    expect(typeof updates[0]?.i).toBe("bigint");
  });

  it("reconnects after a drop, logs on again and asks for a resync every time", async () => {
    h = await startHarness();
    const { stream, resyncs, states } = open(h);
    await vi.waitFor(() => expect(stream.live).toBe(true));
    h.fake.dropUserSockets(undefined, 1012);
    await vi.waitFor(() => expect(states).toContain("closed"));
    await vi.waitFor(() => expect(resyncs).toHaveLength(2), { timeout: 3_000 });
    expect(stream.live).toBe(true);
    expect(resyncs[1]?.connection).toBe(2);
    expect(h.fake.logons.filter((l) => l.ok)).toHaveLength(2);
    expect(h.fake.subscribedSockets(h.accountId)).toBe(1);
  });

  it("recovers from a rejected logon (stale clock) by re-syncing and logging on again", async () => {
    h = await startHarness();
    h.fake.skewMs = 200_000; // our clock now signs logons 200 s in the past
    const { stream, events } = open(h);
    await vi.waitFor(() => expect(stream.live).toBe(true), { timeout: 3_000 });
    expect(h.fake.logons.map((l) => l.ok)).toEqual([false, true]);
    expect(h.fake.logons[0]?.reason).toBe("timestamp window");
    expect(events).toContainEqual({ kind: "error", code: 401, msg: "Authentication failed" });
  });

  it("stops when the logon binds to an unexpected account", async () => {
    h = await startHarness();
    const fatal: string[] = [];
    const { stream } = open(h, {
      expectedAccountId: "someone-else",
      onFatal: (r) => fatal.push(r),
    });
    await vi.waitFor(() => expect(fatal).toHaveLength(1));
    expect(stream.live).toBe(false);
    expect(stream.state).toBe("stopped");
  });

  it("drops, reconnects and escalates when session.logon or subscribe goes unanswered", async () => {
    h = await startHarness();
    for (const method of ["session.logon", "subscribe"] as const) {
      h.fake.unansweredMethods.add(method);
      const alarms: UserStreamAlarm[] = [];
      const { stream, states } = open(h, {
        handshakeTimeoutMs: 40,
        alarmAfterFailedConnections: 2,
        onAlarm: (a) => alarms.push(a),
      });
      await vi.waitFor(() => expect(alarms).toHaveLength(1), { timeout: 3_000 });
      expect(alarms[0]).toEqual({
        kind: "handshake-failing",
        stage: method,
        failedConnections: 2,
        lastError: `${method} not answered`,
      });
      expect(states.filter((s) => s === "closed").length).toBeGreaterThanOrEqual(2);
      expect(stream.live).toBe(false);
      h.fake.unansweredMethods.delete(method);
      await vi.waitFor(() => expect(stream.live).toBe(true), { timeout: 3_000 });
      stream.stop();
    }
  });

  it("raises a handshake-failing alarm while every connection fails to log on", async () => {
    h = await startHarness();
    const alarms: UserStreamAlarm[] = [];
    // A key Strike does not know (revoked, or never registered): every logon is a 401.
    const { stream } = open(h, {
      signer: ApiWalletSigner.fromSeed(randomBytes(32)),
      maxLogonAttempts: 2,
      alarmAfterFailedConnections: 2,
      onAlarm: (a) => alarms.push(a),
    });
    await vi.waitFor(() => expect(alarms.length).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    expect(alarms[0]).toEqual({
      kind: "handshake-failing",
      stage: "session.logon",
      failedConnections: 2,
      lastError: "401 Authentication failed",
    });
    expect(alarms[1]).toMatchObject({ kind: "handshake-failing", failedConnections: 4 });
    expect(stream.live).toBe(false);
    // Two logon attempts on each socket before it is dropped.
    expect(h.fake.logons.filter((l) => !l.ok).length).toBeGreaterThanOrEqual(8);
  });

  it("a clock resync that hangs after a rejected logon still times the handshake out", async () => {
    h = await startHarness();
    const fake = h.fake;
    let calls = 0;
    const clock = new ServerClock({
      samples: 1,
      fetchServerTimeMs: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve(fake.serverNow()) : new Promise<number>(() => {});
      },
    });
    await clock.sync();
    fake.skewMs = 200_000;
    const { stream, states } = open(h, { clock, handshakeTimeoutMs: 40 });
    // Without the timer the stream would sit in logging-on forever, waiting on the sync.
    await vi.waitFor(() => expect(states).toContain("closed"));
    expect(stream.live).toBe(false);
    expect(calls).toBeGreaterThan(1);
  });

  it("allows one socket per account", async () => {
    h = await startHarness();
    open(h);
    expect(() => open(h as Harness)).toThrow(/already running/);
  });
});

describe("classifyUserMessage", () => {
  const parse = (s: string) => classifyUserMessage(parseJsonExact(s));

  it("types a fill from the strike-userstream example, keeping ids exact", () => {
    const e = parse(
      '{"e":"ORDER_TRADE_UPDATE","E":1792440000200,"data":{"s":"BTC-USD","c":"my-order-001","S":"BUY","o":"LIMIT","f":"GTC","q":"0.5","p":"80000","ap":"","sp":"0","x":"TRADE","X":"OPEN","i":9007199254740993,"cr":"","l":"0.1","z":"0.1","L":"80000","N":"USDT","n":"4","ott":1792440000150,"t":18073,"b":"","a":"","m":false,"R":false,"wt":"","ot":"LIMIT","ps":"BOTH","cp":false,"rp":"0","act":"","E":1792440000150,"T":1792440000150,"account_id":"01a1","fill_id":"36026","position_id":"3232","position_seq":22,"position_context":{"known":true,"size":"0","entry_price":"0","margin_mode":"cross","leverage":20,"funding":"0","open_timestamp":0},"builder_fee":"0.8","order_id":"9007199254740993","trade_id":"18073"}}',
    );
    expect(e.kind).toBe("fill");
    if (e.kind !== "fill") return;
    expect(e.data.i).toBe(9007199254740993n);
    expect(e.data.t).toBe(18073n);
    expect(e.data.builder_fee).toBe("0.8");
    expect(e.data.m).toBe(false);
    expect(e.data.c).toBe("my-order-001");
  });

  it("separates order updates (t = 0) from fills", () => {
    const e = classifyUserMessage({
      e: "ORDER_TRADE_UPDATE",
      E: 1,
      data: { c: "x", X: "CANCELED", i: 5, t: 0 },
    });
    expect(e).toMatchObject({ kind: "order", data: { i: 5n, t: 0n, X: "CANCELED" } });
  });

  it("types every ACCOUNT_UPDATE variant", () => {
    const au = (data: unknown) => classifyUserMessage({ e: "ACCOUNT_UPDATE", E: 7, data });
    expect(
      au({ e: "ORDER", B: [{ a: "USDT", wb: "1", cw: "1", bc: "0" }], P: [], r: "FILL" }),
    ).toMatchObject({
      kind: "balance",
      reason: "FILL",
      variant: "ORDER",
    });
    expect(
      au({ e: "POSITION_UPDATE", B: [], P: [{ s: "NIGHT-USD", pa: "-300" }], r: "", T: 9 }),
    ).toMatchObject({
      kind: "position",
      T: 9,
      positions: [{ s: "NIGHT-USD", pa: "-300" }],
    });
    expect(au({ e: "WITHDRAWAL_SETTLED", B: [], P: [], r: "WITHDRAWAL_SETTLED" })).toMatchObject({
      kind: "transfer",
      variant: "WITHDRAWAL_SETTLED",
    });
    expect(
      au({ event_type: "LEVERAGE_UPDATED", event_data: { request_id: "r1", leverage: 2 } }),
    ).toMatchObject({
      kind: "leverage",
      ok: true,
      data: { request_id: "r1" },
    });
    expect(
      au({ event_type: "LEVERAGE_UPDATE_FAILED", event_data: { request_id: "r2", error: "x" } }),
    ).toMatchObject({
      kind: "leverage",
      ok: false,
    });
    expect(au({ event_type: "MARGIN_UPDATE_FAILED", event_data: {} })).toMatchObject({
      kind: "margin",
      ok: false,
    });
    expect(au({ event_type: "VAULT_DEPOSITED", event_data: {} })).toMatchObject({
      kind: "account-event",
      eventType: "VAULT_DEPOSITED",
    });
  });

  it("types errors, strategy and RFQ updates, and leaves the rest unknown", () => {
    expect(
      classifyUserMessage({ e: "error", E: 1, error: { code: 401, msg: "Authentication failed" } }),
    ).toEqual({
      kind: "error",
      code: 401,
      msg: "Authentication failed",
    });
    expect(classifyUserMessage({ e: "strategyUpdate", E: 1, s: "BTC-USD", data: {} }).kind).toBe(
      "strategy",
    );
    expect(classifyUserMessage({ e: "rfqUpdate", E: 1, data: {} }).kind).toBe("rfq");
    expect(classifyUserMessage({ e: "mystery", data: {} }).kind).toBe("unknown");
    expect(classifyUserMessage("x").kind).toBe("unknown");
  });
});
