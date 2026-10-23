import type {
  BookFrame,
  BookHealthResponse,
  CapacityResponse,
  ReplayIndexResponse,
  SeriesResponse,
} from "@ballast/api/types";
import { lazy, Suspense, useMemo } from "react";
import { useApi, useBookStream } from "../api";
import { CapacityGauge } from "../components/Capacity";
import { DepthChart } from "../components/DepthChart";
import { Ladder } from "../components/Ladder";
import { metric } from "../components/Scorecard";
import { footnotes, type SourceDef, SourceList } from "../components/Sources";
import { Stat } from "../components/Stat";
import type { ChartLine } from "../components/TimeChart";
import { API_LINK, HOLDERS_SOURCE, NIGHT_HOLDERS, RECORDER_START } from "../facts";
import { fmtBps, fmtInt, fmtUsd, fmtUtc, fmtUtcTime, shortHash } from "../lib/format";
import { Link } from "../router";

const TimeChart = lazy(() =>
  import("../components/TimeChart").then((m) => ({ default: m.TimeChart })),
);

const SYMBOL = "NIGHT-USD";

function windowText(h: BookHealthResponse | null): string {
  if (!h) return "every sealed recorded hour";
  return `${fmtUtc(h.fromMs)} to ${fmtUtcTime(h.toMs, false)} UTC, ${h.provenance.hours.length} sealed hours`;
}

export function BookCard({ frame, live }: { frame: BookFrame | null; live: string }) {
  const src = frame?.source;
  return (
    <section className="card" aria-labelledby="book-title">
      <div className="card-head">
        <h2 id="book-title" className="card-title">
          {SYMBOL} order book
        </h2>
        {frame ? (
          <span className={`chip${src?.kind === "live" ? " good" : ""}`}>
            <span className={`dot ${live === "open" ? "on" : "wait"}`} aria-hidden="true" />
            {src?.kind === "live" ? "Live" : "Replay"} · {fmtUtcTime(frame.tMs)} UTC · L3 #
            {fmtInt(frame.sequence)}
          </span>
        ) : null}
      </div>
      {frame ? (
        <>
          <Ladder frame={frame} />
          <div className="legend" style={{ marginTop: 14 }}>
            <span>
              <span className="key box" style={{ background: "var(--bid)", opacity: 0.6 }} />
              Bids
            </span>
            <span>
              <span className="key box" style={{ background: "var(--ask)", opacity: 0.6 }} />
              Asks
            </span>
            <span>
              <span className="key box" style={{ background: "var(--ballast)" }} />
              Ballast asks · {frame.ballastOrders} resting
            </span>
          </div>
          <p className="tiny muted" style={{ marginTop: 10 }}>
            {src?.kind === "live" ? (
              <>Strike's public L3 feed, aggregated by price level.</>
            ) : (
              <>
                Replayed at recorded speed from sealed hour <code>{src?.hour}</code>
                {src?.root ? (
                  <>
                    {" "}
                    (Merkle root <span className="hash">{shortHash(src.root, 8)}</span>)
                  </>
                ) : null}
                . Rebuilt order by order from Strike's public L3 feed; this is a recording, not a
                live quote.
              </>
            )}
          </p>
        </>
      ) : (
        <div className="chart-skeleton" style={{ height: 380 }}>
          <span className="visually-hidden">Loading the book</span>
        </div>
      )}
    </section>
  );
}

export function Home() {
  const { frame, state } = useBookStream(SYMBOL);
  const health = useApi<BookHealthResponse>(`/api/book-health?symbol=${SYMBOL}`);
  const cap = useApi<CapacityResponse>(`/api/capacity/${SYMBOL}`);
  const idx = useApi<ReplayIndexResponse>(`/api/replay/${SYMBOL}`);
  const fine = idx.data?.fineWindows.at(-1) ?? idx.data?.windows.at(-1) ?? null;
  const series = useApi<SeriesResponse>(
    fine ? `/api/series/${SYMBOL}?from=${fine.fromMs}&to=${fine.toMs}&step=10000` : null,
  );
  const lines = useMemo<ChartLine[]>(() => {
    const s = series.data;
    if (!s) return [];
    return [
      { id: "ask", label: "Best ask", color: "ask", t: s.t, v: s.bestAsk },
      { id: "bid", label: "Best bid", color: "bid", t: s.t, v: s.bestBid },
      { id: "cf", label: "Mid without Ballast", color: "cf", dashed: true, t: s.t, v: s.ref },
    ];
  }, [series.data]);

  const r = health.data?.report;
  const spread = metric(r, "spreadBps");
  const ask05 = metric(r, "depthUsd.ask.0.5%");
  const bid05 = metric(r, "depthUsd.bid.0.5%");
  const buy1k = metric(r, "slippageBps.buy.1000");

  const sources: SourceDef[] = [
    {
      id: "bh",
      title: `Book Health, time-weighted over ${windowText(health.data)}, replayed from sealed L3 segments`,
      text: (
        <>
          Book Health, time-weighted at 1 s over {windowText(health.data)}:{" "}
          {API_LINK(`/api/book-health?symbol=${SYMBOL}`)}. Computed by <code>@ballast/market</code>{" "}
          from L3 segments hashed into hourly Merkle roots; check them in{" "}
          <Link to="/judge">judge mode</Link>.
        </>
      ),
    },
    {
      id: "book",
      title: "The last sealed hour of L3 recordings, replayed at recorded speed",
      text: (
        <>
          Book: {API_LINK(`/api/stream/${SYMBOL}`)} (server-sent events), the last sealed recorded
          hour played back at recorded speed. Each frame carries its L3 sequence number and hour
          root.
        </>
      ),
    },
    HOLDERS_SOURCE,
    {
      id: "cap",
      title: "Capacity inputs from the last 24 sealed hours of L3 recordings",
      text: (
        <>
          Capacity: {API_LINK(`/api/capacity/${SYMBOL}`)}. Taker buys are resting asks lifted on L3;
          exit depth is the time-weighted ask depth within 2% with Ballast removed.
        </>
      ),
    },
    {
      id: "pos",
      title: "Strike's public live-positions endpoint, as recorded; aggregate counts only",
      text: (
        <>
          Open positions: Strike's public <code>/stat/v1/stats/live-positions</code>, latest
          recorded snapshot, counted by direction only. No address, size, leverage or liquidation
          price is shown.
        </>
      ),
    },
  ];
  const fn = footnotes(sources);
  const pos = cap.data?.livePositions;

  return (
    <>
      <section className="hero grid grid-hero">
        <div>
          <p className="overline brass">Strike Finance · NIGHT-USD perpetual</p>
          <h1 style={{ marginTop: 14 }}>Covered liquidity for a thin book.</h1>
          <p className="claim">
            <strong>
              The first market maker on Strike whose every quote is covered by coins in a Cardano
              wallet
            </strong>{" "}
            — checkable block by block on Koios and order by order on L3.
          </p>
          <p className="lede" style={{ marginTop: 14, fontSize: "1rem" }}>
            NIGHT holders keep their coins in Lace or Eternl as cover. A deterministic,
            Guard-governed keeper posts post-only asks from each holder's own Strike account into
            the empty ask side of the book.
          </p>
          <div className="hero-actions">
            <Link to="/judge" className="btn primary">
              Open judge mode
            </Link>
            <Link to="/book-health" className="btn">
              See Book Health
            </Link>
          </div>
          <div className="status-line">
            <span>
              <span className="dot on" aria-hidden="true" />
              Recording Strike's public L3 since {RECORDER_START}
            </span>
            <span>
              <span className="dot wait" aria-hidden="true" />
              Ballast quoting: not armed yet
            </span>
          </div>
        </div>
        <BookCard frame={frame} live={state} />
      </section>

      <section className="section" aria-label="The before book in numbers">
        <div className="stats">
          <Stat
            label="Spread"
            value={fmtBps(spread)}
            unit="bps"
            fn={fn("bh")}
            note="time-weighted"
          />
          <Stat label="Asks within 0.5%" value={fmtUsd(ask05)} fn={fn("bh")} note="of the mid" />
          <Stat
            label="Bids within 0.5%"
            value={fmtUsd(bid05, { compact: true })}
            fn={fn("bh")}
            note="of the mid"
          />
          <Stat
            label="$1K market buy"
            value={fmtBps(buy1k)}
            unit="bps"
            fn={fn("bh")}
            note="paid over mid"
          />
          <Stat
            label="Staked wallets hold NIGHT"
            value={NIGHT_HOLDERS.toLocaleString("en-US")}
            fn={fn("holders")}
            note="on Cardano"
            wide
          />
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div style={{ display: "grid", gap: 8 }}>
            <p className="overline">The before book</p>
            <h2>NIGHT's ask side is empty within 0.5%.</h2>
          </div>
          <p>
            {ask05 !== null && bid05 !== null
              ? `${fmtUsd(ask05)} of asks against ${fmtUsd(bid05)} of bids near the mid.`
              : "Measuring…"}
          </p>
        </div>
        <div className="grid grid-2">
          <div className="card">
            <div className="card-head">
              <h3 className="card-title">Depth within 2% of the mid, now playing{fn("book")}</h3>
              <div className="legend">
                <span>
                  <span className="key" style={{ background: "var(--bid)" }} />
                  Bids
                </span>
                <span>
                  <span className="key" style={{ background: "var(--ask)" }} />
                  Asks
                </span>
              </div>
            </div>
            {frame ? (
              <DepthChart frame={frame} />
            ) : (
              <div className="chart-skeleton" style={{ height: 240 }} />
            )}
            <p className="tiny muted" style={{ marginTop: 8 }}>
              Cumulative USD outward from the mid. Shaded: ±0.5%. Hover for depth at any distance.
            </p>
          </div>
          <div className="card">
            <div className="card-head">
              <h3 className="card-title">Best bid and ask over the replayed hour{fn("bh")}</h3>
            </div>
            <Suspense fallback={<div className="chart-skeleton" style={{ height: 260 }} />}>
              {lines.length ? (
                <TimeChart
                  lines={lines}
                  precision={6}
                  marker={frame?.source.kind === "replay" ? frame.tMs : null}
                  ariaLabel={`${SYMBOL} best bid, best ask and counterfactual mid over the replayed hour`}
                />
              ) : (
                <div className="chart-skeleton" style={{ height: 290 }} />
              )}
            </Suspense>
            <p className="tiny muted" style={{ marginTop: 8 }}>
              The dashed line is the mid with Ballast's orders removed: the yardstick every Book
              Health number is measured against. With no Ballast orders yet, it is the mid itself.
              The arrow marks the moment now playing.
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div style={{ display: "grid", gap: 8 }}>
            <p className="overline">Capacity</p>
            <h2>How much Ballast could carry</h2>
          </div>
        </div>
        <div className="grid grid-2">
          <div className="card">
            {cap.data ? (
              <CapacityGauge cap={cap.data} fn={fn("cap")} />
            ) : (
              <div className="chart-skeleton" style={{ height: 200 }} />
            )}
          </div>
          <div className="card" style={{ display: "grid", gap: 14, alignContent: "start" }}>
            <p className="small" style={{ color: "var(--ink-2)" }}>
              Capacity is <code>K = Σ(rᵢ·coverᵢ − shortᵢ)</code>: each armed holder offers at most{" "}
              <code>r</code> (default 0.5, never above 0.9) of the NIGHT their wallet held at the
              last block, less what they are already short. Aggregate asks stay within the exit
              depth, so every short can be bought back.
            </p>
            <dl className="kv">
              <dt>Holders armed</dt>
              <dd className="num">{cap.data ? cap.data.ballast.holdersArmed : "—"}</dd>
              <dt>Ballast orders</dt>
              <dd className="num">{cap.data ? cap.data.ballast.ordersResting : "—"} resting</dd>
              <dt>
                Open NIGHT positions
                {fn("pos")}
              </dt>
              <dd className="num">
                {pos ? `${pos.longs} long · ${pos.shorts} short` : "—"}
                {pos ? (
                  <span className="muted"> · as of {fmtUtcTime(pos.atMs, false)} UTC</span>
                ) : null}
              </dd>
            </dl>
            <p className="tiny muted">
              Live positions feed the liquidation-aware floor: no Ballast ask may sit where its fill
              could liquidate a long. They are shown only as counts.
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div style={{ display: "grid", gap: 8 }}>
            <p className="overline">How it works</p>
            <h2>Coins stay home. Quotes go to the book.</h2>
          </div>
        </div>
        <div className="grid grid-2">
          <div className="card steps">
            <div className="step">
              <h3>Connect once</h3>
              <p>
                A holder connects Lace or Eternl and signs one CIP-30 message. Builder Connect
                creates the holder's own Strike account; margin is their own ADA or USDM.
              </p>
            </div>
            <div className="step">
              <h3>Coins stay as cover</h3>
              <p>
                NIGHT never moves. The cover oracle reads it from Koios every block, and capacity is{" "}
                <code>r ×</code> what the wallet held at the last block.
              </p>
            </div>
          </div>
          <div className="card steps" style={{ counterReset: "step 2" }}>
            <div className="step">
              <h3>The keeper quotes; the Guard decides</h3>
              <p>
                Post-only asks, above a liquidation-aware floor, inside an operator-signed policy.
                Every order passes the Guard first. No language model sits on the order path.
              </p>
            </div>
            <div className="step">
              <h3>Fills stay covered</h3>
              <p>
                A lifted ask leaves the holder short on Strike and long the same coins at home.
                Recovery is one reduce-only buy-back and one holder-signed withdrawal.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div style={{ display: "grid", gap: 8 }}>
            <p className="overline">Three proofs</p>
            <h2>Nothing to take on trust</h2>
          </div>
        </div>
        <div className="grid grid-3">
          <div className="card" style={{ display: "grid", gap: 10, alignContent: "start" }}>
            <span className="chip">Awaiting the cover oracle</span>
            <h3>Proof of Cover</h3>
            <p className="small" style={{ color: "var(--ink-2)" }}>
              <code>short + resting asks + pending ≤ r × on-chain cover</code>, in NIGHT units, per
              account, before every order and at every block. Anyone can check it on Koios.
            </p>
          </div>
          <div className="card" style={{ display: "grid", gap: 10, alignContent: "start" }}>
            <span className="chip">Awaiting first armed run</span>
            <h3>Proof of Conduct</h3>
            <p className="small" style={{ color: "var(--ink-2)" }}>
              Every order in every maker account is a <code>bal_</code> order tied to an
              operator-signed policy, and no maker account holds vault shares.{" "}
              <Link to="/conduct">What will appear</Link>.
            </p>
          </div>
          <div className="card" style={{ display: "grid", gap: 10, alignContent: "start" }}>
            <span className="chip good">
              <span className="dot on" aria-hidden="true" />
              Measuring the before book
            </span>
            <h3>Book Health</h3>
            <p className="small" style={{ color: "var(--ink-2)" }}>
              Spread, depth and slippage from L3, measured against the counterfactual book with
              Ballast's orders removed. <Link to="/book-health">The scorecard</Link>.
            </p>
          </div>
        </div>
      </section>

      <SourceList sources={sources} />
    </>
  );
}
