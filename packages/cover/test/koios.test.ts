import { describe, expect, it } from "vitest";
import { KoiosClient, KoiosError, loadCoverConfig, USER_AGENT } from "../src/index.js";
import { h32, night, stakeAddr, utxo } from "./synth.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responder: (call: Call, n: number) => Response | Error) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const out = responder(call, calls.length);
    if (out instanceof Error) throw out;
    return out;
  }) as typeof fetch;
  return { impl, calls };
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const TIP = [
  { hash: h32("tip"), epoch_no: 663, abs_slot: 1, block_height: 14_103_884, block_time: 2 },
];
const noSleep = async () => {};

describe("Koios client: read-only, identified, bounded, retried", () => {
  it("GETs the tip with a custom User-Agent and no body", async () => {
    const f = fakeFetch(() => json(TIP));
    const k = new KoiosClient({ fetchImpl: f.impl, sleep: noSleep });
    expect((await k.tip()).block_height).toBe(14_103_884);
    expect(f.calls[0]).toMatchObject({
      url: "https://api.koios.rest/api/v1/tip",
      method: "GET",
      body: undefined,
    });
    expect(f.calls[0]?.headers["user-agent"]).toBe(USER_AGENT);
    expect(f.calls[0]?.headers.authorization).toBeUndefined();
  });

  it("POSTs account_utxos with _extended, follows pages, and splits bodies under 1 KB", async () => {
    const stakes = Array.from({ length: 40 }, (_, i) => stakeAddr(`s${i}`));
    const f = fakeFetch((call) => {
      const offset = Number(new URL(call.url).searchParams.get("offset"));
      const body = call.body as { _stake_addresses: string[] };
      // First chunk returns two full pages then a short one.
      if (body._stake_addresses[0] === stakes[0] && offset < 4) {
        return json([utxo(`p${offset}a`, "x", [night(1n)]), utxo(`p${offset}b`, "x", [night(1n)])]);
      }
      return json([utxo(`last${offset}`, "x", [night(1n)])]);
    });
    const k = new KoiosClient({ fetchImpl: f.impl, sleep: noSleep, pageSize: 2 });
    const rows = await k.accountUtxos(stakes);
    for (const c of f.calls) {
      expect(c.method).toBe("POST");
      expect(c.headers["content-type"]).toBe("application/json");
      expect(JSON.stringify(c.body).length).toBeLessThanOrEqual(1000);
      expect(c.body).toMatchObject({ _extended: true });
      expect(new URL(c.url).searchParams.get("limit")).toBe("2");
    }
    const sent = f.calls.flatMap(
      (c) => (c.body as { _stake_addresses: string[] })._stake_addresses,
    );
    expect(new Set(sent)).toEqual(new Set(stakes));
    expect(f.calls.length).toBeGreaterThan(3);
    expect(rows.length).toBe(5 + (f.calls.length - 3));
  });

  it("retries 429, 5xx, bad JSON and transport errors; fails fast on other 4xx", async () => {
    const seq = [
      new Error("ECONNRESET"),
      json({}, 503),
      json({}, 429, { "retry-after": "1" }),
      new Response("<html>", { status: 200 }),
      json(TIP),
    ];
    const slept: number[] = [];
    const f = fakeFetch((_c, n) => seq[n - 1] as Response | Error);
    const k = new KoiosClient({
      fetchImpl: f.impl,
      retries: 4,
      sleep: async (ms) => void slept.push(ms),
    });
    expect((await k.tip()).block_height).toBe(14_103_884);
    expect(f.calls).toHaveLength(5);
    expect(slept).toContain(1000);

    const bad = fakeFetch(() => json({ message: "bad" }, 400));
    await expect(new KoiosClient({ fetchImpl: bad.impl, sleep: noSleep }).tip()).rejects.toThrow(
      /HTTP 400/,
    );
    expect(bad.calls).toHaveLength(1);

    const down = fakeFetch(() => json({}, 502));
    await expect(
      new KoiosClient({ fetchImpl: down.impl, retries: 2, sleep: noSleep }).tip(),
    ).rejects.toThrow(/gave up after 3 attempts/);
  });

  it("rejects unexpected shapes and refuses any endpoint outside the read allowlist", async () => {
    const f = fakeFetch(() => json([{ hash: "nope" }]));
    await expect(
      new KoiosClient({ fetchImpl: f.impl, sleep: noSleep }).tip(),
    ).rejects.toBeInstanceOf(KoiosError);
    const k = new KoiosClient({ fetchImpl: fakeFetch(() => json([])).impl });
    // biome-ignore lint/suspicious/noExplicitAny: reaching past the typed surface on purpose
    const raw = k as any;
    await expect(
      raw.query("submittx", { body: "cbor" }, { safeParse: () => ({ success: true }) }),
    ).rejects.toThrow(/not a read-only endpoint/);
    expect(() => new KoiosClient({ baseUrl: "http://api.koios.rest/api/v1" })).toThrow(/https/);
  });

  it("sends a bearer token when configured and never puts it in an error", async () => {
    const token = "koios-token-abcdefghijklmnop";
    const f = fakeFetch(() => json({}, 401));
    const k = new KoiosClient({ fetchImpl: f.impl, token, sleep: noSleep });
    const err = await k.tip().catch((e: unknown) => e as Error);
    expect(f.calls[0]?.headers.authorization).toBe(`Bearer ${token}`);
    expect(String((err as Error).message)).not.toContain(token);
  });

  it("config: https only, r capped at 9000 bps", () => {
    expect(loadCoverConfig({})).toEqual({ koiosUrl: "https://api.koios.rest/api/v1", rBps: 5000 });
    expect(() => loadCoverConfig({ KOIOS_URL: "http://x.example" })).toThrow(/https/);
    expect(() => loadCoverConfig({ BALLAST_COVER_R_BPS: "9500" })).toThrow();
    expect(loadCoverConfig({ BALLAST_COVER_R_BPS: "9000" }).rBps).toBe(9000);
  });
});
