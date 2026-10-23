/**
 * Wire types of Ballast's public, read-only API. This file is shared with the web app, so it
 * imports nothing.
 *
 * Data policy: responses carry aggregated price levels, aggregate counts and hashes only. No
 * order ids, client ids, account ids, addresses, leverage or liquidation prices ever appear.
 */

export const DEPTH_BAND_KEYS = ["0.5%", "1%", "2%"] as const;
export type DepthBandKey = (typeof DEPTH_BAND_KEYS)[number];
export const SLIPPAGE_SIZE_KEYS = ["1000", "10000", "25000"] as const;
export type SlippageSizeKey = (typeof SLIPPAGE_SIZE_KEYS)[number];

/** One aggregated level: price, size in base units, and how much of that size is Ballast's. */
export type WireLevel = [px: number, qty: number, ballastQty: number];

export interface DepthBands {
  bid: Record<DepthBandKey, number>;
  ask: Record<DepthBandKey, number>;
}

export interface FrameSource {
  kind: "replay" | "live";
  /** Recorded UTC hour the frame was rebuilt from, e.g. "2026-10-23T02" (replay only). */
  hour?: string;
  /** That hour's RFC 6962 Merkle root from roots.jsonl (replay only). */
  root?: string;
}

/** The book at one instant, as aggregated levels. */
export interface BookFrame {
  symbol: string;
  /** Engine time the frame describes (ms). */
  tMs: number;
  /** Last L3 sequence number applied to the book. */
  sequence: number;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  /** The counterfactual (non-Ballast) mid: the yardstick spread and depth are measured against. */
  ref: number | null;
  spreadBps: number | null;
  /** Spread of the same book with Ballast's orders removed. */
  cfSpreadBps: number | null;
  depthUsd: { actual: DepthBands; counterfactual: DepthBands } | null;
  ballastOrders: number;
  /** Best first, within ±5% of `ref`. */
  bids: WireLevel[];
  asks: WireLevel[];
  source: FrameSource;
}

/** Columnar time series at `stepMs`, for charts. Nulls are gaps (unsynced book). */
export interface SeriesResponse {
  symbol: string;
  fromMs: number;
  toMs: number;
  stepMs: number;
  t: number[];
  bestBid: (number | null)[];
  bestAsk: (number | null)[];
  mid: (number | null)[];
  ref: (number | null)[];
  spreadBps: (number | null)[];
  cfSpreadBps: (number | null)[];
  askDepth05: (number | null)[];
  bidDepth05: (number | null)[];
  askDepth2: (number | null)[];
}

export interface TimeWindow {
  fromMs: number;
  toMs: number;
}

export interface ReplayIndexResponse {
  symbol: string;
  /** Contiguous stretches where a frame exists every `frameMs`. */
  windows: TimeWindow[];
  frameMs: number;
  /** Stretches with 1 s frames (the playback hour). */
  fineWindows: TimeWindow[];
  sealedThroughMs: number | null;
}

export interface ReplayFrameResponse {
  requestedMs: number;
  frame: BookFrame;
}

/** Mirrors @ballast/market's BookHealthReport (kept structural so the web needs no Node types). */
export interface MetricSummary {
  mean: string | null;
  coverage: number;
}
export interface BookHealthSide {
  ms: number;
  actual: Record<string, MetricSummary>;
  counterfactual: Record<string, MetricSummary>;
}
export interface BookHealthReportWire {
  armed: BookHealthSide;
  unarmed: BookHealthSide;
}

export interface ReplayStatsWire {
  l3Updates: number;
  snapshots: number;
  rebuilds: number;
  breaks: number;
  unsyncedMs: number;
  healthSamples: number;
  takerBuys: number;
}

export interface HourProvenance {
  hour: string;
  root: string;
}

export interface BookHealthResponse {
  symbol: string;
  fromMs: number;
  toMs: number;
  sealedThroughMs: number;
  /** "index": the background pass over every sealed hour; "replay": a replay of this window. */
  method: "index" | "replay";
  computedAt: number;
  report: BookHealthReportWire;
  stats: ReplayStatsWire | null;
  lines: number | null;
  badLines: number | null;
  provenance: { hours: HourProvenance[]; verified: boolean | null };
}

export interface PeriodReport {
  /** "2026-10-23" for a day, "2026-10-23T02" for an hour. */
  key: string;
  fromMs: number;
  toMs: number;
  report: BookHealthReportWire;
}

export interface DailyBookHealthResponse {
  symbol: string;
  sealedThroughMs: number;
  days: (PeriodReport & { hours: PeriodReport[] })[];
  provenance: { hours: HourProvenance[]; verified: boolean | null };
}

export interface SegmentWire {
  segment: string;
  stream: string;
  sha256: string;
  lines: number;
  bytes: number;
}

export interface RootWire {
  hour: string;
  root: string;
  prev: string | null;
  chain: string;
  leaves: string[];
  segments: SegmentWire[];
  sealedMs: number;
}

export interface VerifyWire {
  ok: boolean;
  checkedAt: number;
  segmentsChecked: number;
  compressed: number;
  rootsChecked: number;
  failures: { kind: "segment" | "root"; id: string; reason: string }[];
  /** Segments still being written (the current hour). */
  unsealed: number;
}

export interface RootsResponse {
  hours: RootWire[];
  verify: VerifyWire | null;
}

export interface CapacityResponse {
  symbol: string;
  window: TimeWindow | null;
  /** Committed on-chain cover. Arrives with the cover oracle. */
  coverCommittedUsd: null;
  coverStatus: "coming with the cover oracle";
  /** Taker buys (resting asks lifted) on L3 over the window. */
  takerBuyFlow: { usd: number; buys: number } | null;
  /** Time-weighted asks within 2% of the counterfactual mid over the window: the exit depth. */
  exitDepthUsd: number | null;
  /** Aggregate counts from the latest recorded live-positions snapshot. */
  livePositions: { longs: number; shorts: number; atMs: number } | null;
  ballast: { ordersResting: number; holdersArmed: number; armedMs: number };
}

export interface HealthResponse {
  ok: boolean;
  source: "replay" | "live";
  symbols: string[];
  indexed: boolean;
  sealedThroughMs: number | null;
  builtAt: number | null;
}

export interface ApiError {
  error: string;
}
