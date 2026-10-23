import {
  defaultQuotePolicy,
  microUsd,
  quotePolicyHash,
  steps,
  ticks,
  toSteps,
  toTicks,
} from "@ballast/core";
import { clientOrderId } from "@ballast/engine";
import { describe, expect, it } from "vitest";
import {
  checkGuard,
  EXEMPT_RULES,
  GUARD_RULES,
  type GuardInput,
  type GuardResult,
  type GuardRuleId,
} from "../src/index.js";
import {
  ACCOUNT,
  baseInput,
  firstCreate,
  HASH,
  NIGHT,
  NOW,
  SEQ,
  T0,
  withCreate,
} from "./helpers.js";

function check(res: GuardResult, rule: GuardRuleId) {
  const c = res.checks.find((x) => x.rule === rule);
  expect(c, `check ${rule} missing from trail`).toBeDefined();
  return c as NonNullable<typeof c>;
}

function violation(res: GuardResult, rule: GuardRuleId) {
  const v = res.violations.find((x) => x.rule === rule);
  expect(
    v,
    `violation ${rule} not reported; got ${res.violations.map((x) => x.rule)}`,
  ).toBeDefined();
  return v as NonNullable<typeof v>;
}

/** Blocked by exactly this rule (the mutation broke nothing else). */
function blockedOnlyBy(input: GuardInput, rule: GuardRuleId): GuardResult {
  const res = checkGuard(input);
  expect(res.decision).toBe("blocked");
  expect(res.violations.map((v) => v.rule)).toEqual([rule]);
  return res;
}

const over = (patch: (i: GuardInput) => void): GuardInput => {
  const i = baseInput();
  patch(i);
  return i;
};

describe("checkGuard: golden paths", () => {
  it("executes a valid, armed, live requote with all 28 rules evaluated in order", () => {
    const res = checkGuard(baseInput());
    expect(res.violations).toEqual([]);
    expect(res.decision).toBe("execute");
    expect(res.checks.map((c) => c.rule)).toEqual([...GUARD_RULES]);
    expect(res.checks).toHaveLength(28);
    expect(res.checks.every((c) => c.passed)).toBe(true);
    expect(res.reason).toBe("all 28 safety checks passed");
    expect(res.riskReducing).toBe(false);
  });

  it("returns dry-run when everything passes but DRY_RUN holds fire (the default)", () => {
    const res = checkGuard(over((i) => (i.flags = { ...i.flags, dryRun: true })));
    expect(res.decision).toBe("dry-run");
    expect(check(res, "dry-run").detail).toContain("held fire");
    // A missing flag is treated as DRY_RUN=true.
    const missing = over((i) => (i.flags = { armed: true, mainnet: true } as never));
    expect(checkGuard(missing).decision).toBe("dry-run");
  });
});

describe("policy rules", () => {
  it("policy-signature: blocks a missing policy, a bad signature, a hash mismatch, a lax schema", () => {
    // Without a verified policy every policy-derived cap is zero: the rules after it fail closed.
    for (const res of [
      checkGuard(over((i) => (i.policy = i.policy && { ...i.policy, signatureValid: false }))),
      checkGuard(over((i) => (i.policy = i.policy && { ...i.policy, hash: "0".repeat(64) }))),
    ]) {
      expect(res.decision).toBe("blocked");
      expect(res.violations[0]?.rule).toBe("policy-signature");
      expect(res.violations.map((v) => v.rule)).toContain("cover-invariant");
    }
    const tampered = over((i) => {
      if (!i.policy) return;
      i.policy = {
        ...i.policy,
        policy: {
          ...(i.policy.policy as object),
          fees: { entryBuilderBps: 50, exitBuilderBps: 0 },
        },
      };
    });
    const res = checkGuard(tampered);
    expect(violation(res, "policy-signature").detail).toContain("strict schema");
    expect(checkGuard(over((i) => (i.policy = null))).decision).toBe("blocked");
  });

  it("policy-window: blocks before, at and after expiry, and beyond its renewals", () => {
    blockedOnlyBy(
      over((i) => (i.nowMs = T0 - 1)),
      "policy-window",
    );
    const expired = over((i) => (i.nowMs = T0 + 24 * 3_600_000));
    expect(violation(checkGuard(expired), "policy-window").detail).toContain("outside");
    blockedOnlyBy(
      over((i) => (i.policy = i.policy && { ...i.policy, renewalsUsed: 8 })),
      "policy-window",
    );
  });

  it("critic-pass: strict PASS for this policy's hash, with a verified report", () => {
    blockedOnlyBy(
      over((i) => (i.critic = null)),
      "critic-pass",
    );
    blockedOnlyBy(
      over((i) => (i.critic = { verdict: "pass", policyHash: HASH, reportValid: true })),
      "critic-pass",
    );
    blockedOnlyBy(
      over((i) => (i.critic = { verdict: "PASS", policyHash: "f".repeat(64), reportValid: true })),
      "critic-pass",
    );
    blockedOnlyBy(
      over((i) => (i.critic = { verdict: "PASS", policyHash: HASH, reportValid: false })),
      "critic-pass",
    );
  });
});

describe("arming and market", () => {
  it("arm-flag: mainnet creates need BALLAST_ARM=1, even with DRY_RUN=false", () => {
    blockedOnlyBy(
      over((i) => (i.flags = { dryRun: false, armed: false, mainnet: true })),
      "arm-flag",
    );
    expect(
      checkGuard(over((i) => (i.flags = { dryRun: false, armed: false, mainnet: false }))).decision,
    ).toBe("execute");
  });

  it("market-allowlist: config asset book, the policy's market and the arm list", () => {
    blockedOnlyBy(
      over((i) => (i.market.allowlist = ["ADA-USD"])),
      "market-allowlist",
    );
    blockedOnlyBy(
      over((i) => (i.market.arm = { armed: false, reason: "ADA under index" })),
      "market-allowlist",
    );
  });

  it("data-freshness: index/mark ≤ 3 s, L3 gap-free, cover ≤ 60 s, markets ≤ 120 s, stream up", () => {
    for (const patch of [
      (i: GuardInput) => (i.data.indexAgeMs = 3_001),
      (i: GuardInput) => (i.data.markAgeMs = 3_001),
      (i: GuardInput) => (i.data.l3GapFree = false),
      (i: GuardInput) => (i.data.l3Synced = false),
      (i: GuardInput) => (i.data.coverAgeMs = 60_001),
      (i: GuardInput) => (i.data.marketsAgeMs = 120_001),
      (i: GuardInput) => (i.data.userStreamConnected = false),
      (i: GuardInput) => (i.data.indexAgeMs = Number.NaN),
      (i: GuardInput) => (i.data.coverAgeMs = -1),
    ]) {
      blockedOnlyBy(over(patch), "data-freshness");
    }
    expect(checkGuard(over((i) => (i.data.indexAgeMs = 3_000))).decision).toBe("execute");
  });

  it("reference-sanity: divergent blocks; unavailable continues only while the index is fresh", () => {
    blockedOnlyBy(
      over((i) => (i.reference = { status: "divergent", deviationBps: 120n })),
      "reference-sanity",
    );
    blockedOnlyBy(
      over((i) => (i.reference = { status: "ok", deviationBps: 51n })),
      "reference-sanity",
    );
    expect(
      checkGuard(over((i) => (i.reference = { status: "unavailable", deviationBps: null })))
        .decision,
    ).toBe("execute");
    const stale = checkGuard(
      over((i) => {
        i.reference = { status: "unavailable", deviationBps: null };
        i.data.indexAgeMs = 5_000;
      }),
    );
    expect(stale.violations.map((v) => v.rule)).toEqual(["data-freshness", "reference-sanity"]);
  });
});

describe("cover and account", () => {
  it("cover-invariant: short + asks + pending ≤ r × cover, unknown counted, r capped by policy", () => {
    // 100k cover × 0.5 = 50k; a 45k short leaves less than the 7.7k ask.
    const res = checkGuard(over((i) => (i.account.shortSteps = steps(45_000n))));
    violation(res, "cover-invariant");
    violation(
      checkGuard(over((i) => (i.account.pendingSteps = steps(45_000n)))),
      "cover-invariant",
    );
    // r = 0.9 asked for, policy caps at 0.5: still blocked.
    const r = checkGuard(
      over((i) => {
        i.account.shortSteps = steps(45_000n);
        i.account.rBps = 9_000n;
      }),
    );
    violation(r, "cover-invariant");
  });

  it("cover-invariant counts resting asks the request does not cancel", () => {
    const res = checkGuard(
      over((i) => {
        i.account.resting = [
          { clientOrderId: "bal_old", orderId: 9n, px: ticks(38_600n), qty: steps(45_000n) },
        ];
      }),
    );
    violation(res, "cover-invariant");
  });

  it("stake-binding and dedicated-account", () => {
    blockedOnlyBy(
      over((i) => (i.account.stakeBinding = { bound: false, unique: true })),
      "stake-binding",
    );
    blockedOnlyBy(
      over((i) => (i.account.stakeBinding = { bound: true, unique: false })),
      "stake-binding",
    );
    blockedOnlyBy(
      over((i) => (i.account.foreignOrders = 1)),
      "dedicated-account",
    );
    blockedOnlyBy(
      over((i) => (i.account.foreignPositions = true)),
      "dedicated-account",
    );
    blockedOnlyBy(
      over((i) => (i.account.vaultShares = true)),
      "dedicated-account",
    );
  });
});

describe("prices", () => {
  it("price-floor: every ask ≥ F, ≥ index + 38 bps, ≥ mark when positions are stale", () => {
    const f = over((i) => {
      if (i.market.floor) i.market.floor = { ...i.market.floor, ticks: ticks(38_447n) };
    });
    expect(violation(checkGuard(f), "price-floor").detail).toContain("< F");
    const stale = over((i) => {
      if (i.market.floor) i.market.floor = { ...i.market.floor, positionsStale: true };
      i.market.mark = { num: 38_450n, den: 1n };
    });
    expect(violation(checkGuard(stale), "price-floor").detail).toContain("positions stale");
    const cheap = withCreate((c) => (c.price = "0.038445"));
    expect(violation(checkGuard(cheap), "price-floor").detail).toContain("index + 38 bps");
  });

  it("price-floor: b_liq must be ≥ the policy buffer + 2 × the replica p99", () => {
    const res = over((i) => {
      if (i.market.floor) i.market.floor = { ...i.market.floor, bLiqMicroBps: 11_539_999n };
    });
    blockedOnlyBy(res, "price-floor");
  });

  it("p2-constraint: P2-blind ≤ $300 total across accounts, no fragile long", () => {
    blockedOnlyBy(
      over((i) => (i.market.others = { ...i.market.others, askMicroUsd: microUsd(10_000_000n) })),
      "p2-constraint",
    );
    blockedOnlyBy(
      over(
        (i) =>
          (i.market.p2 = { mode: "blind", fragileLong: true, capMicroUsd: microUsd(300_000_000n) }),
      ),
      "p2-constraint",
    );
    blockedOnlyBy(
      over((i) => (i.market.p2 = null)),
      "p2-constraint",
    );
  });

  it("p2-constraint: replica mode needs safe, L1 ≥ the P2-safe price and depth within it", () => {
    const replica = (safe: boolean, minL1: bigint, depth: bigint) =>
      over(
        (i) =>
          (i.market.p2 = {
            mode: "replica",
            safe,
            minL1Ticks: ticks(minL1),
            maxL1DepthSteps: steps(depth),
          }),
      );
    expect(checkGuard(replica(true, 38_446n, 100_000n)).decision).toBe("execute");
    blockedOnlyBy(replica(false, 38_446n, 100_000n), "p2-constraint");
    blockedOnlyBy(replica(true, 38_447n, 100_000n), "p2-constraint");
    blockedOnlyBy(replica(true, 38_446n, 1_000n), "p2-constraint");
  });

  it("ladder-shape: levels, one order per level, spacing and rations", () => {
    const tooBig = withCreate((c) => (c.size = "7900"));
    const res = checkGuard(tooBig);
    expect(violation(res, "ladder-shape").detail).toContain("ration");
    // Two asks at one price.
    const base = baseInput();
    const c = firstCreate(base);
    const dup = {
      ...base,
      request: {
        ...base.request,
        body: {
          replacements: [
            { new_order: c },
            {
              new_order: {
                ...c,
                client_order_id: clientOrderId({
                  policyHash: HASH,
                  accountId: ACCOUNT,
                  level: 2,
                  seq: SEQ,
                }),
              },
            },
          ],
        },
      },
    };
    expect(violation(checkGuard(dup), "ladder-shape").detail).toContain("is not above L1");
  });

  it("no-bid-ahead: every buy is reduce-only and strictly below the best non-Ballast bid", () => {
    const bid = (price: string, reduceOnly = true, hash = HASH) => {
      const i = baseInput();
      const id = clientOrderId({ policyHash: hash, accountId: ACCOUNT, level: "x", seq: SEQ });
      i.request = {
        method: "POST",
        path: "/v2/orders/batch",
        body: {
          orders: [
            {
              client_order_id: id,
              symbol: "NIGHT-USD",
              side: "buy",
              type: "limit",
              size: "1000",
              price,
              ...(reduceOnly ? { reduce_only: true } : {}),
            },
          ],
        },
        builderFeeBps: 0,
      };
      return i;
    };
    expect(checkGuard(bid("0.038299")).decision).toBe("execute");
    blockedOnlyBy(bid("0.0383"), "no-bid-ahead");
    const naked = checkGuard(bid("0.038299", false));
    violation(naked, "no-bid-ahead");
    violation(naked, "route-allowlist");
    // With Strike's written opt-in: at the best bid or one tick ahead.
    const optIn = (price: string) => {
      const i = bid(price, true, HASHwith("at_best_bid_opt_in"));
      i.market.recyclingOptIn = true;
      if (i.policy)
        i.policy = {
          ...i.policy,
          policy: { ...POLICYwith("at_best_bid_opt_in") },
          hash: HASHwith("at_best_bid_opt_in"),
        };
      if (i.critic) i.critic = { ...i.critic, policyHash: HASHwith("at_best_bid_opt_in") };
      return i;
    };
    expect(checkGuard(optIn("0.038301")).decision).toBe("execute");
    blockedOnlyBy(optIn("0.038302"), "no-bid-ahead");
  });

  it("static-rules: the 8 checks, post-only GTC asks, never crossing the bid", () => {
    expect(
      violation(checkGuard(withCreate((c) => (c.price = "0.0384465"))), "static-rules").detail,
    ).toContain("price-tick");
    expect(
      violation(checkGuard(withCreate((c) => delete c.post_only)), "static-rules").detail,
    ).toContain("post-only");
    expect(
      violation(checkGuard(withCreate((c) => (c.price = "0.0405"))), "static-rules").detail,
    ).toContain("price-band");
    expect(
      violation(checkGuard(withCreate((c) => (c.size = "200"))), "static-rules").detail,
    ).toContain("min-notional");
    const cross = over((i) => (i.market.bestBidTicks = ticks(38_446n)));
    expect(violation(checkGuard(cross), "static-rules").detail).toContain("cross");
  });
});

describe("leverage, margin and caps", () => {
  it("leverage-cap: (short + asks) / equity ≤ 2.0x on NIGHT, counting asks at max(price, mark)", () => {
    // The ask's notional at 2x needs half as much equity, rounded up (NIGHT: 1 tick × 1 step = 1 µUSD).
    const c = firstCreate(baseInput());
    const usd = toSteps(NIGHT.step, String(c.size)) * toTicks(NIGHT.tick, String(c.price));
    const need = (usd + 1n) / 2n;
    expect(checkGuard(over((i) => (i.account.equityMicroUsd = microUsd(need)))).decision).toBe(
      "execute",
    );
    blockedOnlyBy(
      over((i) => (i.account.equityMicroUsd = microUsd(need - 1n))),
      "leverage-cap",
    );
    blockedOnlyBy(
      over((i) => (i.account.equityMicroUsd = microUsd(0n))),
      "leverage-cap",
    );
  });

  it("margin-band: creates only below the reduce-only band, never with an unknown ratio", () => {
    blockedOnlyBy(
      over((i) => (i.account.marginRatioBps = 5_000n)),
      "margin-band",
    );
    blockedOnlyBy(
      over((i) => (i.account.marginRatioBps = null)),
      "margin-band",
    );
    blockedOnlyBy(
      over((i) => (i.account.marginBand = "reduce")),
      "margin-band",
    );
    expect(
      checkGuard(
        over((i) => {
          i.account.marginRatioBps = 4_999n;
          i.account.marginBand = "warn";
        }),
      ).decision,
    ).toBe("execute");
  });

  it("per-account-short: holder-set cap, policy cap, holder #0's $2K", () => {
    blockedOnlyBy(
      over((i) => (i.account.maxShortMicroUsd = microUsd(200_000_000n))),
      "per-account-short",
    );
    const h0 = checkGuard(
      over((i) => {
        i.account.holder0 = true;
        i.account.shortSteps = steps(49_000n);
        i.account.coverSteps = steps(200_000n);
        i.request = { ...i.request, builderFeeBps: 0 };
      }),
    );
    // 49k short ≈ $1.88K + $300 asks > $2K.
    violation(h0, "per-account-short");
  });

  it("aggregate-cap: Σ short + asks ≤ min(policy, exit depth within 2%)", () => {
    blockedOnlyBy(
      over((i) => (i.market.exitDepthMicroUsd = microUsd(100_000_000n))),
      "aggregate-cap",
    );
    blockedOnlyBy(
      over(
        (i) =>
          (i.market.others = { ...i.market.others, exposureMicroUsd: microUsd(27_500_000_000n) }),
      ),
      "aggregate-cap",
    );
  });

  it("fee-cap: entries ≤ min(10, policy, holder-approved); holder #0 pays 0; exits 0", () => {
    blockedOnlyBy(
      over((i) => (i.request.builderFeeBps = 11)),
      "fee-cap",
    );
    blockedOnlyBy(
      over((i) => (i.account.approvedBuilderBps = 5)),
      "fee-cap",
    );
    expect(
      checkGuard(
        over((i) => {
          i.account.approvedBuilderBps = 5;
          i.request.builderFeeBps = 5;
        }),
      ).decision,
    ).toBe("execute");
    blockedOnlyBy(
      over((i) => (i.request.builderFeeBps = Number.NaN)),
      "fee-cap",
    );
    const h0 = checkGuard(
      over((i) => {
        i.account.holder0 = true;
        i.account.coverSteps = steps(7_800n);
        i.account.rBps = 5_000n;
      }),
    );
    expect(h0.violations.map((v) => v.rule)).toContain("fee-cap");
  });

  it("loss-stop: holders 1% of committed cover, holder #0 $25, and the 24 h hold", () => {
    blockedOnlyBy(
      over((i) => (i.account.lossTodayMicroUsd = microUsd(19_150_000n))),
      "loss-stop",
    );
    expect(
      checkGuard(over((i) => (i.account.lossTodayMicroUsd = microUsd(19_149_999n)))).decision,
    ).toBe("execute");
    blockedOnlyBy(
      over((i) => (i.account.lossHoldUntilMs = NOW + 1)),
      "loss-stop",
    );
  });

  it("holder0-unpaired: cover − short ≤ $300 for holder #0 only", () => {
    const h0 = (cover: bigint) =>
      over((i) => {
        i.account.holder0 = true;
        i.account.coverSteps = steps(cover);
        i.account.shortSteps = steps(0n);
        i.request.builderFeeBps = 0;
        i.account.lossTodayMicroUsd = microUsd(0n);
      });
    // 7,822 NIGHT × 0.03835 = $299.97: fine. 16k NIGHT unpaired = $613: blocked.
    expect(checkGuard(h0(7_822n)).violations.map((v) => v.rule)).not.toContain("holder0-unpaired");
    expect(checkGuard(h0(16_000n)).violations.map((v) => v.rule)).toContain("holder0-unpaired");
  });
});

describe("conduct rules", () => {
  it("allocator-conformance: creates within the recomputed allocation", () => {
    blockedOnlyBy(
      over((i) => (i.allocator = null)),
      "allocator-conformance",
    );
    const shrunk = over((i) => {
      if (!i.allocator) return;
      i.allocator = {
        ...i.allocator,
        ladder: i.allocator.ladder.map((l) => ({ ...l, qty: steps(1_000n) })),
      };
    });
    expect(violation(checkGuard(shrunk), "allocator-conformance").detail).toContain(">");
  });

  it("rate-budget: cancel reserve, replace-batch spacing, 429 pause", () => {
    blockedOnlyBy(
      over((i) => (i.rate.usedInWindow = 240)),
      "rate-budget",
    );
    expect(checkGuard(over((i) => (i.rate.usedInWindow = 239))).decision).toBe("execute");
    blockedOnlyBy(
      over((i) => (i.rate.lastReplaceBatchMs = NOW - 1_999)),
      "rate-budget",
    );
    blockedOnlyBy(
      over((i) => (i.rate.pausedUntilMs = NOW + 1)),
      "rate-budget",
    );
  });

  it("client-id-format: this policy, this account, this decision, the right level, never reused", () => {
    const id = (o: Partial<{ seq: bigint; level: 1 | 2 | 3 | "x"; account: string }>) =>
      clientOrderId({
        policyHash: HASH,
        accountId: o.account ?? ACCOUNT,
        level: o.level ?? 1,
        seq: o.seq ?? SEQ,
      });
    blockedOnlyBy(
      withCreate((c) => (c.client_order_id = id({ seq: SEQ + 1n }))),
      "client-id-format",
    );
    // The level is the ladder's, checked against the allocation (blind mode allocates L1 only).
    blockedOnlyBy(
      withCreate((c) => (c.client_order_id = id({ level: 2 }))),
      "allocator-conformance",
    );
    violation(
      checkGuard(withCreate((c) => (c.client_order_id = id({ level: "x" })))),
      "client-id-format",
    );
    blockedOnlyBy(
      withCreate((c) => (c.client_order_id = id({ account: "someone-else" }))),
      "client-id-format",
    );
    blockedOnlyBy(
      over((i) => (i.usedClientOrderIds = new Set([id({})]))),
      "client-id-format",
    );
  });

  it("route-allowlist: refused routes and profiles", () => {
    const res = checkGuard(over((i) => (i.request = { ...i.request, path: "/v2/order/replace" })));
    expect(violation(res, "route-allowlist").detail).toContain("builder attribution");
    const cancelOnly = checkGuard(over((i) => (i.profile = "CANCEL_ONLY")));
    violation(cancelOnly, "route-allowlist");
  });

  it("unknown-orders: none of unknown state, and no create unconfirmed for over 5 s", () => {
    blockedOnlyBy(
      over((i) => (i.account.unknownOrders = 1)),
      "unknown-orders",
    );
    blockedOnlyBy(
      over((i) => (i.account.oldestUnconfirmedCreateAtMs = NOW - 5_001)),
      "unknown-orders",
    );
    expect(
      checkGuard(over((i) => (i.account.oldestUnconfirmedCreateAtMs = NOW - 5_000))).decision,
    ).toBe("execute");
  });
});

describe("risk-reducing requests: only route-allowlist and dry-run", () => {
  /** Everything about the account and market is broken: nothing but the route may matter. */
  const broken = (): GuardInput =>
    over((i) => {
      i.policy = null;
      i.critic = null;
      i.data.indexAgeMs = 60_000;
      i.data.l3GapFree = false;
      i.account.unknownOrders = 3;
      i.account.shortSteps = steps(10_000_000n);
      i.market.p2 = null;
      i.market.floor = null;
      i.allocator = null;
      i.rate.usedInWindow = 300;
    });

  it("cancel-all executes with 2 checks even when every other fact is bad", () => {
    const res = checkGuard({
      ...broken(),
      request: {
        method: "DELETE",
        path: "/v2/order/cancel-all",
        body: { symbol: "NIGHT-USD" },
        builderFeeBps: 0,
      },
    });
    expect(res.decision).toBe("execute");
    expect(res.riskReducing).toBe(true);
    expect(res.checks.map((c) => c.rule)).toEqual([...EXEMPT_RULES]);
  });

  it("a cancel-only replace-batch and a single cancel are exempt too, also under CANCEL_ONLY", () => {
    const rb = checkGuard({
      ...broken(),
      request: {
        method: "POST",
        path: "/v2/order/replace-batch",
        body: { replacements: [{ cancel: { order_id: 5n, symbol: "NIGHT-USD" } }] },
        builderFeeBps: 0,
      },
    });
    expect(rb.decision).toBe("execute");
    const one = checkGuard({
      ...broken(),
      profile: "CANCEL_ONLY",
      request: {
        method: "DELETE",
        path: "/v2/order/cancel",
        body: { symbol: "NIGHT-USD", order_id: 5n },
        builderFeeBps: 0,
      },
    });
    expect(one.decision).toBe("execute");
  });

  it("a reduce-only IOC buy-back is exempt; a resting buy is not", () => {
    const id = clientOrderId({ policyHash: HASH, accountId: ACCOUNT, level: "x", seq: SEQ });
    const buyBack = checkGuard({
      ...broken(),
      request: {
        method: "POST",
        path: "/v2/order",
        body: {
          client_order_id: id,
          symbol: "NIGHT-USD",
          side: "buy",
          type: "limit",
          size: "1000",
          price: "0.0390",
          time_in_force: "IOC",
          reduce_only: true,
        },
        builderFeeBps: 0,
      },
    });
    expect(buyBack.decision).toBe("execute");
    expect(buyBack.checks).toHaveLength(2);
  });

  it("cancel-all {} (every symbol) is still refused by the route allowlist", () => {
    const res = checkGuard({
      ...broken(),
      request: { method: "DELETE", path: "/v2/order/cancel-all", body: {}, builderFeeBps: 0 },
    });
    expect(res.decision).toBe("blocked");
    violation(res, "route-allowlist");
  });

  it("DRY_RUN holds fire on risk-reducing requests too", () => {
    const res = checkGuard({
      ...broken(),
      flags: { dryRun: true, armed: false, mainnet: true },
      request: {
        method: "DELETE",
        path: "/v2/order/cancel-all",
        body: { symbol: "NIGHT-USD" },
        builderFeeBps: 0,
      },
    });
    expect(res.decision).toBe("dry-run");
  });
});

describe("multi-violation and fail-closed evaluation", () => {
  it("reports every violated rule at once; the reason is the first in rule order", () => {
    const res = checkGuard(
      over((i) => {
        i.critic = null;
        i.data.markAgeMs = 9_000;
        i.account.unknownOrders = 2;
      }),
    );
    expect(res.violations.map((v) => v.rule)).toEqual([
      "critic-pass",
      "data-freshness",
      "unknown-orders",
    ]);
    expect(res.reason).toContain("critic-pass");
    expect(res.checks).toHaveLength(28);
  });

  it("a rule that throws is a violation, never a crash or a skip", () => {
    const res = checkGuard(
      over((i) => {
        // A malformed allocator fact: allocate() throws on it.
        i.allocator = { accounts: null, ladder: [], opts: null } as never;
      }),
    );
    expect(res.decision).toBe("blocked");
    expect(violation(res, "allocator-conformance").detail).toContain("evaluation error");
    expect(res.checks).toHaveLength(28);
  });

  it("a garbage body is blocked by the route and still evaluates every rule", () => {
    const res = checkGuard(
      over(
        (i) =>
          (i.request = {
            method: "POST",
            path: "/v2/order/replace-batch",
            body: "nope",
            builderFeeBps: 0,
          }),
      ),
    );
    expect(res.decision).toBe("blocked");
    expect(res.checks).toHaveLength(28);
  });
});

function POLICYwith(mode: "below_best_bid" | "at_best_bid_opt_in") {
  const p = defaultQuotePolicy({ policyId: "01JC0FFEE00000000000000000", validFromMs: T0 });
  return { ...p, exits: { mode } };
}
function HASHwith(mode: "below_best_bid" | "at_best_bid_opt_in") {
  return quotePolicyHash(POLICYwith(mode));
}
