import { parseArgs } from "node:util";

export interface BookHealthArgs {
  root: string;
  symbols: string[];
  fromMs: number;
  toMs: number;
  json?: string;
}

/**
 * `--root dir [--from ISO] [--to ISO] [--symbols A,B] [--json file]`. The window defaults to the
 * first recorded hour (from `firstHourMs`) through `nowMs`.
 */
export function parseBookHealthArgs(
  argv: readonly string[],
  opts: { nowMs: number; firstHourMs: (root: string) => number | undefined },
): BookHealthArgs {
  // pnpm forwards the "--" separator itself.
  const { values } = parseArgs({
    args: argv[0] === "--" ? argv.slice(1) : [...argv],
    options: {
      root: { type: "string", default: "data/recordings" },
      from: { type: "string" },
      to: { type: "string" },
      symbols: { type: "string", default: "NIGHT-USD,ADA-USD" },
      json: { type: "string" },
    },
  });
  const root = values.root ?? "data/recordings";
  const symbols = (values.symbols ?? "").split(",").filter(Boolean);
  if (symbols.length === 0) throw new Error("--symbols must name at least one market");
  const fromMs = values.from ? Date.parse(values.from) : (opts.firstHourMs(root) ?? 0);
  const toMs = values.to ? Date.parse(values.to) : opts.nowMs;
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) {
    throw new Error("--from/--to must be ISO times with from < to");
  }
  return { root, symbols, fromMs, toMs, ...(values.json ? { json: values.json } : {}) };
}
