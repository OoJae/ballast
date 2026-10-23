/**
 * Health endpoint and healthchecks.io-style dead-man ping.
 *
 * - `GET /healthz` answers 200 with the report when `ok`, else 503. Bind to localhost (or the
 *   private interface): it is for systemd, a local monitor or the operator, never the internet.
 * - The dead-man ping is optional (`BALLAST_DEADMAN_URL`). A healthy daemon pings `<url>`; an
 *   unhealthy one pings `<url>/fail`; a dead one stops pinging and the external service pages.
 *   Pings are throttled and can never throw into the caller.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface HealthReport {
  ok: boolean;
  role: "keeper" | "watchdog";
  mode: "dry-run" | "armed";
  /** Short machine-readable reasons when not ok. */
  problems: string[];
  [k: string]: unknown;
}

export interface HealthServer {
  url: string;
  close(): Promise<void>;
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export async function startHealthServer(opts: {
  report: () => HealthReport;
  host?: string;
  port?: number;
}): Promise<HealthServer> {
  const server: Server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url !== "/healthz" && req.url !== "/health")) {
      res.writeHead(404).end();
      return;
    }
    let r: HealthReport;
    try {
      r = opts.report();
    } catch (err) {
      r = {
        ok: false,
        role: "keeper",
        mode: "dry-run",
        problems: [`report threw: ${String(err)}`],
      };
    }
    res.writeHead(r.ok ? 200 : 503, { "content-type": "application/json" }).end(json(r));
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", r));
  const { address, port } = server.address() as AddressInfo;
  return {
    url: `http://${address}:${port}/healthz`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export interface DeadMan {
  /** Report the current health; sends at most one ping per `minIntervalMs` per state. */
  ping(ok: boolean): Promise<void>;
}

export function createDeadMan(opts: {
  url?: string;
  fetch?: typeof fetch;
  now?: () => number;
  minIntervalMs?: number;
  onError?: (err: string) => void;
}): DeadMan {
  if (!opts.url) return { ping: async () => {} };
  const base = opts.url.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const every = opts.minIntervalMs ?? 30_000;
  let lastOkAt = Number.NEGATIVE_INFINITY;
  let lastFailAt = Number.NEGATIVE_INFINITY;
  return {
    async ping(ok) {
      const t = now();
      // A state change pings at once; a steady state pings at most every `every` ms.
      if (ok && t - lastOkAt < every && lastFailAt < lastOkAt) return;
      if (!ok && t - lastFailAt < every && lastOkAt < lastFailAt) return;
      if (ok) lastOkAt = t;
      else lastFailAt = t;
      try {
        const res = await doFetch(ok ? base : `${base}/fail`, {
          method: "POST",
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) opts.onError?.(`dead-man ping HTTP ${res.status}`);
      } catch (err) {
        opts.onError?.(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
