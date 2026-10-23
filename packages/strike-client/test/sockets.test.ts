import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { L3Feed, type L3Snapshot, ReconnectingSocket } from "../src/index.js";

let server: WebSocketServer | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    for (const c of server.clients) c.terminate();
    server.close(() => resolve());
  });
  server = undefined;
});

async function listen(onConnection: (ws: WebSocket, userAgent: string | undefined) => void) {
  server = new WebSocketServer({ port: 0 });
  server.on("connection", (ws, req) => onConnection(ws, req.headers["user-agent"]));
  await new Promise<void>((r) => server?.once("listening", () => r()));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("ReconnectingSocket", () => {
  it("sends the User-Agent, splits packed frames, and resubscribes after a server close", async () => {
    const agents: (string | undefined)[] = [];
    let connections = 0;
    const url = await listen((ws, ua) => {
      agents.push(ua);
      connections += 1;
      ws.send('{"n":1}\n{"n":2}');
      if (connections === 1) setTimeout(() => ws.close(1012, "restart"), 20);
    });
    const opens: number[] = [];
    const got: unknown[] = [];
    const sock = new ReconnectingSocket({
      url,
      userAgent: "ballast-test/1",
      maxBackoffMs: 20,
      onOpen: () => opens.push(Date.now()),
      onMessage: (m) => got.push(m),
    });
    sock.start();
    await vi.waitFor(() => expect(opens.length).toBe(2), { timeout: 3_000 });
    await vi.waitFor(() => expect(got.length).toBe(4));
    sock.stop();
    expect(agents).toEqual(["ballast-test/1", "ballast-test/1"]);
    expect(got.slice(0, 2)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("refuses client messages over 4 KiB", async () => {
    const url = await listen(() => {});
    const sock = new ReconnectingSocket({
      url,
      userAgent: "t",
      onOpen: () => {},
      onMessage: () => {},
    });
    expect(() => sock.send({ pad: "x".repeat(5_000) })).toThrow(/4 KiB/);
  });
});

describe("L3Feed", () => {
  it("bootstraps after the ack, applies updates, and rebuilds on a sequence gap", async () => {
    const received: { method: string; params: string[]; id: number }[] = [];
    let client: WebSocket | undefined;
    const url = await listen((ws) => {
      client = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { method: string; params: string[]; id: number };
        received.push(msg);
        ws.send(JSON.stringify({ id: msg.id, result: null }));
      });
    });
    let snapshots = 0;
    const fetchSnapshot = async (symbol: string): Promise<L3Snapshot> => {
      snapshots += 1;
      return { type: "l3_snapshot", symbol, last_sequence: 100, timestamp: 0, bids: [], asks: [] };
    };
    const rebuilds: string[] = [];
    const feed = new L3Feed({
      url,
      userAgent: "t",
      symbols: ["NIGHT-USD"],
      fetchSnapshot,
      rebuildCooldownMs: 0,
      maxBackoffMs: 20,
      onRebuild: (_s, reason) => rebuilds.push(reason),
    });
    feed.start();
    const book = feed.books.get("NIGHT-USD");
    await vi.waitFor(() => expect(book?.synced).toBe(true), { timeout: 3_000 });
    expect(received[0]).toMatchObject({ method: "SUBSCRIBE", params: ["night-usd@l3"] });

    const send = (u: object) =>
      client?.send(JSON.stringify({ type: "l3_update", symbol: "NIGHT-USD", timestamp: 0, ...u }));
    send({
      action: "open",
      sequence: 101,
      order_id: "A",
      side: "sell",
      price: "0.0386",
      remaining_size: "500",
    });
    await vi.waitFor(() => expect(book?.lastSequence).toBe(101));
    expect(book?.bestAsk()).toBe("0.0386");

    send({
      action: "open",
      sequence: 103,
      order_id: "B",
      side: "sell",
      price: "0.0387",
      remaining_size: "1",
    });
    await vi.waitFor(() => expect(rebuilds).toEqual(["gap"]));
    await vi.waitFor(() => expect(snapshots).toBe(2));
    expect(received.map((m) => m.method)).toEqual(["SUBSCRIBE", "UNSUBSCRIBE", "SUBSCRIBE"]);
    feed.stop();
  });
});
