/**
 * The renewal loop with the Critic, and the keeper's margin bands, at the daemon (real engine,
 * in-process rig).
 */
import type { QuotePolicy } from "@ballast/core";
import {
  type CriticReport,
  type CriticRunner,
  type SignedPolicy,
  signRenewalEnvelope,
} from "@ballast/governance";
import { beforeAll, describe, expect, it } from "vitest";
import { settledTick, T0, wiringRig } from "./fakes.js";
import { operator, passReport, policyAt } from "./harness.js";

let signed: SignedPolicy<QuotePolicy>;
let report: CriticReport;
beforeAll(async () => {
  signed = policyAt(T0 - 60_000);
  report = await passReport(signed, T0);
}, 60_000);

const passing: CriticRunner<QuotePolicy> = {
  run: async () => ({
    dataRoot: "a".repeat(64),
    simGitSha: "8cb2631",
    seed: "1",
    scenarios: [
      {
        id: "last-24h",
        window: { fromMs: T0 - 86_400_000, toMs: T0 },
        violations: { cover: 0, floor: 0, p2: 0, static: 0, rate: 0 },
        fills: 3,
        armedHours: 5,
        maxCombinedDrawdownMicroUsd: "0",
      },
    ],
    verdict: "PASS",
  }),
};
const failing: CriticRunner<QuotePolicy> = {
  run: async () => Promise.reject(new Error("replay broke")),
};

describe("renewal loop with the Critic", () => {
  it("issues the next window only with a fresh Critic PASS inside the operator's envelope", async () => {
    const r = wiringRig({ critic: passing });
    expect(r.daemon.activatePolicy(signed, report).ok).toBe(true);
    expect(r.daemon.attachEnvelope(signRenewalEnvelope(signed, 3, operator, T0))).toBe(true);
    // Not due yet (more than 2 h left): nothing runs.
    expect(await r.daemon.renewIfDue()).toBeNull();
    r.clock.t = signed.policy.validUntilMs - 3_600_000;
    const out = await r.daemon.renewIfDue();
    expect(out?.ok).toBe(true);
    expect(r.db.renewals()).toHaveLength(1);
    const rec = r.db
      .decisions()
      .filter((d) => d.kind === "policy")
      .at(-1);
    expect(rec?.inputsDigest).toBe(r.db.renewals()[0]?.hash);
    // The renewed window is in force after the base one ends.
    expect(r.daemon.registry.activeAt(signed.policy.validUntilMs + 60_000)?.index).toBe(1);
  });

  it("a failing Critic refuses the renewal, records it, and the current window runs to its end", async () => {
    const r = wiringRig({ critic: failing });
    r.daemon.activatePolicy(signed, report);
    r.daemon.attachEnvelope(signRenewalEnvelope(signed, 3, operator, T0));
    r.clock.t = signed.policy.validUntilMs - 3_600_000;
    const out = await r.daemon.renewIfDue();
    expect(out?.ok).toBe(false);
    expect(r.db.renewals()).toEqual([]);
    expect(r.db.decisions().at(-1)?.kind).toBe("critic");
    expect(r.daemon.registry.activeAt(signed.policy.validUntilMs + 60_000)).toBeNull();
  });

  it("a safety-class Guard trip in the ending window blocks the renewal", async () => {
    const r = wiringRig({ critic: passing });
    r.daemon.activatePolicy(signed, report);
    r.daemon.attachEnvelope(signRenewalEnvelope(signed, 3, operator, T0));
    r.db.insertGuardTrip({
      tsMs: T0 + 1_000,
      accountId: r.account.accountId,
      ruleId: "cover-invariant",
      safetyClass: true,
      detail: "test trip",
    });
    r.clock.t = signed.policy.validUntilMs - 3_600_000;
    const out = await r.daemon.renewIfDue();
    expect(out?.ok).toBe(false);
    expect(out?.checks.find((c) => c.rule === "renewal-no-safety-trip")?.passed).toBe(false);
  });
});

describe("margin bands at the daemon", () => {
  it("the flatten band cancels every ask, then buys the whole short back reduce-only", async () => {
    const r = wiringRig();
    r.daemon.activatePolicy(signed, report);
    r.positions.push({
      id: 1,
      account_id: r.account.accountId,
      margin_mode: "cross",
      leverage: 2,
      size: "-5000",
      entry_price: "0.0384",
      iso_balance: "0",
      accumulated_funding_fees: "0",
      create_timestamp: T0,
      update_timestamp: T0,
      symbol: "NIGHT-USD",
      upnl: "0",
      maintenance_margin: "0",
      bankruptcy_price: "0",
      liquidation_price: "0",
    });
    r.balances.maintMargin = "650"; // 65% ≥ the 60% flatten band
    await settledTick(r, 4);
    const buys = r.spy.placeBuyBack.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(buys).toHaveLength(1);
    expect(buys[0]).toMatchObject({
      side: "buy",
      reduce_only: true,
      time_in_force: "IOC",
      size: "5000",
    });
    expect(
      r.spy.replaceBatch.mock.calls.some((c) =>
        JSON.stringify(c[0], (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes(
          "new_order",
        ),
      ),
    ).toBe(false);
  });

  it("the reduce band cancels and stops creating, without a buy-back", async () => {
    const r = wiringRig();
    r.daemon.activatePolicy(signed, report);
    r.balances.maintMargin = "520"; // 52%: reduce band
    await settledTick(r, 4);
    expect(r.spy.placeBuyBack).not.toHaveBeenCalled();
    expect(r.spy.replaceBatch).not.toHaveBeenCalled();
  });
});
