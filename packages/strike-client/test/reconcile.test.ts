import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountReconciler,
  batchOrders,
  ClientOrderIdFactory,
  limitOrder,
  type OrderTradeUpdate,
  resyncAccount,
  type StrikeOrder,
  type StrikePosition,
  UserStream,
  type UserStreamEvent,
} from "../src/index.js";
import { type Harness, sleep, startHarness, UA } from "./helpers.js";

/**
 * A miniature engine for one account and symbol on a real-time line that is also the
 * reconciler's local clock. It emits the documented event shapes (order updates, fill updates
 * with position_seq, position updates that lag their fill like strike-userstream's example, and
 * fills whose order snapshot was unavailable), stamps them with Strike's own clock at an
 * arbitrary offset, and serves REST views that lag the engine. The reconciler is checked
 * against the engine's truth at every step, under any delivery order, delay and loss.
 */

const SYMBOL = "NIGHT-USD";
const LAG = 1_000;

type Action =
  | { kind: "create"; size: number }
  | { kind: "fill"; which: number; qty: number; blind: boolean }
  | { kind: "cancel"; which: number }
  | { kind: "buyback"; qty: number; blind: boolean }
  | { kind: "wait"; ms: number };

const actionArb = (blind = true): fc.Arbitrary<Action> =>
  fc.oneof(
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant("create" as const),
        size: fc.integer({ min: 1, max: 50 }),
      }),
    },
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant("fill" as const),
        which: fc.nat(),
        qty: fc.integer({ min: 1, max: 50 }),
        blind: blind ? fc.integer({ min: 0, max: 4 }).map((n) => n === 0) : fc.constant(false),
      }),
    },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("cancel" as const), which: fc.nat() }) },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("buyback" as const),
        qty: fc.integer({ min: 1, max: 50 }),
        blind: blind ? fc.boolean() : fc.constant(false),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("wait" as const),
        ms: fc.integer({ min: 0, max: 3 * LAG }),
      }),
    },
  );

interface OrderState {
  status: "open" | "filled" | "canceled";
  filled: number;
  /** Strike time of the update. */
  eventT: number;
}

interface SimOrder {
  cid: string;
  id: bigint;
  side: "buy" | "sell";
  size: number;
  createdAt: number;
  history: { at: number; state: OrderState }[];
}

interface SimFill {
  at: number;
  /** When the position service applied it (lags the fill, in fill order). */
  posAt: number;
  signed: number;
  pa: number;
  life: number;
  seq: number;
}

interface SimEvent {
  genAt: number;
  event: UserStreamEvent;
}

function otu(
  p: Partial<OrderTradeUpdate> & Pick<OrderTradeUpdate, "c" | "i" | "X" | "T">,
): OrderTradeUpdate {
  return {
    s: SYMBOL,
    S: "SELL",
    o: "LIMIT",
    ot: "LIMIT",
    f: "GTC",
    q: "0",
    p: "0.0389",
    sp: "0",
    x: "TRADE",
    cr: "",
    z: "0",
    l: "",
    L: "",
    n: "",
    N: "",
    t: 0n,
    m: false,
    R: false,
    cp: false,
    rp: "",
    act: "",
    wt: "",
    ps: "",
    ott: p.T,
    E: p.T,
    ...p,
  };
}

class Sim {
  readonly orders: SimOrder[] = [];
  readonly fills: SimFill[] = [];
  readonly events: SimEvent[] = [];
  t = 1_000;
  private pa = 0;
  private life = 0;
  private seq = 0;
  private lastPosAt = Number.NEGATIVE_INFINITY;
  private nextId = 9_007_199_254_740_990n; // past 2^53: ids must stay exact
  private trade = 100n;

  constructor(
    /** Strike's clock = real time + offset: the reconciler must not care what it is. */
    readonly offset = 0,
    private readonly posLag: (n: number) => number = () => 0,
    private readonly onCreate: (o: SimOrder) => void = () => {},
    /** EventTimestamp does not move on fills (one of the two baseline-cut assumptions fails). */
    private readonly staleEventTs = false,
  ) {}

  T(at: number): number {
    return at + this.offset;
  }

  run(actions: readonly Action[]): void {
    for (const a of actions) this.step(a);
  }

  state(o: SimOrder, at: number): OrderState | undefined {
    let s: OrderState | undefined;
    for (const h of o.history) if (h.at <= at) s = h.state;
    return s;
  }

  private emit(genAt: number, event: UserStreamEvent): void {
    this.events.push({ genAt, event });
  }

  private order(e: OrderTradeUpdate): void {
    this.emit(this.t, { kind: e.t > 0n ? "fill" : "order", E: e.T, data: e });
  }

  private update(o: SimOrder, state: Omit<OrderState, "eventT">, fill = false): void {
    const prev = o.history.at(-1)?.state.eventT;
    const eventT = fill && this.staleEventTs && prev !== undefined ? prev : this.T(this.t);
    o.history.push({ at: this.t, state: { ...state, eventT } });
  }

  private fill(o: SimOrder, qty: number, blind: boolean): void {
    const prev = this.state(o, this.t) as OrderState;
    const filled = prev.filled + qty;
    const status = filled === o.size ? "filled" : "open";
    this.update(o, { status, filled }, true);
    if (this.pa === 0) {
      this.life += 1;
      this.seq = 0;
    }
    const signed = o.side === "sell" ? -qty : qty;
    this.pa += signed;
    this.seq += 1;
    // Position updates are sequential, each stamped after the last.
    const posAt = Math.max(this.lastPosAt + 1, this.t + this.posLag(this.fills.length));
    this.lastPosAt = posAt;
    this.fills.push({ at: this.t, posAt, signed, pa: this.pa, life: this.life, seq: this.seq });
    this.trade += 1n;
    const X = status === "filled" ? "FILLED" : "OPEN";
    const S = o.side === "sell" ? ("SELL" as const) : ("BUY" as const);
    const T = this.T(this.t);
    const position = { position_id: `P${this.life}`, position_seq: this.seq };
    this.order(
      otu({
        c: blind ? "" : o.cid,
        i: o.id,
        S,
        q: blind ? "" : String(o.size),
        z: blind ? "" : String(filled),
        ...(blind ? { o: "", ot: "", f: "", p: "", sp: "", wt: "" } : {}),
        X: blind ? "PARTIALLY_FILLED" : X,
        T,
        t: this.trade,
        l: String(qty),
        trade_id: String(this.trade),
        ...position,
      }),
    );
    this.order(otu({ c: o.cid, i: o.id, S, q: String(o.size), X, z: String(filled), T }));
    this.emit(posAt, {
      kind: "position",
      E: this.T(posAt),
      variant: this.pa === 0 ? "POSITION_CLOSED" : "POSITION_UPDATE",
      T: this.T(posAt),
      positions: [
        {
          s: SYMBOL,
          pa: String(this.pa),
          ep: "0.0389",
          mt: "cross",
          ib: "0",
          ps: "BOTH",
          ...position,
        },
      ],
    });
  }

  private create(side: "buy" | "sell", size: number): SimOrder {
    const o: SimOrder = {
      cid: `bal_${this.orders.length}`,
      id: this.nextId++,
      side,
      size,
      createdAt: this.t,
      history: [],
    };
    this.update(o, { status: "open", filled: 0 });
    this.orders.push(o);
    this.onCreate(o);
    return o;
  }

  step(a: Action): void {
    this.t += 10;
    const open = this.orders.filter(
      (o) => o.side === "sell" && this.state(o, this.t)?.status === "open",
    );
    switch (a.kind) {
      case "wait":
        this.t += a.ms;
        return;
      case "create": {
        const o = this.create("sell", a.size);
        const common = { c: o.cid, i: o.id, q: String(o.size), T: this.T(this.t) };
        this.order(otu({ ...common, X: "NEW", x: "NEW" }));
        this.order(otu({ ...common, X: "OPEN" }));
        return;
      }
      case "fill": {
        const o = open[a.which % Math.max(1, open.length)];
        if (!o) return;
        const left = o.size - (this.state(o, this.t) as OrderState).filled;
        this.fill(o, Math.min(a.qty, left), a.blind);
        return;
      }
      case "cancel": {
        const o = open[a.which % Math.max(1, open.length)];
        if (!o) return;
        const filled = (this.state(o, this.t) as OrderState).filled;
        this.update(o, { status: "canceled", filled });
        this.order(
          otu({
            c: o.cid,
            i: o.id,
            q: String(o.size),
            X: "CANCELED",
            x: "CANCELED",
            z: String(filled),
            T: this.T(this.t),
          }),
        );
        return;
      }
      case "buyback": {
        if (this.pa >= 0) return;
        const o = this.create("buy", Math.min(a.qty, -this.pa));
        this.fill(o, o.size, a.blind);
      }
    }
  }

  /** Engine truth at real time `at`: short from every fill so far plus resting asks. */
  truth(at = this.t): number {
    let pa = 0;
    for (const f of this.fills) if (f.at <= at) pa += f.signed;
    let resting = 0;
    for (const o of this.orders) {
      const s = this.state(o, at);
      if (o.side === "sell" && s?.status === "open") resting += o.size - s.filled;
    }
    return Math.max(0, -pa) + resting;
  }

  enginePosition(): number {
    return this.pa;
  }

  row(o: SimOrder, at: number): StrikeOrder | undefined {
    const s = this.state(o, at);
    if (!s) return undefined;
    return {
      ID: o.id,
      ClientOrderID: o.cid,
      AccountID: "acct",
      Symbol: SYMBOL,
      CloseReason: "",
      Side: o.side,
      Status: s.status,
      Type: "limit",
      TimeInForce: "GTC",
      Size: String(o.size),
      Filled: String(s.filled),
      Price: "0.0389",
      PostOnly: o.side === "sell",
      ReduceOnly: o.side === "buy",
      CreateTimestamp: this.T(o.createdAt),
      EventTimestamp: s.eventT,
    };
  }

  /** GET /v2/openOrders as of engine state at `at`. */
  openOrders(at: number): StrikeOrder[] {
    return this.orders.flatMap((o) => {
      const r = this.row(o, at);
      return r?.Status === "open" ? [r] : [];
    });
  }

  /** GET /v2/positions as of the position service's state at `at`. */
  positions(at: number): StrikePosition[] {
    let last: SimFill | undefined;
    for (const f of this.fills) if (f.posAt <= at) last = f;
    if (!last || last.pa === 0) return [];
    return [
      {
        id: last.life,
        account_id: "acct",
        margin_mode: "cross",
        leverage: 2,
        size: String(last.pa),
        entry_price: "0.0389",
        iso_balance: "0",
        accumulated_funding_fees: "0",
        create_timestamp: 1,
        update_timestamp: this.T(last.posAt),
        symbol: SYMBOL,
        upnl: "0",
        maintenance_margin: "0",
        bankruptcy_price: "0",
        liquidation_price: "0",
      },
    ];
  }
}

/** Everything the reconciler is fed, on one timeline (the reconciler's local clock). */
interface Op {
  at: number;
  /** Tie order at the same instant: registrations, then deliveries, then REST results. */
  rank: number;
  run: () => void;
}

function world(offset = 0, posLag: (n: number) => number = () => 0, staleEventTs = false) {
  let local = 0;
  const rec = new AccountReconciler({ now: () => local, lagMs: LAG });
  const ops: Op[] = [];
  let lastDone = Number.NEGATIVE_INFINITY;
  const sim = new Sim(
    offset,
    posLag,
    (o) =>
      ops.push({
        at: sim.t,
        rank: 0,
        run: () =>
          rec.registerCreate({
            clientOrderId: o.cid,
            symbol: SYMBOL,
            side: o.side,
            size: String(o.size),
            price: "0.0389",
          }),
      }),
    staleEventTs,
  );
  return {
    sim,
    rec,
    ops,
    deliver(e: SimEvent, delay: number) {
      ops.push({ at: e.genAt + delay, rank: 1, run: () => rec.apply(e.event) });
    },
    /**
     * A resync requested at `at`: openOrders served `d1` later from a view `viewLag` old, the
     * answer back `d2` later, then the settle wait, positions served `d3` later, `viewLag2` old.
     */
    snapshot(when: number, d: { d1: number; d2: number; d3: number; v1: number; v2: number }) {
      // Resyncs run one at a time, as resyncAccount awaits each.
      const at = Math.max(when, lastDone + 1);
      const ordersReceivedAt = at + d.d1 + d.d2;
      const positionsRequestedAt = ordersReceivedAt + LAG;
      const done = positionsRequestedAt + d.d3 + d.d2;
      lastDone = done;
      ops.push({
        at: done,
        rank: 2,
        run: () =>
          rec.applySnapshot({
            openOrders: sim.openOrders(at + d.d1 - d.v1),
            positions: sim.positions(positionsRequestedAt + d.d3 - d.v2),
            ordersRequestedAt: at,
            ordersReceivedAt,
            positionsRequestedAt,
          }),
      });
    },
    /** PendingCreates' REST lookup of every still-unconfirmed create, served `v` stale. */
    lookups(at: number, v: number) {
      ops.push({
        at,
        rank: 2,
        run: () => {
          for (const o of sim.orders) {
            const r = sim.row(o, at - v);
            if (r && rec.order(o.cid)?.status === "sent") {
              rec.onCreateOutcome(o.cid, {
                kind: "confirmed",
                via: "rest",
                status: r.Status,
                orderId: o.id,
                order: r,
              });
            }
          }
        },
      });
    },
    /** Run every op in time order, calling `check` after each with the engine truth then. */
    play(check?: (total: number, truth: number, at: number) => void) {
      ops.sort((a, b) => a.at - b.at || a.rank - b.rank);
      for (const op of ops.splice(0)) {
        local = op.at;
        op.run();
        check?.(total(rec), sim.truth(op.at), op.at);
      }
    },
    get local() {
      return local;
    },
  };
}

const total = (rec: AccountReconciler) => Number(rec.exposure(SYMBOL).total);

const snapArb = fc.record({
  d1: fc.integer({ min: 0, max: 300 }),
  d2: fc.integer({ min: 0, max: 300 }),
  d3: fc.integer({ min: 0, max: 300 }),
  v1: fc.integer({ min: 0, max: 300 }),
  v2: fc.integer({ min: 0, max: 300 }),
});
const offsetArb = fc.integer({ min: 0, max: 2e12 });
/** Position updates lag their fill (strike-userstream's example: 100 ms), within LAG overall. */
const posLagArb = fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 50 });
const lagFn = (lags: readonly number[]) => (n: number) => lags[n % lags.length] ?? 0;

describe("AccountReconciler", () => {
  it("property: with every event delivered, in any order and delay, exposure and position are exact", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb(), { minLength: 10, maxLength: 60 }),
        fc.array(fc.nat({ max: 5_000 }), { minLength: 1, maxLength: 400 }),
        offsetArb,
        posLagArb,
        (actions, delays, offset, lags) => {
          const w = world(offset, lagFn(lags));
          w.sim.run(actions);
          for (const [i, e] of w.sim.events.entries()) w.deliver(e, delays[i % delays.length] ?? 0);
          w.play();
          expect(total(w.rec)).toBe(w.sim.truth());
          if (w.sim.fills.length > 0) {
            expect(w.rec.position(SYMBOL)).toBe(String(w.sim.enginePosition()));
          }
          for (const o of w.sim.orders) expect(w.rec.order(o.cid)?.orderId).toBe(o.id);
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it("property: under drops, delays and reordering, exposure never falls below the truth", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb(), { minLength: 10, maxLength: 60 }),
        fc.array(fc.nat({ max: 5_000 }), { minLength: 1, maxLength: 400 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 400 }),
        offsetArb,
        posLagArb,
        (actions, delays, keep, offset, lags) => {
          const w = world(offset, lagFn(lags));
          w.sim.run(actions);
          for (const [i, e] of w.sim.events.entries()) {
            if (keep[i % keep.length]) w.deliver(e, delays[i % delays.length] ?? 0);
          }
          w.play((est, truth) => expect(est).toBeGreaterThanOrEqual(truth));
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it("property: REST resyncs racing live activity, lagging views and lost events never under-count", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb(), { minLength: 10, maxLength: 80 }),
        fc.array(fc.nat({ max: 5_000 }), { minLength: 1, maxLength: 400 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 400 }),
        fc.array(fc.tuple(fc.nat(), snapArb), { minLength: 1, maxLength: 4 }),
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 300 })), { maxLength: 4 }),
        offsetArb,
        posLagArb,
        fc.boolean(),
        (actions, delays, keep, snaps, lookups, offset, lags, staleEventTs) => {
          const w = world(offset, lagFn(lags), staleEventTs);
          w.sim.run(actions);
          const end = w.sim.t + 3 * LAG;
          for (const [i, e] of w.sim.events.entries()) {
            if (keep[i % keep.length]) w.deliver(e, delays[i % delays.length] ?? 0);
          }
          const ordered = snaps.map(([t, d]) => [t % end, d] as const).sort((x, y) => x[0] - y[0]);
          for (const [at, d] of ordered) w.snapshot(at, d);
          for (const [at, v] of lookups) w.lookups(at % end, v);
          w.play((est, truth, at) => expect(est, `at ${at}`).toBeGreaterThanOrEqual(truth));
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it("property: Strike's clock offset changes nothing (no Strike time is compared with ours)", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb(), { minLength: 10, maxLength: 60 }),
        fc.array(fc.nat({ max: 5_000 }), { minLength: 1, maxLength: 200 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 200 }),
        fc.array(fc.tuple(fc.nat(), snapArb), { minLength: 1, maxLength: 3 }),
        offsetArb,
        offsetArb,
        posLagArb,
        (actions, delays, keep, snaps, a, b, lags) => {
          const trace = (offset: number) => {
            const w = world(offset, lagFn(lags));
            w.sim.run(actions);
            const end = w.sim.t + 3 * LAG;
            for (const [i, e] of w.sim.events.entries()) {
              if (keep[i % keep.length]) w.deliver(e, delays[i % delays.length] ?? 0);
            }
            const ordered = snaps
              .map(([t, d]) => [t % end, d] as const)
              .sort((x, y) => x[0] - y[0]);
            for (const [at, d] of ordered) w.snapshot(at, d);
            const out: string[] = [];
            w.play(() => out.push(JSON.stringify(w.rec.exposure(SYMBOL))));
            return out;
          };
          expect(trace(a)).toEqual(trace(b));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: a quiet REST resync restores exactness, and later events keep it", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb(), { minLength: 8, maxLength: 40 }),
        fc.array(actionArb(false), { minLength: 4, maxLength: 40 }),
        fc.array(fc.nat({ max: 3_000 }), { minLength: 1, maxLength: 400 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 400 }),
        snapArb,
        offsetArb,
        posLagArb,
        (before, after, delays, keep, d, offset, lags) => {
          const w = world(offset, lagFn(lags));
          w.sim.run(before);
          const pre = w.sim.events.length;
          for (const [i, e] of w.sim.events.entries()) {
            if (keep[i % keep.length]) w.deliver(e, delays[i % delays.length] ?? 0);
          }
          // Quiet: nothing in flight, then resync (unconfirmed creates resolved by lookups).
          const s1 = w.sim.t + 5 * LAG;
          w.snapshot(s1, d);
          w.lookups(s1 + 4 * LAG, 0);
          w.play((est, truth) => expect(est).toBeGreaterThanOrEqual(truth));
          // Stale duplicates of what was lost, then the next periodic resync.
          for (const [i, e] of w.sim.events.slice(0, pre).entries()) {
            if (!keep[i % keep.length]) w.deliver({ ...e, genAt: s1 + 5 * LAG }, i % 7);
          }
          const s2 = s1 + 8 * LAG;
          w.snapshot(s2, d);
          w.play((est, truth) => expect(est).toBeGreaterThanOrEqual(truth));
          expect(total(w.rec)).toBe(w.sim.truth());

          // New activity well after, registered as it is sent, every event delivered.
          w.sim.t = s2 + 5 * LAG;
          const firstNew = w.sim.events.length;
          w.sim.run(after);
          for (const [i, e] of w.sim.events.slice(firstNew).entries()) {
            w.deliver(e, delays[i % delays.length] ?? 0);
          }
          w.play((est, truth) => expect(est).toBeGreaterThanOrEqual(truth));
          expect(total(w.rec)).toBe(w.sim.truth());
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it("does not credit a listing's fills twice whatever Strike's clock says (review P6/P7)", () => {
    // Order of 10; fills of 4 (seq 1) and 2 (seq 2); the snapshot lists Filled 6 and the
    // position −6; then a fill of 1 (seq 3) and its position update. Truth: short 7 + resting 3.
    // Strike's clock runs ahead of or behind ours by up to 2.1 s, or wildly.
    for (const skew of [0, -900, -1_500, -2_100, 900, 1_500, 2_100, 1e9]) {
      const strike = (localMs: number) => 1_792_440_000_000 + localMs + skew;
      let local = 0;
      const rec = new AccountReconciler({ now: () => local, lagMs: LAG });
      rec.registerCreate({ clientOrderId: "bal_a", symbol: SYMBOL, side: "sell", size: "10" });
      const fill = (at: number, l: string, z: string, seq: number, trade: bigint) => {
        local = at;
        rec.applyOrderUpdate(
          otu({
            c: "bal_a",
            i: 7n,
            q: "10",
            X: "OPEN",
            T: strike(at),
            t: trade,
            l,
            z,
            position_id: "P1",
            position_seq: seq,
          }),
        );
      };
      const report = (at: number, positionAt: number, pa: string, seq: number) => {
        local = at;
        rec.applyStreamPosition(
          {
            s: SYMBOL,
            pa,
            ep: "1",
            mt: "cross",
            ib: "0",
            ps: "SHORT",
            position_id: "P1",
            position_seq: seq,
          },
          strike(positionAt),
        );
      };
      fill(100, "4", "4", 1, 1n);
      fill(150, "2", "6", 2, 2n);
      const row = new Sim().row(
        {
          cid: "bal_a",
          id: 7n,
          side: "sell",
          size: 10,
          createdAt: 0,
          history: [{ at: 0, state: { status: "open", filled: 6, eventT: strike(150) } }],
        },
        0,
      ) as StrikeOrder;
      local = 1_700;
      rec.applySnapshot({
        openOrders: [row],
        positions: [
          {
            id: 1,
            account_id: "acct",
            margin_mode: "cross",
            leverage: 2,
            size: "-6",
            entry_price: "1",
            iso_balance: "0",
            accumulated_funding_fees: "0",
            create_timestamp: 1,
            update_timestamp: strike(250),
            symbol: SYMBOL,
            upnl: "0",
            maintenance_margin: "0",
            bankruptcy_price: "0",
            liquidation_price: "0",
          },
        ],
        ordersRequestedAt: 200,
        ordersReceivedAt: 300,
        positionsRequestedAt: 1_310,
      });
      expect(total(rec), `skew ${skew}`).toBe(10);
      report(2_000, 100, "-4", 1); // a delayed, stale report
      expect(total(rec), `skew ${skew}`).toBe(10);
      fill(2_200, "1", "7", 3, 3n);
      report(2_300, 2_300, "-7", 3);
      expect(rec.exposure(SYMBOL), `skew ${skew}`).toMatchObject({
        shortQty: "7",
        restingAskQty: "3",
        total: "10",
      });
    }
  });

  it("ignores a resync that overlaps the previous one", () => {
    const anomalies: string[] = [];
    const rec = new AccountReconciler({ now: () => 0, onAnomaly: (a) => anomalies.push(a.kind) });
    const snap = (at: number) => ({
      openOrders: [],
      positions: [],
      ordersRequestedAt: at,
      ordersReceivedAt: at + 10,
      positionsRequestedAt: at + 10 + LAG,
    });
    rec.applySnapshot(snap(5_000));
    rec.applySnapshot(snap(5_500));
    expect(anomalies).toEqual(["overlapping-snapshot"]);
  });

  it("without the settle gap after openOrders, a listing's Filled is not credited", () => {
    let local = 0;
    const rec = new AccountReconciler({ now: () => local, lagMs: LAG });
    const sim = new Sim();
    sim.run([
      { kind: "create", size: 10 },
      { kind: "fill", which: 0, qty: 4, blind: false },
    ]);
    local = 5_000;
    // Positions read straight after openOrders: the position may not show the fill yet.
    rec.applySnapshot({
      openOrders: sim.openOrders(sim.t),
      positions: [],
      ordersRequestedAt: 4_000,
      ordersReceivedAt: 4_100,
      positionsRequestedAt: 4_200,
    });
    expect(rec.exposure(SYMBOL).total).toBe("10");
  });

  it("keeps unconfirmed creates through a snapshot and counts them as resting", () => {
    const rec = new AccountReconciler({ now: () => 100_000 });
    rec.registerCreate({ clientOrderId: "bal_x", symbol: SYMBOL, side: "sell", size: "300" });
    rec.applySnapshot({
      openOrders: [],
      positions: [],
      ordersRequestedAt: 99_000,
      ordersReceivedAt: 99_100,
      positionsRequestedAt: 99_100 + LAG,
    });
    expect(rec.exposure(SYMBOL)).toMatchObject({
      restingAskQty: "300",
      pendingCreateQty: "300",
      total: "300",
    });
    rec.onCreateOutcome("bal_x", { kind: "dropped", via: "rest-404" });
    expect(rec.exposure(SYMBOL).total).toBe("0");
  });

  it("counts an unknown-size order's recorded fills until a report reflects them", () => {
    const rec = new AccountReconciler({ now: () => 0 });
    // strike-userstream: a fill whose order snapshot was unavailable has c, q, z (and more) "".
    rec.applyOrderUpdate(
      otu({ c: "", i: 77n, X: "PARTIALLY_FILLED", q: "", z: "", p: "", T: 5, t: 9n, l: "3" }),
    );
    rec.applyOrderUpdate(otu({ c: "manual-1", i: 78n, X: "OPEN", q: "10", T: 5 }));
    expect(rec.exposure(SYMBOL)).toMatchObject({
      unknownOrders: 1,
      upperBound: false,
      foreignOrders: 2,
      restingAskQty: "13",
      total: "13",
    });
    expect(rec.cancelLegs(SYMBOL)).toEqual([
      { order_id: 77n, symbol: SYMBOL },
      { order_id: 78n, symbol: SYMBOL },
    ]);
    // Once its client id is known the placeholder folds into the named order.
    rec.registerCreate({ clientOrderId: "bal_k", symbol: SYMBOL, side: "sell", size: "20" });
    rec.applyOrderUpdate(otu({ c: "bal_k", i: 77n, X: "OPEN", q: "20", z: "3", T: 6 }));
    expect(rec.exposure(SYMBOL)).toMatchObject({ unknownOrders: 0, upperBound: true, total: "30" });
    expect(rec.order("bal_k")?.fills.size).toBe(1);
  });

  it("a REST-confirmed create that already filled keeps its fill in the exposure", () => {
    const rec = new AccountReconciler({ now: () => 0 });
    rec.registerCreate({ clientOrderId: "bal_f", symbol: SYMBOL, side: "sell", size: "300" });
    const sim = new Sim();
    sim.run([{ kind: "create", size: 300 }]);
    rec.onCreateOutcome("bal_f", {
      kind: "confirmed",
      via: "rest",
      status: "filled",
      orderId: 5n,
      order: {
        ...(sim.row(sim.orders[0] as SimOrder, sim.t) as StrikeOrder),
        ID: 5,
        Status: "filled",
        Filled: "300",
        EventTimestamp: 1,
      },
    });
    expect(rec.exposure(SYMBOL)).toMatchObject({
      restingAskQty: "0",
      unaccountedFillQty: "300",
      total: "300",
    });
  });
});

describe("reconcile against the fake server", () => {
  let h: Harness | undefined;
  let stream: UserStream | undefined;
  afterEach(async () => {
    stream?.stop();
    stream = undefined;
    await h?.stop();
    h = undefined;
  });

  it("cancel-all with its CANCELED events lost: still counted, until a resync clears it", async () => {
    h = await startHarness();
    const lag = 50;
    const rec = new AccountReconciler({ accountId: h.accountId, lagMs: lag });
    stream = new UserStream({
      url: h.fake.wsUrl,
      userAgent: UA,
      signer: h.signer,
      clock: h.clock,
      onEvent: (e) => rec.apply(e),
      onResyncNeeded: () => {},
    });
    stream.start();
    await vi.waitFor(() => expect(stream?.live).toBe(true));
    const ids = new ClientOrderIdFactory("rc");
    const asks = ["0.0389", "0.0390", "0.0391"].map((price) =>
      limitOrder({
        clientOrderId: ids.next(),
        symbol: SYMBOL,
        side: "sell",
        size: "300",
        price,
        postOnly: true,
      }),
    );
    for (const a of asks) {
      rec.registerCreate({
        clientOrderId: a.client_order_id,
        symbol: SYMBOL,
        side: "sell",
        size: "300",
      });
    }
    await h.client.placeBatch(batchOrders(asks));
    await vi.waitFor(() =>
      expect(asks.map((a) => rec.order(a.client_order_id)?.status)).toEqual([
        "open",
        "open",
        "open",
      ]),
    );
    h.fake.setEventFilter((_a, msg) => (msg.data as { X?: string } | undefined)?.X === "CANCELED");
    await h.client.cancelAll({ symbol: SYMBOL });
    await vi.waitFor(() => expect(h?.fake.engine.workingOrders(h.accountId)).toHaveLength(0));
    await sleep(30);
    // The book is empty, but nothing said so: the asks still count (unknown counts as resting).
    expect(rec.exposure(SYMBOL)).toMatchObject({ restingAskQty: "900", total: "900" });
    expect(rec.cancelLegs(SYMBOL)).toHaveLength(3);

    await sleep(lag);
    await resyncAccount(rec, h.client, { symbol: SYMBOL });
    expect(rec.exposure(SYMBOL)).toMatchObject({ restingAskQty: "0", total: "0" });
    expect(rec.cancelLegs(SYMBOL)).toEqual([]);
    const reads = h.fake.requests.filter((r) => r.method === "GET").map((r) => r.target);
    expect(reads).toEqual([`/v2/openOrders?symbol=${SYMBOL}`, `/v2/positions?symbol=${SYMBOL}`]);
  });
});
