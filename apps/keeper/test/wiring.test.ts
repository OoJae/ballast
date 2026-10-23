/**
 * WIRING-LEVEL SAFETY PROOFS (Ripcord's pattern), at the keeper daemon.
 *
 * Unit tests prove the Guard says "no". These prove the assembled keeper obeys it: each test
 * drives real ticks with a MAXIMALLY PERMISSIVE engine (the keeper never objects and the planner
 * always proposes a fresh ask, whatever the governor, allocator or cover say) and asserts the
 * signer spy is never asked to create. If a refactor ever drops the Guard from the send path,
 * these fail while every unit test still passes.
 */
import type { QuotePolicy } from "@ballast/core";
import { type CriticReport, OperatorKey, type SignedPolicy, signPolicy } from "@ballast/governance";
import { AdvisorService, type LlmClient } from "@ballast/governance/advisor";
import fc from "fast-check";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { permissiveEngine, settledTick, T0, type WiringRig, wiringRig } from "./fakes.js";
import { passReport, policyAt } from "./harness.js";

let signed: SignedPolicy<QuotePolicy>;
let report: CriticReport;
beforeAll(async () => {
  signed = policyAt(T0 - 60_000);
  report = await passReport(signed, T0);
}, 60_000);

function rig(over: Parameters<typeof wiringRig>[0] = {}): WiringRig {
  const r = wiringRig({ engine: permissiveEngine(), ...over });
  r.daemon.activatePolicy(signed, report);
  return r;
}

const creates = (r: WiringRig) =>
  r.spy.replaceBatch.mock.calls.filter((c) =>
    (c[0] as { replacements: { new_order?: unknown }[] }).replacements.some((x) => x.new_order),
  ).length;

type Blocking = [string, (r: WiringRig) => void];

const BLOCKING: Blocking[] = [
  ["policy expired", (r) => (r.clock.t = T0 + 25 * 3_600_000)],
  ["index stale (> 3 s)", (r) => (r.market.priceAgeMs = 3_500)],
  ["L3 not gap-free", (r) => (r.market.l3Synced = false)],
  ["markets stale (> 120 s)", (r) => (r.market.marketsAgeMs = 121_000)],
  ["cover stale (> 60 s)", (r) => (r.cover.ageMs = 61_000)],
  ["cover sold (10 NIGHT left)", (r) => (r.cover.night = 10n)],
  ["cover gone to zero", (r) => (r.cover.night = 0n)],
  ["an unconfirmed spend of the cover (mempool)", (r) => (r.cover.spend = true)],
  ["user stream down", (r) => (r.stream.live = false)],
  ["vault shares held", (r) => (r.vault.shares = true)],
  ["margin in the reduce band", (r) => (r.balances.maintMargin = "550")],
  ["no equity", (r) => (r.balances.marginBalance = "0")],
  [
    "account not bound/active",
    (r) => r.db.setAccountStatus(r.account.accountId, "paused", "test", T0),
  ],
  [
    "creates paused after three 429s",
    (r) => {
      r.rate.record429();
      r.rate.record429();
      r.rate.record429();
    },
  ],
  ["index far from the ladder (static band)", (r) => (r.market.mark = "0.0300")],
];

describe("SAFETY PROOF: the keeper's signer is reached only through the Guard", () => {
  it("an armed, healthy keeper does create: the spy is wired, not dead", async () => {
    const r = rig();
    await settledTick(r, 3);
    expect(creates(r)).toBe(1);
    const d = r.db.decisions().find((x) => x.kind === "requote" && x.guard?.decision === "execute");
    expect(d?.ops?.[0]?.clientOrderId).toMatch(/^bal_/);
  });

  for (const [name, mutate] of BLOCKING) {
    it(`never creates when ${name}`, async () => {
      const r = rig();
      mutate(r);
      await settledTick(r, 3);
      expect(creates(r), name).toBe(0);
      const blocked = r.db.decisions().filter((x) => x.kind === "requote");
      for (const d of blocked) expect(d.guard?.decision, name).toBe("blocked");
    });
  }

  it("any combination of blocking conditions, with or without DRY_RUN, never creates", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(BLOCKING, { minLength: 1 }),
        fc.boolean(),
        async (muts, dryRun) => {
          const r = rig({ config: { dryRun, mode: dryRun ? "dry-run" : "armed" } });
          for (const [, m] of muts) m(r);
          await settledTick(r, 2);
          expect(creates(r)).toBe(0);
        },
      ),
      { numRuns: 120 },
    );
  }, 120_000);

  it("no policy at all: nothing is planned, nothing is sent", async () => {
    const r = wiringRig({ engine: permissiveEngine() });
    await settledTick(r, 3);
    expect(r.spy.replaceBatch).not.toHaveBeenCalled();
  });

  it("a Critic FAIL or an untrusted operator never activates, so nothing is created", async () => {
    const fail = { ...report, verdict: "FAIL" as const };
    const r1 = wiringRig({ engine: permissiveEngine() });
    expect(r1.daemon.activatePolicy(signed, fail).ok).toBe(false);
    await settledTick(r1, 3);
    expect(creates(r1)).toBe(0);
    const stranger = OperatorKey.fromSeed(new Uint8Array(32).fill(99));
    const r2 = wiringRig({ engine: permissiveEngine() });
    const foreign = signPolicy(signed.policy, stranger);
    expect(r2.daemon.activatePolicy(foreign, report).ok).toBe(false);
    await settledTick(r2, 3);
    expect(creates(r2)).toBe(0);
  });

  it("mainnet unarmed (DRY_RUN=false, ARM=0 slipped past config) is blocked by arm-flag", async () => {
    const r = rig({ config: { armed: false } });
    await settledTick(r, 3);
    expect(creates(r)).toBe(0);
    const d = r.db.decisions().find((x) => x.kind === "requote");
    expect(d?.guard?.violations).toContain("arm-flag");
  });
});

describe("SAFETY PROOF: DRY_RUN never sends", () => {
  it("records 'would place' with every rule evaluated and passed, and calls no signer method", async () => {
    const r = rig({ config: { dryRun: true, armed: false, mode: "dry-run" } });
    await settledTick(r, 3);
    for (const m of Object.values(r.spy)) expect(m).not.toHaveBeenCalled();
    const d = r.db.decisions().find((x) => x.kind === "requote" && x.guard?.decision === "dry-run");
    expect(d?.guard?.violations).toEqual([]);
    const wp = r.wouldPlace[0] as { guard: { checks: { rule: string; passed: boolean }[] } };
    expect(wp.guard.checks).toHaveLength(28);
    expect(wp.guard.checks.every((c) => c.passed)).toBe(true);
  });

  it("DRY_RUN cancels nothing either (the kill path is held too)", async () => {
    const r = rig({ config: { dryRun: true, armed: false, mode: "dry-run" } });
    await settledTick(r, 2);
    await r.daemon.stop({ cancel: true, waitMs: 10 });
    for (const m of Object.values(r.spy)) expect(m).not.toHaveBeenCalled();
  });
});

describe("SAFETY PROOF: a hung or throwing Advisor changes nothing (invariant 19)", () => {
  async function scenario(mode: "none" | "hung" | "throws") {
    const llmSpy = vi.fn();
    const llm: LlmClient | null =
      mode === "none"
        ? null
        : {
            complete: async () => {
              llmSpy();
              if (mode === "throws") throw new Error("advisor exploded");
              return new Promise<string>(() => {});
            },
          };
    const advisor = new AdvisorService({ llm, timeoutMs: 30 });
    const r = rig({ advisor });
    const during: number[] = [];
    const step = async (mut?: (x: WiringRig) => void) => {
      mut?.(r);
      const before = llmSpy.mock.calls.length;
      await r.daemon.runTick();
      during.push(llmSpy.mock.calls.length - before);
      for (let j = 0; j < 5; j++) await new Promise((res) => setImmediate(res));
    };
    await step();
    await step();
    await step((x) => (x.market.priceAgeMs = 3_500)); // blocked: a guard trip is offered to the Advisor
    await step((x) => (x.market.priceAgeMs = 200));
    r.clock.t += 31_000; // the 30 s requote heartbeat
    await step();
    await step();
    await advisor.idle();
    return {
      calls: r.spy.replaceBatch.mock.calls.map((c) =>
        JSON.stringify(c[0], (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      ),
      chain: r.db.decisions().map((d) => d.hash),
      during,
    };
  }

  it("identical signer calls and decision chain with no, a hung and a throwing Advisor", async () => {
    const none = await scenario("none");
    const hung = await scenario("hung");
    const throws = await scenario("throws");
    expect(none.calls.length).toBeGreaterThan(0);
    expect(hung.calls).toEqual(none.calls);
    expect(throws.calls).toEqual(none.calls);
    expect(hung.chain).toEqual(none.chain);
    expect(throws.chain).toEqual(none.chain);
    expect([...hung.during, ...throws.during].every((n) => n === 0)).toBe(true);
  }, 60_000);
});
