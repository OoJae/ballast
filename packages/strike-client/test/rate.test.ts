import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type RateClass, RateLimiter } from "../src/index.js";

type Step =
  | {
      kind: "req";
      dt: number;
      account: string;
      rateClass: RateClass;
      ops: number;
      replaceBatch: boolean;
    }
  | { kind: "429"; dt: number };

const reqArb: fc.Arbitrary<Step> = fc.record({
  kind: fc.constant("req" as const),
  dt: fc.integer({ min: 0, max: 4_000 }),
  account: fc.constantFrom("a", "b", "c"),
  rateClass: fc.constantFrom<RateClass>("create", "create", "cancel", "reduce", "config"),
  ops: fc.integer({ min: 1, max: 40 }),
  replaceBatch: fc.boolean(),
});
const stepArb = fc.oneof(
  { weight: 12, arbitrary: reqArb },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("429" as const),
      dt: fc.integer({ min: 0, max: 20_000 }),
    }),
  },
);

interface Admitted {
  t: number;
  account: string;
  rateClass: RateClass;
  ops: number;
  replaceBatch: boolean;
}

describe("RateLimiter", () => {
  it("property: budget, cancel reserve, replace-batch spacing and the 429 pause all hold", () => {
    let refusals = 0;
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 60, maxLength: 300 }), (steps) => {
        let now = 1_000_000;
        const rl = new RateLimiter({ now: () => now });
        const admitted: Admitted[] = [];
        const four29s: number[] = [];
        let pausedUntil = 0;
        const windowOps = (t: number) =>
          admitted
            .filter((a) => a.t > t - 60_000 && a.rateClass !== "config")
            .reduce((n, a) => n + a.ops, 0);

        for (const s of steps) {
          now += s.dt;
          if (s.kind === "429") {
            rl.record429();
            four29s.push(now);
            const recent = four29s.filter((t) => t > now - 60_000);
            if (recent.length >= 3) {
              pausedUntil = Math.max(pausedUntil, now + 30_000);
              four29s.length = 0;
            }
            continue;
          }
          const before = windowOps(now);
          const d = rl.acquire(s);
          if (s.rateClass === "cancel" || s.rateClass === "config") {
            // Cancels are never refused: the kill path cannot wait on Ballast's own budget.
            expect(d.ok).toBe(true);
          }
          if (d.ok) {
            if (s.replaceBatch && s.rateClass !== "cancel" && s.rateClass !== "config") {
              const prior = admitted.filter(
                (a) => a.replaceBatch && a.account === s.account && a.t > now - 2_000,
              );
              expect(prior, "two replace-batches inside 2 s").toHaveLength(0);
            }
            if (s.rateClass !== "config") admitted.push({ t: now, ...s });
            if (s.rateClass === "create") {
              expect(now >= pausedUntil, "create admitted during a 429 pause").toBe(true);
              // Creates never dip into the 60-token cancel reserve.
              expect(before + s.ops).toBeLessThanOrEqual(240);
            }
            if (s.rateClass === "reduce") expect(before + s.ops).toBeLessThanOrEqual(300);
          } else {
            // Refusals are justified, never arbitrary.
            if (d.reason === "budget") {
              refusals += 1;
              const limit = s.rateClass === "create" ? 240 : 300;
              expect(before + s.ops).toBeGreaterThan(limit);
              expect(d.retryAfterMs).toBeGreaterThan(0);
            } else if (d.reason === "paused-after-429") {
              expect(s.rateClass).toBe("create");
              expect(now).toBeLessThan(pausedUntil);
            } else {
              expect(s.replaceBatch).toBe(true);
              const last = admitted.filter((a) => a.replaceBatch && a.account === s.account).at(-1);
              expect(last && now - last.t < 2_000).toBe(true);
            }
          }
        }
        // Whenever every cancel fit the budget, no 60 s window ever exceeded 300 order tokens.
        if (admitted.every((a, i) => a.rateClass !== "cancel" || windowOpsAt(admitted, i) <= 300)) {
          for (let i = 0; i < admitted.length; i++)
            expect(windowOpsAt(admitted, i)).toBeLessThanOrEqual(300);
        }
      }),
      { numRuns: 500 },
    );
    // The generated traffic must actually saturate the budget for the property to mean much.
    expect(refusals).toBeGreaterThan(1_000);
  });

  it("a refused create is admitted once retryAfterMs has passed", () => {
    let now = 0;
    const rl = new RateLimiter({ now: () => now });
    for (let i = 0; i < 24; i++) {
      expect(
        rl.acquire({ account: "a", rateClass: "create", ops: 10, replaceBatch: false }).ok,
      ).toBe(true);
      now += 1_000;
    }
    const d = rl.acquire({ account: "a", rateClass: "create", ops: 10, replaceBatch: false });
    expect(d).toMatchObject({ ok: false, reason: "budget" });
    if (d.ok) return;
    now += d.retryAfterMs - 1;
    expect(rl.acquire({ account: "a", rateClass: "create", ops: 10, replaceBatch: false }).ok).toBe(
      false,
    );
    now += 1;
    expect(rl.acquire({ account: "a", rateClass: "create", ops: 10, replaceBatch: false }).ok).toBe(
      true,
    );
  });

  it("keeps the 20% reserve for cancels and reduce-only exits", () => {
    let now = 0;
    const rl = new RateLimiter({ now: () => now });
    expect(
      rl.acquire({ account: "a", rateClass: "create", ops: 240, replaceBatch: false }).ok,
    ).toBe(true);
    expect(rl.acquire({ account: "a", rateClass: "create", ops: 1, replaceBatch: false }).ok).toBe(
      false,
    );
    expect(rl.acquire({ account: "a", rateClass: "reduce", ops: 1, replaceBatch: false }).ok).toBe(
      true,
    );
    for (let i = 0; i < 59; i++) {
      expect(
        rl.acquire({ account: "a", rateClass: "cancel", ops: 1, replaceBatch: false }),
      ).toEqual({
        ok: true,
        overBudget: false,
      });
    }
    expect(rl.acquire({ account: "a", rateClass: "reduce", ops: 1, replaceBatch: false }).ok).toBe(
      false,
    );
    // Past the full budget a cancel is still sent, and flagged.
    expect(rl.acquire({ account: "a", rateClass: "cancel", ops: 1, replaceBatch: false })).toEqual({
      ok: true,
      overBudget: true,
    });
    now += 60_000;
    expect(rl.used()).toBe(0);
  });

  it("three 429s inside 60 s pause creates for 30 s, never cancels", () => {
    let now = 0;
    const rl = new RateLimiter({ now: () => now });
    rl.record429();
    now += 30_000;
    rl.record429();
    now += 31_000;
    rl.record429(); // the first is now outside the 60 s window
    expect(rl.acquire({ account: "a", rateClass: "create", ops: 1, replaceBatch: false }).ok).toBe(
      true,
    );
    rl.record429();
    expect(
      rl.acquire({ account: "a", rateClass: "create", ops: 1, replaceBatch: false }),
    ).toMatchObject({
      ok: false,
      reason: "paused-after-429",
      retryAfterMs: 30_000,
    });
    expect(rl.acquire({ account: "a", rateClass: "cancel", ops: 1, replaceBatch: false }).ok).toBe(
      true,
    );
    expect(rl.acquire({ account: "a", rateClass: "reduce", ops: 1, replaceBatch: false }).ok).toBe(
      true,
    );
    now += 30_000;
    expect(rl.acquire({ account: "a", rateClass: "create", ops: 1, replaceBatch: false }).ok).toBe(
      true,
    );
  });

  it("spaces replace-batches per account, not globally", () => {
    let now = 0;
    const rl = new RateLimiter({ now: () => now });
    const rb = (account: string) =>
      rl.acquire({ account, rateClass: "create", ops: 6, replaceBatch: true });
    expect(rb("a").ok).toBe(true);
    expect(rb("b").ok).toBe(true);
    now += 1_999;
    expect(rb("a")).toMatchObject({ ok: false, reason: "replace-batch-spacing", retryAfterMs: 1 });
    now += 1;
    expect(rb("a").ok).toBe(true);
  });
});

function windowOpsAt(admitted: Admitted[], i: number): number {
  const t = (admitted[i] as Admitted).t;
  return admitted.filter((a, j) => j <= i && a.t > t - 60_000).reduce((n, a) => n + a.ops, 0);
}
