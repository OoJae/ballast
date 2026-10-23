import {
  ColorType,
  CrosshairMode,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  LineSeries,
  LineStyle,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { type ChartTokens, chartTokens, useResolvedTheme } from "../theme";

export interface ChartLine {
  id: string;
  label: string;
  color: keyof ChartTokens;
  dashed?: boolean;
  /** Epoch ms → value; null is a gap (the recorded book was unsynced). */
  t: number[];
  v: (number | null)[];
}

export interface TimeChartProps {
  lines: ChartLine[];
  height?: number;
  precision: number;
  unit?: string;
  /** Epoch ms to mark (the judge's scrubber position). */
  marker?: number | null;
  ariaLabel: string;
}

const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

function seriesData(l: ChartLine) {
  return l.t.map((t, i) => {
    const v = l.v[i];
    return v === null || v === undefined ? { time: toTime(t) } : { time: toTime(t), value: v };
  });
}

/**
 * Time series on TradingView's Lightweight Charts (Apache-2.0; attribution in the footer).
 * Colors come from the design tokens and are re-read when the theme changes.
 */
export function TimeChart({
  lines,
  height = 260,
  precision,
  unit,
  marker,
  ariaLabel,
}: TimeChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef(new Map<string, ISeriesApi<"Line">>());
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const theme = useResolvedTheme();
  const [hover, setHover] = useState<Record<string, number | null> | null>(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const c = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        attributionLogo: false,
        fontFamily: getComputedStyle(document.body).fontFamily,
        fontSize: 11,
      },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (t: Time) => {
          const d = new Date((t as number) * 1000);
          return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
        },
      },
      localization: {
        timeFormatter: (t: Time) =>
          `${new Date((t as number) * 1000).toISOString().slice(11, 19)} UTC`,
      },
      crosshair: { mode: CrosshairMode.Magnet },
      handleScroll: { vertTouchDrag: false },
    });
    chart.current = c;
    const map = series.current;
    c.subscribeCrosshairMove((p) => {
      if (!p.time) {
        setHover(null);
        return;
      }
      const out: Record<string, number | null> = {};
      for (const [id, s] of map) {
        const d = p.seriesData.get(s) as { value?: number } | undefined;
        out[id] = d?.value ?? null;
      }
      setHover(out);
    });
    return () => {
      c.remove();
      chart.current = null;
      map.clear();
      markers.current = null;
    };
  }, []);

  // Series set and data.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const tk = chartTokens();
    const map = series.current;
    for (const [id, s] of map) {
      if (!lines.some((l) => l.id === id)) {
        c.removeSeries(s);
        map.delete(id);
      }
    }
    for (const l of lines) {
      let s = map.get(l.id);
      if (!s) {
        s = c.addSeries(LineSeries, {
          color: tk[l.color],
          lineWidth: 2,
          lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: !l.dashed,
          priceFormat: { type: "price", precision, minMove: 1 / 10 ** precision },
          crosshairMarkerRadius: 4,
        });
        map.set(l.id, s);
      }
      s.setData(seriesData(l));
    }
    c.timeScale().fitContent();
  }, [lines, precision]);

  // Theme: the effect reads CSS tokens, so the theme is its real input.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever the theme flips.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const tk = chartTokens();
    c.applyOptions({
      layout: { textColor: tk.ink3 },
      grid: { vertLines: { color: tk.line }, horzLines: { color: tk.line } },
      crosshair: {
        vertLine: { color: tk.ink3, labelBackgroundColor: tk.lineStrong },
        horzLine: { color: tk.ink3, labelBackgroundColor: tk.lineStrong },
      },
    });
    for (const l of linesRef.current) {
      series.current.get(l.id)?.applyOptions({ color: tk[l.color] });
    }
  }, [theme]);

  // Marker, snapped to the series' own grid (markers must sit on a data point).
  useEffect(() => {
    const first = series.current.values().next().value;
    const grid = lines[0]?.t;
    if (!first || !grid) return;
    const snapped =
      marker === null || marker === undefined
        ? null
        : grid.reduce<number | null>((best, t) => (t <= marker ? t : best), null);
    markers.current ??= createSeriesMarkers(first, []);
    const tk = chartTokens();
    markers.current.setMarkers(
      snapped !== null
        ? [{ time: toTime(snapped), position: "aboveBar", shape: "arrowDown", color: tk.brass }]
        : [],
    );
  }, [marker, lines]);

  const shown = (l: ChartLine) => {
    const v = hover ? hover[l.id] : l.v.findLast((x) => x !== null);
    return v === null || v === undefined ? "—" : v.toFixed(precision);
  };

  return (
    <div>
      <div className="legend" style={{ marginBottom: 8 }}>
        {lines.map((l) => (
          <span key={l.id}>
            <span
              className={`key${l.dashed ? " dash" : ""}`}
              style={l.dashed ? undefined : { background: `var(--${l.color})` }}
            />
            {l.label} <b className="num">{shown(l)}</b>
            {unit ? <span className="muted">{unit}</span> : null}
          </span>
        ))}
      </div>
      <div ref={box} className="chart-box" style={{ height }} role="img" aria-label={ariaLabel} />
    </div>
  );
}
