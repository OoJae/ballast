/**
 * In-process fakes for the wiring tests: a static market view, a static cover, a signer spy and
 * scripted reads. No sockets, no timers, no keys that guard anything.
 */
import { type QuotePolicy, refPlusBpsCeil, refPrice, steps } from "@ballast/core";
import {
  clientOrderId,
  engineMarket,
  fingerprintCode,
  fingerprintSize,
  planRequote,
  REFERENCE_MARKETS,
  type RequotePlan,
} from "@ballast/engine";
import { type EvidenceDb, openEvidenceDb } from "@ballast/evidence/db";
import type { CriticRunner } from "@ballast/governance";
import { dec } from "@ballast/market";
import {
  L3Book,
  limitOrder,
  RateLimiter,
  replaceBatch,
  StrikeApiError,
  type StrikePosition,
} from "@ballast/strike-client";
import { vi } from "vitest";
import type { AccountConfig, AccountPorts, BalanceRow } from "../src/account.js";
import type { CoverSource, CoverState } from "../src/cover-watch.js";
import {
  type AdvisorPort,
  createDaemon,
  type EnginePorts,
  type KeeperDaemon,
  type KeeperRuntimeConfig,
} from "../src/daemon.js";
import type { MarketSource, MarketView, PriceTick } from "../src/market-state.js";
import {
  captureNotifier,
  coverProof,
  daemonKey,
  operator,
  SYMBOL,
  silentLogger,
  stakeAddressFor,
} from "./harness.js";

export const NIGHT = engineMarket(REFERENCE_MARKETS["NIGHT-USD"]);
export const T0 = 1_792_716_885_000;

export function houseBook(): L3Book {
  const b = new L3Book(SYMBOL);
  b.applySnapshot({
    type: "l3_snapshot",
    symbol: SYMBOL,
    last_sequence: 1,
    timestamp: T0,
    bids: [
      { price: "0.0383", orders: [{ order_id: "hb1", size: "400000" }] },
      { price: "0.03825", orders: [{ order_id: "hb2", size: "200000" }] },
    ],
    asks: [
      { price: "0.03875", orders: [{ order_id: "ha1", size: "30000" }] },
      { price: "0.0388", orders: [{ order_id: "ha2", size: "100000" }] },
      { price: "0.039", orders: [{ order_id: "ha3", size: "400000" }] },
    ],
  });
  return b;
}

export class StaticMarket implements MarketSource {
  book = houseBook();
  l3Synced = true;
  index = "0.0383";
  mark = "0.03835";
  priceAgeMs = 200;
  marketsAgeMs = 1_000;
  positionsAgeMs = 1_000;
  hasMarket = true;
  constructor(private readonly now: () => number) {}
  view(symbol: string): MarketView {
    const price: PriceTick = {
      mark: dec(this.mark),
      index: dec(this.index),
      rate: dec("0.0001"),
      nextFundingMs: T0 + 3_600_000,
      eventMs: this.now() - this.priceAgeMs,
      recvMs: this.now() - this.priceAgeMs,
    };
    return {
      symbol,
      market: this.hasMarket ? NIGHT : null,
      marketsAgeMs: this.marketsAgeMs,
      book: this.book,
      l3Synced: this.l3Synced,
      l3RebuildAtMs: null,
      price,
      indexAgeMs: this.priceAgeMs,
      markAgeMs: this.priceAgeMs,
      positions: [],
      positionsAgeMs: this.positionsAgeMs,
      replica: { mark: null, errorBps: null },
    };
  }
}

export class StaticCover implements CoverSource {
  night = 200_000n;
  ageMs = 5_000;
  spend = false;
  constructor(
    private readonly now: () => number,
    private readonly label: string,
  ) {}
  view(): CoverState | null {
    const proof = coverProof(this.label, this.night, 12_000_000, this.now() - this.ageMs);
    return {
      proof,
      coverBase: BigInt(proof.coverBase),
      height: proof.height,
      checkedAtMs: proof.checkedAtMs,
      mempoolSpend: this.spend
        ? { txId: "t", refs: [], seenAtMs: this.now(), height: proof.height }
        : null,
    };
  }
}

export interface SignerSpy {
  replaceBatch: ReturnType<typeof vi.fn>;
  placeBuyBack: ReturnType<typeof vi.fn>;
  cancelAll: ReturnType<typeof vi.fn>;
  cancelOrder: ReturnType<typeof vi.fn>;
}

export function signerSpy(): SignerSpy {
  const ok = async () => ({});
  return {
    replaceBatch: vi.fn(ok),
    placeBuyBack: vi.fn(ok),
    cancelAll: vi.fn(async () => ({ canceled_count: -1 })),
    cancelOrder: vi.fn(ok),
  };
}

export interface WiringRig {
  daemon: KeeperDaemon;
  spy: SignerSpy;
  market: StaticMarket;
  cover: StaticCover;
  db: EvidenceDb;
  rate: RateLimiter;
  clock: { t: number; now(): number };
  account: AccountConfig;
  balances: { marginBalance: string; maintMargin: string };
  stream: { live: boolean };
  vault: { shares: boolean };
  /** What `GET /v2/positions` answers (a resync reads it). */
  positions: StrikePosition[];
  notifier: ReturnType<typeof captureNotifier>;
  wouldPlace: unknown[];
}

export function wiringRig(
  opts: {
    config?: Partial<KeeperRuntimeConfig>;
    engine?: Partial<EnginePorts>;
    advisor?: AdvisorPort;
    trustedOperators?: string[];
    critic?: CriticRunner<QuotePolicy> | null;
  } = {},
): WiringRig {
  const clock = { t: T0, now: () => clock.t };
  const market = new StaticMarket(() => clock.t);
  const cover = new StaticCover(() => clock.t, "wiring");
  const spy = signerSpy();
  const balances = { marginBalance: "1000", maintMargin: "0" };
  const stream = { live: true };
  const vault = { shares: false };
  const positions: StrikePosition[] = [];
  const account: AccountConfig = {
    accountId: "acct-wiring",
    stakeAddress: stakeAddressFor("wiring"),
    holder0: false,
    rBps: 5_000n,
    maxShortMicroUsd: null,
    approvedBuilderBps: 10,
  };
  const reads: AccountPorts["reads"] = {
    async get<T>(path: string) {
      if (path !== "/v2/balances") throw new Error(`unexpected GET ${path}`);
      const row: BalanceRow = { asset: "USDT", walletBalance: balances.marginBalance, ...balances };
      return [row] as T;
    },
    async openOrders() {
      return { orders: [], count: 0 };
    },
    async positions() {
      return { positions: [...positions], count: positions.length };
    },
    async getOrder() {
      throw new StrikeApiError(404, "order not found", "", "GET", "/v2/order");
    },
  };
  const db = openEvidenceDb(":memory:");
  db.bindAccount({ accountId: account.accountId, stakeCred: account.stakeAddress, nowMs: T0 });
  db.setAccountStatus(account.accountId, "active", null, T0);
  const rate = new RateLimiter({ now: () => clock.t });
  const notifier = captureNotifier();
  const wouldPlace: unknown[] = [];
  const daemon = createDaemon({
    config: {
      mode: "armed",
      dryRun: false,
      armed: true,
      mainnet: true,
      quoteSymbol: SYMBOL,
      allowlist: [SYMBOL],
      trustedOperators: opts.trustedOperators ?? [operator.publicKeyHex],
      trustedDaemons: [daemonKey.publicKeyHex],
      replicaP99Bps: "0.77",
      reconcilerLagMs: 0,
      marginEveryMs: 0,
      vaultEveryMs: 0,
      ...opts.config,
    },
    db,
    daemonKey,
    market,
    cover,
    accounts: [
      {
        cfg: account,
        signer: spy as unknown as AccountPorts["signer"],
        reads,
        streamLive: () => stream.live,
      },
    ],
    rate,
    notifier,
    logger: silentLogger(),
    clock,
    vaultCheck: async () => vault.shares,
    wouldPlace: (e) => wouldPlace.push(e),
    ...(opts.engine ? { engine: opts.engine } : {}),
    ...(opts.advisor ? { advisor: opts.advisor } : {}),
    ...(opts.critic !== undefined ? { critic: opts.critic } : {}),
    pid: 1,
  });
  return {
    daemon,
    spy,
    market,
    cover,
    db,
    rate,
    clock,
    account,
    balances,
    stream,
    vault,
    positions,
    notifier,
    wouldPlace,
  };
}

/** One tick, with the off-path housekeeping (margin, vault, resync) allowed to finish first. */
export async function settledTick(rig: WiringRig, ticks = 2): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await rig.daemon.runTick();
    for (let j = 0; j < 5; j++) await new Promise((r) => setImmediate(r));
  }
}

/**
 * A maximally permissive engine: the keeper never objects, and the planner always proposes a
 * fresh ask for every account, whatever the governor, the allocator or the keeper decided.
 */
export function permissiveEngine(): Partial<EnginePorts> {
  return {
    keeper: (k) => ({
      actions: [],
      allowCreates: true,
      capacity: steps(10n ** 12n),
      breach: false,
      buyBackPending: steps(0n),
      reasons: [`permissive keeper ignored: ${k.stale.join(", ")}`],
    }),
    plan: (input) => {
      const real: RequotePlan = planRequote(input);
      const index = refPrice(input.market.tick, input.index.toFixed());
      return {
        ...real,
        accounts: real.accounts.map((a) => {
          const desired =
            a.desired.length > 0
              ? a.desired
              : [
                  {
                    level: 1 as const,
                    px: refPlusBpsCeil(index, 38n),
                    qty:
                      fingerprintSize(steps(7_700n), fingerprintCode(a.accountId, 1)) ??
                      steps(7_701n),
                  },
                ];
          const creates = desired.map((d) =>
            limitOrder({
              clientOrderId: clientOrderId({
                policyHash: input.policyHash,
                accountId: a.accountId,
                level: d.level,
                seq: input.seq,
              }),
              symbol: input.market.symbol,
              side: "sell",
              size: input.market.step.fromUnits(d.qty).toFixed(),
              price: input.market.tick.fromUnits(d.px).toFixed(),
              postOnly: true,
            }),
          );
          const cancels = (input.accounts.find((x) => x.id === a.accountId)?.resting ?? [])
            .filter((r) => r.orderId !== null && r.status === "open")
            .map((r) => r.orderId as bigint);
          return {
            ...a,
            desired,
            diff: {
              kind: "replace-batch" as const,
              cancels,
              creates,
              body: replaceBatch(input.market.symbol, { cancels, creates }),
              keep: [],
            },
          };
        }),
      };
    },
  };
}
