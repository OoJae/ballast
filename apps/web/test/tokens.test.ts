import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CVD_MODES, contrast, deltaE } from "../src/lib/color.js";

const css = readFileSync(join(import.meta.dirname, "../src/styles/tokens.css"), "utf8");

/** The declarations inside the first block whose selector text matches `selector`. */
function block(selector: RegExp): Map<string, string> {
  const m = selector.exec(css);
  if (!m) throw new Error(`no block matching ${selector}`);
  const start = css.indexOf("{", m.index + m[0].length - 1) + 1;
  const end = css.indexOf("}", start);
  const vars = new Map<string, string>();
  for (const d of css.slice(start, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars.set(d[1] as string, (d[2] as string).trim());
  }
  return vars;
}

const dark = block(/:root,\s*\[data-theme="dark"\]\s*\{/);
const lightMedia = block(/:root:not\(\[data-theme="dark"\]\)\s*\{/);
const lightAttr = block(/\n\[data-theme="light"\]\s*\{/);

/** Resolves `var(--x)` chains to a hex value. */
function hex(theme: Map<string, string>, name: string): string {
  let v = theme.get(name);
  for (let i = 0; i < 5 && v?.startsWith("var("); i++) {
    v = theme.get(v.slice(4, -1).trim());
  }
  if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${name} is not a hex colour: ${v}`);
  return v;
}

const THEMES = { dark, light: lightAttr };

describe("design tokens", () => {
  it("writes the light theme identically for the OS preference and the explicit choice", () => {
    expect([...lightMedia.entries()]).toEqual([...lightAttr.entries()]);
    expect(lightAttr.size).toBeGreaterThan(20);
  });

  it("defines every token the charts read in both themes", () => {
    const read = ["--surface", "--line", "--line-strong", "--ink", "--ink-2", "--ink-3"];
    const series = ["--bid", "--ask", "--ballast", "--cf", "--brass", "--band"];
    for (const t of Object.values(THEMES)) {
      for (const name of [...read, ...series]) expect(t.has(name), name).toBe(true);
    }
    expect([...dark.keys()].sort()).toEqual([...lightAttr.keys()].sort());
  });

  for (const [name, t] of Object.entries(THEMES)) {
    it(`meets contrast floors in the ${name} theme`, () => {
      const grounds = ["--bg", "--bg-deep", "--surface"];
      for (const g of grounds) {
        for (const fg of ["--ink", "--ink-2", "--ink-3", "--accent-text", "--good", "--bad"]) {
          expect(contrast(hex(t, fg), hex(t, g)), `${fg} on ${g}`).toBeGreaterThanOrEqual(4.5);
        }
        for (const ui of ["--line-strong", "--lead", "--cf", "--bid", "--focus"]) {
          expect(contrast(hex(t, ui), hex(t, g)), `${ui} on ${g}`).toBeGreaterThanOrEqual(3);
        }
      }
      expect(contrast(hex(t, "--on-accent"), hex(t, "--accent-fill"))).toBeGreaterThanOrEqual(4.5);
      // The primary button's border (accent text colour) keeps its edge visible on any ground.
      expect(contrast(hex(t, "--accent-text"), hex(t, "--bg-deep"))).toBeGreaterThanOrEqual(3);
    });

    it(`keeps bids, asks and Ballast apart for colour-blind readers (${name})`, () => {
      const pairs: [string, string, number][] = [
        ["--bid", "--ask", 8],
        ["--bid", "--ballast", 8],
        ["--ask", "--ballast", 8],
        ["--ballast", "--cf", 8],
        ["--good", "--bad", 8],
      ];
      for (const [a, b, min] of pairs) {
        for (const mode of CVD_MODES) {
          const floor = mode === "normal" ? Math.max(min, 15) : min;
          expect(deltaE(hex(t, a), hex(t, b), mode), `${a}~${b} ${mode}`).toBeGreaterThanOrEqual(
            floor,
          );
        }
      }
    });
  }

  it("computes WCAG contrast the standard way", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ece6d9", "#0a0e13")).toBeCloseTo(15.56, 1);
  });
});
