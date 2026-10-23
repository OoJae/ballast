import type { BookFrame, BookHealthResponse } from "@ballast/api/types";
import { useEffect, useId, useMemo, useState } from "react";
import { useApi, useBookStream } from "../api";
import { PauseIcon, PlayIcon } from "../components/Icons";
import { metric } from "../components/Scorecard";
import { footnotes, type SourceDef, SourceList } from "../components/Sources";
import { API_LINK, HOLDERS_SOURCE, NIGHT_HOLDERS } from "../facts";
import { fmtBps, fmtInt, fmtUsd, fmtUtcTime } from "../lib/format";
import {
  asksToLevel,
  heelDeg,
  heelWithAddedAsks,
  MAX_HEEL_DEG,
  PER_ACCOUNT_MAX_SHORT_USD,
  PRE_D6_DEPTH_CAP_USD,
} from "../lib/heel";
import { bodyPlan, DRAFT, FREEBOARD, HALF_BEAM, toPath } from "../lib/hull";
import { Link } from "../router";
import "./landing.css";

type Sym = "NIGHT-USD" | "ADA-USD";
const PLAN = bodyPlan();

function depth05(frame: BookFrame | null): { bid: number; ask: number } | null {
  const d = frame?.depthUsd?.actual;
  if (!d) return null;
  return { bid: d.bid["0.5%"], ask: d.ask["0.5%"] };
}

/** The body plan, heeled by `heel` degrees (positive lists to port, the bid side). */
function HullFigure({
  heel,
  bid,
  ask,
  whatIf,
}: {
  heel: number;
  bid: number | null;
  ask: number | null;
  whatIf: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const W = 300;
  const top = -FREEBOARD - 64;
  const bottom = DRAFT + 64;
  const rot = { transform: `rotate(${-heel}deg)` };
  const lines = PLAN.map((l, i) => (
    <path
      // biome-ignore lint/suspicious/noArrayIndexKey: the plan is a fixed, ordered drawing
      key={i}
      d={toPath(l.points)}
      className={`hl hl-${l.kind}`}
    />
  ));
  // The Plimsoll mark on the starboard topside, its bar on the hull's own waterline.
  const D = 30;
  const mx = HALF_BEAM + 30;
  const mark = (
    <g className="hull-mark" transform={`translate(${mx} 0)`}>
      <path
        d={`M${-D / 2 + 1.25} 0A${D / 2 - 1.25} ${D / 2 - 1.25} 0 0 0 ${D / 2 - 1.25} 0Z`}
        className="hm-weight"
      />
      <circle r={D / 2 - 1.25} className="hm-ring" />
      <rect x={-D * 0.75} y={-1.25} width={D * 1.5} height={2.5} className="hm-bar" />
    </g>
  );
  return (
    <svg
      className="hull-svg"
      viewBox={`${-W / 2} ${top} ${W} ${bottom - top}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={`${id}-above`} clipPathUnits="userSpaceOnUse">
          <rect x={-2000} y={-2000} width={4000} height={2000} />
        </clipPath>
        <clipPath id={`${id}-below`} clipPathUnits="userSpaceOnUse">
          <rect x={-2000} y={0} width={4000} height={2000} />
        </clipPath>
      </defs>
      <rect className="hull-sea" x={-2000} y={0} width={4000} height={2000} />
      <g clipPath={`url(#${id}-above)`} className="above">
        <g className="hull-rot" style={rot}>
          {lines}
          <path d={`M${-HALF_BEAM - 8} 0H${HALF_BEAM + 8}`} className="hl hl-dwl" />
        </g>
      </g>
      <g clipPath={`url(#${id}-below)`} className="below">
        <g className="hull-rot" style={rot}>
          {lines}
          <path d={`M${-HALF_BEAM - 8} 0H${HALF_BEAM + 8}`} className="hl hl-dwl" />
        </g>
      </g>
      <g className="hull-rot" style={rot}>
        {mark}
      </g>
      <line className="sea-line" x1={-2000} x2={2000} y1={0} y2={0} />
      {bid !== null && ask !== null ? (
        <>
          <text className="sl-label" x={-W / 2 + 4} y={DRAFT + 26}>
            bids within 0.5%
          </text>
          <text className="sounding sl-num" x={-W / 2 + 4} y={DRAFT + 50}>
            {fmtUsd(bid)}
          </text>
          <text className="sl-label" x={W / 2 - 4} y={-FREEBOARD - 40} textAnchor="end">
            asks within 0.5%
          </text>
          <text className="sounding sl-num" x={W / 2 - 4} y={-FREEBOARD - 16} textAnchor="end">
            {fmtUsd(ask)}
          </text>
        </>
      ) : null}
      {whatIf ? (
        <text className="sl-label sl-whatif" x={0} y={bottom - 12} textAnchor="middle">
          what-if, computed from the replayed book
        </text>
      ) : null}
    </svg>
  );
}

export function Landing() {
  const [sym, setSym] = useState<Sym>("NIGHT-USD");
  const [paused, setPaused] = useState(false);
  const [added, setAdded] = useState(0);
  const { frame: liveFrame, state } = useBookStream(sym);
  const [held, setHeld] = useState<BookFrame | null>(null);
  useEffect(() => {
    if (!paused) setHeld(liveFrame);
  }, [liveFrame, paused]);
  // The what-if belongs to one book.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the market changes
  useEffect(() => setAdded(0), [sym]);
  const frame = held;
  const d = depth05(frame);
  const heelNow = d ? heelDeg(d.bid, d.ask) : 0;
  const heel = d ? heelWithAddedAsks(d.bid, d.ask, added) : 0;
  const toLevel = d ? asksToLevel(d.bid, d.ask) : 0;
  const sliderMax = Math.max(PER_ACCOUNT_MAX_SHORT_USD * 2, Math.ceil(toLevel / 500) * 500);

  const night = useApi<BookHealthResponse>("/api/book-health?symbol=NIGHT-USD");
  const ada = useApi<BookHealthResponse>("/api/book-health?symbol=ADA-USD");
  const r = night.data?.report;
  const hours = night.data?.provenance.hours.length ?? 0;
  const secs = night.data?.stats?.healthSamples ?? null;
  const windowLabel = night.data
    ? `${fmtUtcTime(night.data.fromMs, false)}–${fmtUtcTime(night.data.toMs, false)} UTC, ${secs !== null ? `${Math.round(secs / 60)} min of samples` : `${hours} sealed hours`}`
    : "the sealed hours on this server";

  const sources: SourceDef[] = useMemo(
    () => [
      {
        id: "frame",
        title: "The last sealed hour of L3 recordings on this server, replayed at recorded speed",
        text: (
          <>
            The drawing and its depths: {API_LINK(`/api/stream/${sym}`)}, the last sealed recorded
            hour replayed at recorded speed (not live). Heel = {MAX_HEEL_DEG}° × (bid − ask) / (bid
            + ask), from depth within ±0.5% of the mid.
          </>
        ),
      },
      {
        id: "bh",
        title: "Book Health, time-weighted over this server's sealed hours",
        text: (
          <>
            Book Health, time-weighted over {windowLabel}:{" "}
            {API_LINK("/api/book-health?symbol=NIGHT-USD")} and{" "}
            {API_LINK("/api/book-health?symbol=ADA-USD")}.
          </>
        ),
      },
      {
        id: "caps",
        title: "The signed policy's caps",
        text: (
          <>
            Caps: Ballast depth is capped at ${PRE_D6_DEPTH_CAP_USD} until test D6 passes, and one
            account's short at ${PER_ACCOUNT_MAX_SHORT_USD.toLocaleString("en-US")}, in the
            operator-signed policy (<Link to="/policies">certificate</Link>).
          </>
        ),
      },
      {
        id: "anchor",
        title: "The first CIP-20 anchor, on Cardano's preprod testnet",
        text: (
          <>
            Anchor: preprod transaction{" "}
            <a
              className="hash"
              href="https://preprod.cexplorer.io/tx/7d8a1cddf6fe4e9e0eeee0b5b3ae533c337bd3d19bb79d386edee0eacfe7723c"
              rel="noreferrer"
            >
              7d8a1cdd…7723c
            </a>{" "}
            commits recorder A's sealed hours 00–07 UTC on 23 Oct 2026 and the first signed
            decision. Recompute it in <Link to="/judge">judge mode</Link>.
          </>
        ),
      },
      HOLDERS_SOURCE,
    ],
    [sym, windowLabel],
  );
  const fn = footnotes(sources);

  return (
    <>
      <section className="lp-hero" aria-labelledby="lp-title">
        <div className="lp-hero-grid">
          <div className="lp-copy">
            <p className="overline">NIGHT-USD · Strike · Cardano</p>
            <h1 id="lp-title" tabIndex={-1}>
              NIGHT's ask side is empty within 0.5%.
            </h1>
            <p className="lp-sub">
              Ballast lets NIGHT holders fill it with post-only asks from their own Strike accounts.
              Every ask must be covered by NIGHT that stays in the holder's Cardano wallet,
              checkable block by block.
            </p>
            <div className="hero-actions">
              <Link to="/judge" className="btn primary">
                Check the evidence
              </Link>
              <Link to="/join" className="btn">
                How joining works
              </Link>
            </div>
            <p className="lp-status">Pilot · recording since 23 Oct 2026 · no orders placed yet</p>
          </div>
          <figure className="lp-figure">
            <HullFigure heel={heel} bid={d?.bid ?? null} ask={d?.ask ?? null} whatIf={added > 0} />
            <figcaption className="lp-caption">
              {d ? (
                <>
                  Drawn heeled {Math.abs(heelNow).toFixed(1)}° because bids within 0.5% were{" "}
                  {fmtUsd(d.bid)} and asks {fmtUsd(d.ask)}
                  {fn("frame")}.{" "}
                  {added > 0 ? (
                    <>
                      With {fmtUsd(added)} more covered asks: {Math.abs(heel).toFixed(1)}°.
                    </>
                  ) : null}
                </>
              ) : (
                "Loading the replayed book…"
              )}
            </figcaption>
          </figure>
        </div>
        <div className="lp-controls">
          <fieldset className="tabs">
            <legend className="visually-hidden">Market</legend>
            {(["NIGHT-USD", "ADA-USD"] as const).map((s) => (
              <button key={s} type="button" aria-pressed={sym === s} onClick={() => setSym(s)}>
                {s}
              </button>
            ))}
          </fieldset>
          <label className="lp-whatif">
            <span className="label">What-if: add covered asks within 0.5%</span>
            <input
              type="range"
              min={0}
              max={sliderMax}
              step={50}
              value={added}
              list="lp-caps"
              onChange={(e) => setAdded(Number(e.target.value))}
              aria-valuetext={`${fmtUsd(added)} added; heel ${Math.abs(heel).toFixed(1)} degrees`}
            />
            <datalist id="lp-caps">
              <option value={PRE_D6_DEPTH_CAP_USD} label="$300 pre-D6 cap" />
              <option value={PER_ACCOUNT_MAX_SHORT_USD} label="$2,000 one account" />
            </datalist>
            <span className="lp-whatif-read small">
              <span className="sounding">{fmtUsd(added)}</span> · heel{" "}
              <span className="sounding">{Math.abs(heel).toFixed(1)}°</span> · level at about{" "}
              {fmtUsd(toLevel)} ({Math.ceil(toLevel / PER_ACCOUNT_MAX_SHORT_USD)} accounts at the
              cap{fn("caps")})
            </span>
          </label>
          <div className="lp-replay small">
            <span>
              Replayed
              {frame ? ` · ${fmtUtcTime(frame.tMs)} UTC · L3 #${fmtInt(frame.sequence)}` : ""}
              {state !== "open" && !paused ? " · connecting" : ""}
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setPaused((p) => !p)}
              aria-pressed={paused}
            >
              {paused ? <PlayIcon /> : <PauseIcon />}
              {paused ? "Resume replay" : "Pause replay"}
            </button>
          </div>
        </div>
      </section>

      <section className="lp-section" aria-labelledby="rungs-title">
        <div className="lp-section-head">
          <p className="overline">How a covered ask works</p>
          <h2 id="rungs-title">Coins stay home. Quotes go to the book.</h2>
        </div>
        <ol className="lp-rungs">
          <li>
            <h3>Connect once</h3>
            <p>
              Sign one message in Lace or Eternl. Strike opens the holder's own account with a
              Ballast trading key. Withdrawals still need the wallet's signature and only pay the
              holder's own address.
            </p>
          </li>
          <li>
            <h3>Your coins stay home</h3>
            <p>
              NIGHT never moves. The cover oracle reads it from Koios every block. An account can
              offer at most r × that NIGHT (r ≤ 0.5 in the signed policy), less what it is already
              short. That is the load line.
            </p>
          </li>
          <li>
            <h3>The keeper quotes, the Guard decides</h3>
            <p>
              Post-only asks rest above a liquidation-aware floor, under an operator-signed policy
              that passed a replay of recorded markets. 28 rules run on every action and fail
              closed. No language model sits on the order path.
            </p>
          </li>
          <li>
            <h3>Logged and anchored</h3>
            <p>
              Every decision is signed into a hash chain, and the chain is anchored on Cardano. A
              fill leaves the holder short on Strike against the same coins at home; a rally needs
              margin, which the keeper watches.
            </p>
          </li>
        </ol>
      </section>

      <section className="lp-section lp-deep" aria-labelledby="today-title">
        <div className="lp-section-head">
          <p className="overline">The book today</p>
          <h2 id="today-title">One side deep, one side dry.</h2>
          <p className="muted small">
            Time-weighted over {windowLabel}
            {fn("bh")}.
          </p>
        </div>
        <dl className="lp-soundings">
          <div>
            <dt className="label">NIGHT spread</dt>
            <dd className="sounding">
              {fmtBps(metric(r, "spreadBps"))}
              <span className="unit">bps</span>
            </dd>
          </div>
          <div>
            <dt className="label">Asks within 0.5%</dt>
            <dd className="sounding">{fmtUsd(metric(r, "depthUsd.ask.0.5%"))}</dd>
          </div>
          <div>
            <dt className="label">Bids within 0.5%</dt>
            <dd className="sounding">{fmtUsd(metric(r, "depthUsd.bid.0.5%"))}</dd>
          </div>
          <div>
            <dt className="label">$1,000 market buy, over mid</dt>
            <dd className="sounding">
              {fmtBps(metric(r, "slippageBps.buy.1000"))}
              <span className="unit">bps</span>
            </dd>
          </div>
          <div>
            <dt className="label">ADA spread, same hours</dt>
            <dd className="sounding">
              {fmtBps(metric(ada.data?.report, "spreadBps"))}
              <span className="unit">bps</span>
            </dd>
          </div>
        </dl>
        <p className="small">
          <Link to="/book">See the book</Link> ·{" "}
          <Link to="/book-health">Book Health, hour by hour</Link>
        </p>
      </section>

      <section className="lp-section" aria-labelledby="proofs-title">
        <div className="lp-section-head">
          <p className="overline">Nothing to take on trust</p>
          <h2 id="proofs-title">Three proofs, and where they stand.</h2>
        </div>
        <div className="lp-proofs">
          <article>
            <h3>Proof of Cover</h3>
            <p>
              short + resting asks + pending ≤ r × on-chain cover, in NIGHT, per account, before
              every order and every block. Built and run read-only against Koios; no cover is
              committed yet.
            </p>
          </article>
          <article>
            <h3>Proof of Conduct</h3>
            <p>
              Every order will be a <code>bal_</code> order tied to a signed policy. No orders yet;
              the log holds two signed entries: the policy activation and the anchor.{" "}
              <Link to="/conduct">Read the log</Link>.
            </p>
          </article>
          <article>
            <h3>Book Health</h3>
            <p>
              Spread, depth and slippage from L3, measured against the book with Ballast's orders
              removed. <Link to="/book-health">The before numbers</Link>.
            </p>
          </article>
        </div>
        <p className="lp-anchor small">
          Anchored once, on Cardano's preprod testnet{fn("anchor")}.{" "}
          <Link to="/judge">Recompute the root in your browser</Link>.
        </p>
      </section>

      <section className="lp-section" aria-labelledby="limits-title">
        <div className="lp-section-head">
          <p className="overline">Honest limits</p>
          <h2 id="limits-title">What Ballast has not done yet.</h2>
        </div>
        <ul className="lp-limits">
          <li>
            No mainnet order has been placed. Holder #0, the team's own account, quotes first.
          </li>
          <li>
            The flow is thin: over the first 7.2 recorded hours, L3 showed 2 taker buys on
            NIGHT-USD.
          </li>
          <li>
            Before test D6, Ballast's depth is capped at ${PRE_D6_DEPTH_CAP_USD}. Levelling the book
            takes many holders, not one.
          </li>
          <li>
            The book on this site is a replay of the last sealed hour, and the only anchor so far is
            on preprod.
          </li>
          <li>
            {fmtInt(NIGHT_HOLDERS)} staked Cardano wallets held NIGHT on 22 Oct 2026
            {fn("holders")}; only some are in eligible jurisdictions.
          </li>
        </ul>
      </section>

      <section className="lp-close" aria-labelledby="close-title">
        <h2 id="close-title">Your coins are the market.</h2>
        <p className="lp-sub">
          Holder #0 quotes first and alone for 72 hours. Outside holders follow once it has run with
          zero cover violations.
        </p>
        <div className="hero-actions">
          <Link to="/judge" className="btn primary">
            Check the evidence
          </Link>
          <Link to="/join" className="btn">
            How joining works
          </Link>
        </div>
      </section>

      <div className="wrap">
        <SourceList sources={sources} />
      </div>
    </>
  );
}
