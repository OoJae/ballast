import {
  type MicroUsd,
  maxBigint,
  microUsd,
  minBigint,
  type NotionalRate,
  notionalCeil,
  type Steps,
  steps,
  stepsAtLeast,
  stepsWithin,
  type Ticks,
} from "@ballast/core";
import type { AccountCapacity } from "./capacity.js";

/** One account as the allocator sees it (from `accountCapacity`). */
export interface AllocAccount {
  id: string;
  holder0: boolean;
  /** C_i: committed cover, r × cover. */
  committed: Steps;
  /** S_i: short plus asks that stay counted. */
  used: Steps;
  /** K_i: what cover still allows. */
  room: Steps;
  /** USD the per-account caps still allow. */
  usdRoom: MicroUsd;
}

export interface AllocLevel {
  level: number;
  px: Ticks;
  /** Aggregate size the governor admitted at this level. */
  qty: Steps;
}

export interface AllocOptions {
  rate: NotionalRate;
  /** Every order must clear this notional (Ballast's $10.50). */
  minNotional: MicroUsd;
  /** USD the aggregate cap still allows across all accounts. */
  aggregateRoom: MicroUsd;
}

export interface Allocation {
  accountId: string;
  level: number;
  px: Ticks;
  qty: Steps;
}

export interface AllocationResult {
  /** Sorted by level, then account id. */
  allocations: Allocation[];
  /** Size per level nobody could take (capacity, caps or minimum notional). */
  unallocated: { level: number; qty: Steps }[];
}

export function allocAccount(c: AccountCapacity): AllocAccount {
  return {
    id: c.id,
    holder0: c.holder0,
    committed: c.committed,
    used: c.used,
    room: c.breached ? steps(0n) : c.room,
    usdRoom: microUsd(maxBigint(0n, c.usdCap - c.usdUsed)),
  };
}

/** Utilization resolution for the water level: fine enough that one step always registers. */
const D = 10n ** 18n;

interface FillItem {
  id: string;
  c: bigint;
  s: bigint;
  /** Upper bound on what this item may receive. */
  b: bigint;
}

const clamp = (x: bigint, lo: bigint, hi: bigint): bigint => (x < lo ? lo : x > hi ? hi : x);

/** (s_a / c_a) vs (s_b / c_b), exactly; ties by id. */
function byUtilization(a: { s: bigint; c: bigint; id: string }, b: typeof a): number {
  const l = a.s * b.c;
  const r = b.s * a.c;
  if (l !== r) return l < r ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Water-fill `q` steps so that (S_i + A_i)/C_i is as equal as possible, each A_i within
 * [0, b_i]. The water level is found exactly by bisection over u = n / D; the < n steps left
 * by flooring go one each to the least-utilized items, ties broken by id. Deterministic.
 */
export function waterFill(items: readonly FillItem[], q: bigint): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const live = items.filter((i) => i.c > 0n && i.b > 0n);
  for (const i of items) out.set(i.id, 0n);
  if (q <= 0n || live.length === 0) return out;
  const total = live.reduce((a, i) => a + i.b, 0n);
  if (total <= q) {
    for (const i of live) out.set(i.id, i.b);
    return out;
  }
  const at = (u: bigint, i: FillItem) => clamp((u * i.c) / D - i.s, 0n, i.b);
  const fill = (u: bigint) => live.reduce((a, i) => a + at(u, i), 0n);
  let lo = 0n;
  let hi = live.reduce((m, i) => maxBigint(m, ((i.s + i.b) * D + i.c - 1n) / i.c), 0n);
  // Invariant: fill(lo) ≤ q < fill(hi).
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (fill(mid) <= q) lo = mid;
    else hi = mid;
  }
  let left = q;
  for (const i of live) {
    const a = at(lo, i);
    out.set(i.id, a);
    left -= a;
  }
  while (left > 0n) {
    const open = live
      .filter((i) => (out.get(i.id) ?? 0n) < i.b)
      .map((i) => ({ id: i.id, c: i.c, s: i.s + (out.get(i.id) ?? 0n) }))
      .sort(byUtilization);
    if (open.length === 0) break;
    for (const o of open) {
      if (left === 0n) break;
      out.set(o.id, (out.get(o.id) ?? 0n) + 1n);
      left -= 1n;
    }
  }
  return out;
}

/**
 * Splits the admitted ladder across accounts, level by level from L1 out: outside accounts are
 * water-filled to equal utilization (S_i + A_i)/C_i, and holder #0 receives only what they
 * cannot take. A share below the minimum notional cannot be an order; that account sits the
 * level out and the rest is re-filled without it. Never exceeds cover, the per-account caps or
 * the aggregate cap.
 */
export function allocate(
  accounts: readonly AllocAccount[],
  ladder: readonly AllocLevel[],
  opts: AllocOptions,
): AllocationResult {
  const sorted = [...accounts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const state = new Map(
    sorted.map((a) => [a.id, { used: a.used, room: a.room, usd: a.usdRoom as bigint }]),
  );
  let aggregate: bigint = opts.aggregateRoom;
  const allocations: Allocation[] = [];
  const unallocated: AllocationResult["unallocated"] = [];

  for (const lvl of [...ladder].sort((a, b) => a.level - b.level)) {
    const minQty = stepsAtLeast(opts.minNotional, lvl.px, opts.rate);
    let q = minBigint(lvl.qty, stepsWithin(microUsd(maxBigint(0n, aggregate)), lvl.px, opts.rate));
    const bound = (a: AllocAccount): bigint => {
      const st = state.get(a.id);
      if (!st || a.committed <= 0n) return 0n;
      const b = minBigint(st.room, stepsWithin(microUsd(maxBigint(0n, st.usd)), lvl.px, opts.rate));
      return b >= minQty ? b : 0n;
    };
    const item = (a: AllocAccount): FillItem => ({
      id: a.id,
      c: a.committed,
      s: state.get(a.id)?.used ?? 0n,
      b: bound(a),
    });
    const outside = sorted.filter((a) => !a.holder0).map(item);
    const outsideRoom = outside.reduce((s, i) => s + i.b, 0n);
    const given = new Map<string, bigint>();

    let pool = outside.filter((i) => i.b > 0n);
    let target = minBigint(q, outsideRoom);
    for (let round = 0; round <= sorted.length && pool.length > 0; round++) {
      const shares = waterFill(pool, target);
      const tooSmall = pool.filter((i) => {
        const s = shares.get(i.id) ?? 0n;
        return s > 0n && s < minQty;
      });
      if (tooSmall.length === 0) {
        for (const [id, s] of shares) if (s > 0n) given.set(id, s);
        break;
      }
      // Drop only the smallest share (ties: the last id) and re-fill: the others' shares grow,
      // so many equal small accounts still clear the minimum once a few sit out.
      const worst = tooSmall.reduce((w, i) => {
        const si = shares.get(i.id) ?? 0n;
        const sw = shares.get(w.id) ?? 0n;
        return si < sw || (si === sw && i.id > w.id) ? i : w;
      });
      pool = pool.filter((i) => i.id !== worst.id);
      target = minBigint(
        target,
        pool.reduce((s, i) => s + i.b, 0n),
      );
    }
    // Holder #0 is last: only the size outside accounts have no room for at all.
    if (q > outsideRoom) {
      for (const a of sorted.filter((x) => x.holder0)) {
        const take = minBigint(bound(a), q - outsideRoom - sumOf(given, sorted, true));
        if (take >= minQty && take > 0n) given.set(a.id, take);
      }
    }
    let placed = 0n;
    for (const a of sorted) {
      const qty = given.get(a.id) ?? 0n;
      if (qty <= 0n) continue;
      const st = state.get(a.id);
      if (!st) continue;
      const usd = notionalCeil(lvl.px, steps(qty), opts.rate);
      st.used = steps(st.used + qty);
      st.room = steps(st.room - qty);
      st.usd -= usd;
      aggregate -= usd;
      placed += qty;
      allocations.push({ accountId: a.id, level: lvl.level, px: lvl.px, qty: steps(qty) });
    }
    q = lvl.qty - placed;
    if (q > 0n) unallocated.push({ level: lvl.level, qty: steps(q) });
  }
  return { allocations, unallocated };
}

function sumOf(
  given: ReadonlyMap<string, bigint>,
  accounts: readonly AllocAccount[],
  holder0: boolean,
): bigint {
  let s = 0n;
  for (const a of accounts) if (a.holder0 === holder0) s += given.get(a.id) ?? 0n;
  return s;
}

/** An account's allocation per level, for the differ and the Guard's conformance check. */
export function allocationFor(result: AllocationResult, accountId: string): Allocation[] {
  return result.allocations.filter((a) => a.accountId === accountId);
}
