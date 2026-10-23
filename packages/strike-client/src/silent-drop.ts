import { StrikeApiError, StrikeRefusedError } from "./errors.js";
import type { BatchOrdersResponse, StrikeOrder } from "./types.js";
import type { OrderTradeUpdate } from "./userstream.js";

/**
 * Strike answers 201/200 when a command is sequenced, before the engine runs it, and some
 * rejects happen before any order event exists (unknown symbol, market not open, a halted
 * market, a create missing side/type in a batch, or the creates a replace-batch skips after its
 * first rejection). Those orders never produce an event and `GET /v2/order` answers 404.
 *
 * Each create is registered before it is sent. An ORDER_TRADE_UPDATE with its client id
 * resolves it; after `lookupAfterMs` without one, it is looked up by client_order_id. Anything
 * found means it exists. A 404 "order not found" must repeat (`notFoundConfirmations` times,
 * each at least `lookupAfterMs` after the previous one) before the create is declared dropped;
 * until then it stays pending and counts as resting. Nothing is ever resent: the registry has no
 * send path, and a client id can be registered only once.
 */

// VERIFY: whether GET /v2/order (and /v2/openOrders) can see a create that is sequenced but not
// yet processed by the engine. If not, an engine slower than the repeated lookups makes a live
// order look dropped; the late event is then flagged (onLateEvent) and counted as resting again,
// never resent (FRICTION 2026-10-23).

export interface PendingCreate {
  account: string;
  symbol: string;
  clientOrderId: string;
  registeredAtMs: number;
  lookups: number;
  lastLookupAtMs?: number;
  lastLookupError?: string;
  /** Consecutive 404 answers; any other answer resets it. */
  notFound: number;
}

export type CreateOutcome =
  | { kind: "confirmed"; via: "stream"; status: string; orderId: bigint }
  | { kind: "confirmed"; via: "rest"; status: string; orderId: bigint; order: StrikeOrder }
  | { kind: "dropped"; via: "rest-404" }
  | { kind: "not-sent"; reason: string };

export type LookupResult = { found: true; order: StrikeOrder } | { found: false };

/** `GET /v2/order?symbol=..&client_order_id=..` for one account. */
export type OrderLookup = (
  account: string,
  symbol: string,
  clientOrderId: string,
) => Promise<LookupResult>;

export interface PendingCreatesOptions {
  lookup: OrderLookup;
  onOutcome: (pending: PendingCreate, outcome: CreateOutcome) => void;
  /** An event resolving a create that was already declared dropped or not sent. */
  onLateEvent?: (clientOrderId: string, update: OrderTradeUpdate) => void;
  now?: () => number;
  lookupAfterMs?: number;
  /** An account with a create unconfirmed for this long may not place new creates. */
  blockAfterMs?: number;
  /** Spacing between repeated lookups while the REST answer is an error. */
  relookupEveryMs?: number;
  /** Consecutive 404s, each at least lookupAfterMs apart, that declare a create dropped. */
  notFoundConfirmations?: number;
  tickMs?: number;
}

/** Builds the lookup from a signed client's getOrder: only `404 order not found` means absent. */
export function lookupVia(
  clientFor: (account: string) => {
    getOrder(symbol: string, ref: { clientOrderId: string }): Promise<StrikeOrder>;
  },
): OrderLookup {
  return async (account, symbol, clientOrderId) => {
    try {
      return { found: true, order: await clientFor(account).getOrder(symbol, { clientOrderId }) };
    } catch (err) {
      if (err instanceof StrikeApiError && err.status === 404 && err.code === "order not found") {
        return { found: false };
      }
      throw err;
    }
  };
}

export class PendingCreates {
  private readonly pending = new Map<string, PendingCreate>();
  private readonly everRegistered = new Set<string>();
  private readonly closed = new Set<string>();
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: PendingCreatesOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Call before sending. Throws if this client id was ever registered (never a duplicate). */
  register(account: string, symbol: string, clientOrderId: string): PendingCreate {
    if (this.everRegistered.has(clientOrderId)) {
      throw new Error(
        `client_order_id ${clientOrderId} was already used; creates are never resent`,
      );
    }
    this.everRegistered.add(clientOrderId);
    const p: PendingCreate = {
      account,
      symbol,
      clientOrderId,
      registeredAtMs: this.now(),
      lookups: 0,
      notFound: 0,
    };
    this.pending.set(clientOrderId, p);
    return p;
  }

  /** The request definitely did not reach the engine (a 4xx answer, or an item in `failed`). */
  notSent(clientOrderId: string, reason: string): void {
    this.resolve(clientOrderId, { kind: "not-sent", reason });
  }

  /**
   * Interpret a write's failure for the creates it carried. A local refusal never reached the
   * network, and an HTTP 4xx proves nothing was sequenced; a 5xx or a transport error leaves the
   * outcome unknown, so those stay pending.
   */
  // VERIFY: the docs say 400s publish nothing and auth (401/403/404) runs before the handler; a
  // 429 is assumed to come from rate-limit middleware that also runs before publishing.
  onSendError(clientOrderIds: readonly string[], err: unknown): void {
    if (err instanceof StrikeRefusedError) {
      for (const id of clientOrderIds) this.notSent(id, `refused (${err.kind}): ${err.reason}`);
    } else if (err instanceof StrikeApiError && err.status >= 400 && err.status < 500) {
      for (const id of clientOrderIds) this.notSent(id, `HTTP ${err.status} ${err.code}`);
    }
  }

  /** `failed` items of an orders/batch response were rejected API-side, before publishing. */
  onBatchResponse(clientOrderIds: readonly string[], res: BatchOrdersResponse): void {
    for (const f of res.failed ?? []) {
      const id = clientOrderIds[f.index];
      if (id !== undefined) this.notSent(id, f.error);
    }
  }

  onOrderUpdate(update: OrderTradeUpdate): void {
    const id = update.c;
    if (!id) return;
    if (this.pending.has(id)) {
      this.resolve(id, { kind: "confirmed", via: "stream", status: update.X, orderId: update.i });
    } else if (this.closed.has(id)) {
      this.opts.onLateEvent?.(id, update);
    }
  }

  private resolve(clientOrderId: string, outcome: CreateOutcome): void {
    const p = this.pending.get(clientOrderId);
    if (!p) return;
    this.pending.delete(clientOrderId);
    if (outcome.kind !== "confirmed") this.closed.add(clientOrderId);
    this.opts.onOutcome(p, outcome);
  }

  /** Unconfirmed creates count as resting: callers include them in pending_create_q. */
  unconfirmed(account?: string): PendingCreate[] {
    return [...this.pending.values()].filter((p) => account === undefined || p.account === account);
  }

  /** True while any create of `account` has been unconfirmed for at least blockAfterMs. */
  isBlocked(account: string): boolean {
    const limit = this.opts.blockAfterMs ?? 5_000;
    const now = this.now();
    for (const p of this.pending.values()) {
      if (p.account === account && now - p.registeredAtMs >= limit) return true;
    }
    return false;
  }

  /** Look up every create that has waited lookupAfterMs without an event. */
  async tick(): Promise<void> {
    const now = this.now();
    const after = this.opts.lookupAfterMs ?? 2_000;
    const every = this.opts.relookupEveryMs ?? 2_000;
    const due = [...this.pending.values()].filter(
      (p) =>
        !this.inFlight.has(p.clientOrderId) &&
        now - p.registeredAtMs >= after &&
        (p.lastLookupAtMs === undefined ||
          now - p.lastLookupAtMs >= (p.notFound > 0 ? Math.max(after, every) : every)),
    );
    await Promise.all(due.map((p) => this.lookupOne(p)));
  }

  private async lookupOne(p: PendingCreate): Promise<void> {
    this.inFlight.add(p.clientOrderId);
    p.lookups += 1;
    p.lastLookupAtMs = this.now();
    try {
      const r = await this.opts.lookup(p.account, p.symbol, p.clientOrderId);
      if (!this.pending.has(p.clientOrderId)) return;
      if (r.found) {
        this.resolve(p.clientOrderId, {
          kind: "confirmed",
          via: "rest",
          status: r.order.Status,
          orderId: BigInt(r.order.ID),
          order: r.order,
        });
        return;
      }
      p.notFound += 1;
      // One 404 is not proof: a sequenced create may not be visible yet (VERIFY above).
      if (p.notFound >= (this.opts.notFoundConfirmations ?? 2)) {
        this.resolve(p.clientOrderId, { kind: "dropped", via: "rest-404" });
      }
    } catch (err) {
      // Unknown stays unknown (and resting) until a lookup or an event says otherwise.
      p.notFound = 0;
      p.lastLookupError = err instanceof Error ? err.message : String(err);
    } finally {
      this.inFlight.delete(p.clientOrderId);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 250);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
