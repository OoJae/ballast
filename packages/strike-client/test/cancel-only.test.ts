import { afterEach, describe, expect, it } from "vitest";
import { CancelOnlyClient, StrikeRefusedError } from "../src/cancel-only.js";
import { limitOrder, RateLimiter, replaceBatch } from "../src/index.js";
import { type Harness, startHarness, UA } from "./helpers.js";

/**
 * Invariant 4 at the client level: the watchdog's client has no create method, its profile is
 * fixed to CANCEL_ONLY, and even a raw write of a create is refused before any nonce is used.
 */
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

function client(harness: Harness): CancelOnlyClient {
  return new CancelOnlyClient({
    baseUrl: harness.fake.baseUrl,
    userAgent: UA,
    signer: harness.signer,
    clock: harness.clock,
    rate: new RateLimiter(),
    account: harness.accountId,
    sleep: async () => {},
  });
}

describe("CancelOnlyClient", () => {
  it("has no create method and cannot be constructed AUTONOMOUS", async () => {
    h = await startHarness();
    const c = client(h);
    expect(c.profile).toBe("CANCEL_ONLY");
    for (const m of ["placeBatch", "replaceBatch", "placeBuyBack", "setLeverage", "write"]) {
      expect((c as unknown as Record<string, unknown>)[m], m).toBeUndefined();
    }
    const forced = new CancelOnlyClient({
      ...({ profile: "AUTONOMOUS" } as object),
      baseUrl: h.fake.baseUrl,
      userAgent: UA,
      signer: h.signer,
      clock: h.clock,
      rate: new RateLimiter(),
      account: h.accountId,
    });
    expect(forced.profile).toBe("CANCEL_ONLY");
  });

  it("refuses a smuggled create before signing; nothing reaches Strike", async () => {
    h = await startHarness();
    const c = client(h) as unknown as {
      sendWrite(m: string, p: string, b: unknown): Promise<unknown>;
    };
    const create = limitOrder({
      clientOrderId: "bal_aaaaaa_bbbbbb_1_1",
      symbol: "NIGHT-USD",
      side: "sell",
      size: "500",
      price: "0.04",
      postOnly: true,
    });
    const attempts: [string, string, unknown][] = [
      ["POST", "/v2/orders/batch", { orders: [create] }],
      [
        "POST",
        "/v2/order/replace-batch",
        replaceBatch("NIGHT-USD", { cancels: [], creates: [create] }),
      ],
      ["POST", "/v2/order", { ...create, reduce_only: true, side: "buy", time_in_force: "IOC" }],
      ["POST", "/v2/leverage", { symbol: "NIGHT-USD", leverage: 2 }],
    ];
    for (const [m, p, b] of attempts) {
      await expect(c.sendWrite(m, p, b), p).rejects.toBeInstanceOf(StrikeRefusedError);
    }
    expect(h.fake.requests).toHaveLength(0);
  });

  it("cancels all on a symbol and reads open orders", async () => {
    h = await startHarness();
    const c = client(h);
    await h.client.placeBatch({
      orders: [
        limitOrder({
          clientOrderId: "bal_aaaaaa_bbbbbb_1_2",
          symbol: "NIGHT-USD",
          side: "sell",
          size: "500",
          price: "0.05",
          postOnly: true,
        }),
      ],
    });
    await h.fake.idle();
    expect((await c.openOrders("NIGHT-USD")).orders).toHaveLength(1);
    const r = await c.cancelAll({ symbol: "NIGHT-USD" });
    expect(r.canceled_count).toBe(-1);
    await h.fake.idle();
    expect((await c.openOrders("NIGHT-USD")).orders).toHaveLength(0);
  });
});
