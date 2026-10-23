import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Invariant 9: integer units in the engine and the Guard. Prices, sizes and money are bigint
 * ticks, steps and micro-USD; nothing in either package may parse a number from a string with a
 * float parser. (The market model's exact decimals enter only through its Grid.)
 */
const PACKAGES = ["../../engine/src", "../src"];
const BANNED = [/\bparseFloat\s*\(/, /\bparseInt\s*\(/, /\bNumber\s*\(/, /\bNumber\.parse/];

describe("invariant 9: no float parsing in engine or guard sources", () => {
  for (const rel of PACKAGES) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      it(`${rel}/${file}`, () => {
        const src = readFileSync(join(dir, file), "utf8");
        for (const re of BANNED) expect(re.test(src), `${file} matches ${re}`).toBe(false);
      });
    }
  }
});
