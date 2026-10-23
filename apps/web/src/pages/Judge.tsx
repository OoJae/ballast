import type {
  ReplayFrameResponse,
  ReplayIndexResponse,
  RootsResponse,
  SeriesResponse,
} from "@ballast/api/types";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ApiError, getJson, useApi } from "../api";
import { Awaiting, Checklist } from "../components/Awaiting";
import { DepthChart } from "../components/DepthChart";
import { CheckIcon, CrossIcon, PauseIcon, PlayIcon } from "../components/Icons";
import { Ladder } from "../components/Ladder";
import { footnotes, type SourceDef, SourceList } from "../components/Sources";
import type { ChartLine } from "../components/TimeChart";
import { API_LINK } from "../facts";
import { type AddressCheck, checkCardanoAddress } from "../lib/address";
import { fmtBps, fmtInt, fmtUtc, shortHash } from "../lib/format";
import { checkChain, type HourCheck } from "../lib/verify";

const TimeChart = lazy(() =>
  import("../components/TimeChart").then((m) => ({ default: m.TimeChart })),
);

const SYMBOLS = ["NIGHT-USD", "ADA-USD"];
const MIN = 60_000;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Scrubber({ roots }: { roots: RootsResponse | null }) {
  const [symbol, setSymbol] = useState("NIGHT-USD");
  const idx = useApi<ReplayIndexResponse>(`/api/replay/${symbol}`);
  const windows = idx.data?.windows ?? [];
  const step = idx.data?.frameMs ?? 5_000;
  const min = windows[0]?.fromMs ?? 0;
  const max = (windows.at(-1)?.toMs ?? step) - step;
  const [at, setAt] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const pos = at ?? max;
  const debounced = useDebounced(pos, 120);
  // Until the debounced position has caught up with a freshly loaded index, ask for nothing.
  const ready = idx.data !== null && debounced >= min && debounced <= max;
  const frame = useApi<ReplayFrameResponse>(ready ? `/api/replay/${symbol}?at=${debounced}` : null);
  const [last, setLast] = useState<ReplayFrameResponse | null>(null);
  useEffect(() => {
    if (frame.data) setLast(frame.data);
  }, [frame.data]);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setAt((a) => {
        const next = (a ?? max) + step;
        if (next > max) {
          setPlaying(false);
          return max;
        }
        return next;
      });
    }, 1_000);
    return () => clearInterval(t);
  }, [playing, max, step]);

  // Series: 30 minutes either side of the scrub position, on a coarse grid.
  const centre = Math.floor(debounced / (10 * MIN)) * 10 * MIN;
  const series = useApi<SeriesResponse>(
    ready
      ? `/api/series/${symbol}?from=${centre - 30 * MIN}&to=${centre + 40 * MIN}&step=10000`
      : null,
  );
  const lines = useMemo<ChartLine[]>(() => {
    const s = series.data;
    if (!s) return [];
    return [
      { id: "spread", label: "Spread", color: "ask", t: s.t, v: s.spreadBps },
      {
        id: "cf",
        label: "Spread without Ballast",
        color: "cf",
        dashed: true,
        t: s.t,
        v: s.cfSpreadBps,
      },
    ];
  }, [series.data]);

  const f = last?.frame ?? null;
  const hour = f?.source.hour ? roots?.hours.find((h) => h.hour === f.source.hour) : undefined;
  const gap = frame.error instanceof ApiError && frame.error.status === 404;
  const move = (d: number) => setAt(Math.min(max, Math.max(min, pos + d)));

  return (
    <div className="card">
      <div className="card-head">
        <fieldset className="tabs">
          <legend className="visually-hidden">Market</legend>
          {SYMBOLS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={symbol === s}
              onClick={() => {
                setSymbol(s);
                setLast(null);
              }}
            >
              {s}
            </button>
          ))}
        </fieldset>
        {f ? (
          <span className="chip brass">
            {fmtUtc(f.tMs)} · L3 #{fmtInt(f.sequence)}
          </span>
        ) : null}
      </div>
      {idx.data ? (
        <>
          <label className="field">
            <span className="visually-hidden">Recorded time</span>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={pos}
              onChange={(e) => {
                setPlaying(false);
                setAt(Number(e.target.value));
              }}
              aria-valuetext={fmtUtc(pos)}
            />
          </label>
          <div className="row" style={{ justifyContent: "space-between", marginTop: 6 }}>
            <span className="tiny muted">{fmtUtc(min)}</span>
            <span className="tiny muted">{fmtUtc(max)}</span>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button type="button" className="btn" onClick={() => move(-MIN)}>
              −1 min
            </button>
            <button type="button" className="btn" onClick={() => move(-step)}>
              −{step / 1000} s
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? "Pause" : `Play at ${step / 1000}× speed`}
            >
              <span style={{ width: 16, height: 16, display: "inline-flex" }}>
                {playing ? <PauseIcon /> : <PlayIcon />}
              </span>
              {playing ? "Pause" : `Play ${step / 1000}×`}
            </button>
            <button type="button" className="btn" onClick={() => move(step)}>
              +{step / 1000} s
            </button>
            <button type="button" className="btn" onClick={() => move(MIN)}>
              +1 min
            </button>
          </div>
        </>
      ) : (
        <div className="chart-skeleton" style={{ height: 90 }} />
      )}

      {gap ? (
        <p className="notice" style={{ marginTop: 16 }}>
          No recorded book at {fmtUtc(pos)}: the recorder was reconnecting, so this moment is a
          reported gap, not a guess.
        </p>
      ) : null}

      {f ? (
        <div className="grid grid-2" style={{ marginTop: 20 }}>
          <div>
            <dl className="kv" style={{ marginBottom: 14 }}>
              <dt>Spread</dt>
              <dd className="num">
                {fmtBps(f.spreadBps)} bps{" "}
                <span className="muted">· without Ballast {fmtBps(f.cfSpreadBps)} bps</span>
              </dd>
              <dt>Ballast</dt>
              <dd>{f.ballastOrders} orders resting</dd>
              <dt>Hour root</dt>
              <dd className="hash">{f.source.root ?? "—"}</dd>
              {hour ? (
                <>
                  <dt>L3 segment</dt>
                  <dd className="hash">
                    {hour.segments
                      .filter((s) => s.stream === "l3")
                      .map((s) => `${s.segment.split("/").at(-1)} ${shortHash(s.sha256, 12)}`)
                      .join(", ")}
                  </dd>
                </>
              ) : null}
            </dl>
            <Ladder frame={f} depth={7} />
          </div>
          <div style={{ display: "grid", gap: 18, alignContent: "start" }}>
            <DepthChart frame={f} />
            <Suspense fallback={<div className="chart-skeleton" style={{ height: 230 }} />}>
              {lines.length ? (
                <TimeChart
                  lines={lines}
                  height={200}
                  precision={1}
                  unit=" bps"
                  marker={f.tMs}
                  ariaLabel={`${symbol} spread, actual and without Ballast, around the chosen moment`}
                />
              ) : null}
            </Suspense>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Evidence({ roots }: { roots: RootsResponse | null }) {
  const [checks, setChecks] = useState<HourCheck[] | null>(null);
  useEffect(() => {
    if (!roots) return;
    let live = true;
    void checkChain(roots.hours).then((c) => {
      if (live) setChecks(c);
    });
    return () => {
      live = false;
    };
  }, [roots]);
  if (!roots) return <div className="chart-skeleton" style={{ height: 200 }} />;
  const v = roots.verify;
  const allOk = checks?.every((c) => c.rootOk && c.chainOk && c.linkOk && c.leavesMatch) ?? null;
  return (
    <div className="card">
      <div className="card-head">
        <div className="row">
          <span className={`chip ${allOk === null ? "" : allOk ? "good" : "bad"}`}>
            {allOk === null
              ? "Checking in your browser…"
              : allOk
                ? "Chain recomputed in your browser: PASS"
                : "Browser check: FAIL"}
          </span>
          {v ? (
            <span className={`chip ${v.ok ? "good" : "bad"}`}>
              Server re-hash of {v.segmentsChecked} segments: {v.ok ? "PASS" : "FAIL"}
            </span>
          ) : (
            <span className="chip">Server re-hash pending</span>
          )}
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <caption className="visually-hidden">Hourly Merkle roots</caption>
          <thead>
            <tr>
              <th scope="col">Hour (UTC)</th>
              <th scope="col" className="n hide-sm">
                Segments
              </th>
              <th scope="col">Root</th>
              <th scope="col" className="hide-sm">
                Chain
              </th>
              <th scope="col">Recomputed</th>
            </tr>
          </thead>
          <tbody>
            {[...roots.hours].reverse().map((h) => {
              const c = checks?.find((x) => x.hour === h.hour);
              const ok = c ? c.rootOk && c.chainOk && c.linkOk && c.leavesMatch : null;
              return (
                <tr key={h.hour}>
                  <td className="mono">{h.hour.replace("T", " ")}:00</td>
                  <td className="n hide-sm">{h.segments.length}</td>
                  <td className="hash" title={h.root}>
                    {shortHash(h.root, 12)}
                  </td>
                  <td className="hash hide-sm" title={h.chain}>
                    {shortHash(h.chain, 8)}
                  </td>
                  <td>
                    {ok === null ? (
                      <span className="muted">…</span>
                    ) : (
                      <span
                        style={{
                          display: "inline-flex",
                          gap: 6,
                          alignItems: "center",
                          color: ok ? "var(--good)" : "var(--ask)",
                        }}
                      >
                        <span style={{ width: 16, height: 16, display: "inline-flex" }}>
                          {ok ? <CheckIcon /> : <CrossIcon />}
                        </span>
                        {ok ? "root, chain, link" : "mismatch"}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="tiny muted" style={{ marginTop: 12 }}>
        Your browser recomputed each RFC 6962 root from the listed segment hashes and each chain
        link from the previous hour, with WebCrypto. To re-hash the segment bytes themselves, run{" "}
        <code>pnpm recorder:verify</code> on a copy of the recordings.
      </p>
    </div>
  );
}

function CoverCalculator() {
  const [input, setInput] = useState("");
  const [check, setCheck] = useState<AddressCheck | null>(null);
  const [result, setResult] = useState<"pending" | "soon" | "error" | null>(null);
  const submit = async () => {
    const c = checkCardanoAddress(input);
    setCheck(c);
    setResult(null);
    if (!c.ok) return;
    setResult("pending");
    try {
      await getJson(`/api/cover/${encodeURIComponent(c.normalized)}`);
      setResult("soon");
    } catch (err) {
      setResult(err instanceof ApiError && err.status === 501 ? "soon" : "error");
    }
  };
  return (
    <div className="card" style={{ display: "grid", gap: 14 }}>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field grow">
          Any Cardano mainnet address
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="addr1… or stake1…"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
          />
        </label>
        <button type="submit" className="btn primary">
          Calculate
        </button>
      </form>
      {check && !check.ok ? (
        <p className="small" style={{ color: "var(--ask)" }} role="alert">
          {check.reason}
        </p>
      ) : null}
      {check?.ok && result === "pending" ? <p className="small muted">Checking…</p> : null}
      {check?.ok && result === "soon" ? (
        <Awaiting tag="Coming soon" title="Valid address. The cover oracle is not live yet.">
          <p className="small">
            The checksum passed in your browser. Once the cover oracle ships, this will read the
            NIGHT the address's stake credential held at each block from Koios, and answer: "you
            could have supplied X hours of asks yesterday", at <code>r = 0.5</code> against the
            recorded taker buy flow. Today the API answers{" "}
            <code>501 coming with the cover oracle</code>, and nothing is estimated in its place.
          </p>
        </Awaiting>
      ) : null}
      {result === "error" ? (
        <div className="error-box">The API did not answer. Try again.</div>
      ) : null}
      <p className="tiny muted">
        The address is checked offline first (bech32 checksum, mainnet prefix); only a valid one is
        sent, to Ballast's read-only API. Nothing is stored.
      </p>
    </div>
  );
}

export function Judge() {
  const roots = useApi<RootsResponse>("/api/recordings/roots");
  const sources: SourceDef[] = [
    {
      id: "replay",
      title: "Frames rebuilt from sealed L3 segments, every 5 s (1 s for the latest hour)",
      text: (
        <>
          Scrubber: {API_LINK("/api/replay/NIGHT-USD")} lists the recorded windows;{" "}
          <code>?at=</code> returns the book at that moment with its L3 sequence number.
        </>
      ),
    },
    {
      id: "roots",
      title: "Hourly RFC 6962 Merkle roots and the server's independent re-hash",
      text: (
        <>Evidence: {API_LINK("/api/recordings/roots")}, the recorder's roots.jsonl and manifest.</>
      ),
    },
  ];
  const fn = footnotes(sources);
  return (
    <>
      <header className="page-head">
        <p className="overline brass">Judge mode</p>
        <h1>Check it yourself. No wallet needed.</h1>
        <p className="lede">
          Everything on this page is read-only and comes from recordings anyone can re-hash. Scrub
          to any recorded second, see the L3 sequence number the book was rebuilt to, and recompute
          the hourly hash chain in your own browser.
        </p>
      </header>

      <section className="section" aria-labelledby="scrub-title">
        <div className="section-head">
          <h2 id="scrub-title">Replay any recorded moment{fn("replay")}</h2>
          <p>
            Ballast's orders would appear in oxide red; the dashed line is the book without them.
          </p>
        </div>
        <Scrubber roots={roots.data} />
      </section>

      <section className="section" aria-labelledby="ev-title">
        <div className="section-head">
          <h2 id="ev-title">Recorded evidence{fn("roots")}</h2>
          <p>Each sealed hour: its segments, its Merkle root, and its link to the hour before.</p>
        </div>
        <Evidence roots={roots.data} />
      </section>

      <section className="section">
        <div className="grid grid-2">
          <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <h2>Verify the last fill</h2>
            <Awaiting tag="Placeholder · M7" title="Arrives with holder #0's first live fill">
              <p className="small">
                This panel will take the most recent Ballast fill and check it in your browser
                against Strike's public endpoints alone:
              </p>
              <Checklist
                items={[
                  {
                    title: "Public fill",
                    body: "role = maker, its trade id, and a bal_ client order id.",
                  },
                  {
                    title: "Policy",
                    body: "the id resolves to a decision record and an operator-signed policy with a Critic PASS.",
                  },
                  {
                    title: "Cover",
                    body: "at that block, short + resting ≤ r × the wallet's NIGHT on Koios.",
                  },
                  { title: "L3", body: "the order's arrival and removal in the recorded feed." },
                ]}
              />
            </Awaiting>
          </div>
          <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <h2>Kill drill</h2>
            <Awaiting tag="Placeholder · M7" title="Arrives with the first watchdog drills">
              <p className="small">
                A log of cancel-all drills fired by the watchdog: time from the cancel to the
                CANCELED event on the user stream, and to removal of every fingerprinted order on
                L3, with p50 and p99 over 100 trials. Strike has no cancel-on-disconnect, so this is
                how a dead keeper is shown to leave nothing resting.
              </p>
              <dl className="kv">
                <dt>Trials</dt>
                <dd>0</dd>
                <dt>p50 / p99</dt>
                <dd>— / —</dd>
              </dl>
            </Awaiting>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="cover-title">
        <div className="section-head">
          <h2 id="cover-title">Paste any addr1: what could it have covered?</h2>
        </div>
        <CoverCalculator />
      </section>

      <SourceList sources={sources} />
    </>
  );
}
