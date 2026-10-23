import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Cache-Control policies, by how fast the underlying data can change. */
export const CACHE = {
  none: "no-store",
  live: "public, max-age=1",
  short: "public, max-age=60, stale-while-revalidate=300",
  /** Derived only from sealed (hashed, rooted) hours: it cannot change. */
  sealed: "public, max-age=86400",
  stream: "no-cache, no-transform",
} as const;

export interface CorsPolicy {
  /** "*" or an exact origin list. */
  origins: "*" | readonly string[];
}

export function corsHeaders(req: IncomingMessage, cors: CorsPolicy): Record<string, string> {
  const base = { "Access-Control-Expose-Headers": "ETag, Cache-Control" };
  if (cors.origins === "*") return { ...base, "Access-Control-Allow-Origin": "*" };
  const origin = req.headers.origin;
  if (origin && cors.origins.includes(origin)) {
    return { ...base, "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return { Vary: "Origin" };
}

const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

/**
 * Sends JSON with a strong ETag; a matching If-None-Match gets 304 without a body. HEAD gets
 * the headers only.
 */
export function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  cache: string,
  extra: Record<string, string> = {},
): void {
  const json = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(json).digest("base64url").slice(0, 27)}"`;
  const headers: Record<string, string> = {
    ...SECURITY,
    ...extra,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cache,
    ETag: etag,
  };
  if (status === 200 && req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  headers["Content-Length"] = String(Buffer.byteLength(json));
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : json);
}

export function sendError(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  message: string,
  extra: Record<string, string> = {},
): void {
  sendJson(req, res, status, { error: message }, CACHE.none, extra);
}

/** An ISO time or epoch milliseconds; undefined when absent; NaN when unparsable. */
export function parseTime(v: string | null): number | undefined {
  if (v === null || v === "") return undefined;
  if (/^\d{1,16}$/.test(v)) return Number(v);
  return Date.parse(v);
}
