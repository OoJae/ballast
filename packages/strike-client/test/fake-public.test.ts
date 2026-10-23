import { FakeStrike } from "@ballast/fake-strike";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicHttp, createPublicReads, L3Feed, ReconnectingSocket } from "../src/index.js";
import { UA } from "./helpers.js";

/**
 * The fake's public surfaces (used by the keeper and watchdog tests) speak the protocol the real
 * L3Feed and price socket expect: subscribe → ack → snapshot → gap-free updates, rebuild on a gap
 * or `clear`, and markPriceUpdate frames.
 */
let fake: FakeStrike | undefined;
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) s();
  await fake?.stop();
  fake = undefined;
});

async function start() {
  fake = new FakeStrike({ priceIntervalMs: 20 });
  await fake.start();
  const reads = createPublicReads(createPublicHttp({ baseUrl: fake.baseUrl, userAgent: UA }));
  const rebuilds: string[] = [];
  const feed = new L3Feed({
    url: `${fake.wsOrigin}/ws/l3`,
    userAgent: UA,
    symbols: ["NIGHT-USD"],
    fetchSnapshot: (s) => reads.l3Snapshot(s),
    onRebuild: (_s, reason) => rebuilds.push(reason),
    rebuildCooldownMs: 0,
  });
  feed.start();
  stops.push(() => feed.stop());
  const book = feed.books.get("NIGHT-USD");
  if (!book) throw new Error("no book");
  return { fake, reads, feed, book, rebuilds };
}

describe("fake public market", () => {
  it("bootstraps L3 and follows opens, fills and cancels in sequence", async () => {
    const { fake, book } = await start();
    fake.engine.restMarketOrder("NIGHT-USD", "buy", "0.0383", "400000");
    fake.engine.restMarketOrder("NIGHT-USD", "sell", "0.0389", "1000");
    await vi.waitFor(() => expect(book.synced).toBe(true));
    await vi.waitFor(() => expect(book.bestAsk()).toBe("0.0389"));
    fake.engine.marketTake("NIGHT-USD", "buy", "400");
    await vi.waitFor(() => expect(book.asks.get("0.0389")?.[0]?.size).toBe("600"));
    fake.engine.marketTake("NIGHT-USD", "buy", "600");
    await vi.waitFor(() => expect(book.asks.size).toBe(0));
    expect(book.bestBid()).toBe("0.0383");
  });

  it("rebuilds on a gap and on a clear", async () => {
    const { fake, book, rebuilds } = await start();
    fake.engine.restMarketOrder("NIGHT-USD", "buy", "0.0383", "400000");
    await vi.waitFor(() => expect(book.bestBid()).toBe("0.0383"));
    fake.market.injectL3Gap("NIGHT-USD");
    fake.engine.restMarketOrder("NIGHT-USD", "sell", "0.0390", "1000");
    await vi.waitFor(() => expect(rebuilds).toContain("gap"));
    await vi.waitFor(() => expect(book.bestAsk()).toBe("0.039"));
    fake.market.injectL3Clear("NIGHT-USD");
    await vi.waitFor(() => expect(rebuilds).toContain("clear"));
    await vi.waitFor(() => expect(book.synced && book.bestAsk() === "0.039").toBe(true));
  });

  it("streams markPriceUpdate and serves markets and live positions", async () => {
    const { fake, reads } = await start();
    fake.market.setPrice("NIGHT-USD", { mark: "0.03835", index: "0.0383" });
    fake.market.marketsPayload = { "NIGHT-USD": { symbol: "NIGHT-USD" } };
    fake.market.livePositions = { positions: [{ symbol: "NIGHT-USD", size: "100" }] };
    const seen: unknown[] = [];
    const sock = new ReconnectingSocket({
      url: `${fake.wsOrigin}/ws/price`,
      userAgent: UA,
      onOpen: (s) => s.send({ method: "SUBSCRIBE", params: ["night-usd@markprice@1s"], id: 1 }),
      onMessage: (m) => seen.push(m),
    });
    sock.start();
    stops.push(() => sock.stop());
    await vi.waitFor(() =>
      expect(seen).toContainEqual(
        expect.objectContaining({ e: "markPriceUpdate", s: "NIGHT-USD", p: "0.03835" }),
      ),
    );
    expect((await reads.markets()).markets).toHaveProperty("NIGHT-USD");
    expect((await reads.livePositions()).positions).toHaveLength(1);
  });
});
