import { defaultQuotePolicy } from "@ballast/core";
import { dec } from "@ballast/market";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNTS,
  longRow,
  Simulator,
  SYNTHETIC_START_MS,
  type SyntheticSpec,
  synthesize,
} from "../src/index.js";

/**
 * Invariant 1 in the simulator (plan section 8): random sequences of fills, cover changes,
 * price paths and requotes, with the keeper, engine and Guard in the loop, never leave a
 * post-enforcement breach. Spends are seen in the mempool, as the cover oracle is built to.
 * Each run replays a full synthetic market, so this suite runs fewer cases than the 10k-run
 * engine property (inv01-cover.prop.test.ts) that exercises the same keeper and allocator.
 */
const POLICY = defaultQuotePolicy({ policyId: "01JC0FFEE00000000000000000", validFromMs: 0 });
const MIN = 60_000;

const arb = fc.record({
  drift: fc.array(fc.integer({ min: -8, max: 8 }), { minLength: 5, maxLength: 5 }),
  takers: fc.array(
    fc.record({
      at: fc.integer({ min: 20, max: 290 }),
      qty: fc.integer({ min: 200, max: 12_000 }),
      sell: fc.boolean(),
    }),
    { maxLength: 25 },
  ),
  covers: fc.array(
    fc.record({
      at: fc.integer({ min: 30, max: 290 }),
      who: fc.constantFrom("holder-0", "holder-a", "holder-b"),
      cover: fc.bigInt({ min: 0n, max: 500_000n }),
    }),
    { maxLength: 4 },
  ),
  lpBps: fc.integer({ min: -600, max: -40 }),
});

describe("invariant 1 in the simulator", () => {
  it("never holds a post-enforcement cover breach (and no other violation)", () => {
    let fills = 0;
    let coverEvents = 0;
    fc.assert(
      fc.property(arb, (a) => {
        const base = dec("0.0383");
        const index = (t: number) => {
          const minute = Math.min(4, Math.max(0, Math.floor((t - SYNTHETIC_START_MS) / MIN)));
          let bps = 0;
          for (let i = 0; i <= minute; i++) bps += a.drift[i] ?? 0;
          return base.times(dec(1).plus(dec(bps).div(10_000)));
        };
        const spec: SyntheticSpec = {
          startMs: SYNTHETIC_START_MS,
          durationMs: 5 * MIN,
          index,
          premiumBps: 25,
          bids: [
            { offBps: -8, qty: 80_000 },
            { offBps: -30, qty: 300_000 },
          ],
          asks: [
            { offBps: 122, qty: 13_000 },
            { offBps: 150, qty: 200_000 },
          ],
          requoteMs: 5_000,
          takers: a.takers
            .map((t) => ({
              tMs: SYNTHETIC_START_MS + t.at * 1_000,
              side: t.sell ? ("sell" as const) : ("buy" as const),
              qty: t.qty,
            }))
            .sort((x, y) => x.tMs - y.tMs),
          positions: [{ atMs: SYNTHETIC_START_MS + 500, rows: [longRow(base, a.lpBps)] }],
        };
        const sim = new Simulator({
          policy: POLICY,
          accounts: DEFAULT_ACCOUNTS,
          seed: 5,
          perturbations: {
            coverEvents: a.covers.map((c) => ({
              atMs: SYNTHETIC_START_MS + c.at * 1_000 + 137,
              accountId: c.who,
              coverSteps: c.cover,
            })),
          },
        });
        for (const r of synthesize(spec)) sim.onRecord(r);
        const rep = sim.finish();
        fills += rep.fills;
        coverEvents += rep.diagnostics["cover.events"] ?? 0;
        expect(rep.violations, rep.violationLog.join(" | ")).toEqual({
          cover: 0,
          floor: 0,
          p2: 0,
          static: 0,
          rate: 0,
        });
      }),
      { numRuns: 300 },
    );
    expect(fills).toBeGreaterThan(300);
    expect(coverEvents).toBeGreaterThan(300);
  }, 300_000);
});
