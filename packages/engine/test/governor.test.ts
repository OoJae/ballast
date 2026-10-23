import { microUsd } from "@ballast/core";
import {
  basisSample,
  bookTop,
  type Dec,
  DOCUMENTED_MARK_PARAMS,
  dec,
  mergeLevels,
  projectP2Path,
} from "@ballast/market";
import { describe, expect, it } from "vitest";
import { type GovernorInput, govern, NIGHT_CAPS } from "../src/index.js";
import { INDEX, longAt, MARK, NIGHT, nightBook, POLICY } from "./helpers.js";

const params = { ...DOCUMENTED_MARK_PARAMS, basisWindow: 10 };
const steady = basisSample(bookTop(nightBook(), NIGHT.spec, 0), INDEX, "impact");
const basis = Array.from({ length: 10 }, () => steady);

const base = (over: Partial<GovernorInput> = {}): GovernorInput => ({
  market: NIGHT,
  caps: NIGHT_CAPS,
  policy: POLICY,
  book: nightBook(),
  index: INDEX,
  mark: MARK,
  positions: [],
  positionsAgeMs: 0,
  replicaP99Bps: dec("0.77"),
  p2: { mode: "blind" },
  ...over,
});

describe("governor: P2-blind mode (before D6)", () => {
  it("admits L1 only, within $300, at max(F, mark, index + 38 bps)", () => {
    const r = govern(base());
    if (!r.ok) throw new Error(r.detail);
    expect(r.mode).toBe("blind");
    expect(r.l1).toBe(38_446n);
    expect(r.ladder.map((l) => [l.level, l.px, l.qty])).toEqual([[1, 38_446n, 7_803n]]);
    expect(r.p2).toEqual({ mode: "blind", fragileLong: false, capMicroUsd: 300_000_000n });
  });

  it("L1 clears the mark even with fresh positions", () => {
    const r = govern(base({ mark: dec("0.0386") }));
    if (!r.ok) throw new Error(r.detail);
    expect(r.l1).toBe(38_600n);
  });

  it("stands down while any long is fragile", () => {
    const r = govern(base({ positions: [longAt("0.0383")] }));
    expect(r).toMatchObject({ ok: false, reason: "blind-fragile-long" });
  });

  it("puts L1 above a non-fragile long's floor F", () => {
    // LP 0.0382 × (1 + b_liq 11.54 bps) = 0.03824408 → F 38245, below the index offset.
    const r = govern(base({ positions: [longAt("0.0382")] }));
    if (!r.ok) throw new Error(r.detail);
    expect(r.floor.ticks).toBe(38_245n);
    expect(r.l1).toBe(38_446n);
  });

  it("stands down when L1 would not improve the best ask by 5 bps", () => {
    const book = nightBook({ asks: [{ px: 38_460n, qty: 100_000n }] });
    expect(govern(base({ book }))).toMatchObject({ ok: false, reason: "no-improvement" });
    expect(govern(base({ book: nightBook({ asks: [] }) }))).toMatchObject({
      ok: false,
      reason: "no-reference-ask",
    });
  });

  it("respects a tighter aggregate budget and stands down when nothing fits", () => {
    const r = govern(base({ budget: microUsd(100_000_000n) }));
    if (!r.ok) throw new Error(r.detail);
    expect(r.ladder[0]?.qty).toBe(2_601n);
    expect(govern(base({ budget: microUsd(10n) }))).toMatchObject({
      ok: false,
      reason: "empty-ladder",
    });
  });

  it("stands down on a market that is not trading", () => {
    expect(govern(base({ market: { ...NIGHT, trading: false } }))).toMatchObject({
      ok: false,
      reason: "market-closed",
    });
  });
});

describe("governor: replica mode (after D6)", () => {
  const replica = { mode: "replica" as const, params, basis, basisGapFree: true };

  it("admits the full ladder when no long constrains P2, then re-projects it", () => {
    const r = govern(base({ p2: replica }));
    if (!r.ok) throw new Error(r.detail);
    expect(r.mode).toBe("replica");
    expect(r.ladder.map((l) => l.level)).toEqual([1, 2, 3]);
    expect(r.p2).toMatchObject({ mode: "replica", safe: true, minL1Ticks: r.l1 });
  });

  it("stands down without a full, gap-free basis window", () => {
    const gap = { ...replica, basisGapFree: false };
    expect(govern(base({ p2: gap }))).toMatchObject({
      ok: false,
      reason: "basis-history-incomplete",
    });
  });

  it("keeps every partial-fill state of the admitted ladder at or above the target", () => {
    // A long whose target sits under today's P2: Ballast's asks at F would drag P2 below it, so
    // the solve has to lift L1 above F.
    const p2Now = INDEX.plus(steady);
    const lp = p2Now.div("1.003").toDecimalPlaces(8);
    const r = govern(base({ p2: replica, positions: [longAt(lp.toFixed(), "200000")] }));
    if (!r.ok) throw new Error(`${r.reason}: ${r.detail}`);
    expect(r.l1 > r.floor.ticks).toBe(true);
    const target = r.floor.liquidationTarget as Dec;
    const book = nightBook();
    const minP2 = (asks: typeof book.asks) =>
      projectP2Path(
        basis,
        basisSample(bookTop({ bids: book.bids, asks }, NIGHT.spec, 0), INDEX, "impact"),
        INDEX,
        10,
      ).reduce((a, b) => (a.lt(b) ? a : b));
    const ladder = r.ladder.map((l) => ({ px: l.px, qty: l.qty }));
    expect(minP2(mergeLevels(book.asks, ladder, "ask")).gte(target)).toBe(true);
    expect(minP2(book.asks).gte(target)).toBe(true);
  });
});
