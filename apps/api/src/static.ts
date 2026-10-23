import { createReadStream, type Stats, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serves the built web app next to the API, so one keyless host can publish both. Only GET/HEAD
 * on non-/api paths reach it. Paths that resolve outside the root are refused; extensionless
 * misses fall back to index.html (client-side routes). Hashed assets are cached for a year,
 * index.html never.
 */
export function createStaticHandler(root: string) {
  const base = resolve(root);
  const index = join(base, "index.html");

  return function serve(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (pathname.startsWith("/api/") || pathname === "/api") return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    const target = resolve(base, `.${decoded}`);
    if (target !== base && !target.startsWith(base + sep)) return false;
    let file = target;
    let stat = statFile(file);
    if (!stat && extname(decoded) === "") {
      file = index;
      stat = statFile(index);
    }
    if (!stat) return false;
    const immutable = decoded.startsWith("/assets/");
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Content-Length": String(stat.size),
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
    return true;
  };
}

function statFile(path: string): Stats | null {
  try {
    const s = statSync(path);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}
