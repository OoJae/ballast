import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Process separation, enforced on the source (invariants 18 and 19):
 * - the governance entry point the keeper imports never reaches the Advisor or the Anthropic SDK;
 * - governance, cover and evidence never import the Strike client or name a Strike host, so
 *   nothing here can deposit, withdraw or place an order.
 */
const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, "../..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name));
}

const IMPORT_RE = /(?:import|export)\s[^;]*?from\s+"([^"]+)"|import\("([^"]+)"\)/g;

function importsOf(file: string): string[] {
  const out: string[] = [];
  for (const m of readFileSync(file, "utf8").matchAll(IMPORT_RE))
    out.push((m[1] ?? m[2]) as string);
  return out;
}

function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of importsOf(f)) {
      if (spec.startsWith(".")) stack.push(resolve(dirname(f), spec.replace(/\.js$/, ".ts")));
      else seen.add(`pkg:${spec}`);
    }
  }
  return seen;
}

describe("import graph", () => {
  it("@ballast/governance's main entry never reaches the Advisor or an LLM SDK", () => {
    const graph = [...reachable(join(packages, "governance/src/index.ts"))];
    expect(graph.filter((f) => f.includes("/advisor/"))).toEqual([]);
    expect(graph.filter((f) => f.includes("anthropic"))).toEqual([]);
  });

  it("governance, cover and evidence never import the Strike client or name a Strike host", () => {
    for (const pkg of ["governance", "cover", "evidence"]) {
      for (const f of sources(join(packages, pkg, "src"))) {
        expect(
          importsOf(f).filter((s) => s.includes("strike-client")),
          f,
        ).toEqual([]);
        expect(readFileSync(f, "utf8"), f).not.toMatch(/strikefinance\.org/);
      }
    }
  });

  it("only the Advisor imports the Anthropic SDK", () => {
    for (const pkg of ["governance", "cover", "evidence", "core", "market", "strike-client"]) {
      for (const f of sources(join(packages, pkg, "src"))) {
        if (f.includes("/governance/src/advisor/")) continue;
        expect(
          importsOf(f).filter((s) => s.includes("anthropic")),
          f,
        ).toEqual([]);
      }
    }
  });
});
