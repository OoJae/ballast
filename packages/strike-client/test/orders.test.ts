import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  batchOrders,
  ClientOrderIdFactory,
  type CreateOrderBody,
  cancelAll,
  cancelOrder,
  checkRoute,
  compareDecimalStrings,
  decFromUnits,
  farToNear,
  leverage,
  limitOrder,
  marginMode,
  reduceOnlyBuyBack,
  replaceBatch,
  restSigningMessage,
  StrikeApiError,
  UserStream,
  type UserStreamEvent,
} from "../src/index.js";
import { addAccount, type Harness, sleep, startHarness, UA } from "./helpers.js";

/** Property names of a schema in the pinned trade-api.yaml. */
function schemaFields(name: string): Set<string> {
  const lines = readFileSync(new URL("../openapi/trade-api.yaml", import.meta.url), "utf8").split(
    "\n",
  );
  const start = lines.indexOf(`    ${name}:`);
  if (start < 0) throw new Error(`schema ${name} not found`);
  const fields = new Set<string>();
  let inProps = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {4}\S/.test(line)) break;
    if (line === "      properties:") inProps = true;
    else if (/^ {6}\S/.test(line)) inProps = false;
    const m = /^ {8}([a-zA-Z_]+):/.exec(line);
    if (inProps && m) fields.add(m[1] as string);
  }
  return fields;
}

const ids = new ClientOrderIdFactory("ob");
const SYMBOL = "NIGHT-USD";
const ask = (price: string, size = "300") =>
  limitOrder({
    clientOrderId: ids.next(),
    symbol: SYMBOL,
    side: "sell",
    size,
    price,
    postOnly: true,
  });

describe("request builders", () => {
  it("use only field names the pinned spec defines", () => {
    const create = schemaFields("CreateOrderRequest");
    const check = (body: object, fields: Set<string>) => {
      for (const k of Object.keys(body)) expect(fields, k).toContain(k);
    };
    const a = ask("0.0389");
    check(a, create);
    check(
      reduceOnlyBuyBack({
        clientOrderId: ids.next(),
        symbol: SYMBOL,
        size: "10",
        slippage: "0.01",
      }),
      create,
    );
    check(batchOrders([a]), schemaFields("CreateBatchOrdersRequest"));
    const rb = replaceBatch(SYMBOL, { cancels: [5n], creates: [a] });
    check(rb, schemaFields("ReplaceBatchOrdersRequest"));
    for (const item of rb.replacements) {
      check(item, schemaFields("ReplaceOrderRequest"));
      if (item.cancel) check(item.cancel, schemaFields("ReplaceCancelLeg"));
    }
    check(cancelOrder(SYMBOL, { orderId: 1n }), schemaFields("CancelOrderRequest"));
    check(cancelOrder(SYMBOL, { clientOrderId: "bal_x" }), schemaFields("CancelOrderRequest"));
    check(cancelAll(SYMBOL), schemaFields("CancelAllOrdersRequest"));
    check(leverage(SYMBOL, 2), schemaFields("LeverageRequest"));
    check(marginMode(SYMBOL, "cross"), schemaFields("MarginModeRequest"));
  });

  it("send lowercase side/type, uppercase time_in_force, and omit unset options", () => {
    expect(ask("0.0389")).toEqual({
      client_order_id: expect.stringMatching(/^bal_ob_/),
      symbol: SYMBOL,
      side: "sell",
      type: "limit",
      size: "300",
      price: "0.0389",
      post_only: true,
    });
    const bb = reduceOnlyBuyBack({
      clientOrderId: "bal_bb1",
      symbol: SYMBOL,
      size: "300",
      price: "0.0391",
    });
    expect(bb).toEqual({
      client_order_id: "bal_bb1",
      symbol: SYMBOL,
      side: "buy",
      type: "limit",
      size: "300",
      price: "0.0391",
      time_in_force: "IOC",
      reduce_only: true,
    });
    expect(checkRoute("AUTONOMOUS", "POST", "/v2/order", bb).ok).toBe(true);
    expect(
      reduceOnlyBuyBack({
        clientOrderId: "bal_bb2",
        symbol: SYMBOL,
        size: "300",
        slippage: "0.01",
      }),
    ).toMatchObject({ type: "market", slippage: "0.01", time_in_force: "IOC" });
  });

  it("validate inputs: bal_ ids, no reserved prefixes, positive decimals, reduce-only buys", () => {
    const base = { symbol: SYMBOL, side: "sell" as const, size: "1", price: "1" };
    expect(() => limitOrder({ ...base, clientOrderId: "liq_1" })).toThrow();
    expect(() => limitOrder({ ...base, clientOrderId: "mine-1" })).toThrow(/bal_/);
    expect(() => limitOrder({ ...base, clientOrderId: `bal_${"x".repeat(253)}` })).toThrow();
    expect(() => limitOrder({ ...base, clientOrderId: "bal_1", price: "1e-3" })).toThrow(/decimal/);
    expect(() => limitOrder({ ...base, clientOrderId: "bal_1", size: "0" })).toThrow(/positive/);
    expect(() => limitOrder({ ...base, clientOrderId: "bal_1", side: "buy" })).toThrow(
      /reduce-only/,
    );
    expect(() => limitOrder({ ...base, clientOrderId: "bal_1", symbol: "night-usd" })).toThrow(
      /symbol/,
    );
    expect(() => cancelAll("")).toThrow();
    expect(() => leverage(SYMBOL, 0)).toThrow();
    expect(() => leverage(SYMBOL, 2.5)).toThrow();
  });

  it("issue unique client ids, and refuse duplicates inside one request", () => {
    const f = new ClientOrderIdFactory("u", () => 1_700_000_000_000);
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(f.next());
    expect(seen.size).toBe(10_000);
    const a = ask("0.0389");
    expect(() => batchOrders([a, a])).toThrow(/duplicate/);
    expect(() => replaceBatch(SYMBOL, { cancels: [], creates: [a, { ...a }] })).toThrow(
      /duplicate/,
    );
    expect(() => replaceBatch(SYMBOL, { cancels: [1n, 1n], creates: [] })).toThrow(/duplicate/);
  });

  it("property: replace-batch creates are ordered far-to-near", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 10_000_000 }), { minLength: 1, maxLength: 20 }),
        fc.constantFrom("sell" as const, "buy" as const),
        (ticks, side) => {
          const creates: CreateOrderBody[] = ticks.map((t) =>
            limitOrder({
              clientOrderId: ids.next(),
              symbol: SYMBOL,
              side,
              size: "1",
              price: decFromUnits(BigInt(t), "0.000001"),
              reduceOnly: side === "buy",
            }),
          );
          const sorted = farToNear(creates).map((c) => c.price as string);
          for (let i = 1; i < sorted.length; i++) {
            const c = compareDecimalStrings(sorted[i - 1] as string, sorted[i] as string);
            expect(side === "sell" ? c > 0 : c < 0).toBe(true);
          }
        },
      ),
    );
    expect(() => farToNear([ask("1"), { ...ask("2"), side: "buy", reduce_only: true }])).toThrow(
      /one side/,
    );
  });

  it("pairs cancel legs with creates and caps operations at 1000", () => {
    const body = replaceBatch(SYMBOL, {
      cancels: [11n, 12n, 13n],
      creates: [ask("0.0389"), ask("0.0395")],
    });
    expect(body.replacements.map((r) => [r.cancel?.order_id, r.new_order?.price])).toEqual([
      [11n, "0.0395"],
      [12n, "0.0389"],
      [13n, undefined],
    ]);
    const many = Array.from({ length: 1001 }, (_, i) => BigInt(i + 1));
    expect(() => replaceBatch(SYMBOL, { cancels: many, creates: [] })).toThrow(/1000/);
    expect(() =>
      replaceBatch(SYMBOL, { cancels: [], creates: [{ ...ask("1"), symbol: "BTC-USD" }] }),
    ).toThrow(/same symbol/);
  });
});

describe("fake Strike semantics, driven through the signed client", () => {
  let h: Harness | undefined;
  let stream: UserStream | undefined;
  afterEach(async () => {
    stream?.stop();
    stream = undefined;
    await h?.stop();
    h = undefined;
  });

  async function withStream(harness: Harness): Promise<UserStreamEvent[]> {
    const events: UserStreamEvent[] = [];
    stream = new UserStream({
      url: harness.fake.wsUrl,
      userAgent: UA,
      signer: harness.signer,
      clock: harness.clock,
      onEvent: (e) => events.push(e),
      onResyncNeeded: () => {},
    });
    stream.start();
    await vi.waitFor(() => expect(stream?.live).toBe(true));
    return events;
  }

  const statusOf = (harness: Harness, cid: string) =>
    harness.fake.engine.findByClientId(harness.accountId, cid)?.status;

  it("replace-batch: a static-rule failure applies nothing, not even the cancels", async () => {
    h = await startHarness();
    const resting = ask("0.0400");
    await h.client.placeBatch(batchOrders([resting]));
    await h.fake.idle();
    const id = h.fake.engine.findByClientId(h.accountId, resting.client_order_id)?.id as bigint;
    const good = ask("0.0395");
    const offTick = { ...ask("0.0392"), price: "0.0392505" };
    await h.client.replaceBatch(replaceBatch(SYMBOL, { cancels: [id], creates: [good, offTick] }));
    await h.fake.idle();
    expect(statusOf(h, resting.client_order_id)).toBe("open");
    expect(statusOf(h, good.client_order_id)).toBeUndefined();
    expect(h.fake.engine.findByClientId(h.accountId, offTick.client_order_id)).toMatchObject({
      status: "rejected",
      closeReason: "order_price_not_multiple_of_tick",
    });
  });

  it("replace-batch: a post-only cross is rejected without sliding and later creates still rest (observed on testnet)", async () => {
    h = await h_with_bid();
    const far = ask("0.0395");
    const crossing = ask("0.0389"); // the scripted bid sits at 0.0390
    const after = ask("0.0392");
    // Built by hand: the builder would sort these far-to-near.
    await h.client.replaceBatch({
      replacements: [{ new_order: far }, { new_order: crossing }, { new_order: after }],
    });
    await h.fake.idle();
    expect(statusOf(h, far.client_order_id)).toBe("open");
    expect(h.fake.engine.findByClientId(h.accountId, crossing.client_order_id)).toMatchObject({
      status: "rejected",
      closeReason: "order_would_match_immediately",
      price: 38_900_000_000_000_000n,
      filled: 0n,
    });
    // Strike's docs say the first reject stops the remaining creates; testnet (D1, 2026-10-23)
    // showed a post-only cross does not.
    expect(statusOf(h, after.client_order_id)).toBe("open");
  });

  async function h_with_bid(): Promise<Harness> {
    const harness = await startHarness();
    harness.fake.engine.restMarketOrder(SYMBOL, "buy", "0.039", "100000");
    return harness;
  }

  it("replace-batch: an unknown symbol drops the whole command silently, cancels included", async () => {
    h = await startHarness();
    const events = await withStream(h);
    const resting = ask("0.0400");
    await h.client.placeBatch(batchOrders([resting]));
    await vi.waitFor(() => expect(statusOf(h as Harness, resting.client_order_id)).toBe("open"));
    // Count only once the resting order's own events have reached us.
    await vi.waitFor(() =>
      expect(events.filter((e) => e.kind === "order" && e.data.X === "OPEN")).toHaveLength(1),
    );
    const id = h.fake.engine.findByClientId(h.accountId, resting.client_order_id)?.id as bigint;
    const n = events.length;
    const ghost = { ...ask("1"), symbol: "FOO-USD" };
    await h.client.replaceBatch({
      replacements: [{ cancel: { order_id: id, symbol: "FOO-USD" }, new_order: ghost }],
    });
    await h.fake.idle();
    await sleep(50); // nothing may arrive
    expect(events.length).toBe(n);
    expect(statusOf(h, resting.client_order_id)).toBe("open");
  });

  it("self-trade prevention expires the maker within one master family; others fill it", async () => {
    h = await startHarness({ family: "fam-1" });
    const events = await withStream(h);
    const order = ask("0.0389", "500");
    await h.client.placeBatch(batchOrders([order]));
    await vi.waitFor(() => expect(statusOf(h as Harness, order.client_order_id)).toBe("open"));

    const sibling = addAccount(h, "fam-1");
    h.fake.engine.create(sibling.account, {
      client_order_id: "sib-1",
      symbol: SYMBOL,
      side: "buy",
      type: "limit",
      size: "300",
      price: "0.0390",
      time_in_force: "IOC",
    });
    expect(h.fake.engine.findByClientId(h.accountId, order.client_order_id)).toMatchObject({
      status: "expired",
      closeReason: "order_expired_in_match",
      filled: 0n,
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "order",
          data: expect.objectContaining({ X: "EXPIRED", cr: "order_expired_in_match" }),
        }),
      ),
    );

    // From another family the ask fills, maker-side, with the builder fee on the fill.
    const second = ask("0.0389", "500");
    await h.client.placeBatch(batchOrders([second]));
    await vi.waitFor(() => expect(statusOf(h as Harness, second.client_order_id)).toBe("open"));
    h.fake.engine.marketTake(SYMBOL, "buy", "300");
    await vi.waitFor(() => expect(events.filter((e) => e.kind === "fill")).toHaveLength(1));
    const fill = events.find((e) => e.kind === "fill");
    expect(fill?.kind === "fill" && fill.data).toMatchObject({
      c: second.client_order_id,
      m: true,
      l: "300",
      L: "0.0389",
      builder_fee: "0.01167",
      position_seq: 1,
    });
    const pos = events.find((e) => e.kind === "position");
    expect(pos?.kind === "position" && pos.positions[0]).toMatchObject({
      pa: "-300",
      position_seq: 1,
    });
  });

  it("cancel-all {symbol} cancels one symbol; {} (refused by our signer) cancels every symbol", async () => {
    h = await startHarness();
    const night = ask("0.0400");
    const btc = limitOrder({
      clientOrderId: ids.next(),
      symbol: "BTC-USD",
      side: "sell",
      size: "0.001",
      price: "90000.1",
      postOnly: true,
    });
    await h.client.placeBatch(batchOrders([night, btc]));
    await h.fake.idle();
    await h.client.cancelAll(cancelAll(SYMBOL));
    await h.fake.idle();
    expect(statusOf(h, night.client_order_id)).toBe("canceled");
    expect(statusOf(h, btc.client_order_id)).toBe("open");

    // Raw signed request, outside the allowlist, to show why the signer refuses `{}`.
    const nonce = randomUUID();
    const ts = h.clock.signingTimestampSec();
    const res = await fetch(`${h.fake.baseUrl}/v2/order/cancel-all`, {
      method: "DELETE",
      body: "{}",
      headers: {
        "User-Agent": UA,
        "X-API-Wallet-Public-Key": h.signer.publicKeyHex,
        "X-API-Wallet-Signature": h.signer.signHex(
          restSigningMessage("DELETE", "/v2/order/cancel-all", ts, nonce, "{}"),
        ),
        "X-API-Wallet-Timestamp": String(ts),
        "X-API-Wallet-Nonce": nonce,
      },
    });
    expect(await res.json()).toMatchObject({ canceled_count: -1 });
    await h.fake.idle();
    expect(statusOf(h, btc.client_order_id)).toBe("canceled");
  });

  it("marginMode is refused silently while orders rest; GET /v2/symbols tells the truth", async () => {
    h = await startHarness();
    await h.client.placeBatch(batchOrders([ask("0.0400")]));
    await h.fake.idle();
    await expect(h.client.setMarginMode(marginMode(SYMBOL, "isolated"))).resolves.toEqual({
      marginMode: "isolated",
      symbol: SYMBOL,
    });
    await h.fake.idle();
    expect((await h.client.symbols()).symbol_settings[SYMBOL]?.margin_mode).toBe("cross");
    await h.client.cancelAll(cancelAll(SYMBOL));
    await h.fake.idle();
    await h.client.setMarginMode(marginMode(SYMBOL, "isolated"));
    await h.fake.idle();
    expect((await h.client.symbols()).symbol_settings[SYMBOL]?.margin_mode).toBe("isolated");

    h.fake.engine.setPosition(
      h.fake.engine.accounts.get(h.accountId) as never,
      SYMBOL,
      "-10",
      "0.04",
    );
    const err = await h.client.setMarginMode(marginMode(SYMBOL, "cross")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StrikeApiError);
    expect(err).toMatchObject({
      status: 400,
      code: "cannot change margin mode while position is open",
    });
  });

  it("leverage changes are confirmed on the stream by request_id", async () => {
    h = await startHarness();
    const events = await withStream(h);
    const res = await h.client.setLeverage(leverage(SYMBOL, 2));
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "leverage",
          ok: true,
          data: expect.objectContaining({ request_id: res.request_id }),
        }),
      ),
    );
    await expect(h.client.setLeverage(leverage(SYMBOL, 50))).rejects.toMatchObject({
      status: 400,
      code: "leverage exceeds maximum allowed",
    });
  });

  it("a reduce-only IOC buy-back is clamped to the short and leaves nothing resting", async () => {
    h = await startHarness();
    const acct = h.fake.engine.accounts.get(h.accountId);
    if (!acct) throw new Error("no account");
    h.fake.engine.setPosition(acct, SYMBOL, "-200", "0.0385");
    h.fake.engine.restMarketOrder(SYMBOL, "sell", "0.0390", "100000");
    const bb = reduceOnlyBuyBack({
      clientOrderId: ids.next(),
      symbol: SYMBOL,
      size: "500",
      price: "0.0391",
    });
    await h.client.placeBuyBack(bb);
    await h.fake.idle();
    expect(h.fake.engine.findByClientId(h.accountId, bb.client_order_id)).toMatchObject({
      status: "filled",
      size: 200n * 10n ** 18n,
    });
    expect((await h.client.positions(SYMBOL)).positions).toEqual([]);
  });
});
