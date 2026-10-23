/**
 * Test harness: a real keeper (createDaemon + LiveMarketState + SignedClient + UserStream)
 * against @ballast/fake-strike, with synthetic Proofs of Cover. No network beyond 127.0.0.1, no
 * real keys, no real Strike. Every key here is derived from a label and guards nothing.
 */
import { createHash, randomBytes } from "node:crypto";
import { defaultQuotePolicy, type QuotePolicy } from "@ballast/core";
import {
  bech32Encode,
  buildCoverProof,
  type CoverProof,
  computeCover,
  type KoiosUtxo,
  NIGHT,
} from "@ballast/cover";
import { REFERENCE_MARKETS } from "@ballast/engine";
import { type EvidenceDb, openEvidenceDb } from "@ballast/evidence/db";
import { FakeStrike, type FakeStrikeOptions } from "@ballast/fake-strike";
import {
  type CriticReport,
  DaemonKey,
  OperatorKey,
  runCriticGate,
  type SignedPolicy,
  signPolicy,
} from "@ballast/governance";
import type { Alert, Notifier } from "@ballast/ops";
import { createSimCriticRunner } from "@ballast/sim";
import {
  ApiWalletSigner,
  apiTimeSource,
  createPublicHttp,
  createPublicReads,
  RateLimiter,
  ServerClock,
  SignedClient,
  UserStream,
} from "@ballast/strike-client";
import type { AccountConfig, AccountPorts } from "../src/account.js";
import type { CoverSource, CoverState } from "../src/cover-watch.js";
import {
  type AdvisorPort,
  createDaemon,
  type DaemonLogger,
  type EnginePorts,
  type KeeperDaemon,
  type KeeperRuntimeConfig,
  type WouldPlaceEntry,
} from "../src/daemon.js";
import { LiveMarketState } from "../src/market-state.js";

export const SYMBOL = "NIGHT-USD";
export const UA = "ballast-keeper-test/0.1";

export function seed(label: string): Buffer {
  return createHash("sha256").update(`ballast-keeper-test:${label}`).digest();
}

export const operator = OperatorKey.fromSeed(seed("operator"));
export const daemonKey = DaemonKey.fromSeed(seed("daemon"));

export function silentLogger(
  lines?: { level: string; msg?: string; obj: unknown }[],
): DaemonLogger {
  const at =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      lines?.push({ level, obj, ...(msg !== undefined ? { msg } : {}) });
    };
  const self: DaemonLogger = {
    child: () => self,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
  return self;
}

export function captureNotifier(): Notifier & { alerts: Alert[] } {
  const alerts: Alert[] = [];
  return {
    alerts,
    async notify(a) {
      alerts.push(a);
    },
  };
}

// ---- synthetic cover ------------------------------------------------------------------------

const h28 = (label: string) =>
  createHash("sha256").update(`cover:${label}`).digest("hex").slice(0, 56);
const h32 = (label: string) => createHash("sha256").update(`tx:${label}`).digest("hex");

export function stakeAddressFor(label: string): string {
  return bech32Encode(
    "stake",
    Uint8Array.from([0xe1, ...Buffer.from(h28(`stake:${label}`), "hex")]),
  );
}

function baseAddressFor(label: string): string {
  return bech32Encode(
    "addr",
    Uint8Array.from([
      0x01,
      ...Buffer.from(h28(`pay:${label}`), "hex"),
      ...Buffer.from(h28(`stake:${label}`), "hex"),
    ]),
  );
}

/** A synthetic Proof of Cover: `nightWhole` NIGHT on one key-hash UTxO at `height`. */
export function coverProof(
  label: string,
  nightWhole: bigint,
  height: number,
  nowMs: number,
): CoverProof {
  const stakeAddress = stakeAddressFor(label);
  const utxos: KoiosUtxo[] =
    nightWhole > 0n
      ? [
          {
            tx_hash: h32(`${label}:${nightWhole}`),
            tx_index: 0,
            address: baseAddressFor(label),
            value: "2000000",
            stake_address: stakeAddress,
            payment_cred: null,
            block_height: Math.max(1, height - 1),
            block_time: Math.floor(nowMs / 1000) - 20,
            asset_list: [
              {
                policy_id: NIGHT.policyId,
                asset_name: NIGHT.assetNameHex,
                quantity: (nightWhole * 1_000_000n).toString(),
              },
            ],
            is_spent: false,
          },
        ]
      : [];
  const comp = computeCover({ kind: "stake", stakeAddress }, utxos, height);
  return buildCoverProof(
    comp,
    {
      hash: h32(`tip:${height}`),
      epoch_no: 600,
      abs_slot: height * 20,
      block_height: height,
      block_time: Math.floor(nowMs / 1000),
    },
    nowMs,
  );
}

/** Cover the test moves by hand; each change is a new block's proof, recorded as evidence. */
export class TestCover implements CoverSource {
  private readonly states = new Map<string, CoverState>();
  private height = 12_000_000;
  onProof: ((accountId: string, proof: CoverProof) => void) | null = null;
  constructor(private readonly now: () => number) {}

  set(accountId: string, label: string, nightWhole: bigint): CoverProof {
    this.height += 1;
    const proof = coverProof(label, nightWhole, this.height, this.now());
    this.states.set(accountId, {
      proof,
      coverBase: BigInt(proof.coverBase),
      height: proof.height,
      checkedAtMs: proof.checkedAtMs,
      mempoolSpend: null,
    });
    this.onProof?.(accountId, proof);
    return proof;
  }

  /** Re-prove the same cover at a new block (keeps it fresh). */
  refresh(accountId: string, label: string): void {
    const st = this.states.get(accountId);
    if (st) this.set(accountId, label, st.coverBase / 1_000_000n);
  }

  view(accountId: string): CoverState | null {
    return this.states.get(accountId) ?? null;
  }
}

// ---- policies -------------------------------------------------------------------------------

export function policyAt(
  validFromMs: number,
  over: Partial<QuotePolicy> = {},
): SignedPolicy<QuotePolicy> {
  const p = {
    ...defaultQuotePolicy({ policyId: "01JKEEPERE2E0000000000000A", validFromMs }),
    ...over,
  };
  return signPolicy(p, operator);
}

/** A real Critic PASS: the deterministic simulator over one stress scenario. */
export async function passReport(
  signed: SignedPolicy<QuotePolicy>,
  nowMs = Date.now(),
): Promise<CriticReport> {
  return runCriticGate({
    runner: createSimCriticRunner({
      segments: null,
      scenarios: ["index-stall"],
      simGitSha: "8cb2631",
    }),
    signed,
    daemonKey,
    now: () => nowMs,
    timeoutMs: 60_000,
  });
}

// ---- the harness ----------------------------------------------------------------------------

export interface HarnessAccount {
  id: string;
  label: string;
  signer: ApiWalletSigner;
  client: SignedClient;
  stream: UserStream;
  cfg: AccountConfig;
}

export interface KeeperHarness {
  fake: FakeStrike;
  db: EvidenceDb;
  market: LiveMarketState;
  cover: TestCover;
  daemon: KeeperDaemon;
  accounts: HarnessAccount[];
  notifier: Notifier & { alerts: Alert[] };
  wouldPlace: WouldPlaceEntry[];
  logs: { level: string; msg?: string; obj: unknown }[];
  rate: RateLimiter;
  clock: ServerClock;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  dryRun?: boolean;
  armed?: boolean;
  fake?: FakeStrikeOptions;
  accounts?: {
    label: string;
    holder0?: boolean;
    rBps?: bigint;
    cover?: bigint;
    approvedBuilderBps?: number;
  }[];
  engine?: Partial<EnginePorts>;
  advisor?: AdvisorPort;
  config?: Partial<KeeperRuntimeConfig>;
  /** House book: scripted outside liquidity. */
  house?: boolean;
  dbPath?: string;
}

export function seedHouseBook(fake: FakeStrike): void {
  for (const [px, q] of [
    ["0.0383", "400000"],
    ["0.03825", "200000"],
  ] as const) {
    fake.engine.restMarketOrder(SYMBOL, "buy", px, q);
  }
  for (const [px, q] of [
    ["0.03875", "30000"],
    ["0.0388", "100000"],
    ["0.039", "400000"],
  ] as const) {
    fake.engine.restMarketOrder(SYMBOL, "sell", px, q);
  }
}

export async function startKeeper(opts: HarnessOptions = {}): Promise<KeeperHarness> {
  const fake = new FakeStrike({ priceIntervalMs: 50, ...opts.fake });
  await fake.start();
  fake.market.marketsPayload = { ...REFERENCE_MARKETS };
  fake.market.setPrice(SYMBOL, { mark: "0.03835", index: "0.0383" });
  fake.market.setPrice("ADA-USD", { mark: "0.21277", index: "0.21244905" });
  if (opts.house !== false) seedHouseBook(fake);

  const http = createPublicHttp({ baseUrl: fake.baseUrl, userAgent: UA, maxRetries: 0 });
  const clock = new ServerClock({ fetchServerTimeMs: apiTimeSource(http), samples: 2 });
  await clock.sync();
  const rate = new RateLimiter();
  const db = openEvidenceDb(opts.dbPath ?? ":memory:");
  const notifier = captureNotifier();
  const logs: KeeperHarness["logs"] = [];
  const logger = silentLogger(logs);
  const wouldPlace: WouldPlaceEntry[] = [];
  const cover = new TestCover(() => Date.now());
  let daemon: KeeperDaemon | null = null;

  const market = new LiveMarketState({
    wsOrigin: fake.wsOrigin,
    userAgent: UA,
    symbols: [SYMBOL, "ADA-USD"],
    reads: createPublicReads(http),
    logger,
    marketsEveryMs: 1_000,
    positionsEveryMs: 1_000,
    rebuildCooldownMs: 0,
    onChange: () => daemon?.requestTick("market"),
  });

  const specs = opts.accounts ?? [{ label: "holder-a", cover: 200_000n }];
  const accounts: HarnessAccount[] = specs.map((s) => {
    const signer = ApiWalletSigner.fromSeed(randomBytes(32));
    const id = `acct-${s.label}`;
    fake.addAccount({
      publicKeyHex: signer.publicKeyHex,
      accountId: id,
      approvedBuilderFeeBps: 10,
    });
    const cfg: AccountConfig = {
      accountId: id,
      stakeAddress: stakeAddressFor(s.label),
      holder0: s.holder0 ?? false,
      rBps: s.rBps ?? 5_000n,
      maxShortMicroUsd: null,
      approvedBuilderBps: s.approvedBuilderBps ?? 10,
    };
    const client = new SignedClient({
      baseUrl: fake.baseUrl,
      userAgent: UA,
      signer,
      clock,
      profile: "AUTONOMOUS",
      rate,
      account: id,
      builderFee: { capBps: cfg.approvedBuilderBps },
      sleep: async () => {},
      maxGetRetries: 0,
    });
    const stream = new UserStream({
      url: fake.wsUrl,
      userAgent: UA,
      signer,
      clock,
      expectedAccountId: id,
      maxBackoffMs: 200,
      onEvent: (ev) => daemon?.onUserEvent(id, ev),
      onResyncNeeded: () => daemon?.onUserResync(id),
    });
    db.bindAccount({ accountId: id, stakeCred: cfg.stakeAddress, nowMs: Date.now() });
    db.setAccountStatus(id, "active", null, Date.now());
    return { id, label: s.label, signer, client, stream, cfg };
  });

  const ports: AccountPorts[] = accounts.map((a) => ({
    cfg: a.cfg,
    signer: a.client,
    reads: a.client,
    streamLive: () => a.stream.live,
  }));
  const dryRun = opts.dryRun ?? false;
  daemon = createDaemon({
    config: {
      mode: dryRun ? "dry-run" : "armed",
      dryRun,
      armed: opts.armed ?? !dryRun,
      mainnet: true,
      quoteSymbol: SYMBOL,
      allowlist: [SYMBOL],
      trustedOperators: [operator.publicKeyHex],
      trustedDaemons: [daemonKey.publicKeyHex],
      replicaP99Bps: "0.77",
      minTickMs: 40,
      maxIdleMs: 100,
      marginEveryMs: 200,
      vaultEveryMs: 300,
      reconcilerLagMs: 30,
      killRetryMs: 1_500,
      killEscalateMs: 3_000,
      ...opts.config,
    },
    db,
    daemonKey,
    market,
    cover,
    accounts: ports,
    rate,
    notifier,
    logger,
    clock: { now: () => Date.now() },
    vaultCheck: async (accountId) => {
      const r = await http.getJson<{ positions: unknown[] | null }>("/v2/vault/positions", {
        account_id: accountId,
      });
      return Array.isArray(r.positions) && r.positions.length > 0;
    },
    wouldPlace: (e) => wouldPlace.push(e),
    ...(opts.engine ? { engine: opts.engine } : {}),
    ...(opts.advisor ? { advisor: opts.advisor } : {}),
    pid: 4242,
  });
  const d = daemon;
  cover.onProof = (id, proof) => d.onCoverProof(id, proof);
  for (const [i, a] of accounts.entries()) cover.set(a.id, a.label, specs[i]?.cover ?? 200_000n);
  // Keep cover fresh as blocks would.
  const coverTimer = setInterval(() => {
    for (const a of accounts) cover.refresh(a.id, a.label);
  }, 5_000);
  coverTimer.unref();

  market.start();
  for (const a of accounts) a.stream.start();

  return {
    fake,
    db,
    market,
    cover,
    daemon,
    accounts,
    notifier,
    wouldPlace,
    logs,
    rate,
    clock,
    async stop() {
      clearInterval(coverTimer);
      await d.stop({ cancel: false });
      for (const a of accounts) a.stream.stop();
      market.stop();
      await fake.stop();
      db.close();
    },
  };
}

/** Activate a policy valid from a minute ago, with a real simulator PASS. */
export async function activate(h: KeeperHarness): Promise<SignedPolicy<QuotePolicy>> {
  const signed = policyAt(Date.now() - 60_000);
  const report = await passReport(signed);
  const r = h.daemon.activatePolicy(signed, report);
  if (!r.ok) throw new Error(`activation failed: ${JSON.stringify(r.checks)}`);
  return signed;
}

/** Ballast's resting asks on the fake engine for one account. */
export function restingAsks(h: KeeperHarness, accountId: string) {
  return h.fake.engine.workingOrders(accountId, SYMBOL).filter((o) => o.side === "sell");
}
