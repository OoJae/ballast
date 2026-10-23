import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaticHandler } from "../src/static.js";

let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ballast-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Ballast</title>");
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
  writeFileSync(join(dir, "..", "secret.txt"), "outside the root");
  const serve = createStaticHandler(dir);
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!serve(req, res, url.pathname)) {
      res.writeHead(404);
      res.end("fallthrough");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(dir, "..", "secret.txt"), { force: true });
});

describe("createStaticHandler", () => {
  it("serves hashed assets with long-lived caching and the right type", async () => {
    const r = await fetch(`${base}/assets/app-abc123.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/javascript");
    expect(r.headers.get("cache-control")).toContain("immutable");
  });

  it("falls back to index.html for client-side routes, never cached", async () => {
    const r = await fetch(`${base}/judge`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("<title>Ballast</title>");
    expect(r.headers.get("cache-control")).toBe("no-cache");
  });

  it("never serves /api paths or missing files with an extension", async () => {
    expect((await fetch(`${base}/api/book-health`)).status).toBe(404);
    expect((await fetch(`${base}/missing.png`)).status).toBe(404);
  });

  it("refuses paths that escape the root", async () => {
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/%2e%2e/%2e%2e/secret.txt"]) {
      const r = await fetch(`${base}${p}`);
      expect(await r.text()).not.toContain("outside the root");
    }
  });
});
