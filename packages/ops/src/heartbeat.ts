/**
 * Signed heartbeats (plan sections 5 and 6): the keeper's daemon key signs one every 2 s, and the
 * watchdog on host B fires a cancel-all when none has verified for 10 s.
 *
 * - hash = sha256(JCS(body)); sig = daemon Ed25519 over `ballast/heartbeat/v1:<hash>`, a domain
 *   no other record shares, so a decision signature can never pass as a heartbeat.
 * - A heartbeat proves liveness only if it is fresh, from a trusted daemon key and newer than the
 *   last one accepted from the same boot: a captured heartbeat replayed later is refused.
 * - Transport is push (host A has no inbound ports): an HTTP POST to the watchdog, or a file for
 *   single-host runs. The receiver trusts nothing but the signature.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { canonicalize, sha256Hex } from "@ballast/core";
import { type DaemonKey, SIG_DOMAIN, verifyDomainSignature } from "@ballast/governance";

export const HEARTBEAT_INTERVAL_MS = 2_000;
/** The watchdog's dead-man threshold. */
export const HEARTBEAT_DEADLINE_MS = 10_000;
/** Tolerated clock difference between hosts (both run chrony). */
export const HEARTBEAT_MAX_SKEW_MS = 5_000;

export interface HeartbeatAccount {
  accountId: string;
  symbol: string;
  restingAsks: number;
  quoting: boolean;
}

export interface HeartbeatBody {
  v: 1;
  kind: "ballast/heartbeat";
  daemonPubkey: string;
  /** Random per process start; seq restarts at 1 with each boot. */
  bootId: string;
  seq: number;
  tsMs: number;
  mode: "dry-run" | "armed";
  /** "stalled": the process is alive but its tick loop has not completed a tick lately. */
  state: "starting" | "running" | "stalled" | "stopping";
  decisionHead: { seq: number; hash: string | null };
  accounts: HeartbeatAccount[];
}

export interface SignedHeartbeat extends HeartbeatBody {
  hash: string;
  sig: string;
}

export function heartbeatHash(body: HeartbeatBody): string {
  return sha256Hex(canonicalize(body));
}

export function signHeartbeat(body: HeartbeatBody, key: DaemonKey): SignedHeartbeat {
  if (key.role !== "daemon") throw new TypeError("heartbeats are daemon-signed");
  if (body.daemonPubkey !== key.publicKeyHex) throw new TypeError("heartbeat names another key");
  const hash = heartbeatHash(body);
  return { ...body, hash, sig: key.signHeartbeatHash(hash) };
}

/** Integrity only: shape, hash and a trusted daemon's signature. Never throws. */
export function heartbeatIssues(hb: unknown, trustedDaemons: readonly string[]): string[] {
  try {
    if (typeof hb !== "object" || hb === null) return ["not an object"];
    const { hash, sig, ...body } = hb as SignedHeartbeat;
    const issues: string[] = [];
    if (body.v !== 1 || body.kind !== "ballast/heartbeat") issues.push("not a v1 heartbeat");
    if (!Number.isSafeInteger(body.seq) || body.seq < 1) issues.push("bad seq");
    if (!Number.isSafeInteger(body.tsMs)) issues.push("bad timestamp");
    if (typeof body.bootId !== "string" || !/^[0-9a-f]{16,64}$/.test(body.bootId))
      issues.push("bad boot id");
    if (heartbeatHash(body as HeartbeatBody) !== hash) issues.push("hash does not recompute");
    if (!trustedDaemons.includes(body.daemonPubkey)) issues.push("signer is not a trusted daemon");
    else if (!verifyDomainSignature(body.daemonPubkey, SIG_DOMAIN.heartbeat, hash, sig))
      issues.push("signature does not verify");
    return issues;
  } catch (err) {
    return [`malformed heartbeat: ${err instanceof Error ? err.message : String(err)}`];
  }
}

export type HeartbeatVerdict =
  | { ok: true; heartbeat: SignedHeartbeat }
  | { ok: false; reason: string };

export interface HeartbeatMonitorOptions {
  trustedDaemons: readonly string[];
  now?: () => number;
  deadlineMs?: number;
  maxSkewMs?: number;
}

/**
 * The watchdog's view of the keeper's liveness: the last accepted heartbeat per daemon key.
 * `alive()` is false until a first valid heartbeat arrives, so a watchdog that has never heard
 * the keeper treats it as dead once its own grace period ends.
 */
export class HeartbeatMonitor {
  private last: SignedHeartbeat | null = null;
  private lastAcceptedAtMs: number | null = null;
  readonly rejected: { atMs: number; reason: string }[] = [];

  constructor(private readonly opts: HeartbeatMonitorOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  offer(hb: unknown): HeartbeatVerdict {
    const now = this.now();
    const refuse = (reason: string): HeartbeatVerdict => {
      this.rejected.push({ atMs: now, reason });
      if (this.rejected.length > 1_000) this.rejected.shift();
      return { ok: false, reason };
    };
    const issues = heartbeatIssues(hb, this.opts.trustedDaemons);
    if (issues.length > 0) return refuse(issues.join("; "));
    const h = hb as SignedHeartbeat;
    const skew = this.opts.maxSkewMs ?? HEARTBEAT_MAX_SKEW_MS;
    if (h.tsMs > now + skew) return refuse(`heartbeat dated ${h.tsMs - now} ms in the future`);
    if (now - h.tsMs > (this.opts.deadlineMs ?? HEARTBEAT_DEADLINE_MS)) {
      return refuse(`heartbeat already ${now - h.tsMs} ms old`);
    }
    const prev = this.last;
    if (prev && prev.daemonPubkey === h.daemonPubkey) {
      if (prev.bootId === h.bootId && h.seq <= prev.seq) return refuse("replayed or reordered seq");
      if (prev.bootId !== h.bootId && h.tsMs <= prev.tsMs) return refuse("stale boot");
    }
    this.last = h;
    this.lastAcceptedAtMs = now;
    return { ok: true, heartbeat: h };
  }

  latest(): SignedHeartbeat | null {
    return this.last;
  }

  /** Milliseconds since the last accepted heartbeat was signed (Infinity before one). */
  ageMs(): number {
    return this.last ? this.now() - this.last.tsMs : Number.POSITIVE_INFINITY;
  }

  alive(): boolean {
    return this.ageMs() <= (this.opts.deadlineMs ?? HEARTBEAT_DEADLINE_MS);
  }

  get acceptedAtMs(): number | null {
    return this.lastAcceptedAtMs;
  }
}

export interface HeartbeatSink {
  publish(hb: SignedHeartbeat): Promise<void>;
}

/** Atomic write of the latest heartbeat (single-host runs and tests). */
export function fileHeartbeatSink(path: string): HeartbeatSink {
  mkdirSync(dirname(path), { recursive: true });
  return {
    async publish(hb) {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(hb)}\n`, { mode: 0o644 });
      renameSync(tmp, path);
    },
  };
}

export function readHeartbeatFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** POST to each watchdog's receiver. A failure is reported, never thrown. */
export function httpHeartbeatSink(
  urls: readonly string[],
  opts: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    onError?: (url: string, err: string) => void;
  } = {},
): HeartbeatSink {
  const doFetch = opts.fetch ?? fetch;
  return {
    async publish(hb) {
      const body = JSON.stringify(hb);
      await Promise.all(
        urls.map(async (url) => {
          try {
            const res = await doFetch(url, {
              method: "POST",
              headers: { "content-type": "application/json", "user-agent": "ballast-keeper" },
              body,
              signal: AbortSignal.timeout(opts.timeoutMs ?? 1_500),
            });
            if (!res.ok) opts.onError?.(url, `HTTP ${res.status}`);
          } catch (err) {
            opts.onError?.(url, err instanceof Error ? err.message : String(err));
          }
        }),
      );
    },
  };
}

/** Fan out to several sinks; each failure stays inside its sink. */
export function multiSink(sinks: readonly HeartbeatSink[]): HeartbeatSink {
  return {
    async publish(hb) {
      await Promise.all(sinks.map((s) => s.publish(hb).catch(() => {})));
    },
  };
}

export interface HeartbeatPublisherOptions {
  key: DaemonKey;
  sink: HeartbeatSink;
  snapshot: () => Omit<HeartbeatBody, "v" | "kind" | "daemonPubkey" | "bootId" | "seq" | "tsMs">;
  now?: () => number;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

/** Signs and publishes a heartbeat every `intervalMs` (default 2 s). */
export class HeartbeatPublisher {
  readonly bootId = randomBytes(8).toString("hex");
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: HeartbeatPublisherOptions) {}

  /** One heartbeat now. Resolves once the sink has finished (never rejects). */
  async beat(): Promise<SignedHeartbeat | null> {
    try {
      this.seq += 1;
      const hb = signHeartbeat(
        {
          v: 1,
          kind: "ballast/heartbeat",
          daemonPubkey: this.opts.key.publicKeyHex,
          bootId: this.bootId,
          seq: this.seq,
          tsMs: (this.opts.now ?? Date.now)(),
          ...this.opts.snapshot(),
        },
        this.opts.key,
      );
      await this.opts.sink.publish(hb);
      return hb;
    } catch (err) {
      this.opts.onError?.(err);
      return null;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.beat();
    this.timer = setInterval(() => void this.beat(), this.opts.intervalMs ?? HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export interface HeartbeatReceiver {
  url: string;
  close(): Promise<void>;
}

/**
 * The watchdog's receiver: `POST /heartbeat` with a signed heartbeat. 204 when accepted, 400
 * when refused (the reason is logged, not echoed). Bind it to the private (WireGuard) address.
 */
export async function startHeartbeatReceiver(opts: {
  monitor: HeartbeatMonitor;
  host?: string;
  port?: number;
  onVerdict?: (v: HeartbeatVerdict) => void;
}): Promise<HeartbeatReceiver> {
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/heartbeat") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {}
      const v = opts.monitor.offer(body);
      opts.onVerdict?.(v);
      res.writeHead(v.ok ? 204 : 400).end();
    });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", r));
  const { address, port } = server.address() as AddressInfo;
  return {
    url: `http://${address}:${port}/heartbeat`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
