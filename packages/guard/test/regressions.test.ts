import { microUsd, steps, ticks, toSteps, toTicks } from "@ballast/core";
import { allocAccount, BALLAST_MIN_NOTIONAL, clientOrderId } from "@ballast/engine";
import { describe, expect, it } from "vitest";
import { checkGuard, type GuardInput, type GuardRuleId } from "../src/index.js";
import { ACCOUNT, baseInput, firstCreate, HASH, NIGHT, NOW, SEQ } from "./helpers.js";

/** Findings from the M3 review, each pinned so it cannot come back. */
const rules = (i: GuardInput): GuardRuleId[] => checkGuard(i).violations.map((v) => v.rule);
const over = (patch: (i: GuardInput) => void): GuardInput => {
  const i = baseInput();
  patch(i);
  return i;
};

describe("unconfirmed creates count toward every dollar cap, not only cover", () => {
  it("P2-blind depth: a second $300 batch while the first is unconfirmed is blocked", () => {
    const c = firstCreate(baseInput());
    const qty = toSteps(NIGHT.step, String(c.size));
    const i = over((x) => {
      x.account.pendingSteps = qty;
      x.account.oldestUnconfirmedCreateAtMs = NOW - 2_500;
    });
    expect(checkGuard(i).decision).toBe("blocked");
    expect(rules(i)).toContain("p2-constraint");
  });

  it("leverage counts pending creates at the dearest admissible price", () => {
    const c = firstCreate(baseInput());
    const qty = toSteps(NIGHT.step, String(c.size));
    const i = over((x) => {
      x.account.equityMicroUsd = microUsd(149_000_000n);
      x.account.pendingSteps = steps(3n * qty);
      x.account.oldestUnconfirmedCreateAtMs = NOW - 2_500;
    });
    expect(rules(i)).toContain("leverage-cap");
  });

  it("without a mark, pending creates cannot be valued: blocked", () => {
    const i = over((x) => {
      x.account.pendingSteps = steps(10n);
      x.market.mark = null;
    });
    expect(checkGuard(i).decision).toBe("blocked");
  });
});

describe("config writes are checked on their body", () => {
  const config = (path: string, body: Record<string, unknown>): GuardInput =>
    over((x) => {
      x.request = { method: "POST", path, body, builderFeeBps: 0 };
    });
  it("symbol leverage may be set to the cap or below, never above, and only on this market", () => {
    expect(checkGuard(config("/v2/leverage", { symbol: "NIGHT-USD", leverage: 2 })).decision).toBe(
      "execute",
    );
    expect(checkGuard(config("/v2/leverage", { symbol: "NIGHT-USD", leverage: 1 })).decision).toBe(
      "execute",
    );
    expect(rules(config("/v2/leverage", { symbol: "NIGHT-USD", leverage: 3 }))).toEqual([
      "leverage-cap",
    ]);
    expect(rules(config("/v2/leverage", { symbol: "NIGHT-USD", leverage: 125 }))).toEqual([
      "leverage-cap",
    ]);
    expect(rules(config("/v2/leverage", { symbol: "BTC-USD", leverage: 2 }))).toEqual([
      "market-allowlist",
    ]);
  });

  it("margin mode may only be cross", () => {
    expect(
      checkGuard(config("/v2/marginMode", { symbol: "NIGHT-USD", marginMode: "cross" })).decision,
    ).toBe("execute");
    expect(
      rules(config("/v2/marginMode", { symbol: "NIGHT-USD", marginMode: "isolated" })),
    ).toEqual(["leverage-cap"]);
  });
});

describe("ladder levels come from the allocator, not the account's own rank", () => {
  it("an account allocated L2 alone may post it with level 2", () => {
    const base = baseInput();
    const c = firstCreate(base);
    const px = toTicks(NIGHT.tick, String(c.price));
    const l2 = ticks(px + 39n);
    const qty = steps(5_100n);
    const alloc = base.allocator;
    if (!alloc) throw new Error("fixture");
    const acct = alloc.accounts.find((a) => a.id === ACCOUNT);
    if (!acct) throw new Error("fixture");
    const i = {
      ...base,
      allocator: {
        accounts: [acct],
        ladder: [{ level: 2, px: l2, qty }],
        opts: { ...alloc.opts, minNotional: BALLAST_MIN_NOTIONAL },
      },
      request: {
        ...base.request,
        body: {
          replacements: [
            {
              new_order: {
                ...c,
                client_order_id: clientOrderId({
                  policyHash: HASH,
                  accountId: ACCOUNT,
                  level: 2,
                  seq: SEQ,
                }),
                price: NIGHT.tick.fromUnits(l2).toFixed(),
                size: NIGHT.step.fromUnits(qty).toFixed(),
              },
            },
          ],
        },
      },
    };
    expect(checkGuard(i).violations).toEqual([]);
    void allocAccount;
  });
});

describe("a new L1 must improve the best non-Ballast ask", () => {
  it("blocks an L1 at or above best ask − 5 bps, and any create with no ask to improve on", () => {
    expect(rules(over((x) => (x.market.bestAskTicks = ticks(38_400n))))).toEqual(["ladder-shape"]);
    // 38,466 × 0.9995 = 38,446.8 → 38,446: exactly enough.
    expect(checkGuard(over((x) => (x.market.bestAskTicks = ticks(38_466n)))).decision).toBe(
      "execute",
    );
    expect(rules(over((x) => (x.market.bestAskTicks = ticks(38_465n))))).toEqual(["ladder-shape"]);
    expect(rules(over((x) => (x.market.bestAskTicks = null)))).toEqual(["ladder-shape"]);
  });
});
