/**
 * End-to-end fake-Strike session (M6/M7 software path, DRY_RUN off against the fake only):
 *  1. activate a signed policy with a real simulator Critic PASS;
 *  2. quote NIGHT asks into the near-empty ask side;
 *  3. a taker lifts one: reconcile and cover math hold;
 *  4. cover drops: cancel first, then a reduce-only buy-back back to r × cover;
 *  5. the keeper crashes: the watchdog's cancel-all is confirmed on stream and L3;
 *  6. `ballast verify` passes over the evidence the keeper produced.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportBundle } from "@ballast/evidence/bundle";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runVerify } from "../../cli/src/verify.js";
import { accountBook, coverSteps } from "../../keeper/src/facts.js";
import {
  activate,
  daemonKey,
  type KeeperHarness,
  operator,
  restingAsks,
  SYMBOL,
  startKeeper,
} from "../../keeper/test/harness.js";
import { requestsBy, startWatchdog, type WatchdogHarness } from "./harness.js";

let h: KeeperHarness;
let w: WatchdogHarness;
let id: string;
const wait = { timeout: 15_000, interval: 50 };

beforeAll(async () => {
  h = await startKeeper({ accounts: [{ label: "e2e-holder", cover: 200_000n }] });
  id = h.accounts[0]?.id as string;
}, 30_000);

afterAll(async () => {
  await w?.stop();
  await h?.stop();
});

describe("end-to-end fake-Strike session", () => {
  it("1. activates a signed policy only with a Critic PASS", async () => {
    const signed = await activate(h);
    expect(h.db.policies().find((p) => p.signed.hash === signed.hash)?.status).toBe("active");
    const rec = h.db.decisions().find((d) => d.kind === "policy");
    expect(rec?.policyHash).toBe(signed.hash);
    w = await startWatchdog(h, { deadlineMs: 2_000 });
    h.daemon.start();
    w.wd.start();
  }, 60_000);

  it("2. quotes a covered post-only ask into the ask side, inside the house's best ask", async () => {
    await vi.waitFor(() => expect(restingAsks(h, id).length).toBeGreaterThan(0), wait);
    const ask = restingAsks(h, id)[0];
    const house = h.fake.engine.book(SYMBOL).asks.filter((o) => !o.accountId);
    expect(ask?.postOnly).toBe(true);
    expect(ask && house[0] && ask.price < house[0].price).toBe(true);
    // It is on L3 too, and the keeper found it there by its fingerprinted size.
    await vi.waitFor(() => expect(h.daemon.accounts[0]?.l3Ids.size).toBeGreaterThan(0), wait);
    expect(w.monitor.alive()).toBe(true);
  }, 30_000);

  it("3. a taker lifts it: the fill is reconciled and short + asks stay within r × cover", async () => {
    h.fake.engine.marketTake(SYMBOL, "buy", "2000");
    const rt = h.daemon.accounts[0];
    if (!rt) throw new Error("no runtime");
    await vi.waitFor(() => expect(rt.reconciler.position(SYMBOL)).toBe("-2000"), wait);
    await vi.waitFor(
      () => expect(h.db.decisions().some((d) => d.kind === "fill")).toBe(true),
      wait,
    );
    const mv = h.market.view(SYMBOL);
    const m = mv.market;
    if (!m) throw new Error("no market");
    const book = accountBook(rt, SYMBOL, m);
    const committed = (coverSteps(m, h.cover.view(id)) * 5_000n) / 10_000n;
    expect(book.shortSteps).toBe(2_000n);
    expect(book.shortSteps + book.restingSteps + book.pendingSteps <= committed).toBe(true);
    // The maker fill is in the evidence store, tied to its bal_ order.
    const fills = h.db.raw.prepare("SELECT client_order_id, role, size_steps FROM fills").all() as {
      client_order_id: string;
      role: string;
      size_steps: string;
    }[];
    expect(fills.some((f) => f.client_order_id.startsWith("bal_") && f.role === "maker")).toBe(
      true,
    );
  }, 30_000);

  it("4. cover drops: cancel-all first, then a reduce-only IOC buy-back to r × cover", async () => {
    const keeperKey = h.accounts[0]?.signer.publicKeyHex as string;
    const before = requestsBy(h, keeperKey).length;
    h.cover.set(id, "e2e-holder", 3_000n); // capacity 1,500 < short 2,000
    const rt = h.daemon.accounts[0];
    await vi.waitFor(() => expect(rt?.reconciler.position(SYMBOL)).toBe("-1500"), wait);
    const mine = requestsBy(h, keeperKey).slice(before);
    const cancel = mine.findIndex(
      (r) => r.method === "DELETE" && r.target === "/v2/order/cancel-all",
    );
    const buy = mine.findIndex((r) => r.method === "POST" && r.target === "/v2/order");
    expect(cancel).toBeGreaterThanOrEqual(0);
    expect(buy).toBeGreaterThan(cancel);
    const body = JSON.parse(mine[buy]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      side: "buy",
      reduce_only: true,
      time_in_force: "IOC",
      size: "500",
    });
    expect(String(body.client_order_id)).toMatch(/^bal_[0-9a-f]{6}_[0-9a-f]{6}_x_/);
    // No create was sent between the breach and the buy-back.
    expect(
      mine
        .slice(0, buy)
        .some((r) => r.target === "/v2/order/replace-batch" && r.body.includes("new_order")),
    ).toBe(false);
  }, 30_000);

  it("5. the keeper crashes: the watchdog fires a cancel-all and confirms it on stream and L3", async () => {
    h.cover.set(id, "e2e-holder", 200_000n);
    await vi.waitFor(() => expect(restingAsks(h, id).length).toBeGreaterThan(0), wait);
    await w.crashKeeper();
    const fired = () => w.killLog.find((k) => k.rule === "heartbeat" && k.latency !== undefined);
    await vi.waitFor(() => expect(fired()).toBeDefined(), { timeout: 20_000, interval: 100 });
    expect(restingAsks(h, id)).toEqual([]);
    const k = fired();
    expect(k?.decision).toBe("execute");
    expect(k?.latency?.l3Ms).toBeGreaterThanOrEqual(0);
    expect(k?.latency?.streamMs).toBeGreaterThanOrEqual(0);
    // The watchdog only ever cancels.
    for (const key of w.keys) {
      for (const r of requestsBy(h, key.publicKeyHex)) {
        expect(
          r.method === "GET" || r.target === "/v2/order/cancel-all",
          `${r.method} ${r.target}`,
        ).toBe(true);
      }
    }
    const row = w.db.raw.prepare("SELECT status, trigger FROM kills").all() as {
      status: string;
      trigger: string;
    }[];
    expect(row.some((x) => x.status === "confirmed" && x.trigger === "watchdog")).toBe(true);
  }, 40_000);

  it("6. ballast verify passes over the evidence the keeper produced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ballast-e2e-bundle-"));
    exportBundle(h.db, dir, {
      network: "mainnet",
      trust: { operatorPubkeys: [operator.publicKeyHex], daemonPubkeys: [daemonKey.publicKeyHex] },
      createdMs: Date.now(),
    });
    const r = await runVerify({
      bundleDir: dir,
      operatorPubkeys: [operator.publicKeyHex],
      daemonPubkeys: [daemonKey.publicKeyHex],
      anchorLookup: null,
    });
    const status = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    expect(r.ok, JSON.stringify(r.checks.filter((c) => c.status === "FAIL"))).toBe(true);
    expect(status).toMatchObject({
      bundle: "PASS",
      trust: "PASS",
      "decision-chain": "PASS",
      policies: "PASS",
      "critic-reports": "PASS",
      activation: "PASS",
    });
    expect(["PASS", "WARN"]).toContain(status.cover);
    const kinds = new Set(h.db.decisions().map((d) => d.kind));
    for (const k of ["policy", "cover", "requote", "fill", "kill", "keeper"])
      expect(kinds.has(k as never), k).toBe(true);
  }, 30_000);
});
