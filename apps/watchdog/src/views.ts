/**
 * The watchdog's own views, independent of the keeper (plan section 2: "its own L3/index/Koios
 * reads"): one L3 connection, the `markprice@1s` stream for index and mark, `/v2/markets` for
 * the grid and margin tiers, live positions for the floor (reduced to the four fields it reads),
 * and a Koios cover read per bound account. Public data only; no keys are needed for any of it.
 */
import type { CoverProof, CoverSubject } from "@ballast/cover";
import { type Dec, dec, type FloorPosition, type MarketSpec, marketSpec } from "@ballast/market";
import {
  type L3Book,
  L3Feed,
  type PublicReads,
  ReconnectingSocket,
  type SocketState,
} from "@ballast/strike-client/cancel-only";

export interface WatchdogMarketView {
  spec: MarketSpec | null;
  book: Pick<L3Book, "asks" | "bids"> | null;
  l3Synced: boolean;
  index: Dec | null;
  mark: Dec | null;
  indexAgeMs: number;
  positions: FloorPosition[];
  positionsAgeMs: number;
}

export interface WatchdogMarket {
  view(): WatchdogMarketView;
}

export interface ViewLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export class LiveWatchdogMarket implements WatchdogMarket {
  readonly l3: L3Feed;
  private readonly price: ReconnectingSocket;
  private spec: MarketSpec | null = null;
  private tick: { index: Dec; mark: Dec; at: number } | null = null;
  private positions: FloorPosition[] = [];
  private positionsAt = Number.NEGATIVE_INFINITY;
  private l3State: SocketState = "stopped";
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly opts: {
      wsOrigin: string;
      userAgent: string;
      symbol: string;
      reads: PublicReads;
      logger: ViewLogger;
      now?: () => number;
      pollEveryMs?: number;
      onChange?: () => void;
      rebuildCooldownMs?: number;
    },
  ) {
    this.l3 = new L3Feed({
      url: `${opts.wsOrigin}/ws/l3`,
      userAgent: opts.userAgent,
      symbols: [opts.symbol],
      fetchSnapshot: (s) => opts.reads.l3Snapshot(s),
      onUpdate: () => opts.onChange?.(),
      onSnapshot: () => opts.onChange?.(),
      onRebuild: (symbol, reason) => opts.logger.warn({ symbol, reason }, "watchdog l3 rebuild"),
      onStateChange: (state) => {
        this.l3State = state;
      },
      ...(opts.rebuildCooldownMs !== undefined
        ? { rebuildCooldownMs: opts.rebuildCooldownMs }
        : {}),
    });
    this.price = new ReconnectingSocket({
      url: `${opts.wsOrigin}/ws/price`,
      userAgent: opts.userAgent,
      onOpen: (s) => {
        s.send({
          method: "SUBSCRIBE",
          params: [`${opts.symbol.toLowerCase()}@markprice@1s`],
          id: 1,
        });
      },
      onMessage: (m) => {
        const d = m as Record<string, unknown> | null;
        if (d?.e !== "markPriceUpdate" || d.s !== opts.symbol) return;
        try {
          this.tick = { index: dec(String(d.i)), mark: dec(String(d.p)), at: this.now() };
          opts.onChange?.();
        } catch {}
      },
    });
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  async refresh(): Promise<void> {
    const { markets } = await this.opts.reads.markets();
    const m = markets[this.opts.symbol];
    if (m) this.spec = marketSpec(m as never);
    const lp = await this.opts.reads.livePositions();
    this.positions = (lp.positions ?? [])
      .filter((p) => p.symbol === this.opts.symbol)
      .map((p) => ({
        size: p.size,
        entryPrice: p.entry_price,
        markPrice: p.mark_price,
        liquidationPrice: p.liquidation_price,
      }));
    this.positionsAt = Number.isFinite(Number(lp.updated_at))
      ? Number(lp.updated_at)
      : Number.NEGATIVE_INFINITY;
  }

  start(): void {
    const poll = () =>
      void this.refresh().catch((err) =>
        this.opts.logger.warn({ err: String(err) }, "watchdog poll failed"),
      );
    poll();
    const t = setInterval(poll, this.opts.pollEveryMs ?? 60_000);
    t.unref();
    this.timers.push(t);
    this.l3.start();
    this.price.start();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.l3.stop();
    this.price.stop();
  }

  view(): WatchdogMarketView {
    const book = this.l3.books.get(this.opts.symbol) ?? null;
    const now = this.now();
    return {
      spec: this.spec,
      book,
      l3Synced: book?.synced === true && this.l3State === "open",
      index: this.tick?.index ?? null,
      mark: this.tick?.mark ?? null,
      indexAgeMs: this.tick ? now - this.tick.at : Number.POSITIVE_INFINITY,
      positions: this.positions,
      positionsAgeMs: now - this.positionsAt,
    };
  }
}

export interface WatchdogCoverState {
  coverBase: bigint;
  /** The previous proof's cover, to see a drop between blocks. */
  prevCoverBase: bigint | null;
  checkedAtMs: number;
  height: number;
}

export interface WatchdogCover {
  view(accountId: string): WatchdogCoverState | null;
}

/** Koios cover per account, polled; keeps the previous proof so a drop is visible. */
export class LiveWatchdogCover implements WatchdogCover {
  private readonly states = new Map<string, WatchdogCoverState>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly opts: {
      oracle: { proof(subject: CoverSubject): Promise<CoverProof> };
      subjects: readonly { accountId: string; stakeAddress: string }[];
      everyMs?: number;
      onError?: (accountId: string, err: string) => void;
    },
  ) {}

  accept(accountId: string, proof: CoverProof): void {
    const prev = this.states.get(accountId);
    if (prev && proof.height <= prev.height) return;
    this.states.set(accountId, {
      coverBase: BigInt(proof.coverBase),
      prevCoverBase: prev?.coverBase ?? null,
      checkedAtMs: proof.checkedAtMs,
      height: proof.height,
    });
  }

  async pollOnce(): Promise<void> {
    await Promise.all(
      this.opts.subjects.map(async (s) => {
        try {
          this.accept(
            s.accountId,
            await this.opts.oracle.proof({ kind: "stake", stakeAddress: s.stakeAddress }),
          );
        } catch (err) {
          this.opts.onError?.(s.accountId, err instanceof Error ? err.message : String(err));
        }
      }),
    );
  }

  start(): void {
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.opts.everyMs ?? 10_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  view(accountId: string): WatchdogCoverState | null {
    return this.states.get(accountId) ?? null;
  }
}
