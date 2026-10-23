import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A runtime import graph over the workspace's TypeScript sources: relative imports, and
 * `@ballast/*` specifiers resolved through each package's `exports` map (subpaths included).
 * `import type` / `export type` statements are skipped (erased at build time, so not in the
 * bundle); other packages and node builtins are recorded as `pkg:<name>`.
 */
const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "../../..");

const workspace = new Map<string, { dir: string; exports: Record<string, string> }>();
for (const group of ["packages", "apps"]) {
  for (const d of readdirSync(join(ROOT, group))) {
    const pj = join(ROOT, group, d, "package.json");
    if (!existsSync(pj)) continue;
    const json = JSON.parse(readFileSync(pj, "utf8")) as {
      name: string;
      exports?: Record<string, string>;
    };
    workspace.set(json.name, {
      dir: join(ROOT, group, d),
      exports: json.exports ?? { ".": "./src/index.ts" },
    });
  }
}

const STATEMENT_RE = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)"/g;
const DYNAMIC_RE = /import\(\s*"([^"]+)"\s*\)/g;
const SIDE_EFFECT_RE = /(?:^|\n)\s*import\s+"([^"]+)"/g;

export function runtimeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(STATEMENT_RE)) {
    if (m[2]) continue; // import type / export type
    const clause = m[3] ?? "";
    // `import { type A, type B } from` is erased too when every binding is type-only.
    const braces = /^\{([\s\S]*)\}$/.exec(clause.trim());
    if (braces) {
      const names = (braces[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith("type "))) continue;
    }
    out.push(m[4] as string);
  }
  for (const m of text.matchAll(DYNAMIC_RE)) out.push(m[1] as string);
  for (const m of text.matchAll(SIDE_EFFECT_RE)) out.push(m[1] as string);
  return out;
}

function resolveSpec(from: string, spec: string): string {
  if (spec.startsWith(".")) return resolve(dirname(from), spec.replace(/\.js$/, ".ts"));
  const m = /^(@ballast\/[^/]+)(\/.*)?$/.exec(spec);
  if (m) {
    const pkg = workspace.get(m[1] as string);
    if (!pkg) throw new Error(`unknown workspace package ${spec}`);
    const sub = m[2] ? `.${m[2]}` : ".";
    const target = pkg.exports[sub];
    if (!target) throw new Error(`${spec} is not exported by ${m[1]}`);
    return resolve(pkg.dir, target);
  }
  return `pkg:${spec}`;
}

/** Every module reachable at runtime from the entry files. */
export function reachable(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    if (f.startsWith("pkg:")) continue;
    for (const spec of runtimeImports(f)) {
      const r = resolveSpec(f, spec);
      if (!seen.has(r)) stack.push(r);
    }
  }
  return seen;
}

export const rel = (f: string) => (f.startsWith("pkg:") ? f : f.slice(ROOT.length + 1));

export function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name));
}
