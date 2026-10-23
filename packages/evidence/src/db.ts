/**
 * Evidence store (better-sqlite3), ported from Ripcord's state/db.ts with Ballast's tables. It is
 * the source of truth for accounting and for the public evidence bundle.
 *
 * SAFETY INVARIANTS ENFORCED BY THE SCHEMA ITSELF (not just by callers)
 * - Decisions are append-only and hash-linked: a row whose seq or prevHash does not extend the
 *   chain is refused, and UPDATE/DELETE are refused outright.
 * - A policy can be 'active' only with a stored Critic PASS for exactly its hash, and an order can
 *   be inserted only under an active policy and a recorded decision (invariant 2, defense in depth).
 * - One stake credential ↔ one account: UNIQUE(stake_cred) and UNIQUE(account_id) (invariant 16).
 *   A manual-activity flag forces the account out of 'active'.
 * - Every buy is reduce-only; every order is a `bal_` order (invariants 6 and Proof of Conduct).
 * - Unknown counts as resting (invariant 14): exposure sums pending, resting, partially filled and
 *   unknown orders; a crash-stranded 'pending' create becomes 'unknown', never 'gone'.
 * - A kill is 'confirmed' only with both stream and L3 confirmation times (invariant 11).
 * - Integer units are decimal strings checked digit by digit; CHECK constraints reject any status,
 *   side or kind outside the contract. Tables are STRICT.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalize } from "@ballast/core";
import type { CoverProof } from "@ballast/cover";
import type {
  CriticReport,
  DecisionRecord,
  DecisionSink,
  GuardTripFact,
  SignedPolicy,
  SignedPolicyRenewal,
  SignedRenewalEnvelope,
} from "@ballast/governance";
import Database from "better-sqlite3";

const hex64 = (c: string) => `(length(${c}) = 64 AND ${c} NOT GLOB '*[^0-9a-f]*')`;
const digits = (c: string) => `(length(${c}) > 0 AND ${c} NOT GLOB '*[^0-9]*')`;
const sdigits = (c: string) =>
  `(${digits(c)} OR (${c} GLOB '-?*' AND substr(${c}, 2) NOT GLOB '*[^0-9]*'))`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  seq         INTEGER PRIMARY KEY CHECK (seq >= 1),
  hash        TEXT NOT NULL UNIQUE CHECK ${hex64("hash")},
  prev_hash   TEXT CHECK (prev_hash IS NULL OR ${hex64("prev_hash")}),
  ts_ms       INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('policy','critic','advisor','requote','keeper','kill',
                                            'cover','fill','anchor','consent')),
  policy_hash TEXT,
  account_id  TEXT,
  record_json TEXT NOT NULL,
  CHECK ((seq = 1) = (prev_hash IS NULL))
) STRICT;
CREATE TRIGGER IF NOT EXISTS decisions_extend_chain BEFORE INSERT ON decisions
WHEN NEW.seq <> COALESCE((SELECT MAX(seq) FROM decisions), 0) + 1
  OR NEW.prev_hash IS NOT (SELECT hash FROM decisions WHERE seq = NEW.seq - 1)
BEGIN SELECT RAISE(ABORT, 'decision chain break'); END;
CREATE TRIGGER IF NOT EXISTS decisions_no_update BEFORE UPDATE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS decisions_no_delete BEFORE DELETE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;

CREATE TABLE IF NOT EXISTS critic_reports (
  hash          TEXT PRIMARY KEY CHECK ${hex64("hash")},
  policy_hash   TEXT NOT NULL CHECK ${hex64("policy_hash")},
  verdict       TEXT NOT NULL CHECK (verdict IN ('PASS','FAIL')),
  created_ms    INTEGER NOT NULL,
  daemon_pubkey TEXT NOT NULL CHECK ${hex64("daemon_pubkey")},
  report_json   TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS policies (
  hash               TEXT PRIMARY KEY CHECK ${hex64("hash")},
  policy_id          TEXT NOT NULL,
  prev_hash          TEXT CHECK (prev_hash IS NULL OR ${hex64("prev_hash")}),
  operator_pubkey    TEXT NOT NULL CHECK ${hex64("operator_pubkey")},
  valid_from_ms      INTEGER NOT NULL,
  valid_until_ms     INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('candidate','active','rejected','superseded','expired')),
  critic_report_hash TEXT REFERENCES critic_reports(hash),
  signed_json        TEXT NOT NULL,
  created_at_ms      INTEGER NOT NULL,
  CHECK (valid_until_ms > valid_from_ms AND valid_until_ms - valid_from_ms <= 86400000),
  CHECK (status NOT IN ('active','superseded','expired') OR critic_report_hash IS NOT NULL)
) STRICT;
CREATE TRIGGER IF NOT EXISTS policies_active_needs_pass_ins BEFORE INSERT ON policies
WHEN NEW.status = 'active' AND NOT EXISTS (SELECT 1 FROM critic_reports
  WHERE hash = NEW.critic_report_hash AND policy_hash = NEW.hash AND verdict = 'PASS')
BEGIN SELECT RAISE(ABORT, 'activation requires a Critic PASS for this policy'); END;
CREATE TRIGGER IF NOT EXISTS policies_active_needs_pass_upd BEFORE UPDATE OF status, critic_report_hash ON policies
WHEN NEW.status = 'active' AND NOT EXISTS (SELECT 1 FROM critic_reports
  WHERE hash = NEW.critic_report_hash AND policy_hash = NEW.hash AND verdict = 'PASS')
BEGIN SELECT RAISE(ABORT, 'activation requires a Critic PASS for this policy'); END;

CREATE TABLE IF NOT EXISTS renewal_envelopes (
  hash             TEXT PRIMARY KEY CHECK ${hex64("hash")},
  base_policy_hash TEXT NOT NULL REFERENCES policies(hash),
  max_renewals     INTEGER NOT NULL CHECK (max_renewals BETWEEN 1 AND 7),
  envelope_json    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS renewals (
  hash               TEXT PRIMARY KEY CHECK ${hex64("hash")},
  base_policy_hash   TEXT NOT NULL REFERENCES policies(hash),
  envelope_hash      TEXT NOT NULL REFERENCES renewal_envelopes(hash),
  idx                INTEGER NOT NULL CHECK (idx BETWEEN 1 AND 7),
  valid_from_ms      INTEGER NOT NULL,
  valid_until_ms     INTEGER NOT NULL,
  critic_report_hash TEXT NOT NULL REFERENCES critic_reports(hash),
  renewal_json       TEXT NOT NULL,
  UNIQUE (envelope_hash, idx),
  CHECK (valid_until_ms > valid_from_ms AND valid_until_ms - valid_from_ms <= 86400000)
) STRICT;
CREATE TRIGGER IF NOT EXISTS renewals_need_pass BEFORE INSERT ON renewals
WHEN NOT EXISTS (SELECT 1 FROM critic_reports
  WHERE hash = NEW.critic_report_hash AND policy_hash = NEW.base_policy_hash AND verdict = 'PASS')
BEGIN SELECT RAISE(ABORT, 'a renewal requires a Critic PASS for its policy'); END;

CREATE TABLE IF NOT EXISTS accounts (
  id              INTEGER PRIMARY KEY,
  account_id      TEXT NOT NULL UNIQUE CHECK (length(account_id) BETWEEN 1 AND 128),
  stake_cred      TEXT NOT NULL UNIQUE CHECK (stake_cred GLOB 'stake1?*' OR stake_cred GLOB 'stake_test1?*'),
  label           TEXT,
  r_bps           INTEGER NOT NULL DEFAULT 5000 CHECK (r_bps BETWEEN 0 AND 9000),
  status          TEXT NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding','active','paused','closed')),
  manual_activity INTEGER NOT NULL DEFAULT 0 CHECK (manual_activity IN (0,1)),
  paused_reason   TEXT,
  created_at_ms   INTEGER NOT NULL,
  updated_at_ms   INTEGER NOT NULL,
  CHECK (manual_activity = 0 OR status IN ('paused','closed'))
) STRICT;

CREATE TABLE IF NOT EXISTS orders (
  client_order_id TEXT PRIMARY KEY CHECK (client_order_id GLOB 'bal_?*' AND length(client_order_id) <= 256),
  account_id      TEXT NOT NULL REFERENCES accounts(account_id),
  decision_seq    INTEGER NOT NULL REFERENCES decisions(seq),
  policy_hash     TEXT NOT NULL REFERENCES policies(hash),
  symbol          TEXT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('buy','sell')),
  reduce_only     INTEGER NOT NULL CHECK (reduce_only IN (0,1)),
  price_ticks     TEXT NOT NULL CHECK ${digits("price_ticks")},
  size_steps      TEXT NOT NULL CHECK (${digits("size_steps")} AND size_steps <> '0'),
  filled_steps    TEXT NOT NULL DEFAULT '0' CHECK ${digits("filled_steps")},
  order_id        TEXT CHECK (order_id IS NULL OR ${digits("order_id")}),
  status          TEXT NOT NULL CHECK (status IN ('pending','resting','partially_filled','filled',
                                                  'canceled','rejected','dropped','unknown')),
  created_at_ms   INTEGER NOT NULL,
  updated_at_ms   INTEGER NOT NULL,
  CHECK (side = 'sell' OR reduce_only = 1)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_orders_account ON orders (account_id, symbol, status);
CREATE TRIGGER IF NOT EXISTS orders_need_active_policy BEFORE INSERT ON orders
WHEN NOT EXISTS (SELECT 1 FROM policies WHERE hash = NEW.policy_hash AND status = 'active')
BEGIN SELECT RAISE(ABORT, 'orders require an active policy'); END;
CREATE TRIGGER IF NOT EXISTS orders_terminal BEFORE UPDATE OF status ON orders
WHEN OLD.status IN ('filled','canceled','rejected') AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'a terminal order status cannot change'); END;

CREATE TABLE IF NOT EXISTS fills (
  trade_id              TEXT PRIMARY KEY,
  client_order_id       TEXT NOT NULL REFERENCES orders(client_order_id),
  account_id            TEXT NOT NULL REFERENCES accounts(account_id),
  side                  TEXT NOT NULL CHECK (side IN ('buy','sell')),
  role                  TEXT NOT NULL CHECK (role IN ('maker','taker')),
  price_ticks           TEXT NOT NULL CHECK ${digits("price_ticks")},
  size_steps            TEXT NOT NULL CHECK ${digits("size_steps")},
  fee_micro_usd         TEXT NOT NULL CHECK ${sdigits("fee_micro_usd")},
  builder_fee_micro_usd TEXT CHECK (builder_fee_micro_usd IS NULL OR ${sdigits("builder_fee_micro_usd")}),
  ts_ms                 INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS cover_checks (
  id            INTEGER PRIMARY KEY,
  subject       TEXT NOT NULL,
  account_id    TEXT REFERENCES accounts(account_id),
  block_height  INTEGER NOT NULL CHECK (block_height > 0),
  block_hash    TEXT NOT NULL CHECK ${hex64("block_hash")},
  cover_base    TEXT NOT NULL CHECK ${digits("cover_base")},
  utxo_count    INTEGER NOT NULL CHECK (utxo_count >= 0),
  proof_hash    TEXT NOT NULL UNIQUE CHECK ${hex64("proof_hash")},
  proof_json    TEXT NOT NULL,
  checked_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_cover_subject ON cover_checks (subject, block_height DESC);

CREATE TABLE IF NOT EXISTS guard_trips (
  id           INTEGER PRIMARY KEY,
  ts_ms        INTEGER NOT NULL,
  account_id   TEXT,
  rule_id      TEXT NOT NULL CHECK (length(rule_id) > 0 AND rule_id NOT GLOB '*[^a-z0-9-]*'),
  safety_class INTEGER NOT NULL CHECK (safety_class IN (0,1)),
  decision_seq INTEGER REFERENCES decisions(seq),
  detail       TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS kills (
  id                  INTEGER PRIMARY KEY,
  account_id          TEXT NOT NULL,
  symbol              TEXT NOT NULL,
  trigger             TEXT NOT NULL CHECK (trigger IN ('guard','cover','stale-data','watchdog',
                                                       'holder','operator','loss-stop','margin')),
  sent_at_ms          INTEGER NOT NULL,
  stream_confirmed_ms INTEGER,
  l3_confirmed_ms     INTEGER,
  status              TEXT NOT NULL CHECK (status IN ('sent','confirmed','retried','escalated','failed')),
  decision_seq        INTEGER REFERENCES decisions(seq),
  CHECK (status <> 'confirmed' OR (stream_confirmed_ms IS NOT NULL AND l3_confirmed_ms IS NOT NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS anchors (
  id             INTEGER PRIMARY KEY,
  root           TEXT NOT NULL UNIQUE CHECK ${hex64("root")},
  decisions_root TEXT NOT NULL CHECK ${hex64("decisions_root")},
  segments_root  TEXT NOT NULL CHECK ${hex64("segments_root")},
  first_seq      INTEGER NOT NULL CHECK (first_seq >= 1),
  last_seq       INTEGER NOT NULL,
  segment_count  INTEGER NOT NULL CHECK (segment_count >= 0),
  network        TEXT NOT NULL CHECK (network IN ('mainnet','preprod','preview')),
  tx_hash        TEXT UNIQUE CHECK (tx_hash IS NULL OR ${hex64("tx_hash")}),
  status         TEXT NOT NULL CHECK (status IN ('built','submitted','confirmed','failed')),
  record_json    TEXT NOT NULL,
  created_at_ms  INTEGER NOT NULL,
  CHECK (last_seq >= first_seq),
  CHECK (status IN ('built','failed') OR tx_hash IS NOT NULL)
) STRICT;

CREATE TABLE IF NOT EXISTS probes (
  id                    INTEGER PRIMARY KEY,
  trade_id              TEXT NOT NULL UNIQUE,
  probe_account         TEXT NOT NULL,
  maker_client_order_id TEXT,
  notional_micro_usd    TEXT NOT NULL CHECK ${digits("notional_micro_usd")},
  ts_ms                 INTEGER NOT NULL,
  note                  TEXT
) STRICT;

-- Holder onboarding (M5). Private rows: none of them is part of the public bundle, because they
-- carry wallet addresses. A consent's hash is what the keeper later chains as a 'consent' decision.
CREATE TABLE IF NOT EXISTS holder_attestations (
  id             INTEGER PRIMARY KEY,
  stake_cred     TEXT NOT NULL CHECK (stake_cred GLOB 'stake1?*' OR stake_cred GLOB 'stake_test1?*'),
  address        TEXT NOT NULL CHECK (address GLOB 'addr1?*' OR address GLOB 'addr_test1?*'),
  kind           TEXT NOT NULL CHECK (kind IN ('geofence')),
  statement_hash TEXT NOT NULL CHECK ${hex64("statement_hash")},
  list_url       TEXT NOT NULL CHECK (list_url GLOB 'https://*'),
  attested_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS holder_wallets (
  public_key    TEXT PRIMARY KEY CHECK ${hex64("public_key")},
  account_id    TEXT NOT NULL REFERENCES accounts(account_id),
  address       TEXT NOT NULL CHECK (address GLOB 'addr1?*' OR address GLOB 'addr_test1?*'),
  key_path      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  CHECK ((status = 'revoked') = (revoked_at_ms IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS holder_wallets_one_active ON holder_wallets (account_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS holder_consents (
  hash           TEXT PRIMARY KEY CHECK ${hex64("hash")},
  account_id     TEXT NOT NULL REFERENCES accounts(account_id),
  stake_cred     TEXT NOT NULL,
  r_bps          INTEGER NOT NULL CHECK (r_bps BETWEEN 0 AND 9000),
  max_short_base TEXT NOT NULL CHECK ${digits("max_short_base")},
  fee_share_bps  INTEGER NOT NULL CHECK (fee_share_bps BETWEEN 0 AND 100),
  signature_hash TEXT NOT NULL CHECK ${hex64("signature_hash")},
  signed_at_ms   INTEGER NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS holder_consents_bound BEFORE INSERT ON holder_consents
WHEN NOT EXISTS (SELECT 1 FROM accounts WHERE account_id = NEW.account_id AND stake_cred = NEW.stake_cred)
BEGIN SELECT RAISE(ABORT, 'a consent must come from the stake credential bound to the account'); END;

CREATE TABLE IF NOT EXISTS funding_events (
  id            INTEGER PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(account_id),
  kind          TEXT NOT NULL CHECK (kind IN ('deposit','withdrawal')),
  request_id    TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  asset         TEXT NOT NULL CHECK (asset IN ('ADA','USDM')),
  amount_base   TEXT CHECK (amount_base IS NULL OR ${digits("amount_base")}),
  usd_value     TEXT,
  tx_hash       TEXT CHECK (tx_hash IS NULL OR ${hex64("tx_hash")}),
  status        TEXT NOT NULL CHECK (status IN ('quoted','built','submitted','confirmed','failed')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (kind, request_id)
) STRICT;

-- Single-instance advisory lock (Ripcord: four daemons once ran on one database).
CREATE TABLE IF NOT EXISTS daemon_lock (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  pid            INTEGER NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  heartbeat_ms   INTEGER NOT NULL
) STRICT;
`;

export type PolicyStatus = "candidate" | "active" | "rejected" | "superseded" | "expired";
export type OrderStatus =
  | "pending"
  | "resting"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "dropped"
  | "unknown";

/** Statuses that may still sell: everything not proven gone (invariant 14). */
export const EXPOSED_STATUSES: readonly OrderStatus[] = [
  "pending",
  "resting",
  "partially_filled",
  "unknown",
];

export interface AccountRow {
  accountId: string;
  stakeCred: string;
  label: string | null;
  rBps: number;
  status: "onboarding" | "active" | "paused" | "closed";
  manualActivity: boolean;
  pausedReason: string | null;
}

export interface OrderRow {
  clientOrderId: string;
  accountId: string;
  decisionSeq: number;
  policyHash: string;
  symbol: string;
  side: "buy" | "sell";
  reduceOnly: boolean;
  priceTicks: string;
  sizeSteps: string;
  filledSteps?: string;
  orderId?: string | null;
  status: OrderStatus;
  createdAtMs: number;
}

export interface FillRow {
  tradeId: string;
  clientOrderId: string;
  accountId: string;
  side: "buy" | "sell";
  role: "maker" | "taker";
  priceTicks: string;
  sizeSteps: string;
  feeMicroUsd: string;
  builderFeeMicroUsd?: string | null;
  tsMs: number;
}

export interface Exposure {
  /** Sell-side steps that may still execute, counting unknown and pending as resting. */
  askSteps: bigint;
  byStatus: Partial<Record<OrderStatus, bigint>>;
}

export interface AnchorRecord {
  v: 1;
  root: string;
  decisionsRoot: string;
  segmentsRoot: string;
  firstSeq: number;
  lastSeq: number;
  segments: { segment: string; sha256: string }[];
  network: "mainnet" | "preprod" | "preview";
  txHash: string | null;
  createdMs: number;
}

export interface GuardTripRow extends GuardTripFact {
  safetyClass: boolean;
  decisionSeq?: number;
  detail: string;
}

export type KillTrigger =
  | "guard"
  | "cover"
  | "stale-data"
  | "watchdog"
  | "holder"
  | "operator"
  | "loss-stop"
  | "margin";

export interface LockAcquisition {
  acquired: boolean;
  holderPid?: number;
  heartbeatAgeMs?: number;
  tookOverStalePid?: number;
}

export interface HolderAttestationRow {
  stakeCred: string;
  address: string;
  kind: "geofence";
  statementHash: string;
  listUrl: string;
  attestedAtMs: number;
}

export interface HolderWalletRow {
  publicKey: string;
  accountId: string;
  address: string;
  /** Where the sealed key file lives (never the key). */
  keyPath: string;
  status: "active" | "revoked";
  createdAtMs: number;
  revokedAtMs: number | null;
}

export interface HolderConsentRow {
  /** sha256 of the consent message's UTF-8 bytes. */
  hash: string;
  accountId: string;
  stakeCred: string;
  rBps: number;
  maxShortBase: string;
  feeShareBps: number;
  signatureHash: string;
  signedAtMs: number;
}

export type FundingStatus = "quoted" | "built" | "submitted" | "confirmed" | "failed";

export interface FundingEventRow {
  accountId: string;
  kind: "deposit" | "withdrawal";
  requestId: string;
  asset: "ADA" | "USDM";
  amountBase: string | null;
  usdValue: string | null;
  txHash: string | null;
  status: FundingStatus;
  createdAtMs: number;
  updatedAtMs: number;
}

export class AccountBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountBindingError";
  }
}

const toParam = (v: unknown): unknown => (v === undefined ? null : v);

/** Opens (and migrates) the evidence DB. `:memory:` is supported for tests. */
export function openEvidenceDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
  } catch {
    // :memory: cannot use WAL; journal mode is best-effort.
  }
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = FULL");
  db.exec(SCHEMA);

  const st = {
    insertDecision: db.prepare(
      `INSERT INTO decisions (seq, hash, prev_hash, ts_ms, kind, policy_hash, account_id, record_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    head: db.prepare("SELECT seq, hash FROM decisions ORDER BY seq DESC LIMIT 1"),
    decisions: db.prepare(
      "SELECT record_json FROM decisions WHERE seq BETWEEN ? AND ? ORDER BY seq",
    ),
    insertReport: db.prepare(
      `INSERT OR IGNORE INTO critic_reports (hash, policy_hash, verdict, created_ms, daemon_pubkey, report_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    reports: db.prepare("SELECT report_json FROM critic_reports ORDER BY created_ms, hash"),
    insertPolicy: db.prepare(
      `INSERT INTO policies (hash, policy_id, prev_hash, operator_pubkey, valid_from_ms, valid_until_ms,
         status, critic_report_hash, signed_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    setPolicyStatus: db.prepare(
      "UPDATE policies SET status = ?, critic_report_hash = COALESCE(?, critic_report_hash) WHERE hash = ?",
    ),
    policies: db.prepare(
      "SELECT signed_json, status, critic_report_hash FROM policies ORDER BY created_at_ms, valid_from_ms, hash",
    ),
    insertEnvelope: db.prepare(
      "INSERT OR IGNORE INTO renewal_envelopes (hash, base_policy_hash, max_renewals, envelope_json) VALUES (?, ?, ?, ?)",
    ),
    envelopes: db.prepare("SELECT envelope_json FROM renewal_envelopes ORDER BY rowid"),
    insertRenewal: db.prepare(
      `INSERT INTO renewals (hash, base_policy_hash, envelope_hash, idx, valid_from_ms, valid_until_ms,
         critic_report_hash, renewal_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    renewals: db.prepare("SELECT renewal_json FROM renewals ORDER BY valid_from_ms, idx"),
    insertAccount: db.prepare(
      `INSERT INTO accounts (account_id, stake_cred, label, r_bps, status, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, 'onboarding', ?, ?)`,
    ),
    accountById: db.prepare("SELECT * FROM accounts WHERE account_id = ?"),
    accountByStake: db.prepare("SELECT * FROM accounts WHERE stake_cred = ?"),
    setAccountStatus: db.prepare(
      "UPDATE accounts SET status = ?, paused_reason = ?, updated_at_ms = ? WHERE account_id = ?",
    ),
    flagManual: db.prepare(
      `UPDATE accounts SET status = 'paused', manual_activity = 1, paused_reason = ?, updated_at_ms = ?
       WHERE account_id = ?`,
    ),
    insertOrder: db.prepare(
      `INSERT INTO orders (client_order_id, account_id, decision_seq, policy_hash, symbol, side, reduce_only,
         price_ticks, size_steps, filled_steps, order_id, status, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateOrder: db.prepare(
      `UPDATE orders SET status = COALESCE(?, status), filled_steps = COALESCE(?, filled_steps),
         order_id = COALESCE(?, order_id), updated_at_ms = ? WHERE client_order_id = ?`,
    ),
    exposedOrders: db.prepare(
      `SELECT status, size_steps, filled_steps FROM orders
       WHERE account_id = ? AND symbol = ? AND side = 'sell'
         AND status IN ('pending','resting','partially_filled','unknown')`,
    ),
    orders: db.prepare(
      "SELECT * FROM orders WHERE account_id = ? ORDER BY created_at_ms, client_order_id",
    ),
    orphaned: db.prepare(
      "UPDATE orders SET status = 'unknown', updated_at_ms = ? WHERE status = 'pending'",
    ),
    insertFill: db.prepare(
      `INSERT INTO fills (trade_id, client_order_id, account_id, side, role, price_ticks, size_steps,
         fee_micro_usd, builder_fee_micro_usd, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertCover: db.prepare(
      `INSERT OR IGNORE INTO cover_checks (subject, account_id, block_height, block_hash, cover_base, utxo_count,
         proof_hash, proof_json, checked_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    coverChecks: db.prepare("SELECT proof_json FROM cover_checks ORDER BY block_height, id"),
    latestCover: db.prepare(
      "SELECT proof_json FROM cover_checks WHERE subject = ? ORDER BY block_height DESC, id DESC LIMIT 1",
    ),
    insertTrip: db.prepare(
      `INSERT INTO guard_trips (ts_ms, account_id, rule_id, safety_class, decision_seq, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    trips: db.prepare("SELECT * FROM guard_trips WHERE ts_ms >= ? ORDER BY ts_ms, id"),
    insertKill: db.prepare(
      `INSERT INTO kills (account_id, symbol, trigger, sent_at_ms, status, decision_seq)
       VALUES (?, ?, ?, ?, 'sent', ?)`,
    ),
    confirmKill: db.prepare(
      `UPDATE kills SET stream_confirmed_ms = COALESCE(?, stream_confirmed_ms),
         l3_confirmed_ms = COALESCE(?, l3_confirmed_ms) WHERE id = ?`,
    ),
    setKillStatus: db.prepare("UPDATE kills SET status = ? WHERE id = ?"),
    kill: db.prepare("SELECT * FROM kills WHERE id = ?"),
    insertAnchor: db.prepare(
      `INSERT INTO anchors (root, decisions_root, segments_root, first_seq, last_seq, segment_count, network,
         tx_hash, status, record_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    setAnchorTx: db.prepare(
      "UPDATE anchors SET tx_hash = ?, status = ?, record_json = ? WHERE root = ?",
    ),
    anchors: db.prepare("SELECT record_json FROM anchors ORDER BY first_seq, id"),
    insertProbe: db.prepare(
      `INSERT INTO probes (trade_id, probe_account, maker_client_order_id, notional_micro_usd, ts_ms, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    isProbe: db.prepare("SELECT 1 FROM probes WHERE trade_id = ?"),
    insertAttestation: db.prepare(
      `INSERT INTO holder_attestations (stake_cred, address, kind, statement_hash, list_url, attested_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    attestations: db.prepare(
      "SELECT * FROM holder_attestations WHERE stake_cred = ? ORDER BY attested_at_ms, id",
    ),
    revokeWallets: db.prepare(
      `UPDATE holder_wallets SET status = 'revoked', revoked_at_ms = ?
       WHERE account_id = ? AND status = 'active'`,
    ),
    insertWallet: db.prepare(
      `INSERT INTO holder_wallets (public_key, account_id, address, key_path, status, created_at_ms)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    ),
    activeWallet: db.prepare(
      "SELECT * FROM holder_wallets WHERE account_id = ? AND status = 'active'",
    ),
    insertConsent: db.prepare(
      `INSERT INTO holder_consents (hash, account_id, stake_cred, r_bps, max_short_base, fee_share_bps,
         signature_hash, signed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    setRBps: db.prepare("UPDATE accounts SET r_bps = ?, updated_at_ms = ? WHERE account_id = ?"),
    latestConsent: db.prepare(
      "SELECT * FROM holder_consents WHERE account_id = ? ORDER BY signed_at_ms DESC, rowid DESC LIMIT 1",
    ),
    upsertFunding: db.prepare(
      `INSERT INTO funding_events (account_id, kind, request_id, asset, amount_base, usd_value, tx_hash,
         status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, request_id) DO UPDATE SET status = excluded.status,
         tx_hash = COALESCE(excluded.tx_hash, tx_hash), usd_value = COALESCE(excluded.usd_value, usd_value),
         amount_base = COALESCE(excluded.amount_base, amount_base), updated_at_ms = excluded.updated_at_ms
       WHERE account_id = excluded.account_id`,
    ),
    fundingEvents: db.prepare(
      "SELECT * FROM funding_events WHERE account_id = ? ORDER BY created_at_ms, id",
    ),
    selectLock: db.prepare("SELECT pid, heartbeat_ms FROM daemon_lock WHERE id = 1"),
    insertLock: db.prepare(
      "INSERT INTO daemon_lock (id, pid, acquired_at_ms, heartbeat_ms) VALUES (1, ?, ?, ?)",
    ),
    takeoverLock: db.prepare(
      "UPDATE daemon_lock SET pid = ?, acquired_at_ms = ?, heartbeat_ms = ? WHERE id = 1",
    ),
    refreshLock: db.prepare("UPDATE daemon_lock SET heartbeat_ms = ? WHERE id = 1 AND pid = ?"),
    releaseLock: db.prepare("DELETE FROM daemon_lock WHERE id = 1 AND pid = ?"),
  };

  const acquireLockTxn = db.transaction(
    (pid: number, nowMs: number, staleMs: number): LockAcquisition => {
      const row = st.selectLock.get() as { pid: number; heartbeat_ms: number } | undefined;
      if (row === undefined) {
        st.insertLock.run(pid, nowMs, nowMs);
        return { acquired: true };
      }
      if (row.pid === pid) {
        st.refreshLock.run(nowMs, pid);
        return { acquired: true };
      }
      const heartbeatAgeMs = nowMs - row.heartbeat_ms;
      if (heartbeatAgeMs > staleMs) {
        st.takeoverLock.run(pid, nowMs, nowMs);
        return { acquired: true, tookOverStalePid: row.pid };
      }
      return { acquired: false, holderPid: row.pid, heartbeatAgeMs };
    },
  );

  const rotateWalletTxn = db.transaction((w: Omit<HolderWalletRow, "status" | "revokedAtMs">) => {
    st.revokeWallets.run(w.createdAtMs, w.accountId);
    st.insertWallet.run(w.publicKey, w.accountId, w.address, w.keyPath, w.createdAtMs);
  });

  const recordConsentTxn = db.transaction((c: HolderConsentRow) => {
    st.insertConsent.run(
      c.hash,
      c.accountId,
      c.stakeCred,
      c.rBps,
      c.maxShortBase,
      c.feeShareBps,
      c.signatureHash,
      c.signedAtMs,
    );
    st.setRBps.run(c.rBps, c.signedAtMs, c.accountId);
  });

  const mapAccount = (r: Record<string, unknown> | undefined): AccountRow | null =>
    r
      ? {
          accountId: r.account_id as string,
          stakeCred: r.stake_cred as string,
          label: (r.label as string | null) ?? null,
          rBps: r.r_bps as number,
          status: r.status as AccountRow["status"],
          manualActivity: r.manual_activity === 1,
          pausedReason: (r.paused_reason as string | null) ?? null,
        }
      : null;

  const parseRows = <T>(rows: unknown[], col: string): T[] =>
    rows.map((r) => JSON.parse((r as Record<string, string>)[col] as string) as T);

  const store = {
    raw: db,

    // Decisions: the DB is the DecisionLog's sink, so a failed write never advances the chain.
    appendDecision(r: DecisionRecord): void {
      st.insertDecision.run(
        r.seq,
        r.hash,
        r.prevHash,
        r.tsMs,
        r.kind,
        toParam(r.policyHash),
        toParam(r.accountId),
        canonicalize(r),
      );
    },
    decisionSink(): DecisionSink {
      return { append: (r) => store.appendDecision(r) };
    },
    decisionHead(): { seq: number; hash: string } | null {
      return (st.head.get() as { seq: number; hash: string } | undefined) ?? null;
    },
    decisions(fromSeq = 1, toSeq = Number.MAX_SAFE_INTEGER): DecisionRecord[] {
      return parseRows<DecisionRecord>(st.decisions.all(fromSeq, toSeq), "record_json");
    },

    insertCriticReport(r: CriticReport): void {
      st.insertReport.run(
        r.hash,
        r.policyHash,
        r.verdict,
        r.createdMs,
        r.daemonPubkey,
        canonicalize(r),
      );
    },
    criticReports(): CriticReport[] {
      return parseRows<CriticReport>(st.reports.all(), "report_json");
    },

    insertPolicy(
      sp: SignedPolicy,
      status: PolicyStatus,
      nowMs: number,
      criticReportHash?: string,
    ): void {
      st.insertPolicy.run(
        sp.hash,
        sp.policy.policyId,
        sp.policy.prevPolicyHash,
        sp.operatorPubkey,
        sp.policy.validFromMs,
        sp.policy.validUntilMs,
        status,
        toParam(criticReportHash),
        canonicalize(sp),
        nowMs,
      );
    },
    setPolicyStatus(hash: string, status: PolicyStatus, criticReportHash?: string): void {
      if (st.setPolicyStatus.run(status, toParam(criticReportHash), hash).changes === 0) {
        throw new Error(`no policy ${hash}`);
      }
    },
    policies(): { signed: SignedPolicy; status: PolicyStatus; criticReportHash: string | null }[] {
      return (st.policies.all() as Record<string, string | null>[]).map((r) => ({
        signed: JSON.parse(r.signed_json as string) as SignedPolicy,
        status: r.status as PolicyStatus,
        criticReportHash: r.critic_report_hash ?? null,
      }));
    },

    insertRenewalEnvelope(e: SignedRenewalEnvelope): void {
      st.insertEnvelope.run(
        e.hash,
        e.envelope.basePolicyHash,
        e.envelope.maxRenewals,
        canonicalize(e),
      );
    },
    renewalEnvelopes(): SignedRenewalEnvelope[] {
      return parseRows<SignedRenewalEnvelope>(st.envelopes.all(), "envelope_json");
    },
    insertRenewal(r: SignedPolicyRenewal): void {
      const x = r.renewal;
      st.insertRenewal.run(
        r.hash,
        x.basePolicyHash,
        x.envelopeHash,
        x.index,
        x.validFromMs,
        x.validUntilMs,
        x.criticReportHash,
        canonicalize(r),
      );
    },
    renewals(): SignedPolicyRenewal[] {
      return parseRows<SignedPolicyRenewal>(st.renewals.all(), "renewal_json");
    },

    /** Binds a stake credential to an account; a second binding of either side is refused. */
    bindAccount(a: {
      accountId: string;
      stakeCred: string;
      label?: string;
      rBps?: number;
      nowMs: number;
    }): void {
      try {
        st.insertAccount.run(
          a.accountId,
          a.stakeCred,
          toParam(a.label),
          a.rBps ?? 5000,
          a.nowMs,
          a.nowMs,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/UNIQUE constraint failed: accounts\.stake_cred/.test(msg)) {
          throw new AccountBindingError(
            "this stake credential is already bound to a Ballast account",
          );
        }
        if (/UNIQUE constraint failed: accounts\.account_id/.test(msg)) {
          throw new AccountBindingError(
            "this Strike account is already bound to a stake credential",
          );
        }
        throw err;
      }
    },
    account(accountId: string): AccountRow | null {
      return mapAccount(st.accountById.get(accountId) as Record<string, unknown> | undefined);
    },
    accountByStake(stakeCred: string): AccountRow | null {
      return mapAccount(st.accountByStake.get(stakeCred) as Record<string, unknown> | undefined);
    },
    setAccountStatus(
      accountId: string,
      status: AccountRow["status"],
      reason: string | null,
      nowMs: number,
    ): void {
      st.setAccountStatus.run(status, reason, nowMs, accountId);
    },
    /** Non-Ballast activity: pause and flag publicly ("paused: non-Ballast activity"). */
    flagManualActivity(accountId: string, detail: string, nowMs: number): void {
      st.flagManual.run(`non-Ballast activity: ${detail}`, nowMs, accountId);
    },

    insertOrder(o: OrderRow): void {
      st.insertOrder.run(
        o.clientOrderId,
        o.accountId,
        o.decisionSeq,
        o.policyHash,
        o.symbol,
        o.side,
        o.reduceOnly ? 1 : 0,
        o.priceTicks,
        o.sizeSteps,
        o.filledSteps ?? "0",
        toParam(o.orderId),
        o.status,
        o.createdAtMs,
        o.createdAtMs,
      );
    },
    updateOrder(
      clientOrderId: string,
      patch: { status?: OrderStatus; filledSteps?: string; orderId?: string },
      nowMs: number,
    ): void {
      const r = st.updateOrder.run(
        toParam(patch.status),
        toParam(patch.filledSteps),
        toParam(patch.orderId),
        nowMs,
        clientOrderId,
      );
      if (r.changes === 0) throw new Error(`no order ${clientOrderId}`);
    },
    orders(accountId: string): Record<string, unknown>[] {
      return st.orders.all(accountId) as Record<string, unknown>[];
    },
    /** FAIL-CLOSED: unknown and pending creates count as resting until proven gone. */
    exposure(accountId: string, symbol: string): Exposure {
      const byStatus: Partial<Record<OrderStatus, bigint>> = {};
      let askSteps = 0n;
      for (const row of st.exposedOrders.all(accountId, symbol) as Record<string, string>[]) {
        const open = BigInt(row.size_steps as string) - BigInt(row.filled_steps as string);
        const remaining = open > 0n ? open : 0n;
        askSteps += remaining;
        const s = row.status as OrderStatus;
        byStatus[s] = (byStatus[s] ?? 0n) + remaining;
      }
      return { askSteps, byStatus };
    },
    /** Startup: a create stranded in 'pending' by a crash may have landed, so it becomes 'unknown'. */
    reconcileOrphanedPending(nowMs: number): number {
      return st.orphaned.run(nowMs).changes;
    },

    insertFill(f: FillRow): void {
      st.insertFill.run(
        f.tradeId,
        f.clientOrderId,
        f.accountId,
        f.side,
        f.role,
        f.priceTicks,
        f.sizeSteps,
        f.feeMicroUsd,
        toParam(f.builderFeeMicroUsd),
        f.tsMs,
      );
    },

    insertCoverCheck(p: CoverProof, accountId: string | null): void {
      const subject = p.subject.kind === "stake" ? p.subject.stakeAddress : p.subject.address;
      st.insertCover.run(
        subject,
        accountId,
        p.height,
        p.tipHash,
        p.coverBase,
        p.utxos.length,
        p.hash,
        canonicalize(p),
        p.checkedAtMs,
      );
    },
    coverProofs(): CoverProof[] {
      return parseRows<CoverProof>(st.coverChecks.all(), "proof_json");
    },
    latestCover(subject: string): CoverProof | null {
      const r = st.latestCover.get(subject) as { proof_json: string } | undefined;
      return r ? (JSON.parse(r.proof_json) as CoverProof) : null;
    },

    insertGuardTrip(t: GuardTripRow): void {
      st.insertTrip.run(
        t.tsMs,
        toParam(t.accountId),
        t.ruleId,
        t.safetyClass ? 1 : 0,
        toParam(t.decisionSeq),
        t.detail,
      );
    },
    guardTrips(sinceMs = 0): GuardTripRow[] {
      return (st.trips.all(sinceMs) as Record<string, unknown>[]).map((r) => ({
        tsMs: r.ts_ms as number,
        ruleId: r.rule_id as string,
        safetyClass: r.safety_class === 1,
        detail: r.detail as string,
        ...(r.account_id ? { accountId: r.account_id as string } : {}),
        ...(r.decision_seq ? { decisionSeq: r.decision_seq as number } : {}),
      }));
    },

    insertKill(k: {
      accountId: string;
      symbol: string;
      trigger: KillTrigger;
      sentAtMs: number;
      decisionSeq?: number;
    }): number {
      return Number(
        st.insertKill.run(k.accountId, k.symbol, k.trigger, k.sentAtMs, toParam(k.decisionSeq))
          .lastInsertRowid,
      );
    },
    /** Records confirmations; the row becomes 'confirmed' only once both stream and L3 agree. */
    confirmKill(id: number, c: { streamMs?: number; l3Ms?: number }): void {
      st.confirmKill.run(toParam(c.streamMs), toParam(c.l3Ms), id);
      const row = st.kill.get(id) as Record<string, number | null> | undefined;
      if (row?.stream_confirmed_ms != null && row.l3_confirmed_ms != null)
        st.setKillStatus.run("confirmed", id);
    },
    setKillStatus(id: number, status: "retried" | "escalated" | "failed"): void {
      st.setKillStatus.run(status, id);
    },
    kill(id: number): Record<string, unknown> | null {
      return (st.kill.get(id) as Record<string, unknown> | undefined) ?? null;
    },

    insertAnchor(a: AnchorRecord, nowMs: number): void {
      st.insertAnchor.run(
        a.root,
        a.decisionsRoot,
        a.segmentsRoot,
        a.firstSeq,
        a.lastSeq,
        a.segments.length,
        a.network,
        toParam(a.txHash),
        a.txHash ? "submitted" : "built",
        canonicalize(a),
        nowMs,
      );
    },
    setAnchorTx(root: string, txHash: string, status: "submitted" | "confirmed" | "failed"): void {
      const current = store.anchors().find((x) => x.root === root);
      if (!current) throw new Error(`no anchor ${root}`);
      st.setAnchorTx.run(txHash, status, canonicalize({ ...current, txHash }), root);
    },
    anchors(): AnchorRecord[] {
      return parseRows<AnchorRecord>(st.anchors.all(), "record_json");
    },

    insertProbe(p: {
      tradeId: string;
      probeAccount: string;
      makerClientOrderId?: string;
      notionalMicroUsd: string;
      tsMs: number;
      note?: string;
    }): void {
      st.insertProbe.run(
        p.tradeId,
        p.probeAccount,
        toParam(p.makerClientOrderId),
        p.notionalMicroUsd,
        p.tsMs,
        toParam(p.note),
      );
    },
    /** Labeled probe fills are excluded from KPIs. */
    isProbe(tradeId: string): boolean {
      return st.isProbe.get(tradeId) !== undefined;
    },

    /** A holder's geofence attestation (no IP data: the holder's own statement only). */
    insertAttestation(a: HolderAttestationRow): void {
      st.insertAttestation.run(
        a.stakeCred,
        a.address,
        a.kind,
        a.statementHash,
        a.listUrl,
        a.attestedAtMs,
      );
    },
    attestations(stakeCred: string): HolderAttestationRow[] {
      return (st.attestations.all(stakeCred) as Record<string, unknown>[]).map((r) => ({
        stakeCred: r.stake_cred as string,
        address: r.address as string,
        kind: r.kind as "geofence",
        statementHash: r.statement_hash as string,
        listUrl: r.list_url as string,
        attestedAtMs: r.attested_at_ms as number,
      }));
    },

    /** Records a new API wallet for the account, revoking the previous one in the same commit. */
    rotateHolderWallet(w: Omit<HolderWalletRow, "status" | "revokedAtMs">): void {
      rotateWalletTxn(w);
    },
    activeHolderWallet(accountId: string): HolderWalletRow | null {
      const r = st.activeWallet.get(accountId) as Record<string, unknown> | undefined;
      return r
        ? {
            publicKey: r.public_key as string,
            accountId: r.account_id as string,
            address: r.address as string,
            keyPath: r.key_path as string,
            status: r.status as "active",
            createdAtMs: r.created_at_ms as number,
            revokedAtMs: null,
          }
        : null;
    },

    /** Stores a signed consent's hash and applies its r to the account, atomically. */
    recordConsent(c: HolderConsentRow): void {
      recordConsentTxn(c);
    },
    latestConsent(accountId: string): HolderConsentRow | null {
      const r = st.latestConsent.get(accountId) as Record<string, unknown> | undefined;
      return r
        ? {
            hash: r.hash as string,
            accountId: r.account_id as string,
            stakeCred: r.stake_cred as string,
            rBps: r.r_bps as number,
            maxShortBase: r.max_short_base as string,
            feeShareBps: r.fee_share_bps as number,
            signatureHash: r.signature_hash as string,
            signedAtMs: r.signed_at_ms as number,
          }
        : null;
    },

    /** One row per deposit or withdrawal request, advanced through its statuses. */
    recordFunding(
      e: Omit<FundingEventRow, "createdAtMs" | "updatedAtMs"> & { nowMs: number },
    ): void {
      st.upsertFunding.run(
        e.accountId,
        e.kind,
        e.requestId,
        e.asset,
        e.amountBase,
        e.usdValue,
        e.txHash,
        e.status,
        e.nowMs,
        e.nowMs,
      );
    },
    fundingEvents(accountId: string): FundingEventRow[] {
      return (st.fundingEvents.all(accountId) as Record<string, unknown>[]).map((r) => ({
        accountId: r.account_id as string,
        kind: r.kind as FundingEventRow["kind"],
        requestId: r.request_id as string,
        asset: r.asset as FundingEventRow["asset"],
        amountBase: (r.amount_base as string | null) ?? null,
        usdValue: (r.usd_value as string | null) ?? null,
        txHash: (r.tx_hash as string | null) ?? null,
        status: r.status as FundingStatus,
        createdAtMs: r.created_at_ms as number,
        updatedAtMs: r.updated_at_ms as number,
      }));
    },

    acquireDaemonLock(pid: number, nowMs: number, staleMs: number): LockAcquisition {
      return acquireLockTxn(pid, nowMs, staleMs);
    },
    refreshDaemonLock(pid: number, nowMs: number): boolean {
      return st.refreshLock.run(nowMs, pid).changes > 0;
    },
    releaseDaemonLock(pid: number): void {
      st.releaseLock.run(pid);
    },

    close(): void {
      db.close();
    },
  };
  return store;
}

export type EvidenceDb = ReturnType<typeof openEvidenceDb>;

/** The startup gate: a second daemon dies with a named, actionable error. */
export function acquireDaemonLockOrThrow(
  db: EvidenceDb,
  pid: number,
  nowMs: number,
  staleMs: number,
): void {
  const r = db.acquireDaemonLock(pid, nowMs, staleMs);
  if (!r.acquired) {
    throw new Error(
      `another Ballast daemon (pid ${r.holderPid}) holds the lock; its last heartbeat was ` +
        `${Math.round((r.heartbeatAgeMs ?? 0) / 1000)}s ago. Stop it first.`,
    );
  }
}
