import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Decimal } from "decimal.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  add,
  bankruptcyPrice,
  builderFee,
  commission,
  crossProfile,
  type Dec,
  dec,
  derivePosition,
  effectiveRate,
  fundingTransfer,
  impactNotional,
  isolatedProfile,
  liquidationPrice,
  listSegmentFiles,
  makerFee,
  maxPositionNotional,
  mul,
  parseMarginTiers,
  type RawMarginTier,
  readRecordings,
  riskLevel,
  sub,
  tierIndexByLeverage,
  tierIndexByNotional,
} from "../src/index.js";

interface MarketRow {
  quote_prec: number;
  margin_tiers: RawMarginTier[];
  impact_notional: string;
}
/** Public `/v2/markets` fields only (margin tiers are public market data). */
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/markets.json", import.meta.url), "utf8"),
) as { markets: Record<string, MarketRow> };
const market = (s: string, markets: Record<string, MarketRow> = fixture.markets) => {
  const m = markets[s];
  if (!m) throw new Error(`fixture has no ${s}`);
  return { tiers: parseMarginTiers(m.margin_tiers), quotePrec: m.quote_prec, raw: m };
};
const NIGHT = market("NIGHT-USD");

interface IsolatedRow {
  symbol: string;
  size: string;
  entry_price: string;
  mark_price: string;
  leverage: number;
  margin_mode: string;
  isolated_margin: string;
  liquidation_price: string;
  is_vault?: boolean;
}

/**
 * Golden rows come from the local recordings at test time (`BALLAST_RECORDINGS`, default the
 * gitignored data/recordings), never from a committed file: they are real positions. Isolated,
 * non-vault rows of the first recorded hours, deduplicated. Absent recordings skip the suite.
 */
async function recordedIsolatedRows(): Promise<{
  markets: Record<string, MarketRow>;
  rows: IsolatedRow[];
} | null> {
  const root =
    process.env.BALLAST_RECORDINGS ??
    fileURLToPath(new URL("../../../data/recordings", import.meta.url));
  if (!existsSync(root)) return null;
  const first = listSegmentFiles(root, { streams: ["rest"] })[0];
  if (!first) return null;
  const markets: Record<string, MarketRow> = {};
  const rows: IsolatedRow[] = [];
  const seen = new Set<string>();
  // The first three recorded hours keep the read short as recordings grow.
  const window = { fromMs: first.hourStartMs, toMs: first.hourStartMs + 3 * 3_600_000 };
  for await (const r of readRecordings(root, { streams: ["rest"], ...window })) {
    if (r.k === "markets") {
      for (const [s, m] of Object.entries(r.d as Record<string, MarketRow>)) {
        if (m?.margin_tiers) markets[s] = m;
      }
    } else if (r.k === "live-positions") {
      for (const p of ((r.d as { positions?: IsolatedRow[] }).positions ?? []) as IsolatedRow[]) {
        if (p.margin_mode !== "isolated" || p.is_vault || !markets[p.symbol]) continue;
        const key = JSON.stringify([
          p.symbol,
          p.size,
          p.entry_price,
          p.mark_price,
          p.isolated_margin,
        ]);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(p);
      }
    }
  }
  return rows.length > 0 ? { markets, rows } : null;
}
const golden = await recordedIsolatedRows();

describe("margin tiers", () => {
  it("derives every served maintenance amount", () => {
    for (const s of ["NIGHT-USD", "ADA-USD"]) {
      const { tiers, raw } = market(s);
      for (const [i, t] of tiers.entries()) {
        expect(t.ma.eq(dec(raw.margin_tiers[i]?.maintenance_amount ?? "x")), `${s} tier ${i}`).toBe(
          true,
        );
      }
    }
  });
  it("keeps a boundary notional in the lower tier and uses the last tier above the top", () => {
    expect(tierIndexByNotional(NIGHT.tiers, dec("5000"))).toBe(0);
    expect(tierIndexByNotional(NIGHT.tiers, dec("5000.000001"))).toBe(1);
    expect(tierIndexByNotional(NIGHT.tiers, dec("1000000000"))).toBe(8);
  });
  it("maps leverage to the highest tier that allows it", () => {
    expect(tierIndexByLeverage(NIGHT.tiers, 10)).toBe(4);
    expect(tierIndexByLeverage(NIGHT.tiers, 2)).toBe(6);
    expect(maxPositionNotional(NIGHT.tiers, 1).toFixed()).toBe("10000000");
    expect(() => tierIndexByLeverage(NIGHT.tiers, 11)).toThrow(RangeError);
  });
  it("matches the served impact notional", () => {
    for (const s of ["NIGHT-USD", "ADA-USD"]) {
      const { tiers, raw } = market(s);
      expect(impactNotional(tiers).eq(dec(raw.impact_notional))).toBe(true);
    }
  });
  it("rejects a malformed schedule", () => {
    const t = (n: string, l: number, m: string): RawMarginTier => ({
      max_notional: n,
      max_leverage: l,
      maintenance_margin_rate: m,
    });
    expect(() => parseMarginTiers([])).toThrow();
    expect(() => parseMarginTiers([t("10", 10, "0.01"), t("5", 5, "0.02")])).toThrow();
    expect(() => parseMarginTiers([t("10", 10, "0.02"), t("20", 5, "0.01")])).toThrow();
    expect(() => parseMarginTiers([t("10", 10, "1")])).toThrow();
  });
});

/**
 * The live-positions stats endpoint rounds each division to 20 decimal places (not govalues'
 * 19 digits). Reproducing that shows the formula itself is exact, digit for digit.
 */
function statsEndpointLp(p: IsolatedRow, mmr: Dec, ma: Dec): string {
  const D = Decimal.clone({ precision: 80 });
  const r = (x: Decimal) => x.toDecimalPlaces(20, Decimal.ROUND_HALF_EVEN);
  const size = new D(p.size);
  const dir = size.isPos() ? 1 : -1;
  const inner = r(new D(p.isolated_margin).plus(ma.toFixed()).div(size));
  return r(
    new D(p.entry_price).minus(inner).div(new D(1).minus(new D(mmr.toFixed()).times(dir))),
  ).toFixed();
}

/**
 * An independent reference: the skill's formula at 100 digits, with its own tier walk and MA
 * derivation from the raw schedule (nothing shared with src/).
 */
function referenceLp(
  p: IsolatedRow,
  raw: readonly RawMarginTier[],
): { lp: Decimal | null; scale: Decimal } {
  const R = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_EVEN });
  const ma: Decimal[] = [];
  raw.forEach((t, i) => {
    const prev = raw[i - 1];
    ma.push(
      prev
        ? (ma[i - 1] as Decimal).plus(
            new R(prev.max_notional).times(
              new R(t.maintenance_margin_rate).minus(prev.maintenance_margin_rate),
            ),
          )
        : new R(0),
    );
  });
  const size = new R(p.size);
  const notional = new R(p.mark_price).times(size.abs());
  let i = raw.findIndex((t) => notional.lte(t.max_notional));
  if (i < 0) i = raw.length - 1;
  const t = raw[i] as RawMarginTier;
  const dir = size.isPos() ? 1 : -1;
  const inner = new R(p.isolated_margin).plus(ma[i] as Decimal).div(size);
  const lp = new R(p.entry_price)
    .minus(inner)
    .div(new R(1).minus(new R(t.maintenance_margin_rate).times(dir)));
  // The largest magnitude the formula passes through: 19-digit rounding errs relative to it.
  const scale = Decimal.max(inner.abs(), new R(p.entry_price).abs(), lp.abs());
  return { lp: lp.gt(0) ? lp : null, scale };
}

function ourLp(p: IsolatedRow, markets: Record<string, MarketRow>): Dec | null {
  const { tiers, quotePrec } = market(p.symbol, markets);
  const pos = {
    size: p.size,
    entryPrice: p.entry_price,
    leverage: p.leverage,
    marginMode: "isolated" as const,
    isoBalance: p.isolated_margin,
  };
  const d = derivePosition(pos, p.mark_price, tiers, quotePrec);
  return liquidationPrice(pos, d, tiers, isolatedProfile(pos, d));
}

describe("isolated liquidation prices vs an independent reference (synthetic rows)", () => {
  const arbRow = fc
    .record({
      symbol: fc.constantFrom("NIGHT-USD", "ADA-USD"),
      long: fc.boolean(),
      size: fc.integer({ min: 1, max: 20_000_000 }),
      entryMicro: fc.integer({ min: 10_000, max: 1_000_000 }),
      markMove: fc.integer({ min: -500, max: 500 }),
      leverage: fc.integer({ min: 1, max: 10 }),
      isoCents: fc.integer({ min: -10_000, max: 50_000_000 }),
    })
    .map((x) => {
      const entry = dec(x.entryMicro).div(1_000_000);
      return {
        symbol: x.symbol,
        size: String(x.long ? x.size : -x.size),
        entry_price: entry.toFixed(),
        mark_price: entry
          .times(dec(1).plus(dec(x.markMove).div(10_000)))
          .toDecimalPlaces(8)
          .toFixed(),
        leverage: x.leverage,
        margin_mode: "isolated",
        isolated_margin: dec(x.isoCents).div(100).toFixed(),
        liquidation_price: "",
      } satisfies IsolatedRow;
    });
  it("agrees to the engine's 19-digit precision, LP ≤ 0 included", () => {
    fc.assert(
      fc.property(arbRow, (row) => {
        const { lp: ref, scale } = referenceLp(
          row,
          fixture.markets[row.symbol]?.margin_tiers ?? [],
        );
        const ours = ourLp(row, fixture.markets);
        // Five 19-digit roundings (and the 19-decimal cap) stay well inside 1e-17 of the scale.
        const tol = scale.times("1e-17").plus("1e-18");
        if (ref?.lte(tol)) return;
        if (!ref) {
          expect(ours === null || ours.lte(tol)).toBe(true);
          return;
        }
        if (!ours) throw new Error(`expected an LP near ${ref.toFixed()}`);
        expect(ref.minus(ours.toFixed()).abs().lte(tol)).toBe(true);
      }),
      { numRuns: 5_000 },
    );
  });
});

describe.skipIf(golden === null)("golden: isolated LPs vs recorded live-positions rows", () => {
  const rows = golden?.rows ?? [];
  const markets = golden?.markets ?? {};
  it("covers both markets", () => {
    expect(rows.filter((p) => p.symbol === "NIGHT-USD").length).toBeGreaterThan(5);
    expect(rows.filter((p) => p.symbol === "ADA-USD").length).toBeGreaterThan(5);
  });
  for (const [i, p] of rows.entries()) {
    it(`${p.symbol} row ${i}`, () => {
      const { tiers, quotePrec } = market(p.symbol, markets);
      const lp = ourLp(p, markets);
      const served = dec(p.liquidation_price);
      if (served.isZero()) {
        expect(lp).toBeNull();
        return;
      }
      if (!lp) throw new Error("expected a liquidation price");
      // Our engine-precision value (19 decimals below 1) is within one unit of its last place...
      expect(sub(lp, served).abs().lte("0.0000000000000000001")).toBe(true);
      // ...and the served digits are exactly the same formula under the endpoint's rounding.
      const pos = {
        size: p.size,
        entryPrice: p.entry_price,
        leverage: p.leverage,
        marginMode: "isolated" as const,
      };
      const t = tiers[derivePosition(pos, p.mark_price, tiers, quotePrec).tier];
      if (!t) throw new Error("tier");
      expect(dec(statsEndpointLp(p, t.mmr, t.ma)).eq(served)).toBe(true);
    });
  }
});

const arbPosition = fc.record({
  long: fc.boolean(),
  size: fc.integer({ min: 1, max: 5_000_000 }),
  entryMicro: fc.integer({ min: 10_000, max: 60_000 }),
  leverage: fc.integer({ min: 1, max: 10 }),
});

describe("liquidation and bankruptcy prices (properties)", () => {
  it("at LP, margin balance equals maintenance margin (isolated, same tier)", () => {
    fc.assert(
      fc.property(arbPosition, ({ long, size, entryMicro, leverage }) => {
        const entry = dec(entryMicro).div(1_000_000);
        const signed = long ? size : -size;
        // An opening isolated balance: notional / leverage.
        const iso = mul(mul(entry, size), dec(1).div(leverage));
        const pos = {
          size: String(signed),
          entryPrice: entry.toFixed(),
          leverage,
          marginMode: "isolated" as const,
          isoBalance: iso.toFixed(),
        };
        const d = derivePosition(pos, entry, NIGHT.tiers, 30);
        const lp = liquidationPrice(pos, d, NIGHT.tiers, isolatedProfile(pos, d));
        if (!lp) return;
        const atLp = derivePosition(pos, lp, NIGHT.tiers, 30);
        if (atLp.tier !== d.tier) return;
        const mb = add(iso, atLp.upnl);
        expect(sub(mb, atLp.mm).abs().lte(mul(atLp.notional, "0.000000000000001"))).toBe(true);
        // Longs liquidate below entry, shorts above.
        expect(long ? lp.lt(entry) : lp.gt(entry)).toBe(true);
        const bp = bankruptcyPrice(pos, d, isolatedProfile(pos, d));
        if (bp) {
          const atBp = derivePosition(pos, bp, NIGHT.tiers, 30);
          expect(add(iso, atBp.upnl).abs().lte(mul(atBp.notional, "0.000000000000001"))).toBe(true);
          // Liquidation comes before bankruptcy.
          expect(long ? lp.gt(bp) : lp.lt(bp)).toBe(true);
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it("returns no LP when the result is ≤ 0", () => {
    const pos = {
      size: "1000",
      entryPrice: "0.04",
      leverage: 1,
      marginMode: "isolated" as const,
      isoBalance: "40",
    };
    const d = derivePosition(pos, "0.04", NIGHT.tiers, 8);
    expect(liquidationPrice(pos, d, NIGHT.tiers, isolatedProfile(pos, d))).toBeNull();
  });

  it("uses the other cross positions' uPnL and MM (TU, TM) only when there are several", () => {
    const a = { size: "100000", entryPrice: "0.04", leverage: 10, marginMode: "cross" as const };
    const b = { size: "-50000", entryPrice: "0.05", leverage: 10, marginMode: "cross" as const };
    const iso = {
      size: "10",
      entryPrice: "1",
      leverage: 1,
      marginMode: "isolated" as const,
      isoBalance: "100",
    };
    const da = derivePosition(a, "0.038", NIGHT.tiers, 8);
    const db = derivePosition(b, "0.038", NIGHT.tiers, 8);
    const di = derivePosition(iso, "1", NIGHT.tiers, 8);
    const profile = crossProfile("1100", [
      { p: a, d: da },
      { p: b, d: db },
      { p: iso, d: di },
    ]);
    expect(profile.w.toFixed()).toBe("1000");
    expect(profile.count).toBe(2);
    const lp = liquidationPrice(a, da, NIGHT.tiers, profile);
    const t = NIGHT.tiers[da.tier];
    if (!lp || !t) throw new Error("expected an LP");
    // Hand-evaluated: (EP − (W + TU − TM + MA)/size) / (1 − MMR).
    const tu = db.upnl;
    const tm = db.mm;
    const expected = dec("0.04")
      .minus(dec(1000).plus(tu).minus(tm).plus(t.ma).div(100_000))
      .div(dec(1).minus(t.mmr));
    expect(sub(lp, expected).abs().lt("0.000000000000000001")).toBe(true);
    const alone = crossProfile("1100", [{ p: a, d: da }]);
    expect(alone.count).toBe(1);
    expect(liquidationPrice(a, da, NIGHT.tiers, alone)?.eq(lp)).toBe(false);
  });

  it("classifies risk levels at the documented thresholds", () => {
    const at = (mm: string) => riskLevel({ w: dec(100), upnl: dec(0), mm: dec(mm), count: 1 });
    expect(at("0")).toBe("none");
    expect(at("69.99")).toBe("none");
    expect(at("70")).toBe("margin_call");
    expect(at("90")).toBe("reduce_only");
    expect(at("100")).toBe("liquidate");
    expect(riskLevel({ w: dec(10), upnl: dec(-10), mm: dec(1), count: 1 })).toBe("bankrupt");
  });
});

describe("derived position fields", () => {
  it("rounds half-even to quote_prec and looks the tier up on the unrounded notional", () => {
    const pos = { size: "-200000", entryPrice: "0.04", leverage: 10, marginMode: "cross" as const };
    const d = derivePosition(pos, "0.03837", NIGHT.tiers, 8);
    expect(d.notional.toFixed()).toBe("7674");
    expect(d.upnl.toFixed()).toBe("326");
    expect(d.im.toFixed()).toBe("767.4");
    expect(d.tier).toBe(1);
    // 7674 × 0.025 − 50
    expect(d.mm.toFixed()).toBe("141.85");
  });
});

describe("funding transfer (funding-rates.md example)", () => {
  it("a 2 BTC long at $50,000 and +0.00125%/h pays $1.25; the short receives it", () => {
    expect(fundingTransfer("2", "50000", "0.0000125").toFixed()).toBe("-1.25");
    expect(fundingTransfer("-2", "50000", "0.0000125").toFixed()).toBe("1.25");
  });
});

describe("fees", () => {
  it("commission rounds half-even to quote_prec", () => {
    expect(commission("0.038372", "1000", "0.0005", 8).toFixed()).toBe("0.019186");
    expect(commission("0.038375", "1", "0.0005", 8).toFixed()).toBe("0.00001919");
  });
  it("builder fee floors to 2 decimals", () => {
    expect(builderFee("0.038372", "100000", 10).toFixed()).toBe("3.83");
    expect(builderFee("0.038372", "1000", 10).toFixed()).toBe("0.03");
    expect(builderFee("0.01", "1", 10).toFixed()).toBe("0");
    expect(() => builderFee("1", "1", -1)).toThrow(RangeError);
  });
  it("applies discounts to positive rates only", () => {
    expect(effectiveRate("0.0005", "0.1", "0.2").toFixed()).toBe("0.00036");
    expect(effectiveRate("-0.0001", "0.1", "0.2").toFixed()).toBe("-0.0001");
  });
  it("caps a maker rebate at the protocol's share of the taker fee", () => {
    const base = { fillPx: "0.04", fillSize: "100000", makerRate: "-0.0002", quotePrec: 8 };
    expect(makerFee({ ...base, takerFee: "2", referralRewardRate: "0" }).toFixed()).toBe("-0.8");
    expect(makerFee({ ...base, takerFee: "1", referralRewardRate: "0.5" }).toFixed()).toBe("-0.5");
    expect(makerFee({ ...base, takerFee: "0" }).toFixed()).toBe("0");
    expect(makerFee({ ...base, makerRate: "0.0001", takerFee: "0" }).toFixed()).toBe("0.4");
  });
});
