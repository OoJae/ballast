import type {
  BookHealthResponse,
  DailyBookHealthResponse,
  HealthResponse,
  HourProvenance,
} from "@ballast/api/types";
import { useState } from "react";
import { useApi } from "../api";
import { Awaiting } from "../components/Awaiting";
import { metric, Scorecard } from "../components/Scorecard";
import { footnotes, type SourceDef, SourceList } from "../components/Sources";
import { API_LINK } from "../facts";
import { fmtBps, fmtDuration, fmtUsd, fmtUtc, fmtUtcDate, fmtUtcTime } from "../lib/format";
import { Link } from "../router";

const SYMBOLS = ["NIGHT-USD", "ADA-USD"];
const HOUR = 3_600_000;

function Provenance({
  hours,
  verified,
  method,
}: {
  hours: HourProvenance[];
  verified: boolean | null;
  method?: string;
}) {
  return (
    <details className="small" style={{ marginTop: 14 }}>
      <summary className="muted" style={{ cursor: "pointer" }}>
        Computed from {hours.length} sealed hour{hours.length === 1 ? "" : "s"}
        {method ? ` (${method === "index" ? "background index" : "replay of this window"})` : ""} ·{" "}
        {verified === null
          ? "re-hash pending"
          : verified
            ? "segments re-hashed: PASS"
            : "re-hash FAILED"}
      </summary>
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table>
          <thead>
            <tr>
              <th scope="col">Hour (UTC)</th>
              <th scope="col">Merkle root</th>
            </tr>
          </thead>
          <tbody>
            {hours.map((h) => (
              <tr key={h.hour}>
                <td className="mono">{h.hour.replace("T", " ")}:00</td>
                <td className="hash">{h.root}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function HourTable({ day }: { day: DailyBookHealthResponse["days"][number] }) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="visually-hidden">By hour, {day.key}</caption>
        <thead>
          <tr>
            <th scope="col">UTC</th>
            <th scope="col" className="n">
              Spread
            </th>
            <th scope="col" className="n">
              Asks ±0.5%
            </th>
            <th scope="col" className="n">
              Bids ±0.5%
            </th>
            <th scope="col" className="n hide-sm">
              $1K buy, bps
            </th>
            <th scope="col" className="n hide-sm">
              Measured
            </th>
          </tr>
        </thead>
        <tbody>
          {day.hours.map((h) => (
            <tr key={h.key}>
              <td className="mono">{h.key.slice(11)}:00</td>
              <td className="n">{fmtBps(metric(h.report, "spreadBps"))}</td>
              <td className="n">{fmtUsd(metric(h.report, "depthUsd.ask.0.5%"))}</td>
              <td className="n">{fmtUsd(metric(h.report, "depthUsd.bid.0.5%"))}</td>
              <td className="n hide-sm">{fmtBps(metric(h.report, "slippageBps.buy.1000"))}</td>
              <td className="n hide-sm">{fmtDuration(h.report.unarmed.ms + h.report.armed.ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Daily({ symbol }: { symbol: string }) {
  const daily = useApi<DailyBookHealthResponse>(`/api/book-health/daily?symbol=${symbol}`);
  if (daily.error)
    return <div className="error-box">Book Health is unavailable: {daily.error.message}</div>;
  if (!daily.data) return <div className="chart-skeleton" style={{ height: 420 }} />;
  return (
    <div className="grid">
      {[...daily.data.days].reverse().map((d) => (
        <article key={d.key} className="card">
          <div className="card-head">
            <h3 className="card-title">{fmtUtcDate(d.fromMs)}</h3>
            <span className="chip">
              {fmtUtcTime(d.fromMs, false)}–{fmtUtcTime(d.toMs, false)} UTC · sampled{" "}
              {fmtDuration(d.report.unarmed.ms + d.report.armed.ms)}
            </span>
          </div>
          <Scorecard report={d.report} caption={`${symbol} Book Health for ${d.key}`} />
          <h4 className="overline" style={{ margin: "22px 0 8px" }}>
            By hour
          </h4>
          <HourTable day={d} />
          <Provenance
            hours={daily.data?.provenance.hours.filter((h) => h.hour.startsWith(d.key)) ?? []}
            verified={daily.data?.provenance.verified ?? null}
          />
        </article>
      ))}
    </div>
  );
}

function hourOptions(fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  for (let t = fromMs; t <= toMs; t += HOUR) out.push(t);
  return out;
}

function Window({ symbol }: { symbol: string }) {
  const status = useApi<HealthResponse>("/api/health");
  const all = useApi<BookHealthResponse>(`/api/book-health?symbol=${symbol}`);
  const first = all.data?.fromMs ?? null;
  const last = status.data?.sealedThroughMs ?? all.data?.toMs ?? null;
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const res = useApi<BookHealthResponse>(query);
  const options = first !== null && last !== null ? hourOptions(first, last) : [];
  const f = from ?? first;
  const t = to ?? last;
  const valid = f !== null && t !== null && t > f;
  const shown = query ? res.data : all.data;
  return (
    <div className="card">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) setQuery(`/api/book-health?symbol=${symbol}&from=${f}&to=${t}`);
        }}
      >
        <label className="field grow">
          From (UTC)
          <select value={f ?? ""} onChange={(e) => setFrom(Number(e.target.value))}>
            {options.slice(0, -1).map((o) => (
              <option key={o} value={o}>
                {fmtUtc(o).replace(":00 UTC", " UTC")}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          To (UTC)
          <select value={t ?? ""} onChange={(e) => setTo(Number(e.target.value))}>
            {options.slice(1).map((o) => (
              <option key={o} value={o}>
                {fmtUtc(o).replace(":00 UTC", " UTC")}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn primary" disabled={!valid || res.loading}>
          {res.loading ? "Replaying…" : "Replay window"}
        </button>
      </form>
      <p className="tiny muted" style={{ marginTop: 10 }}>
        Any window of sealed hours is replayed from the raw L3 segments on request, exactly as{" "}
        <code>pnpm book-health</code> does, and cached.
      </p>
      <div style={{ marginTop: 18 }}>
        {res.error ? <div className="error-box">{res.error.message}</div> : null}
        {shown ? (
          <>
            <p className="small muted" style={{ marginBottom: 10 }}>
              {fmtUtc(shown.fromMs)} → {fmtUtc(shown.toMs)} ·{" "}
              {shown.stats?.l3Updates.toLocaleString("en-US") ?? "—"} L3 updates ·{" "}
              {shown.stats?.breaks ?? 0} sequence breaks
            </p>
            <Scorecard
              report={shown.report}
              caption={`${symbol} Book Health for the chosen window`}
            />
            <Provenance
              hours={shown.provenance.hours}
              verified={shown.provenance.verified}
              method={shown.method}
            />
          </>
        ) : (
          <div className="chart-skeleton" style={{ height: 380 }} />
        )}
      </div>
    </div>
  );
}

const LATER: { name: string; def: string }[] = [
  {
    name: "Realized savings",
    def: "For each taker buy that touched Ballast: (counterfactual VWAP − actual VWAP) × size, re-matched on L3.",
  },
  { name: "bps saved per $ of cover", def: "Realized savings ÷ committed cover." },
  {
    name: "Non-protocol maker share",
    def: "Share of maker volume not from the protocol vault, via trade_id joins; aggregate only.",
  },
  { name: "Capacity", def: "Armed hours, and Σ cover ÷ 24 h taker buy flow." },
  {
    name: "Reliability",
    def: "Uptime, cancel latency p50/p99, Guard trips by rule, silent drops, 429s.",
  },
  { name: "Proof of Cover", def: "Checks run, violations (target 0), maximum utilization." },
  { name: "New accounts", def: "Strike accounts created through Ballast vs the ~25/day baseline." },
];

export function BookHealth() {
  const [symbol, setSymbol] = useState("NIGHT-USD");
  const [view, setView] = useState<"daily" | "window">("daily");
  const sources: SourceDef[] = [
    {
      id: "daily",
      title: "Per-day and per-hour aggregates of the background replay over every sealed hour",
      text: (
        <>
          Daily view: {API_LINK(`/api/book-health/daily?symbol=${symbol}`)}, one replay of every
          sealed hour with <code>@ballast/market</code>, split by UTC day and hour.
        </>
      ),
    },
    {
      id: "window",
      title: "A replay of the chosen window of sealed L3 segments",
      text: (
        <>
          Window view: {API_LINK(`/api/book-health?symbol=${symbol}&from=…&to=…`)}, a replay of
          exactly that window.
        </>
      ),
    },
  ];
  const fn = footnotes(sources);
  return (
    <>
      <header className="page-head">
        <p className="overline brass">Book Health</p>
        <h1>The book, measured from L3</h1>
        <p className="lede">
          Spread, depth and slippage, time-weighted at one-second samples from Strike's public
          order-by-order feed. Once Ballast quotes, every number is shown twice: the real book, and
          the same book with Ballast's orders removed, both measured against the mid without
          Ballast. <Link to="/book-health#methodology">Methodology</Link>.
        </p>
      </header>

      <div className="row" style={{ justifyContent: "space-between" }}>
        <fieldset className="tabs">
          <legend className="visually-hidden">Market</legend>
          {SYMBOLS.map((s) => (
            <button key={s} type="button" aria-pressed={symbol === s} onClick={() => setSymbol(s)}>
              {s}
            </button>
          ))}
        </fieldset>
        <fieldset className="tabs">
          <legend className="visually-hidden">View</legend>
          <button type="button" aria-pressed={view === "daily"} onClick={() => setView("daily")}>
            Daily
          </button>
          <button type="button" aria-pressed={view === "window"} onClick={() => setView("window")}>
            Window
          </button>
        </fieldset>
      </div>
      {symbol === "ADA-USD" ? (
        <p className="notice" style={{ marginTop: 16 }}>
          ADA-USD is recorded as a control market and an optional holder carry leg. It is never a
          Ballast KPI.
        </p>
      ) : null}

      <section className="section" aria-label={view === "daily" ? "Daily view" : "Window view"}>
        <div className="section-head">
          <h2>
            {view === "daily" ? "Day by day" : "Any recorded window"}
            {fn(view)}
          </h2>
          <p>Unarmed: no Ballast orders were resting, so actual and counterfactual coincide.</p>
        </div>
        {view === "daily" ? <Daily symbol={symbol} /> : <Window symbol={symbol} />}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Measured once Ballast is armed</h2>
        </div>
        <Awaiting title="These rows need Ballast's own orders and fills">
          <div className="table-wrap" style={{ width: "100%" }}>
            <table>
              <tbody>
                {LATER.map((l) => (
                  <tr key={l.name}>
                    <td style={{ width: "34%" }} className="metric-name">
                      {l.name}
                    </td>
                    <td className="muted">{l.def}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Awaiting>
      </section>

      <section className="section" id="methodology" aria-labelledby="method-title">
        <div className="section-head">
          <h2 id="method-title">Methodology</h2>
        </div>
        <div className="grid grid-2">
          <div className="card" style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <h3 className="card-title">Inputs</h3>
            <p className="small" style={{ color: "var(--ink-2)" }}>
              Strike's public L3 feed (<code>/ws/l3</code> plus <code>/v2/l3/snapshot</code>),
              recorded from day 0 into hourly JSONL segments. Each segment is sha256-hashed into a
              manifest; each completed hour gets an RFC 6962 Merkle root, hash-chained to the
              previous hour. Book Health reads only sealed, rooted hours.
            </p>
            <p className="small" style={{ color: "var(--ink-2)" }}>
              The book is rebuilt order by order: snapshot, then every update with its sequence
              number checked. A gap, a <code>clear</code> or a socket close stops sampling until the
              next snapshot, and the unsynced time is reported rather than filled.
            </p>
          </div>
          <div className="card" style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <h3 className="card-title">Definitions</h3>
            <ul
              className="small"
              style={{ color: "var(--ink-2)", margin: 0, paddingLeft: 18, display: "grid", gap: 8 }}
            >
              <li>
                <b>Time-weighted spread</b>: Σ spread·Δt ÷ Σ Δt over 1 s samples, split armed vs
                unarmed, actual vs counterfactual.
              </li>
              <li>
                <b>Depth</b>: USD resting within ±0.5 / 1 / 2% of the mid, per side.
              </li>
              <li>
                <b>Slippage</b>: VWAP of a $1K / $10K / $25K market order vs the mid, in bps. A size
                the side cannot fill is reported as the share of time it could.
              </li>
              <li>
                <b>The yardstick</b>: both books are measured against the counterfactual mid
                (Ballast removed), so Ballast's own quotes cannot move the reference they are judged
                by.
              </li>
            </ul>
            <p className="small muted">
              Code: <code>packages/market/src/book-health.ts</code> and <code>replay.ts</code>.
              Reproduce with <code>pnpm book-health -- --root data/recordings</code>.
            </p>
          </div>
        </div>
      </section>

      <SourceList sources={sources} />
    </>
  );
}
