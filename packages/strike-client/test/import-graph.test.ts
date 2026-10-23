import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Invariant 18, enforced on the source: the keeper and the watchdog bundles contain no funding
 * code. The graph follows relative imports and @ballast/* workspace imports (through each
 * package's `exports`), so a funding module reached through any package shows up here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

const IMPORT_RE = /(?:import|export)\s[^;]*?from\s+"([^"]+)"|import\("([^"]+)"\)/g;

function importsOf(file: string): string[] {
  const out: string[] = [];
  for (const m of readFileSync(file, "utf8").matchAll(IMPORT_RE))
    out.push((m[1] ?? m[2]) as string);
  return out;
}

const WORKSPACE = new Map<string, string>();
for (const group of ["packages", "apps"]) {
  for (const d of readdirSync(join(root, group))) {
    const pj = join(root, group, d, "package.json");
    if (!existsSync(pj)) continue;
    const name = (JSON.parse(readFileSync(pj, "utf8")) as { name: string }).name;
    WORKSPACE.set(name, join(root, group, d));
  }
}

/** Resolves `@ballast/x` or `@ballast/x/sub` through the package's exports map. */
function resolveWorkspace(spec: string): string | undefined {
  const m = /^(@ballast\/[^/]+)(\/.+)?$/.exec(spec);
  if (!m) return undefined;
  const dir = WORKSPACE.get(m[1] as string);
  if (!dir) return undefined;
  const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    exports?: Record<string, string>;
  };
  const target = pj.exports?.[m[2] ? `.${m[2]}` : "."];
  return target ? join(dir, target) : undefined;
}

/** NodeNext `./x.js` → x.ts; the web's bundler-style `./x` → x.ts or x.tsx; assets are skipped. */
function resolveRelative(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  if (/\.(css|svg|json)$/.test(spec)) return undefined;
  for (const c of [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
  ]) {
    if (existsSync(c) && /\.tsx?$/.test(c)) return c;
  }
  throw new Error(`cannot resolve ${spec} from ${from}`);
}

function reachable(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    if (f.startsWith("pkg:")) continue;
    for (const spec of importsOf(f)) {
      if (spec.startsWith(".")) {
        const r = resolveRelative(f, spec);
        if (r) stack.push(r);
      } else {
        const ws = resolveWorkspace(spec);
        if (ws) stack.push(ws);
        else seen.add(`pkg:${spec}`);
      }
    }
  }
  return seen;
}

const pkg = (name: string, sub = "src/index.ts") => join(root, "packages", name, sub);

/** What a keeper process imports; apps/keeper joins the list when it lands (M7). */
const KEEPER_ENTRIES = [
  pkg("core"),
  pkg("market"),
  pkg("engine"),
  pkg("guard"),
  pkg("sim"),
  pkg("governance"),
  pkg("cover"),
  pkg("evidence"),
  pkg("evidence", "src/db.ts"),
  pkg("evidence", "src/anchor.ts"),
  pkg("evidence", "src/bundle.ts"),
  pkg("strike-client"),
  ...["apps/keeper/src/main.ts"].map((f) => join(root, f)).filter(existsSync),
];
/** The watchdog's CANCEL_ONLY build: the Strike client, market data and cover. */
const WATCHDOG_ENTRIES = [
  pkg("strike-client"),
  pkg("market"),
  pkg("cover"),
  ...["apps/watchdog/src/main.ts"].map((f) => join(root, f)).filter(existsSync),
];

const FUNDING_FILE = pkg("strike-client", "src/funding.ts");
const CARDANO_DIR = join(root, "packages", "cardano");
/** The keeper's allowlist names the funding paths only to refuse them. */
const REFUSAL_LIST = pkg("strike-client", "src/routes.ts");

function fundingFootprint(graph: Set<string>): string[] {
  const hits: string[] = [];
  for (const f of graph) {
    if (f === FUNDING_FILE || f.startsWith(CARDANO_DIR)) hits.push(f);
    else if (f.startsWith("pkg:@emurgo/cardano-message-signing")) hits.push(f);
    else if (
      !f.startsWith("pkg:") &&
      f !== REFUSAL_LIST &&
      /\/v2\/(deposit|withdraw)/.test(readFileSync(f, "utf8"))
    ) {
      hits.push(`${f} (names a funding path)`);
    }
  }
  return hits;
}

describe("import graph (invariant 18)", () => {
  it("the keeper bundle reaches no funding module, no wallet code and no funding path", () => {
    const graph = reachable(KEEPER_ENTRIES);
    expect(graph.has(pkg("strike-client", "src/signed-client.ts"))).toBe(true);
    expect(fundingFootprint(graph)).toEqual([]);
  });

  it("the watchdog bundle reaches no funding module either", () => {
    expect(fundingFootprint(reachable(WATCHDOG_ENTRIES))).toEqual([]);
  });

  it("the funding module is real and is reached only through its own entry point", () => {
    const graph = reachable([pkg("strike-client", "src/funding.ts")]);
    expect(graph.has(pkg("cardano", "src/cose-verify.ts"))).toBe(true);
    // Negative control: the detector does fire on a bundle that contains funding code.
    expect(fundingFootprint(graph).length).toBeGreaterThan(0);
    const main = reachable([pkg("strike-client")]);
    expect(main.has(FUNDING_FILE)).toBe(false);
  });

  it("the public API server and the web app never reach the funding module", () => {
    const server = reachable([join(root, "apps/api/src/server.ts")]);
    expect(server.has(FUNDING_FILE)).toBe(false);
    const webMain = join(root, "apps/web/src/main.tsx");
    const web = reachable([webMain].filter(existsSync));
    expect(web.has(FUNDING_FILE)).toBe(false);
    expect([...web].filter((f) => f.startsWith("pkg:@emurgo"))).toEqual([]);
  });

  it("no runtime source imports the test wallet", () => {
    for (const group of ["packages", "apps"]) {
      for (const d of readdirSync(join(root, group))) {
        const src = join(root, group, d, "src");
        if (!existsSync(src) || d === "fake-strike") continue;
        for (const e of readdirSync(src, { withFileTypes: true, recursive: true })) {
          if (!e.isFile() || !/\.tsx?$/.test(e.name)) continue;
          const f = join(e.parentPath, e.name);
          if (f.startsWith(join(CARDANO_DIR, "src", "testing"))) continue;
          expect(
            importsOf(f).filter((s) => s.includes("cardano/testing")),
            f,
          ).toEqual([]);
        }
      }
    }
  });
});
