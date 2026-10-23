import { minBigint } from "@ballast/core";
import { REFERENCE_MARKETS } from "@ballast/engine";
import { type Dec, dec, type RecordedPosition, type RecordLine } from "@ballast/market";
import type { L3Snapshot, L3Update } from "@ballast/strike-client";

/**
 * Synthetic recordings for the stress library, in exactly the recorder's line format, so the
 * simulator replays them the same way it replays real segments. A house market maker quotes a
 * ladder around the index and re-centres it; scripted takers lift or hit it (each fill is an L3
 * update carrying the taker's order id, as Strike publishes it). Everything is integer ticks
 * and steps; USD sizes are converted once per order.
 */
export interface HouseLevel {
  /** Offset from index in bps (negative for bids). */
  offBps: number;
  /** Size in whole NIGHT. */
  qty: number;
}

export interface SyntheticTaker {
  tMs: number;
  side: "buy" | "sell";
  /** Size in whole NIGHT. */
  qty: number;
}

export interface SyntheticSpec {
  startMs: number;
  durationMs: number;
  /** Index at time t (it is published rounded to 8 dp, as the stream does). */
  index: (tMs: number) => Dec;
  /** Mark over index, published alongside (the simulator computes its own mark). */
  premiumBps: number;
  bids: readonly HouseLevel[];
  asks: readonly HouseLevel[];
  /** The house re-centres its ladder this often. */
  requoteMs: number;
  takers: readonly SyntheticTaker[];
  positions: readonly { atMs: number; rows: readonly RecordedPosition[] }[];
  /** Mark ticks are not delivered in these windows (index stall). */
  stalls?: readonly { fromMs: number; toMs: number }[];
  /** An L3 `clear` at atMs, and a fresh snapshot after `resnapshotMs`. */
  clears?: readonly { atMs: number; resnapshotMs: number }[];
}

const SYMBOL = "NIGHT-USD";
const TICKS_PER_USD = 1_000_000n;

interface HouseOrder {
  id: string;
  side: "buy" | "sell";
  px: bigint;
  qty: bigint;
}

const priceOf = (px: bigint): string => {
  const s = px.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/^\./, "0.");
};

function indexTicks(x: Dec): bigint {
  return BigInt(x.times(TICKS_PER_USD.toString()).toDecimalPlaces(0, 3).toFixed());
}

function offset(base: bigint, bps: number): bigint {
  return (base * BigInt(10_000 + bps)) / 10_000n;
}

export function synthesize(spec: SyntheticSpec): RecordLine[] {
  const out: (RecordLine & { o: number })[] = [];
  let o = 0;
  const push = (r: number, stream: string, k: string, d: unknown) =>
    out.push({ r, stream, k, d, o: o++ });
  let seq = 1_000;
  let trade = 50_000;
  let nextId = 1;
  const house = new Map<string, HouseOrder>();
  const update = (r: number, u: Omit<L3Update, "type" | "symbol" | "sequence" | "timestamp">) => {
    seq += 1;
    push(r, "l3", "update", {
      type: "l3_update",
      symbol: SYMBOL,
      sequence: seq,
      timestamp: r,
      ...u,
    });
  };
  const snapshot = (r: number) => {
    const levels = (side: "buy" | "sell") => {
      const by = new Map<bigint, HouseOrder[]>();
      for (const h of house.values()) {
        if (h.side !== side) continue;
        const l = by.get(h.px) ?? [];
        l.push(h);
        by.set(h.px, l);
      }
      return [...by]
        .sort((a, b) => (side === "buy" ? (a[0] > b[0] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
        .map(([px, hs]) => ({
          price: priceOf(px),
          orders: hs.map((h) => ({ order_id: h.id, size: h.qty.toString() })),
        }));
    };
    const s: L3Snapshot = {
      type: "l3_snapshot",
      symbol: SYMBOL,
      last_sequence: seq,
      timestamp: r,
      bids: levels("buy"),
      asks: levels("sell"),
    };
    push(r, "l3", "snapshot", s);
  };
  const ladder = (t: number) => {
    const x = indexTicks(spec.index(t));
    return [
      ...spec.bids.map((l, i) => ({
        key: `b${i}`,
        side: "buy" as const,
        px: offset(x, l.offBps),
        qty: BigInt(l.qty),
      })),
      ...spec.asks.map((l, i) => ({
        key: `a${i}`,
        side: "sell" as const,
        px: offset(x, l.offBps),
        qty: BigInt(l.qty),
      })),
    ];
  };
  const slot = new Map<string, string>();
  const requote = (t: number, quiet: boolean) => {
    for (const want of ladder(t)) {
      const curId = slot.get(want.key);
      const cur = curId ? house.get(curId) : undefined;
      if (cur && cur.px === want.px && cur.qty === want.qty) continue;
      if (cur) {
        house.delete(cur.id);
        if (!quiet) {
          update(t, {
            action: "cancel",
            order_id: cur.id,
            side: cur.side,
            price: priceOf(cur.px),
            remaining_size: "0",
          });
        }
      }
      const h: HouseOrder = {
        id: `house-${nextId++}`,
        side: want.side,
        px: want.px,
        qty: want.qty,
      };
      house.set(h.id, h);
      slot.set(want.key, h.id);
      if (!quiet) {
        update(t, {
          action: "open",
          order_id: h.id,
          side: h.side,
          price: priceOf(h.px),
          remaining_size: h.qty.toString(),
        });
      }
    }
  };
  const take = (t: number, side: "buy" | "sell", qty: bigint, takerId: string) => {
    // A buy takes the asks cheapest first, a sell the bids dearest first, FIFO within a price.
    const makers = [...house.values()]
      .filter((h) => h.side === (side === "buy" ? "sell" : "buy"))
      .sort((a, b) =>
        side === "buy"
          ? a.px < b.px
            ? -1
            : a.px > b.px
              ? 1
              : 0
          : a.px > b.px
            ? -1
            : a.px < b.px
              ? 1
              : 0,
      );
    let left = qty;
    for (const h of makers) {
      if (left === 0n) break;
      const q = minBigint(h.qty, left);
      left -= q;
      h.qty -= q;
      trade += 1;
      update(t, {
        action: h.qty === 0n ? "full_fill" : "partial_fill",
        order_id: h.id,
        taker_order_id: takerId,
        side: h.side,
        price: priceOf(h.px),
        delta_size: `-${q}`,
        remaining_size: h.qty.toString(),
        trade_id: trade,
      });
      if (h.qty === 0n) house.delete(h.id);
    }
  };

  const t0 = spec.startMs;
  const end = t0 + spec.durationMs;
  push(t0, "rest", "markets", { [SYMBOL]: REFERENCE_MARKETS[SYMBOL] });
  requote(t0, true);
  snapshot(t0 + 1);

  const events: {
    t: number;
    kind: "tick" | "requote" | "taker" | "positions" | "clear" | "snap";
    i: number;
  }[] = [];
  for (let t = t0 + 1_000; t < end; t += 1_000) events.push({ t, kind: "tick", i: 0 });
  for (let t = t0 + spec.requoteMs; t < end; t += spec.requoteMs)
    events.push({ t: t + 300, kind: "requote", i: 0 });
  for (const [i, k] of spec.takers.entries()) events.push({ t: k.tMs, kind: "taker", i });
  for (const [i, p] of spec.positions.entries()) events.push({ t: p.atMs, kind: "positions", i });
  for (const [i, c] of (spec.clears ?? []).entries()) {
    events.push({ t: c.atMs, kind: "clear", i });
    events.push({ t: c.atMs + c.resnapshotMs, kind: "snap", i });
  }
  events.sort((a, b) => a.t - b.t);

  let takerN = 0;
  for (const e of events) {
    if (e.t >= end) continue;
    if (e.kind === "tick") {
      if ((spec.stalls ?? []).some((s) => e.t >= s.fromMs && e.t < s.toMs)) continue;
      const x = spec.index(e.t);
      push(e.t, "price", "markPriceUpdate", {
        e: "markPriceUpdate",
        E: e.t - 80,
        s: SYMBOL,
        p: x
          .times(dec(1).plus(dec(spec.premiumBps).div(10_000)))
          .toDecimalPlaces(8)
          .toFixed(),
        i: x.toDecimalPlaces(8).toFixed(),
        r: "0.0001",
        T: Math.floor(e.t / 3_600_000) * 3_600_000 + 3_600_000,
      });
    } else if (e.kind === "requote") {
      requote(e.t, false);
    } else if (e.kind === "taker") {
      const k = spec.takers[e.i];
      if (k) take(e.t, k.side, BigInt(k.qty), `taker-${++takerN}`);
    } else if (e.kind === "positions") {
      const p = spec.positions[e.i];
      if (p) push(e.t, "rest", "live-positions", { positions: p.rows, updated_at: p.atMs - 2_000 });
    } else if (e.kind === "clear") {
      seq += 1;
      push(e.t, "l3", "update", {
        type: "l3_update",
        symbol: SYMBOL,
        action: "clear",
        sequence: seq,
        timestamp: e.t,
      });
    } else {
      snapshot(e.t);
    }
  }
  out.sort((a, b) => a.r - b.r || a.o - b.o);
  return out.map(({ o: _o, ...rec }) => rec);
}

/** A live long whose served liquidation price sits `lpBps` from the index (isolated, tier 0). */
export function longRow(index: Dec, lpBps: number, size = 20_000): RecordedPosition {
  const lp = index.times(dec(1).plus(dec(lpBps).div(10_000))).toDecimalPlaces(8);
  return {
    symbol: SYMBOL,
    size: String(size),
    entry_price: index.toDecimalPlaces(8).toFixed(),
    mark_price: index.toDecimalPlaces(8).toFixed(),
    leverage: 10,
    margin_mode: "isolated",
    isolated_margin: "0",
    liquidation_price: lp.toFixed(),
  };
}
