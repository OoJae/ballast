import { steps, ticks } from "@ballast/core";
import { type FakeAccount, FakeEngine } from "@ballast/fake-strike";
import { L3Book } from "@ballast/strike-client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  accountTag,
  armDecision,
  CLIENT_ID_RE,
  clientOrderId,
  DEFAULT_ARM_LIST,
  diffOrders,
  engineMarket,
  fingerprintCode,
  fingerprintSize,
  hasFingerprint,
  listingCaps,
  matchOwnOrders,
  parseClientOrderId,
  REFERENCE_MARKETS,
  type RestingOrder,
} from "../src/index.js";
import { ADA, NIGHT, POLICY_HASH, T0 } from "./helpers.js";

describe("engine market rules", () => {
  it("converts /v2/markets once into integer units", () => {
    expect(NIGHT.minPriceTicks).toBe(10n);
    expect(NIGHT.maxPriceTicks).toBe(200_000_000n);
    expect(NIGHT.minSizeSteps).toBe(1n);
    expect(NIGHT.maxSizeSteps).toBe(40_000_000n);
    expect(NIGHT.strikeMinNotional).toBe(10_000_000n);
    expect(NIGHT.strikePriceBoundBps).toBe(500n);
    expect(NIGHT.ballastMinNotional).toBe(10_500_000n);
    expect(NIGHT.ballastPriceBandBps).toBe(450n);
    expect(ADA.rate).toEqual({ num: 10n, den: 1n });
  });

  it("refuses to quote a market whose rules are not all served", () => {
    const { order_limit_price_bound: _, ...missing } = REFERENCE_MARKETS["NIGHT-USD"];
    expect(() => engineMarket(missing)).toThrow(/order_limit_price_bound/);
  });
});

describe("arm list", () => {
  it("NIGHT is always armable; ADA only while it trades ≥ 5 bps over index", () => {
    const idx = { num: 2_124_490n, den: 100n };
    expect(armDecision(DEFAULT_ARM_LIST, "NIGHT-USD", { index: idx, mark: idx }).armed).toBe(true);
    expect(armDecision(DEFAULT_ARM_LIST, "ADA-USD", { index: idx, mark: idx }).armed).toBe(false);
    const over = { num: (idx.num * 10_005n) / 10_000n + 1n, den: 100n };
    expect(armDecision(DEFAULT_ARM_LIST, "ADA-USD", { index: idx, mark: over }).armed).toBe(true);
    expect(
      armDecision(DEFAULT_ARM_LIST, "ADA-USD", {
        index: idx,
        mark: over,
        fundingAtOrAboveFloor: false,
      }).armed,
    ).toBe(false);
  });

  it("other markets come only from config, with NIGHT's caps", () => {
    const idx = { num: 1n, den: 1n };
    expect(armDecision(DEFAULT_ARM_LIST, "SNEK-USD", { index: idx, mark: idx }).armed).toBe(false);
    const cfg = { markets: [...DEFAULT_ARM_LIST.markets, listingCaps("SNEK-USD")] };
    expect(armDecision(cfg, "SNEK-USD", { index: idx, mark: idx }).armed).toBe(true);
    expect(listingCaps("SNEK-USD").maxLeverageX100).toBe(200n);
    expect(() => listingCaps("snek")).toThrow();
    expect(armDecision(cfg, "NIGHT-USD", { index: null, mark: idx }).armed).toBe(false);
  });
});

describe("client order ids", () => {
  it("bal_<policy6>_<acct6>_<lvl|x>_<seq36>, parsed back exactly", () => {
    const id = clientOrderId({
      policyHash: POLICY_HASH,
      accountId: "acct-1",
      level: 2,
      seq: 1_295n,
    });
    expect(id).toBe(`bal_${POLICY_HASH.slice(0, 6)}_${accountTag("acct-1")}_2_zz`);
    expect(id.length).toBeLessThanOrEqual(26);
    expect(parseClientOrderId(id)).toEqual({
      policy6: POLICY_HASH.slice(0, 6),
      acct6: accountTag("acct-1"),
      level: 2,
      seq: 1_295n,
    });
    expect(
      parseClientOrderId(
        clientOrderId({ policyHash: POLICY_HASH, accountId: "a", level: "x", seq: 0n }),
      )?.level,
    ).toBe("x");
  });

  it("round-trips every seq and rejects non-canonical or foreign ids", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 36n ** 13n - 1n }),
        fc.constantFrom<1 | 2 | 3 | "x">(1, 2, 3, "x"),
        (seq, level) => {
          const id = clientOrderId({ policyHash: POLICY_HASH, accountId: "acct-9", level, seq });
          expect(CLIENT_ID_RE.test(id)).toBe(true);
          expect(parseClientOrderId(id)?.seq).toBe(seq);
        },
      ),
      { numRuns: 2_000 },
    );
    for (const bad of [
      "bal_abcdef_012345_1_00a",
      "bal_abcdef_012345_4_a",
      "bal_ABCDEF_012345_1_a",
      "copy:abc",
      "bal_abcdef_012345_1_",
      "liq_abcdef_012345_1_a",
    ]) {
      expect(parseClientOrderId(bad)).toBeNull();
    }
    expect(() =>
      clientOrderId({ policyHash: "nothex", accountId: "a", level: 1, seq: 1n }),
    ).toThrow();
  });

  it("acct6 spreads accounts created in the same hour (UUIDv7 share their prefix)", () => {
    const a = accountTag("019a0c2e-1111-7000-8000-000000000001");
    const b = accountTag("019a0c2e-1111-7000-8000-000000000002");
    expect(a).not.toBe(b);
  });
});

describe("fingerprinted sizes", () => {
  it("is the largest size ≤ qty congruent to the account-level code", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.string({ minLength: 1 }),
        fc.integer({ min: 1, max: 3 }),
        (q, acct, lvl) => {
          const code = fingerprintCode(acct, lvl);
          expect(code >= 1n && code <= 99n).toBe(true);
          const f = fingerprintSize(steps(q), code);
          if (f === null) {
            expect(q < code).toBe(true);
            return;
          }
          expect(f <= q && q - f < 100n).toBe(true);
          expect(hasFingerprint(f, code)).toBe(true);
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it("finds our freshly opened order on L3 by price and exact size, newest first", () => {
    const book = new L3Book("NIGHT-USD");
    book.applySnapshot({
      type: "l3_snapshot",
      symbol: "NIGHT-USD",
      last_sequence: 1,
      timestamp: T0,
      bids: [],
      asks: [
        {
          price: "0.038446",
          orders: [
            { order_id: "house-1", size: "7742" },
            { order_id: "ours-old", size: "7742" },
            { order_id: "ours-new", size: "7742" },
          ],
        },
        { price: "0.03875", orders: [{ order_id: "house-2", size: "1000" }] },
      ],
    });
    const m = matchOwnOrders(
      book.asks,
      [
        { key: "L1", price: "0.0384460", size: "7742" },
        { key: "L2", price: "0.038485", size: "18142" },
      ],
      new Set(["ours-new"]),
    );
    expect([...m]).toEqual([["L1", "ours-old"]]);
  });
});

describe("differ", () => {
  const resting = (over: Partial<RestingOrder>): RestingOrder => ({
    clientOrderId: "bal_x",
    orderId: 11n,
    px: ticks(38_446n),
    qty: steps(7_742n),
    status: "open",
    ...over,
  });
  const ids = (level: 1 | 2 | 3 | "x") =>
    clientOrderId({ policyHash: POLICY_HASH, accountId: "a", level, seq: 7n });

  it("keeps a matching order, cancels the rest by numeric id, creates far-to-near", () => {
    const d = diffOrders({
      market: NIGHT,
      resting: [resting({}), resting({ orderId: 12n, px: ticks(38_480n), qty: steps(18_100n) })],
      desired: [
        { level: 1, px: ticks(38_446n), qty: steps(7_742n) },
        { level: 2, px: ticks(38_485n), qty: steps(18_142n) },
        { level: 3, px: ticks(38_543n), qty: steps(38_842n) },
      ],
      nowMs: T0,
      lastReplaceBatchMs: null,
      clientId: ids,
    });
    if (d.kind !== "replace-batch") throw new Error(d.kind);
    expect(d.keep.map((k) => k.orderId)).toEqual([11n]);
    expect(d.cancels).toEqual([12n]);
    expect(d.body.replacements.map((r) => r.new_order?.price)).toEqual(["0.038543", "0.038485"]);
    expect(d.body.replacements[0]?.cancel).toEqual({ order_id: 12n, symbol: "NIGHT-USD" });
    for (const r of d.body.replacements) {
      expect(r.new_order).toMatchObject({ side: "sell", type: "limit", post_only: true });
    }
  });

  it("does nothing when the book already matches, and throttles inside 2 s", () => {
    const desired = [{ level: 1 as const, px: ticks(38_446n), qty: steps(7_742n) }];
    const base = { market: NIGHT, desired, nowMs: T0, clientId: ids };
    expect(diffOrders({ ...base, resting: [resting({})], lastReplaceBatchMs: null }).kind).toBe(
      "none",
    );
    expect(diffOrders({ ...base, resting: [], lastReplaceBatchMs: T0 - 1_999 })).toEqual({
      kind: "throttled",
      retryAfterMs: 1,
    });
    expect(diffOrders({ ...base, resting: [], lastReplaceBatchMs: T0 - 2_000 }).kind).toBe(
      "replace-batch",
    );
  });

  it("waits rather than requote around an order it cannot cancel by id", () => {
    const d = diffOrders({
      market: NIGHT,
      resting: [resting({ orderId: null, status: "pending", px: ticks(38_400n) })],
      desired: [{ level: 1, px: ticks(38_446n), qty: steps(7_742n) }],
      nowMs: T0,
      lastReplaceBatchMs: null,
      clientId: ids,
    });
    expect(d.kind).toBe("wait");
    // A pending order that already matches is kept, never doubled.
    const same = diffOrders({
      market: NIGHT,
      resting: [resting({ orderId: null, status: "pending" })],
      desired: [{ level: 1, px: ticks(38_446n), qty: steps(7_742n) }],
      nowMs: T0,
      lastReplaceBatchMs: null,
      clientId: ids,
    });
    expect(same.kind).toBe("none");
  });

  it("a near create that crosses leaves the far levels resting (fake replace-batch semantics)", () => {
    const events: Record<string, unknown>[] = [];
    const engine = new FakeEngine(
      () => T0,
      (_a, m) => events.push(m),
      100n,
    );
    engine.addMarket({
      symbol: "NIGHT-USD",
      tickSize: "0.000001",
      stepSize: "1",
      minSize: "1",
      minNotional: "10",
      maxLeverage: 10,
    });
    const acct: FakeAccount = {
      id: "acct-a",
      publicKeyHex: "00".repeat(32),
      family: "fam-a",
      approvedBuilderFeeBps: 10,
      leverage: new Map(),
      marginMode: new Map(),
      positions: new Map(),
    };
    engine.accounts.set(acct.id, acct);
    // Someone bids at 0.038450: an L1 ask at 0.038446 would cross and is rejected post-only.
    engine.restMarketOrder("NIGHT-USD", "buy", "0.03845", "100000");
    const d = diffOrders({
      market: NIGHT,
      resting: [],
      desired: [
        { level: 1, px: ticks(38_446n), qty: steps(7_742n) },
        { level: 2, px: ticks(38_485n), qty: steps(18_142n) },
        { level: 3, px: ticks(38_543n), qty: steps(38_842n) },
      ],
      nowMs: T0,
      lastReplaceBatchMs: null,
      clientId: ids,
    });
    if (d.kind !== "replace-batch") throw new Error(d.kind);
    engine.replaceBatch(
      acct,
      d.body.replacements.map((r) => ({
        ...(r.cancel ? { cancel: { order_id: r.cancel.order_id } } : {}),
        ...(r.new_order ? { new_order: r.new_order } : {}),
      })),
    );
    const live = engine
      .workingOrders(acct.id, "NIGHT-USD")
      .map((o) => o.clientOrderId)
      .sort();
    expect(live).toEqual([ids(2), ids(3)].sort());
  });
});
