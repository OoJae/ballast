import type { MicroUsd, RefPrice, Steps, Ticks } from "@ballast/core";
import type {
  AllocAccount,
  AllocLevel,
  AllocOptions,
  ArmDecision,
  EngineMarket,
  MarginBand,
  MarketCaps,
  P2Fact,
} from "@ballast/engine";
import type { ProfileName } from "@ballast/strike-client";

/** Plan section 6, in evaluation order; dry-run is always last. */
export const GUARD_RULES = [
  "policy-signature",
  "policy-window",
  "critic-pass",
  "arm-flag",
  "market-allowlist",
  "data-freshness",
  "reference-sanity",
  "cover-invariant",
  "stake-binding",
  "dedicated-account",
  "price-floor",
  "p2-constraint",
  "ladder-shape",
  "no-bid-ahead",
  "static-rules",
  "leverage-cap",
  "margin-band",
  "per-account-short",
  "aggregate-cap",
  "fee-cap",
  "loss-stop",
  "holder0-unpaired",
  "allocator-conformance",
  "rate-budget",
  "client-id-format",
  "route-allowlist",
  "unknown-orders",
  "dry-run",
] as const;

export type GuardRuleId = (typeof GUARD_RULES)[number];

/** Cancels and reduce-only buy-backs are checked only by these (plan section 6). */
export const EXEMPT_RULES: readonly GuardRuleId[] = ["route-allowlist", "dry-run"];

export type GuardDecision = "execute" | "dry-run" | "blocked";

export interface GuardCheck {
  rule: GuardRuleId;
  passed: boolean;
  detail: string;
}

export interface GuardViolation {
  rule: GuardRuleId;
  detail: string;
}

export interface GuardResult {
  decision: GuardDecision;
  /** Every failed rule (all rules are evaluated; nothing short-circuits). */
  violations: GuardViolation[];
  /** The full evaluation trail, passing checks included. */
  checks: GuardCheck[];
  reason: string;
  /** The request only cancels or buys back reduce-only. */
  riskReducing: boolean;
}

/** One signed request exactly as it will be sent. */
export interface GuardRequest {
  method: string;
  path: string;
  /** Parsed form of the exact body bytes (undefined when there is none). */
  body: unknown;
  /** X-Builder-Fee-Bps; 0 when the header is absent. */
  builderFeeBps: number;
}

export interface GuardPolicyFact {
  /** The policy as signed; re-parsed strictly here. */
  policy: unknown;
  /** The hash the operator signature covers. */
  hash: string;
  /** Ed25519 verification of the operator signature (M4), injected as a fact. */
  signatureValid: boolean;
  /** Renewals already used under the operator's pre-authorized envelope. */
  renewalsUsed: number;
}

export interface GuardCriticFact {
  verdict: string;
  policyHash: string;
  /** The report's daemon signature and data root verified (M4). */
  reportValid: boolean;
}

export interface GuardFloorFact {
  /** F on the tick grid (0 = no live long sets one). */
  ticks: Ticks;
  /** The b_liq F was computed with, and the replica p99 error, both in micro-bps. */
  bLiqMicroBps: bigint;
  replicaP99MicroBps: bigint;
  positionsStale: boolean;
}

export interface GuardMarketFact {
  spec: EngineMarket;
  caps: MarketCaps;
  /** Symbols the config's asset book allows. */
  allowlist: readonly string[];
  arm: ArmDecision;
  index: RefPrice | null;
  mark: RefPrice | null;
  /** Best bid and ask in the book without Ballast. */
  bestBidTicks: Ticks | null;
  bestAskTicks: Ticks | null;
  floor: GuardFloorFact | null;
  p2: P2Fact | null;
  /** Ballast's other accounts on this symbol. */
  others: {
    /** short + asks, valued like this account's (short at mark, asks at their price). */
    exposureMicroUsd: MicroUsd;
    askMicroUsd: MicroUsd;
    /** Their asks at this request's L1 price. */
    l1Steps: Steps;
  };
  /** Live asks within 2% of mid, Ballast excluded. */
  exitDepthMicroUsd: MicroUsd;
  /** Strike's written opt-in for exit bids at or one tick ahead of the best bid. */
  recyclingOptIn: boolean;
}

export interface GuardDataFact {
  indexAgeMs: number;
  markAgeMs: number;
  l3Synced: boolean;
  l3GapFree: boolean;
  coverAgeMs: number;
  marketsAgeMs: number;
  userStreamConnected: boolean;
}

export interface GuardReferenceFact {
  status: "ok" | "divergent" | "unavailable";
  /** |index − CEX median| in bps, when a reference exists. */
  deviationBps: bigint | null;
}

export interface GuardRestingAsk {
  clientOrderId: string;
  orderId: bigint | null;
  px: Ticks;
  qty: Steps;
}

export interface GuardAccountFact {
  id: string;
  holder0: boolean;
  stakeBinding: { bound: boolean; unique: boolean };
  foreignOrders: number;
  foreignPositions: boolean;
  vaultShares: boolean;
  coverSteps: Steps;
  rBps: bigint;
  shortSteps: Steps;
  /** This account's live Ballast asks on the symbol (confirmed). */
  resting: readonly GuardRestingAsk[];
  /** Creates sent but not yet confirmed: they count as resting. */
  pendingSteps: Steps;
  unknownOrders: number;
  /** The reconciler's exposure is a proven upper bound (no order of unknown size). */
  exposureUpperBound: boolean;
  oldestUnconfirmedCreateAtMs: number | null;
  equityMicroUsd: MicroUsd;
  /** MM / MB in bps; null when unknown. */
  marginRatioBps: bigint | null;
  marginBand: MarginBand;
  /** Holder-set cap on short + asks. */
  maxShortMicroUsd: MicroUsd | null;
  /** The builder fee the holder approved at connect. */
  approvedBuilderBps: number;
  lossTodayMicroUsd: MicroUsd;
  lossHoldUntilMs: number | null;
  /** r × cover at mid, the base of the holders' loss stop. */
  committedCoverMicroUsd: MicroUsd;
}

export interface GuardRateFact {
  usedInWindow: number;
  windowCap: number;
  cancelReserve: number;
  lastReplaceBatchMs: number | null;
  spacingMs: number;
  pausedUntilMs: number;
}

export interface GuardAllocatorFact {
  accounts: readonly AllocAccount[];
  ladder: readonly AllocLevel[];
  opts: AllocOptions;
}

export interface GuardInput {
  nowMs: number;
  request: GuardRequest;
  profile: ProfileName;
  flags: { dryRun: boolean; armed: boolean; mainnet: boolean };
  policy: GuardPolicyFact | null;
  critic: GuardCriticFact | null;
  market: GuardMarketFact;
  data: GuardDataFact;
  reference: GuardReferenceFact;
  account: GuardAccountFact;
  allocator: GuardAllocatorFact | null;
  rate: GuardRateFact;
  /** Decision sequence number the request's client ids must carry. */
  decisionSeq: bigint;
  /** Client ids already used (any decision): ids are unique per create. */
  usedClientOrderIds: ReadonlySet<string>;
}
