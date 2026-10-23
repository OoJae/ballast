import { refPrice, steps } from "@ballast/core";
import { keeperStep, planRequote } from "@ballast/engine";
import { DaemonKey } from "@ballast/governance";
import { Grid } from "@ballast/market";
import { HeartbeatMonitor, signHeartbeat } from "@ballast/ops";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activate,
  daemonKey,
  type KeeperHarness,
  restingAsks,
  SYMBOL,
  startKeeper,
} from "../../keeper/test/harness.js";
import { loadWatchdogConfig } from "../src/config.js";
import { evaluateWatchdog, type WatchdogFacts } from "../src/rules.js";
import { startWatchdog, type WatchdogHarness } from "./harness.js";

const tick = new Grid("0.000001");
const facts = (over: Partial<WatchdogFacts> = {}): WatchdogFacts => ({
  heartbeatAlive: true,
  armedForHeartbeat: true,
  heartbeatAgeMs: 500,
  floorTicks: 38_400n,
  index: refPrice(tick, "0.0383"),
  accounts: [
    {
      accountId: "a",
      asks: [{ clientOrderId: "bal_x", px: 38_446n, source: "l3" }],
      exposureSteps: 7_700n,
      capacitySteps: 100_000n,
      coverFell: false,
    },
  ],
  ...over,
});

describe("watchdog rules", () => {
  it("is quiet when the keeper is alive and every ask is safe and covered", () => {
    expect(evaluateWatchdog(facts())).toEqual([]);
  });

  it("fires on a missing heartbeat only after its own grace period", () => {
    expect(evaluateWatchdog(facts({ heartbeatAlive: false, armedForHeartbeat: false }))).toEqual(
      [],
    );
    expect(evaluateWatchdog(facts({ heartbeatAlive: false }))[0]?.rule).toBe("heartbeat");
  });

  it("fires on a Ballast ask below the floor or below index + 20 bps", () => {
    const below = (px: bigint) =>
      facts({
        accounts: [
          { ...facts().accounts[0], asks: [{ clientOrderId: "bal_x", px, source: "l3" }] } as never,
        ],
      });
    expect(evaluateWatchdog(below(38_399n))[0]?.rule).toBe("price"); // below F
    expect(evaluateWatchdog({ ...below(38_370n), floorTicks: 0n })[0]?.rule).toBe("price"); // < index + 20 bps
    expect(evaluateWatchdog({ ...below(38_377n), floorTicks: 0n })).toEqual([]); // index × 1.002 = 38376.6
  });

  it("fires when cover no longer covers short + asks, or falls while asks rest", () => {
    const a = facts().accounts[0];
    expect(
      evaluateWatchdog(facts({ accounts: [{ ...a, capacitySteps: 5_000n } as never] }))[0]?.rule,
    ).toBe("cover");
    expect(
      evaluateWatchdog(facts({ accounts: [{ ...a, coverFell: true } as never] }))[0]?.rule,
    ).toBe("cover");
    expect(
      evaluateWatchdog(facts({ accounts: [{ ...a, coverFell: true, asks: [] } as never] })),
    ).toEqual([]);
  });
});

describe("watchdog config", () => {
  const daemons = { BALLAST_TRUSTED_DAEMONS: daemonKey.publicKeyHex };
  it("is DRY_RUN by default, needs the keeper's daemon key pinned and refuses half-armed starts", () => {
    expect(loadWatchdogConfig(daemons).mode).toBe("dry-run");
    expect(() => loadWatchdogConfig({})).toThrow(/BALLAST_TRUSTED_DAEMONS/);
    expect(() => loadWatchdogConfig({ ...daemons, DRY_RUN: "false" })).toThrow(/half-armed/);
    expect(() => loadWatchdogConfig({ ...daemons, BALLAST_ARM: "1" }, ["--mainnet"])).toThrow(
      /half-armed/,
    );
    expect(
      loadWatchdogConfig({ ...daemons, DRY_RUN: "false", BALLAST_ARM: "1" }, ["--mainnet"]).mode,
    ).toBe("armed");
    expect(() =>
      loadWatchdogConfig({ ...daemons, BALLAST_WATCHDOG_ACCOUNTS_FILE: "a.json" }),
    ).toThrow(/restricted jurisdictions/);
  });
});

describe("heartbeat trust", () => {
  it("a heartbeat signed by any other daemon key does not keep the keeper alive", () => {
    const mon = new HeartbeatMonitor({ trustedDaemons: [daemonKey.publicKeyHex] });
    const impostor = DaemonKey.fromSeed(new Uint8Array(32).fill(66));
    const v = mon.offer(
      signHeartbeat(
        {
          v: 1,
          kind: "ballast/heartbeat",
          daemonPubkey: impostor.publicKeyHex,
          bootId: "0123456789abcdef",
          seq: 1,
          tsMs: Date.now(),
          mode: "armed",
          state: "running",
          decisionHead: { seq: 1, hash: null },
          accounts: [],
        },
        impostor,
      ),
    );
    expect(v.ok).toBe(false);
    expect(mon.alive()).toBe(false);
  });
});

describe("chaos: keeper crash", () => {
  let h: KeeperHarness | undefined;
  let w: WatchdogHarness | undefined;
  afterEach(async () => {
    await w?.stop();
    await h?.stop();
    w = undefined;
    h = undefined;
  });

  it("with the user stream silent, the watchdog still cancels and confirms via REST and L3", async () => {
    h = await startKeeper();
    const x = h;
    const id = x.accounts[0]?.id as string;
    await activate(x);
    w = await startWatchdog(x, { deadlineMs: 1_500 });
    x.daemon.start();
    w.wd.start();
    await vi.waitFor(() => expect(restingAsks(x, id).length).toBeGreaterThan(0), {
      timeout: 15_000,
    });
    // Every order event is lost from now on: confirmation must come from REST and L3.
    x.fake.setEventFilter((acct, msg) => acct === id && msg.e === "ORDER_TRADE_UPDATE");
    const ww = w;
    await ww.crashKeeper();
    await vi.waitFor(
      () => expect(ww.killLog.find((k) => k.rule === "heartbeat" && k.latency)).toBeDefined(),
      { timeout: 20_000, interval: 100 },
    );
    expect(restingAsks(x, id)).toEqual([]);
    expect(x.fake.engine.book(SYMBOL).asks.some((o) => o.accountId === id)).toBe(false);
  }, 40_000);

  for (const rule of ["price", "cover"] as const) {
    it(`a keeper that ticks and heartbeats but stopped acting: the ${rule} rule fires on the watchdog's own view`, async () => {
      // A wedged keeper: its loop and heartbeat run, but it never cancels or requotes.
      const bug = { on: false };
      h = await startKeeper({
        engine: {
          keeper: (k) =>
            bug.on
              ? {
                  actions: [],
                  allowCreates: true,
                  capacity: steps(0n),
                  breach: false,
                  buyBackPending: steps(0n),
                  reasons: [],
                }
              : keeperStep(k),
          plan: (i) => {
            const p = planRequote(i);
            return bug.on
              ? {
                  ...p,
                  accounts: p.accounts.map((a) => ({
                    ...a,
                    diff: { kind: "none" as const, keep: [] },
                  })),
                }
              : p;
          },
        },
      });
      const x = h;
      const id = x.accounts[0]?.id as string;
      await activate(x);
      w = await startWatchdog(x, { deadlineMs: 1_500 });
      x.daemon.start();
      w.wd.start();
      await vi.waitFor(() => expect(restingAsks(x, id).length).toBeGreaterThan(0), {
        timeout: 15_000,
      });
      bug.on = true;
      if (rule === "price") {
        // Index jumps: the resting ask is now below index + 20 bps.
        x.fake.market.setPrice(SYMBOL, { mark: "0.03870", index: "0.03865" });
      } else {
        x.cover.set(id, x.accounts[0]?.label as string, 2_000n); // r × cover 1,000 < resting asks
      }
      const ww = w;
      await vi.waitFor(
        () => expect(ww.killLog.find((k) => k.rule === rule && k.latency)).toBeDefined(),
        { timeout: 20_000, interval: 100 },
      );
      expect(ww.monitor.alive()).toBe(true);
      expect(restingAsks(x, id)).toEqual([]);
    }, 40_000);
  }

  it("a keeper that stopped its loop while still heartbeating is treated as dead", async () => {
    h = await startKeeper();
    const x = h;
    const id = x.accounts[0]?.id as string;
    await activate(x);
    w = await startWatchdog(x, { deadlineMs: 1_500 });
    x.daemon.start();
    w.wd.start();
    await vi.waitFor(() => expect(restingAsks(x, id).length).toBeGreaterThan(0), {
      timeout: 15_000,
    });
    await x.daemon.stop({ cancel: false }); // heartbeats continue, saying "stopping"
    const ww = w;
    await vi.waitFor(
      () => expect(ww.killLog.find((k) => k.rule === "heartbeat" && k.latency)).toBeDefined(),
      { timeout: 20_000, interval: 100 },
    );
    expect(ww.monitor.latest()?.state).toBe("stopping");
    expect(restingAsks(x, id)).toEqual([]);
  }, 40_000);

  it("in DRY_RUN the watchdog only logs: nothing is cancelled", async () => {
    h = await startKeeper();
    const x = h;
    const id = x.accounts[0]?.id as string;
    await activate(x);
    w = await startWatchdog(x, { deadlineMs: 1_500, dryRun: true, mode: "dry-run" });
    x.daemon.start();
    w.wd.start();
    await vi.waitFor(() => expect(restingAsks(x, id).length).toBeGreaterThan(0), {
      timeout: 15_000,
    });
    const ww = w;
    await ww.crashKeeper();
    await vi.waitFor(() => expect(ww.killLog.some((k) => k.decision === "dry-run")).toBe(true), {
      timeout: 20_000,
      interval: 100,
    });
    expect(restingAsks(x, id).length).toBeGreaterThan(0);
    // An armed keeper under a dry-run watchdog is flagged: there is no second kill path.
    expect(
      ww.notifier.alerts.some((a) => /ARMED but this watchdog runs in DRY_RUN/.test(a.title)),
    ).toBe(true);
    for (const key of ww.keys) {
      expect(
        x.fake.requests.filter(
          (r) => r.headers["x-api-wallet-public-key"] === key.publicKeyHex && r.method !== "GET",
        ),
      ).toEqual([]);
    }
  }, 40_000);
});
