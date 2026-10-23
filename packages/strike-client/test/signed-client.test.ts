import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  batchOrders,
  ClientOrderIdFactory,
  cancelAll,
  cancelOrder,
  limitOrder,
  RateLimiter,
  reduceOnlyBuyBack,
  replaceBatch,
  restSigningMessage,
  ServerClock,
  type SignedClientAlarm,
  StrikeApiError,
  StrikeRefusedError,
  StrikeTransportError,
} from "../src/index.js";
import { type Harness, startHarness, UA } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const ids = new ClientOrderIdFactory("sc");
const ask = (price = "0.0389", size = "300") =>
  limitOrder({
    clientOrderId: ids.next(),
    symbol: "NIGHT-USD",
    side: "sell",
    size,
    price,
    postOnly: true,
  });

function requestsTo(h: Harness, path: string) {
  return h.fake.requests.filter((r) => r.target.split("?")[0] === path);
}

describe("SignedClient against the fake server", () => {
  it("signs reads and writes that the fake verifies, with the custom User-Agent", async () => {
    h = await startHarness();
    expect(await h.client.openOrders("NIGHT-USD")).toEqual({ orders: [], count: 0 });
    const order = ask();
    const res = await h.client.placeBatch(batchOrders([order]));
    expect(res.failed).toBeNull();
    expect(res.successful?.[0]).toMatchObject({
      client_order_id: order.client_order_id,
      status: "pending",
    });
    for (const r of h.fake.requests) {
      expect(r.status).toBeLessThan(300);
      expect(r.headers["user-agent"]).toBe(UA);
      expect(r.headers["x-api-wallet-public-key"]).toBe(h.signer.publicKeyHex);
      expect(r.headers["x-api-wallet-nonce"]).toMatch(/^[0-9a-f-]{36}$/);
    }
    const write = requestsTo(h, "/v2/orders/batch")[0];
    expect(write?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(write?.body ?? "")).toEqual({ orders: [order] });
    expect(h.fake.requests[0]?.target).toBe("/v2/openOrders?symbol=NIGHT-USD");
  });

  it("the fake rejects a replayed nonce, a stale or future timestamp, and a tampered body", async () => {
    h = await startHarness();
    await h.client.openOrders();
    const first = h.fake.requests[0];
    if (!first) throw new Error("no request");
    const replay = await fetch(`${h.fake.baseUrl}${first.target}`, {
      headers: Object.fromEntries(
        Object.entries(first.headers).filter(
          ([k]) => k.startsWith("x-api-wallet") || k === "user-agent",
        ),
      ) as Record<string, string>,
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "request already processed" });

    const raw = async (ts: number, body?: string, sentBody = body) => {
      const nonce = randomUUID();
      const msg = restSigningMessage("DELETE", "/v2/order/cancel-all", ts, nonce, body);
      const res = await fetch(`${h?.fake.baseUrl}/v2/order/cancel-all`, {
        method: "DELETE",
        headers: {
          "User-Agent": UA,
          "X-API-Wallet-Public-Key": h?.signer.publicKeyHex ?? "",
          "X-API-Wallet-Signature": h?.signer.signHex(msg) ?? "",
          "X-API-Wallet-Timestamp": String(ts),
          "X-API-Wallet-Nonce": nonce,
        },
        ...(sentBody !== undefined ? { body: sentBody } : {}),
      });
      return { status: res.status, body: (await res.json()) as { error?: string } };
    };
    const nowSec = Math.floor(h.fake.serverNow() / 1000);
    const body = '{"symbol":"NIGHT-USD"}';
    expect(await raw(nowSec - 181, body)).toEqual({
      status: 401,
      body: { error: "signature expired or invalid timestamp" },
    });
    expect((await raw(nowSec + 2, body)).status).toBe(401);
    expect(await raw(nowSec - 1, body, '{"symbol":"BTC-USD"}')).toEqual({
      status: 401,
      body: { error: "authentication failed" },
    });
    expect(await raw(nowSec - 1, "")).toEqual({ status: 400, body: { error: "EOF" } });
    expect((await raw(nowSec - 1, body)).status).toBe(200);
  });

  it("never retries a write: a 503 surfaces once and the nonce is spent", async () => {
    h = await startHarness();
    h.fake.failNext({ method: "POST", path: "/v2/orders/batch", status: 503 });
    const order = ask();
    const err = await h.client.placeBatch(batchOrders([order])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StrikeApiError);
    expect(err).toMatchObject({ status: 503, code: "service unavailable" });
    expect(requestsTo(h, "/v2/orders/batch")).toHaveLength(1);
    expect(h.fake.createCommands.get(order.client_order_id)).toBeUndefined();
  });

  it("a write whose transport fails is reported as outcome-unknown, sent once", async () => {
    h = await startHarness();
    let calls = 0;
    const client = h.makeClient({
      fetch: (async () => {
        calls += 1;
        throw new TypeError("socket hang up");
      }) as typeof fetch,
    });
    const err = await client.cancelAll(cancelAll("NIGHT-USD")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StrikeTransportError);
    expect(err).toMatchObject({ write: true });
    expect(calls).toBe(1);
  });

  it("retries GETs on 503 with a fresh nonce and signature each time", async () => {
    h = await startHarness();
    h.fake.failNext({ method: "GET", path: "/v2/positions", status: 503, times: 2 });
    expect(await h.client.positions()).toEqual({ positions: [], count: 0 });
    const reqs = requestsTo(h, "/v2/positions");
    expect(reqs.map((r) => r.status)).toEqual([503, 503, 200]);
    expect(new Set(reqs.map((r) => r.headers["x-api-wallet-nonce"])).size).toBe(3);
  });

  it("three 429s pause creates locally; cancels still go out", async () => {
    h = await startHarness();
    h.fake.failNext({ method: "POST", path: "/v2/orders/batch", status: 429, times: 3 });
    for (let i = 0; i < 3; i++) {
      await expect(h.client.placeBatch(batchOrders([ask()]))).rejects.toMatchObject({
        status: 429,
      });
    }
    const before = h.fake.requests.length;
    const refused = await h.client.placeBatch(batchOrders([ask()])).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(StrikeRefusedError);
    expect(refused).toMatchObject({ kind: "rate", reason: "paused-after-429" });
    expect(h.fake.requests.length).toBe(before);
    await expect(h.client.cancelAll(cancelAll("NIGHT-USD"))).resolves.toMatchObject({
      canceled_count: -1,
    });
  });

  it("refused routes never reach the network or spend budget", async () => {
    h = await startHarness();
    const used = h.rate.used();
    const attempts: Promise<unknown>[] = [
      h.client.write("POST", "/v2/order/replace", { new_order: ask() }),
      h.client.write("POST", "/v2/orders/replace", { symbol: "NIGHT-USD", orders: [ask()] }),
      h.client.write("DELETE", "/v2/order/cancel-all", {}),
      h.client.write("POST", "/v2/orders/batch", { orders: [ask()], vault_id: "v1" }),
      h.client.write("POST", "/v2/order", ask()),
      h.client.get("/v2/openOrders", { account_id: "01a144dc-27e4-706c-ac46-9c2c1e77d60b" }),
      h.client.get("/v2/vault/positions"),
    ];
    for (const a of attempts) await expect(a).rejects.toBeInstanceOf(StrikeRefusedError);
    expect(h.fake.requests).toHaveLength(0);
    expect(h.rate.used()).toBe(used);
  });

  it("CANCEL_ONLY can cancel and read, nothing else", async () => {
    h = await startHarness({ profile: "CANCEL_ONLY" });
    await expect(h.client.placeBatch(batchOrders([ask()]))).rejects.toBeInstanceOf(
      StrikeRefusedError,
    );
    await expect(h.client.setLeverage({ symbol: "NIGHT-USD", leverage: 2 })).rejects.toBeInstanceOf(
      StrikeRefusedError,
    );
    await expect(h.client.cancelAll(cancelAll("NIGHT-USD"))).resolves.toMatchObject({
      symbol: "NIGHT-USD",
    });
    await expect(h.client.openOrders()).resolves.toMatchObject({ count: 0 });
  });

  it("puts X-Builder-Fee-Bps on entry order routes only, capped, and never on exits", async () => {
    h = await startHarness();
    h.fake.engine.setPosition(
      h.fake.engine.accounts.get(h.accountId) as never,
      "NIGHT-USD",
      "-300",
      "0.0385",
    );
    await h.client.placeBatch(batchOrders([ask()]));
    await h.client.placeBatch(batchOrders([ask("0.0399")]), { builderFeeBps: 4 });
    await h.client.placeBatch(batchOrders([ask("0.0401")]), { exit: true });
    await h.client.placeBuyBack(
      reduceOnlyBuyBack({
        clientOrderId: ids.next(),
        symbol: "NIGHT-USD",
        size: "300",
        price: "0.0390",
      }),
    );
    await h.client.cancelAll(cancelAll("NIGHT-USD"));
    await h.client.setLeverage({ symbol: "NIGHT-USD", leverage: 2 });
    const fee = (path: string) =>
      requestsTo(h as Harness, path).map((r) => r.headers["x-builder-fee-bps"]);
    expect(fee("/v2/orders/batch")).toEqual(["10", "4", undefined]);
    expect(fee("/v2/order")).toEqual([undefined]);
    expect(fee("/v2/order/cancel-all")).toEqual([undefined]);
    expect(fee("/v2/leverage")).toEqual([undefined]);

    await expect(
      h.client.placeBatch(batchOrders([ask()]), { builderFeeBps: 11 }),
    ).rejects.toMatchObject({
      kind: "builder-fee",
    });
    await expect(
      h.client.placeBatch(batchOrders([ask()]), { exit: true, builderFeeBps: 5 }),
    ).rejects.toMatchObject({
      kind: "builder-fee",
    });
    await expect(
      h.client.write("DELETE", "/v2/order/cancel-all", cancelAll("NIGHT-USD"), {
        builderFeeBps: 1,
      }),
    ).rejects.toMatchObject({ kind: "builder-fee" });

    // The fee header is not part of the signature: the server checks it against the approval.
    const greedy = h.makeClient({ builderFee: { capBps: 50, defaultBps: 50 } });
    await expect(greedy.placeBatch(batchOrders([ask()]))).rejects.toMatchObject({
      status: 400,
      code: "X-Builder-Fee-Bps 50 exceeds your approved max of 10",
    });
  });

  it("re-syncs the clock on a signature-expired 401 (GETs retry; writes do not)", async () => {
    h = await startHarness();
    h.fake.skewMs = -200_000;
    const err = await h.client.cancelAll(cancelAll("NIGHT-USD")).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, code: "signature expired or invalid timestamp" });
    await vi.waitFor(() => expect(h?.clock.offsetMs).toBeLessThan(-150_000));
    await expect(h.client.cancelAll(cancelAll("NIGHT-USD"))).resolves.toMatchObject({
      canceled_count: -1,
    });

    h.fake.skewMs = 0;
    await expect(h.client.positions()).resolves.toMatchObject({ count: 0 });
    expect(requestsTo(h, "/v2/positions").map((r) => r.status)).toEqual([401, 200]);
  });

  it("refuses to sign before the clock has synced", async () => {
    h = await startHarness();
    const unsynced = new ServerClock({ fetchServerTimeMs: async () => Date.now() });
    const rate = new RateLimiter();
    const client = h.makeClient({ clock: unsynced, rate });
    await expect(client.placeBatch(batchOrders([ask()]))).rejects.toMatchObject({ kind: "clock" });
    expect(rate.used()).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  it("raises a bug alarm on a nonce replay and a key alarm on authentication failure", async () => {
    h = await startHarness();
    const alarms: SignedClientAlarm[] = [];
    const client = h.makeClient({ onAlarm: (a) => alarms.push(a) });
    h.fake.failNext({ status: 401, body: { error: "request already processed" } });
    h.fake.failNext({ status: 401, body: { error: "wallet expired or revoked" } });
    await expect(client.cancelAll(cancelAll("NIGHT-USD"))).rejects.toMatchObject({ status: 401 });
    await expect(client.cancelAll(cancelAll("NIGHT-USD"))).rejects.toMatchObject({ status: 401 });
    expect(alarms.map((a) => a.kind)).toEqual(["nonce-replay", "key-invalid"]);
  });

  it("derives exit status from the body: reduce-only creates never carry the entry fee", async () => {
    h = await startHarness();
    h.fake.engine.setPosition(
      h.fake.engine.accounts.get(h.accountId) as never,
      "NIGHT-USD",
      "-300",
      "0.0385",
    );
    const exitBid = () =>
      limitOrder({
        clientOrderId: ids.next(),
        symbol: "NIGHT-USD",
        side: "buy",
        size: "10",
        price: "0.0300",
        reduceOnly: true,
      });
    await h.client.placeBatch(batchOrders([exitBid()]));
    await h.client.placeBatch(batchOrders([exitBid(), exitBid()]), { builderFeeBps: 0 });
    const fee = () =>
      requestsTo(h as Harness, "/v2/orders/batch").map((r) => r.headers["x-builder-fee-bps"]);
    expect(fee()).toEqual([undefined, undefined]);

    const before = h.fake.requests.length;
    const used = h.rate.used();
    // Mixed entry and exit: the default fee would hit the exit too, so it is refused locally.
    await expect(h.client.placeBatch(batchOrders([ask(), exitBid()]))).rejects.toMatchObject({
      kind: "builder-fee",
    });
    await expect(
      h.client.placeBatch(batchOrders([exitBid()]), { builderFeeBps: 3 }),
    ).rejects.toMatchObject({ kind: "builder-fee" });
    expect(h.fake.requests.length).toBe(before);
    expect(h.rate.used()).toBe(used);
    // With a zero fee a mixed request is fine, and goes out without the header.
    await h.client.placeBatch(batchOrders([ask("0.0399"), exitBid()]), { builderFeeBps: 0 });
    expect(fee()).toEqual([undefined, undefined, undefined]);
    const noDefault = h.makeClient({ builderFee: { capBps: 10 } });
    await noDefault.placeBatch(batchOrders([ask("0.0401"), exitBid()]));
    expect(fee()).toHaveLength(4);
    expect(fee()[3]).toBeUndefined();
  });

  it("never signs a create whose client_order_id it already sent, even after a failure", async () => {
    h = await startHarness();
    const order = ask();
    await h.client.placeBatch(batchOrders([order]));
    const used = h.rate.used();
    const sent = h.fake.requests.length;
    for (const attempt of [
      () => h?.client.placeBatch(batchOrders([order])),
      () => h?.client.placeBatch(batchOrders([ask("0.0399"), order])),
      () => h?.client.replaceBatch(replaceBatch("NIGHT-USD", { cancels: [], creates: [order] })),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ kind: "route", reason: /already sent/ });
    }
    expect(h.fake.requests.length).toBe(sent);
    expect(h.rate.used()).toBe(used);
    expect(h.fake.createCommands.get(order.client_order_id)).toBe(1);

    // A transport failure leaves the outcome unknown: the id still counts as sent.
    const lost = ask("0.0402");
    const flaky = h.makeClient({
      fetch: (async () => {
        throw new TypeError("socket hang up");
      }) as typeof fetch,
    });
    await expect(flaky.placeBatch(batchOrders([lost]))).rejects.toBeInstanceOf(
      StrikeTransportError,
    );
    await expect(flaky.placeBatch(batchOrders([lost]))).rejects.toMatchObject({ kind: "route" });
    // A local refusal sent nothing, so the same id may still go out.
    let t = 0;
    const paused = ask("0.0403");
    const tiny = h.makeClient({
      rate: new RateLimiter({ now: () => t, ordersPerWindow: 2, cancelReserve: 1 }),
    });
    await tiny.placeBatch(batchOrders([ask("0.0404")]));
    await expect(tiny.placeBatch(batchOrders([paused]))).rejects.toMatchObject({ kind: "rate" });
    t += 60_001;
    await expect(tiny.placeBatch(batchOrders([paused]))).resolves.toMatchObject({ failed: null });
    expect(h.fake.createCommands.get(paused.client_order_id)).toBe(1);
  });

  it("raises an alarm when a clock resync after a signature-expired 401 fails", async () => {
    h = await startHarness();
    const alarms: SignedClientAlarm[] = [];
    let healthy = true;
    const clock = new ServerClock({
      samples: 1,
      fetchServerTimeMs: async () => {
        if (!healthy) throw new Error("time endpoint down");
        return h?.fake.serverNow() ?? 0;
      },
    });
    await clock.sync();
    healthy = false;
    const client = h.makeClient({ clock, onAlarm: (a) => alarms.push(a) });
    h.fake.failNext({ status: 401, body: { error: "signature expired or invalid timestamp" } });
    await expect(client.cancelAll(cancelAll("NIGHT-USD"))).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() =>
      expect(alarms).toEqual([{ kind: "clock-resync-failed", error: "time endpoint down" }]),
    );
  });

  it("keeps engine ids past 2^53 exact from openOrders through a cancel", async () => {
    const first = 2n ** 53n + 7n;
    h = await startHarness({ fake: { firstOrderId: first } });
    const order = ask();
    await h.client.placeBatch(batchOrders([order]));
    await h.fake.idle();
    const open = await h.client.openOrders("NIGHT-USD");
    expect(open.orders[0]?.ID).toBe(first);
    await h.client.cancelOrder(cancelOrder("NIGHT-USD", { orderId: first }));
    await h.fake.idle();
    expect(h.fake.engine.orders.get(first)?.status).toBe("canceled");
    expect(requestsTo(h, "/v2/order/cancel")[0]?.body).toBe(
      `{"symbol":"NIGHT-USD","order_id":${first}}`,
    );
    expect(h.fake.engine.orders.get(first + 1n)).toBeUndefined();
  });
});
