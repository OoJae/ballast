import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, reachable, rel, sources } from "../../watchdog/test/graph.js";

/**
 * Invariants 18 and 19, build half: the keeper's runtime module graph has no funding module and
 * no deposit, withdraw or vault-action path (it can never move a holder's money), and it never
 * reaches the Advisor or an LLM SDK (the Advisor runs in the API process, off the order path).
 */
const graph = [...reachable(sources(join(ROOT, "apps/keeper/src")))];
const files = graph.filter((f) => !f.startsWith("pkg:"));

describe("keeper import graph", () => {
  it("is not vacuous: the keeper does reach the signer and the full Guard", () => {
    const reached = files.map(rel);
    expect(reached).toContain("packages/strike-client/src/signed-client.ts");
    expect(reached).toContain("packages/guard/src/guard.ts");
    expect(reached).toContain("packages/engine/src/requote.ts");
  });

  it("has no funding module and no deposit, withdraw or vault-action call site", () => {
    const reached = files.map(rel);
    expect(
      reached.filter((f) =>
        /funding\.ts$|deposit|withdraw|packages\/cardano|apps\/web|apps\/api/.test(f),
      ),
    ).toEqual([]);
    const money =
      /"\/v2\/(deposit|withdraw)|\/v2\/vaults?\/(deposit|withdraw|redeem|transfer)|\/v2\/isoMargin/;
    for (const f of files) {
      // routes.ts names them only to refuse them.
      if (rel(f) === "packages/strike-client/src/routes.ts") continue;
      expect(money.test(readFileSync(f, "utf8")), rel(f)).toBe(false);
    }
  });

  it("never reaches the Advisor or the Anthropic SDK (invariant 19)", () => {
    expect(graph.filter((f) => f.includes("/advisor/") || f.includes("anthropic"))).toEqual([]);
  });
});
