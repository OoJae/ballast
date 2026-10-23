import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type HealthSample,
  levelsFromL3,
  measureLevels,
  replay,
  type TakerBuy,
} from "../src/index.js";

const root = fileURLToPath(new URL("./fixtures/rec", import.meta.url));
const fromMs = 1_792_716_885_000;

describe("replay hooks", () => {
  it("hands every Book Health sample the book it was measured on", async () => {
    const samples: { s: HealthSample; recomputed: string | null; spread: string | null }[] = [];
    const buys: [string, TakerBuy][] = [];
    const res = await replay({
      root,
      symbols: ["NIGHT-USD", "ADA-USD"],
      fromMs,
      toMs: fromMs + 60_000,
      onHealthSample: (s) => {
        // Read synchronously: the book keeps moving after the hook returns.
        const levels = levelsFromL3(s.book, s.spec);
        samples.push({
          s,
          recomputed: measureLevels(levels, s.spec).spreadBps?.toFixed() ?? null,
          spread: s.pair.actual.spreadBps?.toFixed() ?? null,
        });
      },
      onTakerBuy: (symbol, buy) => buys.push([symbol, buy]),
    });
    for (const symbol of ["NIGHT-USD", "ADA-USD"]) {
      const r = res.symbols.get(symbol);
      const mine = samples.filter((x) => x.s.symbol === symbol);
      expect(mine.length).toBe(r?.stats.healthSamples);
      expect(buys.filter(([s]) => s === symbol).length).toBe(r?.stats.takerBuys);
    }
    for (const { s, recomputed, spread } of samples) {
      expect(s.tMs % 1_000).toBe(0);
      expect(s.tMs).toBeGreaterThanOrEqual(fromMs);
      expect(s.tMs).toBeLessThan(fromMs + 60_000);
      expect(s.armed).toBe(false);
      expect(recomputed).toBe(spread);
    }
    for (const [, b] of buys) expect(b.fills.length).toBeGreaterThan(0);
  });
});
