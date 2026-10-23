import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BundleContents, writeBundle } from "@ballast/evidence/bundle";
import { DecisionLog } from "@ballast/governance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runVerify } from "../src/verify.js";
import { buildContents, DAY, daemon, T0, TRUST } from "./fixture.js";

/**
 * Invariant 2's retro-check mirrors the Guard: it governs asks. A reduce-only buy-back after the
 * last policy window ended (the keeper closing a short on a cover loss) is risk-reducing and
 * passes; the same op as a sell (a new ask) with no policy in force fails.
 */
const dir = mkdtempSync(join(tmpdir(), "ballast-verify-exits-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let base: BundleContents;
beforeAll(async () => {
  base = (await buildContents()).contents;
});

function withLateOp(side: "buy" | "sell"): string {
  const c = structuredClone(base);
  const last = c.decisions.at(-1);
  if (!last) throw new Error("fixture has no decisions");
  const log = new DecisionLog({
    key: daemon,
    head: { seq: last.seq, hash: last.hash },
    now: () => T0 + 30 * DAY,
  });
  c.decisions.push(
    log.append({
      kind: "keeper",
      accountId: "acct-fixture",
      inputsDigest: "a".repeat(64),
      inputsRef: null,
      ops: [
        {
          route: side === "buy" ? "POST /v2/order" : "POST /v2/order/replace-batch",
          clientOrderId: `bal_aaaaaa_bbbbbb_${side === "buy" ? "x" : "1"}_zz`,
          side,
          priceTicks: "39000",
          sizeSteps: "500",
        },
      ],
      guard: { decision: "execute", checksHash: "b".repeat(64), violations: [] },
    }),
  );
  const out = join(dir, side);
  writeBundle(out, c, { network: "mainnet", trust: TRUST, createdMs: T0 });
  return out;
}

describe("verify: exits are exempt from invariant 2, asks are not", () => {
  it("a reduce-only buy-back with no policy in force passes", async () => {
    const r = await runVerify({ bundleDir: withLateOp("buy"), ...TRUST, anchorLookup: null });
    expect(r.checks.find((c) => c.id === "activation")?.status).toBe("PASS");
  });

  it("an ask with no policy in force fails", async () => {
    const r = await runVerify({ bundleDir: withLateOp("sell"), ...TRUST, anchorLookup: null });
    const a = r.checks.find((c) => c.id === "activation");
    expect(a?.status).toBe("FAIL");
    expect(a?.failures.join(" ")).toMatch(/no policy in force/);
  });
});
