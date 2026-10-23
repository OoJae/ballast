import type { BookFrame, WireLevel } from "@ballast/api/types";
import { type PointerEvent, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { fmtPrice, fmtUsd } from "../lib/format";

const RANGE = 0.02;
const BAND = 0.005;
const H = 240;
const PAD = { top: 26, right: 12, bottom: 26, left: 44 };

interface Step {
  /** Signed distance from the reference mid, as a fraction. */
  d: number;
  cum: number;
  cumBallast: number;
}

/** Cumulative USD outward from the mid, one step per level, within ±RANGE. */
function steps(levels: WireLevel[], ref: number, sign: 1 | -1): Step[] {
  const out: Step[] = [];
  let cum = 0;
  let cumBallast = 0;
  for (const [px, qty, ballast] of levels) {
    const d = (px - ref) / ref;
    if (d * sign > RANGE) break;
    cum += px * qty;
    cumBallast += px * ballast;
    out.push({ d, cum, cumBallast });
  }
  return out;
}

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e?.contentRect.width ?? 0)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const niceMax = (x: number) => {
  if (x <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= x) return m * p;
  return 10 * p;
};

/**
 * Cumulative depth within ±2% of the reference mid. The ±0.5% band is shaded: its emptiness on
 * the ask side is the problem Ballast exists to fix. Ballast's own asks would stack in brass,
 * and the counterfactual (Ballast removed) is drawn dashed.
 */
export function DepthChart({ frame }: { frame: BookFrame }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const ref = frame.ref;
  if (ref === null) {
    return (
      <div ref={box} className="ladder-empty">
        One side of the book is empty, so there is no mid to measure from.
      </div>
    );
  }
  const bids = steps(frame.bids, ref, -1);
  const asks = steps(frame.asks, ref, 1);
  const top = niceMax(Math.max(bids.at(-1)?.cum ?? 0, asks.at(-1)?.cum ?? 0));
  const W = Math.max(280, width);
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (d: number) => PAD.left + ((d + RANGE) / (2 * RANGE)) * iw;
  const y = (v: number) => PAD.top + ih - (v / top) * ih;

  // Step path from the mid outward; each level adds its USD at its own price.
  const path = (s: Step[], key: "cum" | "cumBallast", sign: 1 | -1) => {
    if (s.length === 0) return "";
    let p = `M${x(s[0]?.d ?? 0)},${y(0)}`;
    let prev = 0;
    for (const st of s) {
      p += ` L${x(st.d)},${y(prev)} L${x(st.d)},${y(st[key])}`;
      prev = st[key];
    }
    return `${p} L${x(sign * RANGE)},${y(prev)}`;
  };
  const area = (line: string, s: Step[], sign: 1 | -1) =>
    line ? `${line} L${x(sign * RANGE)},${y(0)} L${x(s[0]?.d ?? 0)},${y(0)} Z` : "";

  const bidLine = path(bids, "cum", -1);
  const askLine = path(asks, "cum", 1);
  const ballastAsk = asks.some((s) => s.cumBallast > 0) ? path(asks, "cumBallast", 1) : "";
  const cfAsks = asks.map((s) => ({ ...s, cum: s.cum - s.cumBallast }));
  const cfLine = ballastAsk ? path(cfAsks, "cum", 1) : "";
  const within = (s: Step[], band: number) =>
    s.filter((st) => Math.abs(st.d) <= band).at(-1)?.cum ?? 0;
  const bidIn = within(bids, BAND);
  const askIn = within(asks, BAND);
  const ticks =
    W < 480 ? [-0.02, -0.01, 0, 0.01, 0.02] : [-0.02, -0.01, -0.005, 0, 0.005, 0.01, 0.02];
  const yTicks = [0, top / 2, top];

  const at = (d: number) => {
    const s = d < 0 ? bids : asks;
    return s.filter((st) => Math.abs(st.d) <= Math.abs(d)).at(-1)?.cum ?? 0;
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const d = ((px - PAD.left) / iw) * 2 * RANGE - RANGE;
    setHover(Math.abs(d) <= RANGE ? d : null);
  };

  const label = `Cumulative depth within 2% of the ${frame.symbol} mid. Within 0.5%: ${fmtUsd(bidIn)} of bids and ${fmtUsd(askIn)} of asks.`;
  return (
    <div ref={box} style={{ position: "relative" }}>
      {width > 0 ? (
        <svg
          className="depth-svg"
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={label}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <rect
            x={x(-BAND)}
            y={PAD.top}
            width={x(BAND) - x(-BAND)}
            height={ih}
            fill="var(--band)"
          />
          <text x={x(0)} y={PAD.top - 9} textAnchor="middle">
            ±0.5%
          </text>
          <text x={x(-BAND) - 6} y={PAD.top + 14} textAnchor="end" className="depth-label">
            bids {fmtUsd(bidIn, { compact: true })}
          </text>
          <text x={x(BAND) + 6} y={PAD.top + 14} textAnchor="start" className="depth-label">
            asks {fmtUsd(askIn, { compact: true })}
          </text>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--line)" />
              <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
                {fmtUsd(t, { compact: true })}
              </text>
            </g>
          ))}
          {ticks.map((t) => (
            <text key={t} x={x(t)} y={H - 8} textAnchor="middle">
              {t === 0 ? "mid" : `${t > 0 ? "+" : "−"}${Math.abs(t * 100)}%`}
            </text>
          ))}
          <line x1={x(0)} x2={x(0)} y1={PAD.top} y2={PAD.top + ih} stroke="var(--line-strong)" />
          <path d={area(bidLine, bids, -1)} fill="var(--bid)" opacity="0.1" />
          <path d={area(askLine, asks, 1)} fill="var(--ask)" opacity="0.1" />
          {ballastAsk ? (
            <path d={area(ballastAsk, asks, 1)} fill="var(--ballast)" opacity="0.45" />
          ) : null}
          <path
            d={bidLine}
            fill="none"
            stroke="var(--bid)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            d={askLine}
            fill="none"
            stroke="var(--ask)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          {cfLine ? (
            <path d={cfLine} fill="none" stroke="var(--cf)" strokeWidth="2" strokeDasharray="5 4" />
          ) : null}
          {hover !== null ? (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + ih}
              stroke="var(--ink-3)"
              strokeWidth="1"
            />
          ) : null}
        </svg>
      ) : (
        <div style={{ height: H }} />
      )}
      {hover !== null && width > 0 ? (
        <div
          className="tooltip"
          style={{
            left: Math.min(Math.max(x(hover) - 80, 0), W - 170),
            top: 4,
          }}
        >
          <div>
            {hover < 0 ? "Bids" : "Asks"} within {Math.abs(hover * 100).toFixed(2)}%:{" "}
            <b className="num">{fmtUsd(at(hover))}</b>
          </div>
          <div className="muted">
            price {fmtPrice(ref * (1 + hover), frame.symbol)} · mid {fmtPrice(ref, frame.symbol)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
