import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalPrice,
  isZeroSize,
  L3Book,
  type L3Snapshot,
  type L3Update,
} from "../src/index.js";

const SYM = "NIGHT-USD";
const snap = (last: number, over: Partial<L3Snapshot> = {}): L3Snapshot => ({
  type: "l3_snapshot",
  symbol: SYM,
  last_sequence: last,
  timestamp: 0,
  bids: [],
  asks: [],
  ...over,
});
const upd = (sequence: number, u: Partial<L3Update>): L3Update => ({
  type: "l3_update",
  symbol: SYM,
  action: "open",
  sequence,
  timestamp: 0,
  ...u,
});

describe("canonicalPrice / isZeroSize", () => {
  it("normalizes trailing zeros so snapshot and update spellings share a level", () => {
    expect(canonicalPrice("72247.30")).toBe("72247.3");
    expect(canonicalPrice("0.0386000")).toBe("0.0386");
    expect(canonicalPrice("100.00")).toBe("100");
    expect(canonicalPrice("1200")).toBe("1200");
  });
  it("treats every zero spelling as zero", () => {
    for (const z of ["0", "0.0", "0.000000", "00"]) expect(isZeroSize(z)).toBe(true);
    for (const nz of ["1", "0.001", "10"]) expect(isZeroSize(nz)).toBe(false);
  });
});

describe("L3Book", () => {
  it("applies open, partial fill, full fill and cancel with FIFO semantics", () => {
    const b = new L3Book(SYM);
    expect(
      b.applySnapshot(
        snap(10, { asks: [{ price: "0.038595", orders: [{ order_id: "A", size: "1135" }] }] }),
      ).ok,
    ).toBe(true);
    expect(
      b.onUpdate(upd(11, { order_id: "B", side: "sell", price: "0.0385950", remaining_size: "50" }))
        .ok,
    ).toBe(true);
    expect(b.asks.get("0.038595")?.map((o) => o.id)).toEqual(["A", "B"]);

    expect(
      b.onUpdate(
        upd(12, {
          action: "partial_fill",
          order_id: "A",
          side: "sell",
          price: "0.038595",
          remaining_size: "1000",
          trade_id: 1,
          taker_order_id: "T",
        }),
      ).ok,
    ).toBe(true);
    expect(b.asks.get("0.038595")?.[0]).toEqual({ id: "A", size: "1000" });

    b.onUpdate(
      upd(13, {
        action: "full_fill",
        order_id: "A",
        side: "sell",
        price: "0.038595",
        remaining_size: "0",
      }),
    );
    b.onUpdate(
      upd(14, {
        action: "cancel",
        order_id: "B",
        side: "sell",
        price: "0.038595",
        remaining_size: "0",
      }),
    );
    expect(b.asks.size).toBe(0);
    expect(b.lastSequence).toBe(14);
  });

  it("buffers updates until the snapshot, then drops those it already contains", () => {
    const b = new L3Book(SYM);
    b.onUpdate(upd(9, { order_id: "old", side: "buy", price: "0.038", remaining_size: "5" }));
    b.onUpdate(upd(11, { order_id: "new", side: "buy", price: "0.038", remaining_size: "7" }));
    expect(b.applySnapshot(snap(10)).ok).toBe(true);
    expect(b.bids.get("0.038")?.map((o) => o.id)).toEqual(["new"]);
    expect(b.bestBid()).toBe("0.038");
  });

  it("drops updates the snapshot already contains, even after it is applied", () => {
    // Seen live: an update still queued on the socket when the snapshot landed (2026-10-23).
    const b = new L3Book(SYM);
    b.applySnapshot(
      snap(100, { asks: [{ price: "0.0386", orders: [{ order_id: "A", size: "500" }] }] }),
    );
    const stale = upd(95, {
      action: "cancel",
      order_id: "A",
      side: "sell",
      price: "0.0386",
      remaining_size: "0",
    });
    expect(b.onUpdate(stale).ok).toBe(true);
    expect(b.asks.get("0.0386")?.map((o) => o.id)).toEqual(["A"]);
    expect(b.lastSequence).toBe(100);
    expect(
      b.onUpdate(upd(101, { order_id: "B", side: "sell", price: "0.0387", remaining_size: "1" }))
        .ok,
    ).toBe(true);
    expect(
      b.onUpdate(upd(103, { order_id: "C", side: "sell", price: "0.0388", remaining_size: "1" })),
    ).toMatchObject({ ok: false, reason: "gap" });
  });

  it("reports a gap, a clear and an unknown order", () => {
    const b = new L3Book(SYM);
    b.applySnapshot(snap(10));
    expect(
      b.onUpdate(upd(12, { order_id: "x", side: "buy", price: "1", remaining_size: "1" })),
    ).toMatchObject({ ok: false, reason: "gap" });

    const c = new L3Book(SYM);
    c.applySnapshot(snap(10));
    expect(c.onUpdate(upd(11, { action: "clear" }))).toMatchObject({ ok: false, reason: "clear" });

    const d = new L3Book(SYM);
    d.applySnapshot(snap(10));
    expect(
      d.onUpdate(
        upd(11, {
          action: "cancel",
          order_id: "ghost",
          side: "sell",
          price: "1",
          remaining_size: "0",
        }),
      ),
    ).toMatchObject({ ok: false, reason: "unknown_order" });
  });

  it("matches a reference model over random open/fill/cancel sequences", () => {
    type Cmd =
      | { t: "open"; sell: boolean; px: number; size: number }
      | { t: "fill"; pick: number; amount: number }
      | { t: "cancel"; pick: number };
    const cmd: fc.Arbitrary<Cmd> = fc.oneof(
      fc.record({
        t: fc.constant("open" as const),
        sell: fc.boolean(),
        px: fc.integer({ min: 0, max: 4 }),
        size: fc.integer({ min: 1, max: 1000 }),
      }),
      fc.record({
        t: fc.constant("fill" as const),
        pick: fc.nat(),
        amount: fc.integer({ min: 1, max: 1000 }),
      }),
      fc.record({ t: fc.constant("cancel" as const), pick: fc.nat() }),
    );
    fc.assert(
      fc.property(fc.array(cmd, { maxLength: 200 }), (cmds) => {
        // Reference model: FIFO queues per (side, price), plus a live-order list to pick from.
        const model = new Map<string, { id: string; size: number }[]>();
        const live: { id: string; side: "buy" | "sell"; price: string }[] = [];
        const book = new L3Book(SYM);
        book.applySnapshot(snap(0));
        let seq = 0;
        let nextId = 0;
        for (const c of cmds) {
          if (c.t === "open") {
            const side = c.sell ? "sell" : "buy";
            const price = `0.0${380 + c.px}0`; // trailing zero exercises canonicalization
            const id = `o${nextId++}`;
            const key = `${side}:${canonicalPrice(price)}`;
            model.set(key, [...(model.get(key) ?? []), { id, size: c.size }]);
            live.push({ id, side, price });
            expect(
              book.onUpdate(
                upd(++seq, {
                  order_id: id,
                  side,
                  price,
                  remaining_size: String(c.size),
                  delta_size: String(c.size),
                }),
              ).ok,
            ).toBe(true);
            continue;
          }
          if (live.length === 0) continue;
          const at = c.pick % live.length;
          const o = live[at];
          if (!o) continue;
          const key = `${o.side}:${canonicalPrice(o.price)}`;
          const queue = model.get(key) ?? [];
          const entry = queue.find((q) => q.id === o.id);
          if (!entry) continue;
          const remaining = c.t === "cancel" ? 0 : Math.max(0, entry.size - c.amount);
          const action =
            c.t === "cancel" ? "cancel" : remaining === 0 ? "full_fill" : "partial_fill";
          if (remaining === 0) {
            model.set(
              key,
              queue.filter((q) => q.id !== o.id),
            );
            live.splice(at, 1);
          } else {
            entry.size = remaining;
          }
          expect(
            book.onUpdate(
              upd(++seq, {
                action,
                order_id: o.id,
                side: o.side,
                price: o.price,
                remaining_size: String(remaining),
              }),
            ).ok,
          ).toBe(true);
        }
        for (const [key, queue] of model) {
          const [side, price] = key.split(":") as ["buy" | "sell", string];
          const got = (side === "buy" ? book.bids : book.asks).get(price) ?? [];
          expect(got).toEqual(queue.map((q) => ({ id: q.id, size: String(q.size) })));
        }
        const nonEmpty = [...model.values()].filter((q) => q.length > 0).length;
        expect(book.bids.size + book.asks.size).toBe(nonEmpty);
      }),
    );
  });
});
