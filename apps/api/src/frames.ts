import {
  type BookHealth,
  type BookHealthPair,
  countOrders,
  DEPTH_BANDS,
  type Dec,
  type Grid,
  type GridSpec,
  healthPairOfLevels,
  type Level,
  type LevelBook,
  levelsFromL3,
} from "@ballast/market";
import type { L3Book } from "@ballast/strike-client";
import type { BookFrame, DepthBands, FrameSource, WireLevel } from "./types.js";

/** Levels further than this from the reference mid are left out of a frame. */
export const FRAME_BAND = 0.05;
export const FRAME_MAX_LEVELS = 120;

const scaleCache = new WeakMap<Grid, { mult: bigint; exp: number }>();

/** Exact grid units → number: the decimal string is built from bigints, then parsed once. */
export function unitsToNumber(n: bigint, grid: Grid): number {
  let s = scaleCache.get(grid);
  if (!s) {
    s = { mult: BigInt(grid.unit.times(10 ** grid.scale).toFixed(0)), exp: grid.scale };
    scaleCache.set(grid, s);
  }
  return Number(`${n * s.mult}e-${s.exp}`);
}

export function decToNumber(d: Dec | null | undefined): number | null {
  return d ? Number(d.toFixed()) : null;
}

function bands(h: BookHealth): DepthBands | null {
  if (!h.depthUsd) return null;
  const side = (s: "bid" | "ask") =>
    Object.fromEntries(
      DEPTH_BANDS.map((b) => [b, decToNumber(h.depthUsd?.[s][b]) ?? 0]),
    ) as DepthBands["bid"];
  return { bid: side("bid"), ask: side("ask") };
}

function wireSide(
  levels: readonly Level[],
  cf: readonly Level[] | null,
  spec: GridSpec,
  inside: (px: number) => boolean,
): WireLevel[] {
  const cfQty = cf ? new Map(cf.map((l) => [l.px, l.qty])) : null;
  const out: WireLevel[] = [];
  for (const l of levels) {
    if (out.length >= FRAME_MAX_LEVELS) break;
    const px = unitsToNumber(l.px, spec.tick);
    if (!inside(px)) break;
    const ballast = cfQty ? l.qty - (cfQty.get(l.px) ?? 0n) : 0n;
    out.push([px, unitsToNumber(l.qty, spec.step), unitsToNumber(ballast, spec.step)]);
  }
  return out;
}

export interface FrameInput {
  symbol: string;
  tMs: number;
  sequence: number;
  spec: GridSpec;
  levels: LevelBook;
  /** The book without Ballast's orders; null when none rest. */
  cfLevels: LevelBook | null;
  pair: BookHealthPair;
  source: FrameSource;
}

/**
 * A public frame: aggregated levels near the reference mid plus the Book Health headline
 * numbers. Order ids never leave this function; only price, size and Ballast's share do.
 */
export function frameOf(i: FrameInput): BookFrame {
  const a = i.pair.actual;
  const ref = decToNumber(a.ref);
  const lo = ref === null ? 0 : ref * (1 - FRAME_BAND);
  const hi = ref === null ? Number.POSITIVE_INFINITY : ref * (1 + FRAME_BAND);
  const actualBands = bands(a);
  const cfBands = bands(i.pair.counterfactual);
  return {
    symbol: i.symbol,
    tMs: i.tMs,
    sequence: i.sequence,
    bestBid: decToNumber(a.bestBid),
    bestAsk: decToNumber(a.bestAsk),
    mid: decToNumber(a.mid),
    ref,
    spreadBps: decToNumber(a.spreadBps),
    cfSpreadBps: decToNumber(i.pair.counterfactual.spreadBps),
    depthUsd: actualBands && cfBands ? { actual: actualBands, counterfactual: cfBands } : null,
    ballastOrders: i.pair.ballastOrders,
    bids: wireSide(i.levels.bids, i.cfLevels?.bids ?? null, i.spec, (px) => px >= lo),
    asks: wireSide(i.levels.asks, i.cfLevels?.asks ?? null, i.spec, (px) => px <= hi),
    source: i.source,
  };
}

/** A frame straight from an L3 book (the live source), measured with @ballast/market. */
export function frameFromBook(
  symbol: string,
  book: Pick<L3Book, "bids" | "asks" | "lastSequence">,
  spec: GridSpec,
  ballastIds: ReadonlySet<string>,
  tMs: number,
  source: FrameSource,
): BookFrame {
  const n = countOrders(book, ballastIds);
  const levels = levelsFromL3(book, spec);
  const cfLevels = n === 0 ? null : levelsFromL3(book, spec, ballastIds);
  const pair = healthPairOfLevels(levels, cfLevels, spec, n);
  return frameOf({
    symbol,
    tMs,
    sequence: book.lastSequence,
    spec,
    levels,
    cfLevels,
    pair,
    source,
  });
}
