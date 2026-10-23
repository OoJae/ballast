import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { FakeStrike } from "../src/index.js";

// A signer written from the docs alone, independent of @ballast/strike-client.
function keypair() {
  const seed = randomBytes(32);
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const pub = createPublicKey(key)
    .export({ format: "der", type: "spki" })
    .subarray(12)
    .toString("hex");
  return { key, pub };
}

let fake: FakeStrike;
let kp: ReturnType<typeof keypair>;
const ACCOUNT = "acct-1";

beforeEach(async () => {
  fake = new FakeStrike({ engineDelayMs: 1 });
  await fake.start();
  kp = keypair();
  fake.addAccount({ publicKeyHex: kp.pub, accountId: ACCOUNT });
});
afterEach(async () => {
  await fake.stop();
});

async function call(
  method: string,
  target: string,
  body?: string,
  over: { ts?: number; nonce?: string; sigKey?: typeof kp; headers?: Record<string, string> } = {},
) {
  const ts = over.ts ?? Math.floor(fake.serverNow() / 1000) - 1;
  const nonce = over.nonce ?? randomUUID();
  const hash = createHash("sha256")
    .update(body ?? "")
    .digest("hex");
  const msg = `${method}:${target}:${ts}:${nonce}:${hash}`;
  const signer = over.sigKey ?? kp;
  const res = await fetch(`${fake.baseUrl}${target}`, {
    method,
    headers: {
      "User-Agent": "fake-test",
      "X-API-Wallet-Public-Key": kp.pub,
      "X-API-Wallet-Signature": sign(null, Buffer.from(msg), signer.key).toString("hex"),
      "X-API-Wallet-Timestamp": String(ts),
      "X-API-Wallet-Nonce": nonce,
      ...over.headers,
    },
    ...(body !== undefined ? { body } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const ask = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    client_order_id: `bal_${randomUUID()}`,
    symbol: "NIGHT-USD",
    side: "sell",
    type: "limit",
    size: "300",
    price: "0.0389",
    post_only: true,
    ...over,
  });

describe("REST authentication", () => {
  it("verifies Ed25519 over METHOD:PATH?QUERY:TS:NONCE:sha256(body)", async () => {
    expect(await call("GET", "/v2/openOrders?symbol=NIGHT-USD")).toEqual({
      status: 200,
      json: { orders: [], count: 0 },
    });
  });

  it("enforces the 180 s window, never the future, and single-use nonces", async () => {
    // Read the clock per call: a slow run must not drift a case across a second boundary.
    const now = () => Math.floor(fake.serverNow() / 1000);
    const expired = { error: "signature expired or invalid timestamp" };
    expect((await call("GET", "/v2/positions", undefined, { ts: now() - 181 })).json).toEqual(
      expired,
    );
    expect((await call("GET", "/v2/positions", undefined, { ts: now() + 5 })).json).toEqual(
      expired,
    );
    expect((await call("GET", "/v2/positions", undefined, { ts: now() - 170 })).status).toBe(200);
    const nonce = randomUUID();
    expect((await call("GET", "/v2/positions", undefined, { nonce })).status).toBe(200);
    expect((await call("GET", "/v2/positions", undefined, { nonce })).json).toEqual({
      error: "request already processed",
    });
  });

  it("rejects bad headers, a wrong key and a signature over different bytes", async () => {
    expect((await call("GET", "/v2/positions", undefined, { nonce: "short" })).json).toEqual({
      error: "invalid nonce format",
    });
    expect(
      (
        await call("GET", "/v2/positions", undefined, {
          headers: { "X-API-Wallet-Timestamp": "1.5" },
        })
      ).json,
    ).toEqual({ error: "invalid timestamp format" });
    expect((await call("GET", "/v2/positions", undefined, { sigKey: keypair() })).json).toEqual({
      error: "authentication failed",
    });
    const r = await fetch(`${fake.baseUrl}/v2/positions`);
    expect(await r.json()).toEqual({ error: "missing API wallet authentication headers" });
  });
});

describe("REST binding and engine semantics", () => {
  it("binds single creates strictly: lowercase enums, required fields, reserved prefixes", async () => {
    expect((await call("POST", "/v2/order", ask({ side: "SELL" }))).json.error).toMatch(
      /'Side' failed on the 'oneof'/,
    );
    expect((await call("POST", "/v2/order", ask({ type: "LIMIT" }))).json.error).toMatch(
      /'Type' failed/,
    );
    expect((await call("POST", "/v2/order", ask({ time_in_force: "gtc" }))).json.error).toMatch(
      /TimeInForce/,
    );
    expect((await call("POST", "/v2/order", ask({ client_order_id: "liq_1" }))).status).toBe(400);
    const ok = await call("POST", "/v2/order", ask());
    expect(ok).toMatchObject({ status: 201, json: { status: "pending", account_id: ACCOUNT } });
  });

  it("batch items: empty symbol fails, unknown symbol or missing side is accepted then dropped", async () => {
    const body = JSON.stringify({
      orders: [
        JSON.parse(ask({ symbol: "" })),
        JSON.parse(ask({ symbol: "FOO-USD", client_order_id: "bal_foo" })),
        { ...JSON.parse(ask({ client_order_id: "bal_noside" })), side: undefined },
      ],
    });
    const r = await call("POST", "/v2/orders/batch", body);
    expect(r.json.failed).toEqual([{ index: 0, error: "invalid_symbol" }]);
    expect(r.json.successful).toHaveLength(2);
    await vi.waitFor(() => expect(fake.engine.orders.size).toBe(0));
    await new Promise((res) => setTimeout(res, 20));
    expect(fake.engine.orders.size).toBe(0);
    expect((await call("GET", "/v2/order?symbol=FOO-USD&client_order_id=bal_foo")).status).toBe(
      404,
    );
  });

  it("replace-batch build errors carry failed_index; duplicates and empty bodies are refused", async () => {
    const leg = JSON.parse(ask());
    expect(
      (await call("POST", "/v2/order/replace-batch", JSON.stringify({ replacements: [{}] }))).json,
    ).toEqual({
      error: "replacement at index 0 must include cancel or new_order",
      failed_index: 0,
    });
    expect(
      (
        await call(
          "POST",
          "/v2/order/replace-batch",
          JSON.stringify({ replacements: [{ new_order: leg }, { new_order: leg }] }),
        )
      ).json,
    ).toEqual({ error: "duplicate_request_id" });
    expect(
      (
        await call(
          "POST",
          "/v2/order/replace-batch",
          JSON.stringify({ replacements: [{ cancel: { symbol: "NIGHT-USD" } }] }),
        )
      ).json,
    ).toEqual({ error: "order_id_not_set", failed_index: 0 });
    expect((await call("DELETE", "/v2/order/cancel-all", "")).json).toEqual({ error: "EOF" });
  });

  it("IOC remainders expire, FOK expires unless fully fillable, reduce-only needs a position", () => {
    const acct = fake.engine.accounts.get(ACCOUNT);
    if (!acct) throw new Error("no account");
    fake.engine.restMarketOrder("NIGHT-USD", "sell", "0.0390", "500");
    const take = (id: string, over: Record<string, unknown>) =>
      fake.engine.create(acct, {
        client_order_id: id,
        symbol: "NIGHT-USD",
        side: "buy",
        type: "limit",
        size: "800",
        price: "0.0391",
        ...over,
      });
    fake.engine.setPosition(acct, "NIGHT-USD", "-2000", "0.04");
    take("fok", { time_in_force: "FOK", reduce_only: true });
    expect(fake.engine.findByClientId(ACCOUNT, "fok")).toMatchObject({
      status: "expired",
      filled: 0n,
    });
    take("ioc", { time_in_force: "IOC", reduce_only: true });
    expect(fake.engine.findByClientId(ACCOUNT, "ioc")).toMatchObject({
      status: "expired",
      filled: 500n * 10n ** 18n,
    });
    fake.engine.setPosition(acct, "NIGHT-USD", "0", "0");
    expect(take("ro", { time_in_force: "IOC", reduce_only: true })).toEqual({
      ok: false,
      code: "no_open_position",
    });
    fake.engine.setPosition(acct, "NIGHT-USD", "100", "0.04");
    expect(take("ro2", { time_in_force: "IOC", reduce_only: true })).toEqual({
      ok: false,
      code: "order_increase_position",
    });
  });

  it("injects 429 and 503 after authentication, consuming the nonce", async () => {
    fake.failNext({ path: "/v2/positions", status: 429 });
    const nonce = randomUUID();
    expect(await call("GET", "/v2/positions", undefined, { nonce })).toEqual({
      status: 429,
      json: { error: "rate limit exceeded" },
    });
    expect((await call("GET", "/v2/positions", undefined, { nonce })).json.error).toBe(
      "request already processed",
    );
  });
});

describe("user WebSocket", () => {
  function connect() {
    const ws = new WebSocket(fake.wsUrl, { headers: { "User-Agent": "fake-test" } });
    const inbox: Record<string, unknown>[] = [];
    ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
    return { ws, inbox, ready: new Promise<void>((r) => ws.once("open", () => r())) };
  }
  const logon = (ts: number, key = kp) => ({
    id: 1,
    method: "session.logon",
    params: {
      apiKey: kp.pub,
      signature: sign(null, Buffer.from(`session.logon:${ts}:${kp.pub}`), key.key).toString("hex"),
      timestamp: ts,
    },
  });

  it("verifies session.logon (ms, ≤ 30 s ahead, ≤ 3 min old) and keeps the socket open on failure", async () => {
    const { ws, inbox, ready } = connect();
    await ready;
    ws.send(JSON.stringify({ method: "subscribe", channel: "userstream", id: 9 }));
    ws.send(JSON.stringify(logon(fake.serverNow() - 181_000)));
    ws.send(JSON.stringify(logon(fake.serverNow() + 31_000)));
    ws.send(JSON.stringify(logon(fake.serverNow(), keypair())));
    ws.send(JSON.stringify(logon(fake.serverNow() + 29_000)));
    await vi.waitFor(() => expect(inbox).toHaveLength(5));
    expect(inbox.slice(0, 4).map((m) => (m.error as { code: number }).code)).toEqual([
      401, 401, 401, 401,
    ]);
    expect(inbox[4]).toEqual({
      id: 1,
      status: 200,
      result: { authenticated: true, account_id: ACCOUNT },
    });
    ws.send(JSON.stringify({ method: "subscribe", channel: "userstream", id: 2 }));
    await vi.waitFor(() => expect(inbox[5]).toEqual({ result: null, id: 2 }));
    expect(fake.subscribedSockets(ACCOUNT)).toBe(1);
    ws.close();
  });

  it("delivers order events after the 201, with event filters, delays and socket drops", async () => {
    const { ws, inbox, ready } = connect();
    await ready;
    ws.send(JSON.stringify(logon(fake.serverNow() - 1_000)));
    ws.send(JSON.stringify({ method: "subscribe", channel: "userstream", id: 2 }));
    await vi.waitFor(() => expect(fake.subscribedSockets(ACCOUNT)).toBe(1));
    fake.setEventFilter((_a, m) => (m.data as { X?: string }).X === "NEW");
    const r = await call("POST", "/v2/order", ask());
    expect(r.status).toBe(201);
    await vi.waitFor(() => expect(inbox.some((m) => m.e === "ORDER_TRADE_UPDATE")).toBe(true));
    const events = inbox
      .filter((m) => m.e === "ORDER_TRADE_UPDATE")
      .map((m) => (m.data as { X: string }).X);
    expect(events).toEqual(["OPEN"]);
    fake.setEventFilter(undefined);
    fake.eventDelayMs = 400;
    const before = inbox.length;
    await call("POST", "/v2/order", ask({ price: "0.0390" }));
    await fake.idle();
    expect(inbox.length).toBe(before);
    await vi.waitFor(() => expect(inbox.length).toBe(before + 2), { timeout: 3_000 });
    const closed = new Promise<number>((res) => ws.once("close", (code) => res(code)));
    fake.dropUserSockets(ACCOUNT, 1012);
    expect(await closed).toBe(1012);
  });
});
