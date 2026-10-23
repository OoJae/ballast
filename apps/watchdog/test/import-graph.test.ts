import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as watchdog from "../src/index.js";
import { ROOT, reachable, rel, sources } from "./graph.js";

/**
 * Invariant 4, build half: "the watchdog bundle exports no create path". The watchdog's runtime
 * module graph (its sources plus every workspace module they reach) contains no order builder,
 * no create method and no module that defines one; only cancels and signed GETs can be built.
 */
const entries = sources(join(ROOT, "apps/watchdog/src"));
const graph = [...reachable(entries)];
const files = graph.filter((f) => !f.startsWith("pkg:"));

const FORBIDDEN_MODULES = [
  "packages/strike-client/src/index.ts",
  "packages/strike-client/src/signed-client.ts",
  "packages/strike-client/src/orders.ts",
  "packages/strike-client/src/silent-drop.ts",
  "packages/engine/src/index.ts",
  "packages/engine/src/differ.ts",
  "packages/engine/src/requote.ts",
  "packages/engine/src/keeper.ts",
  "packages/guard/src/index.ts",
  "packages/guard/src/guard.ts",
];

/** Definitions that build or send a create. */
const CREATE_DEFS =
  /\b(?:function|async\s+function)\s+(limitOrder|reduceOnlyBuyBack|batchOrders|replaceBatch|placeBatch|placeBuyBack|farToNear)\b|^\s*(?:async\s+)?(placeBatch|replaceBatch|placeBuyBack|setLeverage|setMarginMode)\s*\(/m;

describe("watchdog import graph (CANCEL_ONLY build)", () => {
  it("reaches only the cancel-only barrel, the exempt Guard and the engine's id helpers", () => {
    const reached = files.map(rel);
    for (const f of FORBIDDEN_MODULES) expect(reached, f).not.toContain(f);
    const engine = reached.filter((f) => f.startsWith("packages/engine/"));
    expect(engine.sort()).toEqual([
      "packages/engine/src/client-id.ts",
      "packages/engine/src/fingerprint.ts",
    ]);
    expect(reached).toContain("packages/strike-client/src/cancel-only-client.ts");
    expect(reached).toContain("packages/guard/src/exempt.ts");
    expect(reached.some((f) => f.startsWith("apps/keeper/") || f.startsWith("packages/sim/"))).toBe(
      false,
    );
  });

  it("no reachable module defines a create builder or a create method", () => {
    for (const f of files) {
      expect(CREATE_DEFS.test(readFileSync(f, "utf8")), rel(f)).toBe(false);
    }
  });

  it("no reachable module names a create route except the allowlist that refuses it", () => {
    const create = /"\/v2\/(orders\/batch|order\/replace-batch|leverage|marginMode)"/;
    // GET /v2/order is a read; a POST to it would be the reduce-only create.
    const post = /sendWrite\(\s*"POST"|write\(\s*"POST"/;
    for (const f of files) {
      if (rel(f) === "packages/strike-client/src/routes.ts") continue;
      const text = readFileSync(f, "utf8");
      expect(create.test(text), rel(f)).toBe(false);
      expect(post.test(text), rel(f)).toBe(false);
    }
  });

  it("never reaches the Advisor or an LLM SDK", () => {
    expect(graph.filter((f) => f.includes("/advisor/") || f.includes("anthropic"))).toEqual([]);
  });

  it("the watchdog's own exports contain no create function", () => {
    for (const [name, v] of Object.entries(watchdog)) {
      expect(/place|create(Order|Batch)|replace|buyBack/i.test(name), name).toBe(false);
      if (typeof v === "function") expect(String(v)).not.toMatch(/replace-batch|orders\/batch/);
    }
  });
});
