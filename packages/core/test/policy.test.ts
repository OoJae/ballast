import { describe, expect, it } from "vitest";
import {
  canonicalize,
  defaultQuotePolicy,
  parseQuotePolicy,
  policyMoney,
  type QuotePolicy,
  quotePolicyHash,
  safeParseQuotePolicy,
} from "../src/index.js";

const T0 = 1_792_716_885_000;
const base = (): QuotePolicy =>
  defaultQuotePolicy({ policyId: "01JC0FFEE00000000000000000", validFromMs: T0 });

/** Deep-set one path on a JSON copy, so each case starts from a valid policy. */
function withPath(path: (string | number)[], value: unknown): unknown {
  const p = JSON.parse(JSON.stringify(base())) as Record<string, unknown>;
  let o: Record<string | number, unknown> = p;
  for (const k of path.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if (value === undefined) delete o[last];
  else o[last] = value;
  return p;
}

describe("QuotePolicy schema (plan section 6)", () => {
  it("accepts the section 5 defaults for NIGHT and ADA", () => {
    const p = base();
    expect(p.pricing).toEqual({
      minOffsetBps: 38,
      liqBufferBps: 10,
      levelSpacingBps: [10, 25],
      maxLevels: 3,
      minImprovementBps: 5,
    });
    expect(policyMoney(p).preD6DepthCap).toBe(300_000_000n);
    const ada = defaultQuotePolicy({ policyId: p.policyId, validFromMs: T0, market: "ADA-USD" });
    expect(ada.pricing.maxLevels).toBe(1);
    expect(ada.fees.entryBuilderBps).toBe(0);
  });

  it("is strict: unknown keys are refused at every level", () => {
    expect(safeParseQuotePolicy({ ...base(), extra: 1 }).ok).toBe(false);
    expect(safeParseQuotePolicy(withPath(["pricing", "minOffsetBPS"], 38)).ok).toBe(false);
    expect(safeParseQuotePolicy(withPath(["fees", "builderBps"], 0)).ok).toBe(false);
  });

  const refusals: [string, (string | number)[], unknown][] = [
    ["v must be 1", ["v"], 2],
    ["policyId must be a ULID", ["policyId"], "not-a-ulid"],
    ["prevPolicyHash must be hex32", ["prevPolicyHash"], "ABC"],
    ["market must be NIGHT or ADA", ["market"], "BTC-USD"],
    ["mode must be asks_only", ["mode"], "two_sided"],
    ["renewals ≤ 7", ["renewals"], 8],
    ["minOffsetBps ≥ 38", ["pricing", "minOffsetBps"], 37],
    ["liqBufferBps ≥ 10", ["pricing", "liqBufferBps"], 9],
    ["at most 2 level offsets", ["pricing", "levelSpacingBps"], [10, 25, 40]],
    ["level offsets are integers", ["pricing", "levelSpacingBps"], [10.5, 25]],
    ["level offsets increase", ["pricing", "levelSpacingBps"], [25, 10]],
    ["maxLevels ≤ 3", ["pricing", "maxLevels"], 4],
    ["maxLevels needs its offsets", ["pricing", "levelSpacingBps"], [10]],
    ["minImprovementBps ≥ 5", ["pricing", "minImprovementBps"], 4],
    ["rMaxBps ≤ 9000", ["sizing", "rMaxBps"], 9_001],
    ["money is an integer string", ["sizing", "l1RefillMicroUsd"], 300_000_000],
    ["money has no decimals", ["sizing", "l1RefillMicroUsd"], "300.5"],
    ["pre-D6 depth ≤ $300", ["sizing", "preD6DepthCapMicroUsd"], "300000001"],
    ["maxLeverageX100 ≤ 200", ["risk", "maxLeverageX100"], 201],
    ["marginReduceBps ≤ 5000", ["risk", "marginReduceBps"], 5_001],
    ["marginFlattenBps ≤ 6000", ["risk", "marginFlattenBps"], 6_001],
    ["flatten above reduce", ["risk", "marginFlattenBps"], 5_000],
    ["lossStopBpsOfCover ≤ 200", ["risk", "lossStopBpsOfCover"], 201],
    ["entry builder fee ≤ 10", ["fees", "entryBuilderBps"], 11],
    ["exit builder fee is 0", ["fees", "exitBuilderBps"], 1],
    ["exit mode enum", ["exits", "mode"], "ahead_of_best_bid"],
    ["indexMoveBps ≥ 1", ["requote", "indexMoveBps"], 0],
    ["minIntervalMs ≥ 2000", ["requote", "minIntervalMs"], 1_999],
    ["window ≤ 24 h", ["validUntilMs"], T0 + 24 * 3_600_000 + 1],
    ["window is positive", ["validUntilMs"], T0],
    ["times are integers", ["validFromMs"], T0 + 0.5],
  ];
  for (const [name, path, value] of refusals) {
    it(`refuses: ${name}`, () => {
      const r = safeParseQuotePolicy(withPath(path, value));
      expect(r.ok).toBe(false);
    });
  }

  it("hashes the JCS bytes, so key order does not matter", () => {
    const p = base();
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(p).reverse())),
    ) as unknown;
    expect(quotePolicyHash(parseQuotePolicy(reordered))).toBe(quotePolicyHash(p));
    expect(quotePolicyHash(p)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalize(p)).not.toContain(" ");
    const other = parseQuotePolicy(withPath(["requote", "indexMoveBps"], 4));
    expect(quotePolicyHash(other)).not.toBe(quotePolicyHash(p));
  });
});
