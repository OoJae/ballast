/**
 * Market state (plan section 2, step 2): the gap-free L3 book, the price stream's mark and
 * index, the mark replica, live positions (a safety input only) and the market rules, each with
 * the time it was last refreshed so the daemon can tell fresh from stale.
 *
 * Public data only (data policy): L3, `markprice@1s`, `/v2/markets` and live positions, the
 * latter reduced at once to the four fields the floor reads, so no trader identity is held.
 */
import { type EngineMarket, engineMarket, type StrikeMarketRules } from "@ballast/engine";
import {
  bookTop,
  type Dec,
  DOCUMENTED_MARK_PARAMS,
  dec,
  type FloorPosition,
  levelsFromL3,
  MarkReplica,
} from "@ballast/market";
import {
  type L3Book,
  L3Feed,
  type PublicReads,
  ReconnectingSocket,
  type SocketState,
} from "@ballast/strike-client";

export interface PriceTick {
  mark: Dec;
  index: Dec;
  rate: Dec;
  nextFundingMs: number;
  /** Strike's event time (E). */
  eventMs: number;
  /** Local receive time. */
  recvMs: number;
}

export interface MarketView {
  symbol: string;
  market: EngineMarket | null;
  /** now − last successful `/v2/markets` conversion (Infinity before one). */
  marketsAgeMs: number;
  book: Pick<L3Book, "bids" | "asks"> | null;
  /** The book is bootstrapped and every update since advanced the sequence by exactly 1. */
  l3Synced: boolean;
  price: PriceTick | null;
  indexAgeMs: number;
  markAgeMs: number;
  positions: FloorPosition[];
  positionsAgeMs: number;
  /** The replica's last mark and its distance from the served mark (D6 drift monitoring). */
  replica: { mark: Dec | null; errorBps: Dec | null };
}

/** What the daemon reads; LiveMarketState implements it, tests pass static views. */
export interface MarketSource {
  view(symbol: string): MarketView;
}

export interface MarketLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface LiveMarketOptions {
  wsOrigin: string;
  userAgent: string;
  symbols: readonly string[];
  reads: PublicReads;
  logger: MarketLogger;
  now?: () => number;
  /** `/v2/markets` refresh (plan section 4: every 60 s). */
  marketsEveryMs?: number;
  /** Live positions are cached 3–10 min server-side; polling faster only costs requests. */
  positionsEveryMs?: number;
  /** Fired on every mark tick and L3 change, so the daemon can schedule a tick. */
  onChange?: (symbol: string, what: "price" | "l3" | "rules" | "positions") => void;
  rebuildCooldownMs?: number;
}

interface SymbolState {
  market: EngineMarket | null;
  marketsAt: number;
  price: PriceTick | null;
  positions: FloorPosition[];
  positionsUpdatedAt: number;
  replica: MarkReplica | null;
  replicaMark: Dec | null;
  replicaErrorBps: Dec | null;
}

const NEVER = Number.NEGATIVE_INFINITY;

export class LiveMarketState implements MarketSource {
  readonly l3: L3Feed;
  private readonly price: ReconnectingSocket;
  private readonly state = new Map<string, SymbolState>();
  private readonly timers: NodeJS.Timeout[] = [];
  private l3State: SocketState = "stopped";
  private priceState: SocketState = "stopped";

  constructor(private readonly opts: LiveMarketOptions) {
    for (const s of opts.symbols) {
      this.state.set(s, {
        market: null,
        marketsAt: NEVER,
        price: null,
        positions: [],
        positionsUpdatedAt: NEVER,
        replica: null,
        replicaMark: null,
        replicaErrorBps: null,
      });
    }
    this.l3 = new L3Feed({
      url: `${opts.wsOrigin}/ws/l3`,
      userAgent: opts.userAgent,
      symbols: [...opts.symbols],
      fetchSnapshot: (s) => opts.reads.l3Snapshot(s),
      onUpdate: (u) => {
        if ((u.action === "partial_fill" || u.action === "full_fill") && u.price) {
          this.state.get(u.symbol)?.replica?.onTrade(u.price);
        }
        opts.onChange?.(u.symbol, "l3");
      },
      onSnapshot: (s) => opts.onChange?.(s.symbol, "l3"),
      onRebuild: (symbol, reason, detail) => {
        opts.logger.warn({ symbol, reason, detail }, "l3 rebuild");
        opts.onChange?.(symbol, "l3");
      },
      onStateChange: (state, info) => {
        this.l3State = state;
        opts.logger.info({ state, ...info }, "l3 socket");
      },
      ...(opts.rebuildCooldownMs !== undefined
        ? { rebuildCooldownMs: opts.rebuildCooldownMs }
        : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    // markprice@1s must not share a socket with @markprice (identical payloads, plan section 4).
    const params = opts.symbols.map((s) => `${s.toLowerCase()}@markprice@1s`);
    this.price = new ReconnectingSocket({
      url: `${opts.wsOrigin}/ws/price`,
      userAgent: opts.userAgent,
      onOpen: (sock) => {
        sock.send({ method: "SUBSCRIBE", params, id: 1 });
      },
      onMessage: (m) => this.onPrice(m),
      onStateChange: (state, info) => {
        this.priceState = state;
        opts.logger.info({ state, ...info }, "price socket");
      },
      ...(opts.now ? { now: opts.now } : {}),
    });
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private onPrice(m: unknown): void {
    if (typeof m !== "object" || m === null) return;
    const d = m as Record<string, unknown>;
    if (d.e !== "markPriceUpdate" || typeof d.s !== "string") return;
    const st = this.state.get(d.s);
    if (!st) return;
    try {
      const tick: PriceTick = {
        mark: dec(String(d.p)),
        index: dec(String(d.i)),
        rate: dec(String(d.r ?? "0")),
        nextFundingMs: Number(d.T),
        eventMs: Number(d.E),
        recvMs: this.now(),
      };
      if (!tick.mark.isPositive() || !tick.index.isPositive()) return;
      st.price = tick;
      this.cycleReplica(d.s, st, tick);
      this.opts.onChange?.(d.s, "price");
    } catch (err) {
      this.opts.logger.warn({ err: String(err) }, "unreadable markPriceUpdate");
    }
  }

  /** One replica cycle per published mark: basis from the full L3 book, then the median. */
  private cycleReplica(symbol: string, st: SymbolState, tick: PriceTick): void {
    const book = this.l3.books.get(symbol);
    if (!st.market || !book?.synced) return;
    st.replica ??= new MarkReplica(DOCUMENTED_MARK_PARAMS, st.market.spec);
    const top = bookTop(levelsFromL3(book, st.market.spec), st.market.spec, tick.eventMs);
    st.replica.addBasis(top, tick.index);
    const out = st.replica.cycle(tick.eventMs, tick.index, tick.nextFundingMs, top);
    st.replicaMark = out?.mark ?? null;
    st.replicaErrorBps = out ? out.mark.minus(tick.mark).abs().div(tick.mark).times(10_000) : null;
  }

  async refreshMarkets(): Promise<void> {
    const { markets } = await this.opts.reads.markets();
    for (const [symbol, st] of this.state) {
      const m = markets[symbol];
      if (!m) continue;
      try {
        st.market = engineMarket(m as StrikeMarketRules);
        st.marketsAt = this.now();
        this.opts.onChange?.(symbol, "rules");
      } catch (err) {
        // A missing rule field stops quoting rather than loosening a check (engineMarket).
        st.market = null;
        this.opts.logger.warn({ symbol, err: String(err) }, "unusable /v2/markets row");
      }
    }
  }

  async refreshPositions(): Promise<void> {
    const payload = await this.opts.reads.livePositions();
    const at = Number(payload.updated_at);
    for (const [symbol, st] of this.state) {
      st.positions = (payload.positions ?? [])
        .filter((p) => p.symbol === symbol)
        .map((p) => ({
          size: p.size,
          entryPrice: p.entry_price,
          markPrice: p.mark_price,
          liquidationPrice: p.liquidation_price,
        }));
      st.positionsUpdatedAt = Number.isFinite(at) ? at : NEVER;
      this.opts.onChange?.(symbol, "positions");
    }
  }

  private poll(name: string, everyMs: number, run: () => Promise<void>): void {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        await run();
      } catch (err) {
        this.opts.logger.warn(
          { name, err: err instanceof Error ? err.message : String(err) },
          "poll failed",
        );
      } finally {
        busy = false;
      }
    };
    void tick();
    const t = setInterval(tick, everyMs);
    t.unref();
    this.timers.push(t);
  }

  start(): void {
    this.poll("markets", this.opts.marketsEveryMs ?? 60_000, () => this.refreshMarkets());
    this.poll("positions", this.opts.positionsEveryMs ?? 60_000, () => this.refreshPositions());
    this.l3.start();
    this.price.start();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    this.l3.stop();
    this.price.stop();
  }

  sockets(): { l3: SocketState; price: SocketState } {
    return { l3: this.l3State, price: this.priceState };
  }

  view(symbol: string): MarketView {
    const st = this.state.get(symbol);
    const now = this.now();
    const book = this.l3.books.get(symbol) ?? null;
    const age = (t: number | undefined) => (t === undefined ? Number.POSITIVE_INFINITY : now - t);
    return {
      symbol,
      market: st?.market ?? null,
      marketsAgeMs: age(st?.marketsAt),
      book,
      l3Synced: book?.synced === true && this.l3State === "open",
      price: st?.price ?? null,
      indexAgeMs: age(st?.price?.recvMs),
      markAgeMs: age(st?.price?.recvMs),
      positions: st?.positions ?? [],
      positionsAgeMs: age(st?.positionsUpdatedAt),
      replica: { mark: st?.replicaMark ?? null, errorBps: st?.replicaErrorBps ?? null },
    };
  }
}
