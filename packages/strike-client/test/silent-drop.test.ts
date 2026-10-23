import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountReconciler,
  batchOrders,
  ClientOrderIdFactory,
  type CreateOrderBody,
  type CreateOutcome,
  limitOrder,
  lookupVia,
  PendingCreates,
  replaceBatch,
  type SignedClient,
  UserStream,
} from "../src/index.js";
import { type Harness, startHarness, UA } from "./helpers.js";

let h: Harness | undefined;
let stream: UserStream | undefined;
afterEach(async () => {
  stream?.stop();
  stream = undefined;
  await h?.stop();
  h = undefined;
});

const ids = new ClientOrderIdFactory("sd");
const ask = (price: string, symbol = "NIGHT-USD") =>
  limitOrder({
    clientOrderId: ids.next(),
    symbol,
    side: "sell",
    size: "300",
    price,
    postOnly: true,
  });

/** The production wiring in miniature: register → send once → stream → lookup. */
async function wire(h: Harness, client: SignedClient = h.client) {
  let t = 1_000_000;
  const outcomes = new Map<string, CreateOutcome>();
  const late: string[] = [];
  const anomalies: string[] = [];
  const rec = new AccountReconciler({
    accountId: h.accountId,
    onAnomaly: (a) => anomalies.push(a.kind),
  });
  const pending = new PendingCreates({
    lookup: lookupVia(() => client),
    now: () => t,
    onOutcome: (p, o) => {
      outcomes.set(p.clientOrderId, o);
      rec.onCreateOutcome(p.clientOrderId, o);
    },
    onLateEvent: (id) => late.push(id),
  });
  stream = new UserStream({
    url: h.fake.wsUrl,
    userAgent: UA,
    signer: h.signer,
    clock: h.clock,
    onEvent: (e) => {
      if (e.kind === "order" || e.kind === "fill") pending.onOrderUpdate(e.data);
      rec.apply(e);
    },
    onResyncNeeded: () => {},
  });
  stream.start();
  await vi.waitFor(() => expect(stream?.live).toBe(true));

  const register = (orders: readonly CreateOrderBody[]) => {
    for (const o of orders) {
      pending.register(h.accountId, o.symbol, o.client_order_id);
      rec.registerCreate({
        clientOrderId: o.client_order_id,
        symbol: o.symbol,
        side: o.side,
        size: o.size,
        ...(o.price !== undefined ? { price: o.price } : {}),
      });
    }
    return orders.map((o) => o.client_order_id);
  };
  const sendBatch = async (orders: CreateOrderBody[]) => {
    const cids = register(orders);
    try {
      pending.onBatchResponse(cids, await client.placeBatch(batchOrders(orders)));
    } catch (err) {
      pending.onSendError(cids, err);
    }
  };
  return {
    rec,
    pending,
    outcomes,
    late,
    anomalies,
    register,
    sendBatch,
    advance: async (ms: number) => {
      t += ms;
      await pending.tick();
    },
  };
}

describe("silent-drop detection end to end", () => {
  it("resolves stream-confirmed creates and finds an unknown-symbol create dropped by a 404", async () => {
    h = await startHarness();
    const w = await wire(h);
    const good = ask("0.0389");
    const dropped = ask("0.0389", "FOO-USD");
    await w.sendBatch([good, dropped]);
    await vi.waitFor(() => expect(w.outcomes.get(good.client_order_id)?.kind).toBe("confirmed"));
    expect(w.outcomes.has(dropped.client_order_id)).toBe(false);

    await w.advance(1_999);
    expect(w.outcomes.has(dropped.client_order_id)).toBe(false);
    await w.advance(1);
    // One 404 is not proof yet: the create stays pending and counts as resting.
    expect(w.outcomes.has(dropped.client_order_id)).toBe(false);
    expect(w.rec.exposure("FOO-USD").restingAskQty).toBe("300");
    await w.advance(1_999);
    expect(w.outcomes.has(dropped.client_order_id)).toBe(false);
    await w.advance(1);
    expect(w.outcomes.get(dropped.client_order_id)).toEqual({ kind: "dropped", via: "rest-404" });
    expect(w.pending.isBlocked(h.accountId)).toBe(false);
    const lookups = h.fake.requests.filter((r) => r.target.startsWith("/v2/order?"));
    const target = `/v2/order?symbol=FOO-USD&client_order_id=${dropped.client_order_id}`;
    expect(lookups.map((r) => [r.target, r.status])).toEqual([
      [target, 404],
      [target, 404],
    ]);
    // Never a duplicate create, before or after the timeout.
    expect(h.fake.createCommands.get(good.client_order_id)).toBe(1);
    expect(h.fake.createCommands.get(dropped.client_order_id)).toBe(1);
    expect(w.rec.exposure("NIGHT-USD").restingAskQty).toBe("300");
    expect(w.rec.exposure("FOO-USD").restingAskQty).toBe("0");
    expect(() => w.register([dropped])).toThrow(/never resent/);
  });

  it("blocks the account while a create stays unconfirmed past 5 s, never resending it", async () => {
    h = await startHarness();
    const client = h.makeClient({ maxGetRetries: 0 });
    const w = await wire(h, client);
    const order = ask("0.0389");
    h.fake.setEventFilter(
      (_a, msg) => (msg.data as { c?: string } | undefined)?.c === order.client_order_id,
    );
    h.fake.failNext({ method: "GET", path: "/v2/order", status: 503, times: 100 });
    await w.sendBatch([order]);
    await h.fake.idle();
    for (let i = 0; i < 5; i++) await w.advance(1_000);
    expect(w.pending.isBlocked(h.accountId)).toBe(true);
    expect(w.outcomes.size).toBe(0);
    expect(w.pending.unconfirmed(h.accountId)[0]?.lastLookupError).toMatch(/503/);
    // Unknown counts as resting.
    expect(w.rec.exposure("NIGHT-USD")).toMatchObject({
      restingAskQty: "300",
      pendingCreateQty: "300",
    });

    h.fake.clearFaults();
    await w.advance(2_000);
    expect(w.outcomes.get(order.client_order_id)).toMatchObject({
      kind: "confirmed",
      via: "rest",
      status: "open",
    });
    expect(w.pending.isBlocked(h.accountId)).toBe(false);
    expect(w.rec.exposure("NIGHT-USD")).toMatchObject({
      restingAskQty: "300",
      pendingCreateQty: "0",
    });
    expect(h.fake.createCommands.get(order.client_order_id)).toBe(1);
  });

  it("a slow engine can look like a drop; the late event is flagged and counted as resting again", async () => {
    h = await startHarness();
    const w = await wire(h);
    h.fake.holdEngine();
    const order = ask("0.0389");
    await w.sendBatch([order]);
    await w.advance(2_000);
    expect(w.outcomes.has(order.client_order_id)).toBe(false);
    expect(w.rec.exposure("NIGHT-USD").restingAskQty).toBe("300");
    await w.advance(2_000);
    expect(w.outcomes.get(order.client_order_id)?.kind).toBe("dropped");
    expect(w.rec.exposure("NIGHT-USD").restingAskQty).toBe("0");
    h.fake.releaseEngine();
    await vi.waitFor(() => expect(w.late).toContain(order.client_order_id));
    expect(w.anomalies).toContain("late-event");
    await vi.waitFor(() => expect(w.rec.order(order.client_order_id)?.status).toBe("open"));
    expect(w.rec.exposure("NIGHT-USD").restingAskQty).toBe("300");
    expect(h.fake.createCommands.get(order.client_order_id)).toBe(1);
  });

  it("a create whose response is lost stays pending, then resolves from the stream", async () => {
    h = await startHarness();
    const client = h.makeClient({
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        await fetch(input, init);
        throw new TypeError("connection reset after send");
      }) as typeof fetch,
    });
    const w = await wire(h, client);
    const order = ask("0.0389");
    await w.sendBatch([order]);
    expect(w.pending.unconfirmed()).toHaveLength(1);
    await vi.waitFor(() => expect(w.outcomes.get(order.client_order_id)?.kind).toBe("confirmed"));
    expect(h.fake.createCommands.get(order.client_order_id)).toBe(1);
  });

  it("a definite 4xx marks the creates not sent", async () => {
    h = await startHarness();
    const w = await wire(h);
    h.fake.failNext({
      method: "POST",
      path: "/v2/orders/batch",
      status: 400,
      body: { error: "binding" },
    });
    const order = ask("0.0389");
    await w.sendBatch([order]);
    expect(w.outcomes.get(order.client_order_id)).toEqual({
      kind: "not-sent",
      reason: "HTTP 400 binding",
    });
    expect(w.rec.exposure("NIGHT-USD").restingAskQty).toBe("0");
  });

  it("a local refusal resolves the creates as not sent, so the account is not blocked", async () => {
    h = await startHarness();
    const w = await wire(h, h.makeClient({ profile: "CANCEL_ONLY" }));
    const order = ask("0.0389");
    await w.sendBatch([order]);
    expect(w.outcomes.get(order.client_order_id)).toMatchObject({
      kind: "not-sent",
      reason: expect.stringMatching(/^refused \(route\)/),
    });
    for (let i = 0; i < 6; i++) await w.advance(1_000);
    expect(w.pending.isBlocked(h.accountId)).toBe(false);
    expect(w.rec.exposure("NIGHT-USD").total).toBe("0");
    expect(h.fake.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });

  it("a 429 marks the creates not sent (VERIFY: Strike rate-limits before publishing)", async () => {
    h = await startHarness();
    const w = await wire(h);
    h.fake.failNext({ method: "POST", path: "/v2/orders/batch", status: 429 });
    const order = ask("0.0389");
    await w.sendBatch([order]);
    expect(w.outcomes.get(order.client_order_id)).toEqual({
      kind: "not-sent",
      reason: "HTTP 429 rate limit exceeded",
    });
    expect(h.fake.createCommands.get(order.client_order_id)).toBeUndefined();
  });

  it("replace-batch: creates skipped after the first rejection have no event and look up as 404", async () => {
    h = await startHarness();
    const w = await wire(h);
    const far = ask("0.0395");
    const mid = ask("0.0392");
    const near = ask("0.0389");
    h.fake.engine.forcedRejects.set(mid.client_order_id, "insufficient_balance");
    const body = replaceBatch("NIGHT-USD", { cancels: [], creates: [near, mid, far] });
    expect(body.replacements.map((r) => r.new_order?.price)).toEqual([
      "0.0395",
      "0.0392",
      "0.0389",
    ]);
    const cids = w.register([far, mid, near]);
    await h.client.replaceBatch(body).catch((e: unknown) => w.pending.onSendError(cids, e));
    await vi.waitFor(() => expect(w.outcomes.size).toBe(2));
    expect(w.outcomes.get(far.client_order_id)).toMatchObject({ kind: "confirmed", status: "NEW" });
    expect(w.outcomes.get(mid.client_order_id)).toMatchObject({
      kind: "confirmed",
      status: "REJECTED",
    });
    await w.advance(2_000);
    await w.advance(2_000);
    expect(w.outcomes.get(near.client_order_id)).toEqual({ kind: "dropped", via: "rest-404" });
    await vi.waitFor(() => expect(w.rec.exposure("NIGHT-USD").restingAskQty).toBe("300"));
  });
});
