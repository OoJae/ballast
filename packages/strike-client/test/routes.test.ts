import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkRoute,
  FUNDING_ROUTES,
  type ProfileName,
  parseJsonExact,
  SIGNED_READ_PATHS,
  stringifyJsonExact,
} from "../src/index.js";

const OPENAPI = new URL("../openapi/", import.meta.url);
const pin = JSON.parse(readFileSync(new URL("PIN.json", OPENAPI), "utf8")) as {
  commit: string;
  files: Record<string, { sha256: string }>;
};

/** (method, path) for every operation under `paths:` in a pinned OpenAPI file. */
function specRoutes(file: string): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  let inPaths = false;
  let current: string | undefined;
  for (const line of readFileSync(new URL(file, OPENAPI), "utf8").split("\n")) {
    if (line === "paths:") {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (/^\S/.test(line)) break;
    const p = /^ {2}(\/\S+):\s*$/.exec(line);
    if (p) {
      current = p[1];
      continue;
    }
    const m = /^ {4}(get|post|put|delete|patch):\s*$/.exec(line);
    if (m && current) out.push({ method: (m[1] as string).toUpperCase(), path: current });
  }
  return out;
}

const TRADE = specRoutes("trade-api.yaml");
const USER = specRoutes("user-api.yaml");

// Other authenticated routes strike-auth lists, outside the two pinned files.
const EXTRA = [
  "POST /v2/vault/create",
  "POST /v2/vault/deposit",
  "POST /v2/vault/withdraw",
  "GET /v2/vault/positions",
  "GET /v2/vaults",
  "POST /v2/copy/subscribe",
  "DELETE /v2/copy/subscribe/abc",
  "POST /v2/grid/bot",
  "DELETE /v2/grid/bot/grid-1",
  "POST /v2/rfq",
  "PUT /v2/rfq/abc/response",
  "GET /v2/withdraw/limits",
  "POST /v2/wallet",
  "DELETE /v2/wallet/12",
  "POST /v2/builder",
  "POST /v2/account",
  ...FUNDING_ROUTES,
].map((r) => {
  const [method, path] = r.split(" ") as [string, string];
  return { method, path };
});

const SYMBOL = "NIGHT-USD";
const ask = {
  client_order_id: "bal_ask_1",
  symbol: SYMBOL,
  side: "sell",
  type: "limit",
  size: "300",
  price: "0.0389",
  post_only: true,
};
const buyBack = {
  client_order_id: "bal_bb_1",
  symbol: SYMBOL,
  side: "buy",
  type: "limit",
  size: "300",
  price: "0.0391",
  time_in_force: "IOC",
  reduce_only: true,
};

/** A body that passes every content check for its route, so only the route decides. */
function goodBody(method: string, path: string): unknown {
  switch (`${method} ${path}`) {
    case "POST /v2/orders/batch":
      return { orders: [ask] };
    case "POST /v2/order/replace-batch":
      return { replacements: [{ cancel: { order_id: 33428500, symbol: SYMBOL }, new_order: ask }] };
    case "POST /v2/order":
      return buyBack;
    case "DELETE /v2/order/cancel":
      return { symbol: SYMBOL, order_id: 33428500 };
    case "DELETE /v2/order/cancel-all":
      return { symbol: SYMBOL };
    case "POST /v2/leverage":
      return { symbol: SYMBOL, leverage: 2 };
    case "POST /v2/marginMode":
      return { symbol: SYMBOL, marginMode: "cross" };
    default:
      return method === "GET" ? undefined : { ...ask };
  }
}

const AUTONOMOUS_WRITES = new Set([
  "POST /v2/orders/batch",
  "POST /v2/order/replace-batch",
  "POST /v2/order",
  "DELETE /v2/order/cancel",
  "DELETE /v2/order/cancel-all",
  "POST /v2/leverage",
  "POST /v2/marginMode",
]);
const CANCEL_ONLY_WRITES = new Set(["DELETE /v2/order/cancel", "DELETE /v2/order/cancel-all"]);

// Written out here, not imported, so a change to the read allowlist must be made twice.
const EXPECTED_SIGNED_READS = new Set([
  "/v2/account",
  "/v2/balances",
  "/v2/portfolio",
  "/v2/positions",
  "/v2/closedPositions",
  "/v2/openOrders",
  "/v2/order",
  "/v2/symbols",
  "/v2/history/order",
  "/v2/history/fill",
  "/v2/history/funding",
  "/v2/history/transaction",
  "/v2/history/position",
]);

function allowed(profile: ProfileName, method: string, path: string): boolean {
  if (profile === "HOLDER_PRESENT") return false;
  if (method === "GET") return EXPECTED_SIGNED_READS.has(path);
  return (profile === "AUTONOMOUS" ? AUTONOMOUS_WRITES : CANCEL_ONLY_WRITES).has(
    `${method} ${path}`,
  );
}

const PROFILES: ProfileName[] = ["AUTONOMOUS", "CANCEL_ONLY", "HOLDER_PRESENT"];
const idArb = fc.stringMatching(/^[A-Za-z0-9-]{1,24}$/);

function fill(path: string, id: string): string {
  return path.replace(/\{[^}]+\}/g, id);
}

describe("pinned OpenAPI", () => {
  it("matches PIN.json (commit and file hashes)", () => {
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const [name, f] of Object.entries(pin.files)) {
      const sha = createHash("sha256")
        .update(readFileSync(new URL(name, OPENAPI)))
        .digest("hex");
      expect(sha, name).toBe(f.sha256);
    }
  });

  it("parses every operation", () => {
    expect(TRADE).toHaveLength(20);
    expect(USER).toHaveLength(11);
    expect(TRADE).toContainEqual({ method: "POST", path: "/v2/order/replace-batch" });
    expect(USER).toContainEqual({ method: "GET", path: "/v2/positions" });
  });
});

describe("route allowlist", () => {
  it("signs exactly the expected reads", () => {
    expect(new Set(SIGNED_READ_PATHS)).toEqual(EXPECTED_SIGNED_READS);
  });

  it("property: every spec (method, path) outside a profile's allowlist refuses to sign, whatever the body", () => {
    const routes = [...TRADE, ...USER, ...EXTRA];
    fc.assert(
      fc.property(
        fc.constantFrom(...routes),
        fc.constantFrom(...PROFILES),
        idArb,
        fc.option(fc.jsonValue(), { nil: undefined }),
        (route, profile, id, randomBody) => {
          const path = fill(route.path, id);
          const ok = allowed(profile, route.method, path);
          for (const body of [goodBody(route.method, path), randomBody]) {
            const r = checkRoute(profile, route.method, path, body);
            if (!ok) expect(r.ok, `${profile} ${route.method} ${path}`).toBe(false);
          }
          if (ok) {
            const r = checkRoute(profile, route.method, path, goodBody(route.method, path));
            expect(r.ok, `${profile} ${route.method} ${path}`).toBe(true);
          }
        },
      ),
      { numRuns: 5_000 },
    );
  });

  it("refuses replace routes, vault/copy/grid/RFQ/TWAP, isoMargin, PUT /v2/symbols and funding", () => {
    const refused = [
      ["POST", "/v2/order/replace"],
      ["POST", "/v2/orders/replace"],
      ["POST", "/v2/algo/twap"],
      ["POST", "/v2/isoMargin"],
      ["PUT", "/v2/symbols"],
      ["POST", "/v2/rfq"],
      ["POST", "/v2/rfqs"],
      ...FUNDING_ROUTES.map((r) => r.split(" ")),
    ];
    for (const profile of PROFILES) {
      for (const [m, p] of refused) {
        expect(
          checkRoute(profile, m as string, p as string, goodBody("POST", "/v2/orders/batch")).ok,
        ).toBe(false);
      }
    }
  });

  it("property: a vault_id or sub_account_id anywhere in a body refuses the request", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...AUTONOMOUS_WRITES),
        fc.constantFrom("vault_id", "sub_account_id"),
        fc.string(),
        fc.boolean(),
        (key, selector, value, nested) => {
          const [method, path] = key.split(" ") as [string, string];
          const body = structuredClone(goodBody(method, path)) as Record<string, unknown>;
          if (nested && Array.isArray(body.orders))
            (body.orders[0] as Record<string, unknown>)[selector] = value;
          else if (nested && Array.isArray(body.replacements)) {
            const item = body.replacements[0] as { new_order: Record<string, unknown> };
            item.new_order[selector] = value;
          } else body[selector] = value;
          expect(checkRoute("AUTONOMOUS", method, path, goodBody(method, path)).ok).toBe(true);
          const r = checkRoute("AUTONOMOUS", method, path, body);
          expect(r.ok).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("cancel-all must name a symbol: {} cancels every symbol", () => {
    for (const profile of ["AUTONOMOUS", "CANCEL_ONLY"] as const) {
      expect(checkRoute(profile, "DELETE", "/v2/order/cancel-all", {}).ok).toBe(false);
      expect(checkRoute(profile, "DELETE", "/v2/order/cancel-all", undefined).ok).toBe(false);
      expect(checkRoute(profile, "DELETE", "/v2/order/cancel-all", { symbol: "" }).ok).toBe(false);
      const r = checkRoute(profile, "DELETE", "/v2/order/cancel-all", { symbol: SYMBOL });
      expect(r).toMatchObject({ ok: true, cost: { rateClass: "cancel", ops: 1 } });
    }
  });

  it("POST /v2/order signs only a reduce-only IOC buy-back", () => {
    const variants = [
      { ...buyBack, reduce_only: false },
      { ...buyBack, time_in_force: "GTC" },
      { ...buyBack, side: "sell" },
      { ...buyBack, type: "stop" },
      { ...ask },
    ];
    for (const v of variants)
      expect(checkRoute("AUTONOMOUS", "POST", "/v2/order", v).ok).toBe(false);
    const ok = checkRoute("AUTONOMOUS", "POST", "/v2/order", buyBack);
    expect(ok).toMatchObject({ ok: true, route: "order.exit", cost: { rateClass: "reduce" } });
  });

  it("every buy in a batch or replace-batch must be reduce-only", () => {
    const bid = { ...ask, client_order_id: "bal_bid_1", side: "buy", post_only: false };
    expect(checkRoute("AUTONOMOUS", "POST", "/v2/orders/batch", { orders: [ask, bid] }).ok).toBe(
      false,
    );
    expect(
      checkRoute("AUTONOMOUS", "POST", "/v2/orders/batch", {
        orders: [ask, { ...bid, reduce_only: true }],
      }),
    ).toMatchObject({ ok: true, clientOrderIds: ["bal_ask_1", "bal_bid_1"], exitCreates: 1 });
    expect(
      checkRoute("AUTONOMOUS", "POST", "/v2/order/replace-batch", {
        replacements: [{ new_order: bid }],
      }).ok,
    ).toBe(false);
  });

  it("replace-batch costs one token per operation and must stay on one symbol", () => {
    const body = {
      replacements: [
        { cancel: { order_id: 1, symbol: SYMBOL }, new_order: ask },
        { cancel: { order_id: 2, symbol: SYMBOL } },
      ],
    };
    const twice = { replacements: [{ new_order: ask }, { new_order: { ...ask, price: "0.04" } }] };
    expect(checkRoute("AUTONOMOUS", "POST", "/v2/order/replace-batch", twice)).toMatchObject({
      ok: false,
      reason: "duplicate client_order_id bal_ask_1",
    });
    expect(checkRoute("AUTONOMOUS", "POST", "/v2/order/replace-batch", body)).toMatchObject({
      ok: true,
      cost: { rateClass: "create", ops: 3, creates: 1, cancels: 2, replaceBatch: true },
    });
    const mixed = {
      replacements: [{ cancel: { order_id: 1, symbol: "BTC-USD" }, new_order: ask }],
    };
    expect(checkRoute("AUTONOMOUS", "POST", "/v2/order/replace-batch", mixed).ok).toBe(false);
    const cancelOnly = { replacements: [{ cancel: { order_id: 1, symbol: SYMBOL } }] };
    expect(checkRoute("AUTONOMOUS", "POST", "/v2/order/replace-batch", cancelOnly)).toMatchObject({
      ok: true,
      cost: { rateClass: "cancel" },
    });
    expect(checkRoute("CANCEL_ONLY", "POST", "/v2/order/replace-batch", cancelOnly).ok).toBe(false);
  });

  it("refuses path tricks and account selectors in the query", () => {
    const tricks = [
      "/v2/orders/batch/",
      "/v2//orders/batch",
      "/v2/orders/../orders/batch",
      "/v2/Orders/batch",
      "/v2/orders%2Fbatch",
      "v2/orders/batch",
      "/v2/orders/batch?x=1",
    ];
    for (const p of tricks)
      expect(checkRoute("AUTONOMOUS", "POST", p, { orders: [ask] }).ok, p).toBe(false);
    for (const sel of ["account_id", "vault_id", "sub_account_id", "blockchain_address", "scope"]) {
      expect(checkRoute("AUTONOMOUS", "GET", `/v2/openOrders?${sel}=x`, undefined).ok).toBe(false);
      expect(
        checkRoute("CANCEL_ONLY", "GET", `/v2/positions?symbol=X&${sel}=y`, undefined).ok,
      ).toBe(false);
    }
    expect(checkRoute("AUTONOMOUS", "GET", "/v2/openOrders?symbol=NIGHT-USD", undefined).ok).toBe(
      true,
    );
    expect(checkRoute("AUTONOMOUS", "GET", "/v2/openOrders", {}).ok).toBe(false);
    expect(checkRoute("AUTONOMOUS", "get", "/v2/openOrders", undefined).ok).toBe(false);
  });
});

/** The body as checkRoute sees it in SignedClient: the parsed form of the bytes sent. */
const wire = (body: unknown) => parseJsonExact(stringifyJsonExact(body));
const ALLOWED_WRITES = [...AUTONOMOUS_WRITES].map((k) => k.split(" ") as [string, string]);

function objectsIn(v: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(v)) for (const x of v) objectsIn(x, out);
  else if (typeof v === "object" && v !== null) {
    out.push(v as Record<string, unknown>);
    for (const x of Object.values(v)) objectsIn(x, out);
  }
  return out;
}

/** Create objects inside a body (they are the ones carrying a client_order_id). */
const createsIn = (body: unknown) => objectsIn(body).filter((o) => "client_order_id" in o);

/** A different spelling of `key` that Go's case-insensitive match would bind to it. */
function caseVariant(key: string, pick: number): string {
  const variants = [
    key.toUpperCase(),
    key.charAt(0).toUpperCase() + key.slice(1),
    key.replace(/_([a-z])/g, (_m, c: string) => `_${c.toUpperCase()}`),
    key.replace(/s/, "\u017f"),
    key.replace(/k/, "\u212a"),
    [...key].map((c, i) => ((i + pick) % 2 ? c.toUpperCase() : c)).join(""),
  ].filter((v) => v !== key);
  return variants[pick % variants.length] as string;
}

type Mutation = (body: Record<string, unknown>, pick: number) => boolean;

/** Each mutation returns false when it does not apply to this body. */
const MUTATIONS: Record<string, Mutation> = {
  "case-variant key replaces the original": (body, pick) => {
    const objs = objectsIn(body).filter((o) => Object.keys(o).length > 0);
    const o = objs[pick % objs.length] as Record<string, unknown>;
    const key = Object.keys(o)[pick % Object.keys(o).length] as string;
    const value = o[key];
    delete o[key];
    o[caseVariant(key, pick)] = value;
    return true;
  },
  "case-variant key added after the original": (body, pick) => {
    const objs = objectsIn(body).filter((o) => Object.keys(o).length > 0);
    const o = objs[pick % objs.length] as Record<string, unknown>;
    const key = Object.keys(o)[pick % Object.keys(o).length] as string;
    o[caseVariant(key, pick)] = key === "side" ? "buy" : key === "reduce_only" ? false : o[key];
    return true;
  },
  "selector at any depth in any casing": (body, pick) => {
    const objs = objectsIn(body);
    const sel = ["vault_id", "sub_account_id"][pick % 2] as string;
    (objs[pick % objs.length] as Record<string, unknown>)[pick % 3 ? caseVariant(sel, pick) : sel] =
      "v1";
    return true;
  },
  "unknown extra key": (body, pick) => {
    const objs = objectsIn(body);
    const extra = ["stop_price", "close_position", "working_type", "price_protect", "foo"];
    (objs[pick % objs.length] as Record<string, unknown>)[extra[pick % extra.length] as string] =
      "x";
    return true;
  },
  "missing, uppercase or other type": (body, pick) => {
    const c = createsIn(body)[0];
    if (!c) return false;
    const values = [undefined, "LIMIT", "Limit", "stop", "stop_limit", "", 1];
    const v = values[pick % values.length];
    if (v === undefined) delete c.type;
    else c.type = v;
    return true;
  },
  "market type in a batch or replace-batch": (body) => {
    const c = createsIn(body)[0];
    if (c?.side !== "sell") return false;
    c.type = "market";
    delete c.price;
    delete c.post_only;
    return true;
  },
  "lowercase or unknown time_in_force": (body, pick) => {
    const c = createsIn(body)[0];
    if (!c) return false;
    c.time_in_force = ["gtc", "ioc", "fok", "Gtc", "GTX", ""][pick % 6];
    return true;
  },
  "uppercase or missing side": (body, pick) => {
    const c = createsIn(body)[0];
    if (!c) return false;
    if (pick % 3 === 0) delete c.side;
    else c.side = pick % 3 === 1 ? "SELL" : "BUY";
    return true;
  },
  "buy without reduce_only": (body, pick) => {
    const c = createsIn(body)[0];
    if (!c) return false;
    c.side = "buy";
    if (pick % 2) delete c.reduce_only;
    else c.reduce_only = false;
    delete c.post_only;
    return true;
  },
  "size or price not a positive decimal string": (body, pick) => {
    const c = createsIn(body)[0];
    if (!c) return false;
    const field = pick % 2 ? "size" : "price";
    c[field] = ["0", "-1", "1e-3", 300, "", " 1", "0x10"][pick % 7];
    return true;
  },
  "flag not a boolean": (body, pick) => {
    const c = createsIn(body)[0];
    if (!c) return false;
    c[pick % 2 ? "post_only" : "reduce_only"] = ["true", 1, null][pick % 3];
    return true;
  },
  "client_order_id missing, foreign or reserved": (body, pick) => {
    const c = createsIn(body)[0];
    if (!c) return false;
    const values = [undefined, "", "mine-1", "liq_1", "copy:1", 7];
    const v = values[pick % values.length];
    if (v === undefined) delete c.client_order_id;
    else c.client_order_id = v;
    return true;
  },
};

describe("route allowlist on allowlisted routes", () => {
  it("property: case-varied keys, selectors, extra keys and bad enums or values never sign", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALLOWED_WRITES),
        fc.constantFrom(...Object.keys(MUTATIONS)),
        fc.nat(),
        ([method, path], name, pick) => {
          const good = goodBody(method, path);
          expect(checkRoute("AUTONOMOUS", method, path, wire(good)).ok).toBe(true);
          const body = structuredClone(good) as Record<string, unknown>;
          if (!(MUTATIONS[name] as Mutation)(body, pick)) return;
          const r = checkRoute("AUTONOMOUS", method, path, wire(body));
          expect(r.ok, `${name}: ${method} ${path} ${stringifyJsonExact(body)}`).toBe(false);
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it("refuses the review probes (case-varied keys bound by Go's case-insensitive match)", () => {
    const probes: [string, string, unknown][] = [
      ["POST", "/v2/orders/batch", { orders: [{ ...ask, Side: "buy" }] }],
      ["POST", "/v2/orders/batch", { orders: [{ ...ask, Vault_Id: "v1" }] }],
      ["POST", "/v2/order", { ...buyBack, Reduce_Only: false, Time_In_Force: "GTC" }],
      [
        "POST",
        "/v2/order/replace-batch",
        { replacements: [{ new_order: { ...ask, SUB_ACCOUNT_ID: "s" } }] },
      ],
      [
        "POST",
        "/v2/order/replace-batch",
        { replacements: [{ new_order: { ...ask, type: undefined } }] },
      ],
      [
        "POST",
        "/v2/order/replace-batch",
        { replacements: [{ new_order: { ...ask, type: "LIMIT" } }] },
      ],
      [
        "POST",
        "/v2/orders/batch",
        { orders: [{ ...ask, post_only: undefined, time_in_force: "gtc" }] },
      ],
      ["POST", "/v2/orders/batch", { orders: [{ ...ask, type: "market", price: undefined }] }],
      ["DELETE", "/v2/order/cancel-all", { symbol: SYMBOL, Symbol: "" }],
      ["DELETE", "/v2/order/cancel", { symbol: SYMBOL, order_id: 5, Order_Id: 6 }],
    ];
    for (const [m, p, b] of probes) {
      expect(checkRoute("AUTONOMOUS", m, p, wire(b)).ok, stringifyJsonExact(b)).toBe(false);
    }
    for (const sel of ["Vault_Id", "\u017fub_account_id", "SUB_ACCOUNT_ID", "Account_ID"]) {
      const q = `/v2/openOrders?symbol=${SYMBOL}&${encodeURIComponent(sel)}=x`;
      expect(checkRoute("AUTONOMOUS", "GET", q, undefined).ok, sel).toBe(false);
    }
    expect(
      checkRoute("AUTONOMOUS", "GET", `/v2/openOrders?symbol=${SYMBOL}&Symbol=X`, undefined).ok,
    ).toBe(false);
  });

  it("reports client ids and exits so the client can route fees and refuse repeats", () => {
    const exitBid = { ...buyBack, client_order_id: "bal_bid_2", time_in_force: "GTC" };
    expect(
      checkRoute("AUTONOMOUS", "POST", "/v2/orders/batch", { orders: [ask, exitBid] }),
    ).toMatchObject({ ok: true, clientOrderIds: ["bal_ask_1", "bal_bid_2"], exitCreates: 1 });
    expect(checkRoute("AUTONOMOUS", "POST", "/v2/order", buyBack)).toMatchObject({
      ok: true,
      clientOrderIds: ["bal_bb_1"],
      exitCreates: 1,
    });
    expect(
      checkRoute("AUTONOMOUS", "POST", "/v2/orders/batch", { orders: [ask, { ...ask }] }).ok,
    ).toBe(false);
  });
});
