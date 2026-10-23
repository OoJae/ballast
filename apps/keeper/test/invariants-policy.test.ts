/**
 * CLAUDE.md invariants 2, 3, 4, 12 and 18 at the daemon level, against a real keeper on the
 * fake Strike. (10, 11, 13 and 14: invariants-faults.test.ts; 19: wiring.test.ts.)
 */
import { defaultQuotePolicy } from "@ballast/core";
import { acquireDaemonLockOrThrow, openEvidenceDb } from "@ballast/evidence/db";
import { signPolicy } from "@ballast/governance";
import { checkRoute, StrikeRefusedError } from "@ballast/strike-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activate,
  type KeeperHarness,
  operator,
  passReport,
  restingAsks,
  SYMBOL,
  startKeeper,
} from "./harness.js";

let h: KeeperHarness | undefined;
afterEach(async () => {
  h?.fake.releaseEngine();
  await h?.stop();
  h = undefined;
});
const wait = { timeout: 15_000, interval: 50 };

const keeperRequests = (x: KeeperHarness) => {
  const key = x.accounts[0]?.signer.publicKeyHex;
  return x.fake.requests.filter((r) => r.headers["x-api-wallet-public-key"] === key);
};
const creates = (x: KeeperHarness) =>
  keeperRequests(x).filter(
    (r) => r.target === "/v2/order/replace-batch" && r.body.includes("new_order"),
  );

async function quoting(opts: Parameters<typeof startKeeper>[0] = {}) {
  const harness = await startKeeper(opts);
  h = harness;
  await activate(harness);
  harness.daemon.start();
  const id = harness.accounts[0]?.id as string;
  await vi.waitFor(() => expect(restingAsks(harness, id).length).toBeGreaterThan(0), wait);
  return { x: harness, id };
}

describe("invariant 2: no create without an operator-signed, unexpired policy with a Critic PASS", () => {
  it("nothing is created before activation; creates stop and asks are cancelled when the window ends", async () => {
    const x = await startKeeper();
    h = x;
    const id = x.accounts[0]?.id as string;
    x.daemon.start();
    await new Promise((r) => setTimeout(r, 1_500));
    expect(creates(x)).toEqual([]);
    const now = Date.now();
    const p = defaultQuotePolicy({
      policyId: "01JKEEPERSTV2000000000000A",
      validFromMs: now - 1_000,
      validForMs: 4_000,
    });
    const signed = signPolicy(p, operator);
    expect(x.daemon.activatePolicy(signed, await passReport(signed)).ok).toBe(true);
    await vi.waitFor(() => expect(restingAsks(x, id).length).toBeGreaterThan(0), wait);
    // The window closes: asks are cancelled and nothing new is created.
    await vi.waitFor(() => expect(restingAsks(x, id)).toEqual([]), wait);
    const n = creates(x).length;
    await new Promise((r) => setTimeout(r, 1_000));
    expect(creates(x).length).toBe(n);
  }, 40_000);
});

describe("invariant 3: DRY_RUN never sends", () => {
  it("a DRY_RUN keeper sends Strike nothing but signed reads, and logs would-place records", async () => {
    const x = await startKeeper({ dryRun: true, armed: false });
    h = x;
    await activate(x);
    x.daemon.start();
    await vi.waitFor(() => expect(x.wouldPlace.length).toBeGreaterThan(0), wait);
    await new Promise((r) => setTimeout(r, 500));
    expect(keeperRequests(x).filter((r) => r.method !== "GET")).toEqual([]);
    expect(x.wouldPlace[0]?.guard.decision).toBe("dry-run");
    expect(x.wouldPlace[0]?.guard.checks).toHaveLength(28);
    expect(x.fake.engine.workingOrders(x.accounts[0]?.id as string)).toEqual([]);
  }, 30_000);
});

describe("invariant 4: only allowlisted routes are ever signed", () => {
  it("every request of a full session (quote, fill, cover loss, buy-back, kill) is on the AUTONOMOUS allowlist", async () => {
    const { x, id } = await quoting();
    x.fake.engine.marketTake(SYMBOL, "buy", "2000");
    await vi.waitFor(
      () => expect(x.daemon.accounts[0]?.reconciler.position(SYMBOL)).toBe("-2000"),
      wait,
    );
    x.cover.set(id, x.accounts[0]?.label as string, 3_000n);
    await vi.waitFor(
      () => expect(x.daemon.accounts[0]?.reconciler.position(SYMBOL)).toBe("-1500"),
      wait,
    );
    const reqs = keeperRequests(x);
    expect(reqs.some((r) => r.target === "/v2/order")).toBe(true);
    for (const r of reqs) {
      const body = r.body ? JSON.parse(r.body) : undefined;
      const route = checkRoute("AUTONOMOUS", r.method, r.target, body);
      expect(route.ok, `${r.method} ${r.target}`).toBe(true);
      expect(r.target).not.toMatch(/replace$|vault|deposit|withdraw|copy|grid|rfq|algo|isoMargin/);
    }
  }, 40_000);
});

describe("invariant 12: single instance", () => {
  it("a second daemon on the same evidence DB refuses to start; a dead holder's lock goes stale", () => {
    const db = openEvidenceDb(":memory:");
    acquireDaemonLockOrThrow(db, 101, 1_000, 15_000);
    expect(() => acquireDaemonLockOrThrow(db, 202, 2_000, 15_000)).toThrow(/holds the lock/);
    expect(() => acquireDaemonLockOrThrow(db, 202, 1_000 + 15_001, 15_000)).not.toThrow();
    db.close();
  });
});

describe("invariant 18: the keeper never deposits, withdraws or uses vault routes", () => {
  it("its signer refuses every funding and vault route before anything is sent", async () => {
    const x = await startKeeper();
    h = x;
    const c = x.accounts[0]?.client;
    if (!c) throw new Error("no client");
    const before = x.fake.requests.length;
    for (const path of [
      "/v2/withdraw",
      "/v2/deposit",
      "/v2/deposit/quote",
      "/v2/withdraw/quote",
      "/v2/vault/deposit",
      "/v2/vaults/redeem",
      "/v2/order/replace",
      "/v2/isoMargin",
    ]) {
      await expect(c.write("POST", path, { amount: "1" }), path).rejects.toBeInstanceOf(
        StrikeRefusedError,
      );
    }
    expect(x.fake.requests.length).toBe(before);
  });
  // The build half (no funding module in the keeper's import graph): import-graph.test.ts.
});

// Invariant 19 (the LLM is not in the path; a hung Advisor changes nothing) is proved in
// wiring.test.ts (identical signer calls and decision chain with no, a hung and a throwing
// Advisor) and import-graph.test.ts (the keeper never reaches the Advisor or the SDK).
