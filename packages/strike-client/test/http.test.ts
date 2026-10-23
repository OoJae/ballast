import { describe, expect, it } from "vitest";
import { createPublicHttp, parseFrame, StrikeHttpError } from "../src/index.js";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

function fakeFetch(replies: Reply[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const next = replies.shift();
    if (!next) throw new Error("no more replies");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: next.headers ?? {},
    });
  }) as typeof fetch;
  return { impl, calls };
}

describe("createPublicHttp", () => {
  it("sends a custom User-Agent and query parameters", async () => {
    const f = fakeFetch([{ status: 200, body: { ok: 1 } }]);
    const http = createPublicHttp({
      baseUrl: "https://api.example",
      userAgent: "ballast-test/1",
      fetch: f.impl,
    });
    expect(
      await http.getJson("/price/v2/depth", { symbol: "NIGHT-USD", limit: 1000, skip: undefined }),
    ).toEqual({ ok: 1 });
    expect(f.calls[0]?.url).toBe("https://api.example/price/v2/depth?symbol=NIGHT-USD&limit=1000");
    expect(f.calls[0]?.headers["User-Agent"]).toBe("ballast-test/1");
  });

  it("retries 503 and network errors, honouring Retry-After", async () => {
    const sleeps: number[] = [];
    const f = fakeFetch([
      { status: 503, headers: { "retry-after": "2" } },
      new TypeError("fetch failed"),
      { status: 200, body: [1] },
    ]);
    const http = createPublicHttp({
      baseUrl: "https://api.example",
      userAgent: "t",
      fetch: f.impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(await http.getJson("/v2/time")).toEqual([1]);
    expect(sleeps).toEqual([2_000, 1_000]);
  });

  it("does not retry client errors", async () => {
    const f = fakeFetch([{ status: 400, body: { code: "INVALID_SYMBOL" } }]);
    const http = createPublicHttp({
      baseUrl: "https://api.example",
      userAgent: "t",
      fetch: f.impl,
    });
    await expect(http.getJson("/price/v2/premiumIndex", { symbol: "X" })).rejects.toBeInstanceOf(
      StrikeHttpError,
    );
    expect(f.calls).toHaveLength(1);
  });

  it("gives up after maxRetries", async () => {
    const f = fakeFetch([{ status: 429 }, { status: 429 }, { status: 429 }]);
    const http = createPublicHttp({
      baseUrl: "https://api.example",
      userAgent: "t",
      fetch: f.impl,
      maxRetries: 2,
      sleep: async () => {},
    });
    await expect(http.getJson("/v2/markets")).rejects.toMatchObject({ status: 429 });
    expect(f.calls).toHaveLength(3);
  });
});

describe("parseFrame", () => {
  it("splits newline-packed frames and isolates bad lines", () => {
    const { messages, errors } = parseFrame('{"e":"trade"}\n\n{"e":"bookTicker"}\n{oops\n');
    expect(messages).toEqual([{ e: "trade" }, { e: "bookTicker" }]);
    expect(errors).toEqual(["{oops"]);
  });
});
