import type { BookHealthReportWire, MetricSummary } from "@ballast/api/types";
import { fmtBps, fmtUsd } from "../lib/format";

interface MetricRow {
  key: string;
  name: string;
  def: string;
  kind: "bps" | "usd";
  /** Better when lower (spread, slippage) or higher (depth). */
  lowerIsBetter: boolean;
}

export const SCORECARD_ROWS: MetricRow[] = [
  {
    key: "spreadBps",
    name: "Spread",
    def: "Time-weighted (ask − bid) / mid, bps",
    kind: "bps",
    lowerIsBetter: true,
  },
  ...(["0.5%", "1%", "2%"] as const).flatMap((b) => [
    {
      key: `depthUsd.ask.${b}`,
      name: `Asks within ${b}`,
      def: `USD resting at or below mid + ${b}`,
      kind: "usd" as const,
      lowerIsBetter: false,
    },
    {
      key: `depthUsd.bid.${b}`,
      name: `Bids within ${b}`,
      def: `USD resting at or above mid − ${b}`,
      kind: "usd" as const,
      lowerIsBetter: false,
    },
  ]),
  ...(["1000", "10000", "25000"] as const).flatMap((z) => [
    {
      key: `slippageBps.buy.${z}`,
      name: `$${Number(z) / 1000}K market buy`,
      def: "VWAP over mid, bps",
      kind: "bps" as const,
      lowerIsBetter: true,
    },
    {
      key: `slippageBps.sell.${z}`,
      name: `$${Number(z) / 1000}K market sell`,
      def: "VWAP under mid, bps",
      kind: "bps" as const,
      lowerIsBetter: true,
    },
  ]),
];

function cell(m: MetricSummary | undefined, kind: "bps" | "usd"): string {
  if (!m || m.mean === null) return "—";
  const v = Number(m.mean);
  const s = kind === "usd" ? fmtUsd(v) : fmtBps(v);
  return m.coverage < 0.999 ? `${s} (${Math.round(m.coverage * 100)}% of time)` : s;
}

/**
 * The §7 scorecard: before (no Ballast orders) vs armed, and while armed the actual book vs the
 * counterfactual book with Ballast removed, both against the counterfactual mid.
 */
export function Scorecard({ report, caption }: { report: BookHealthReportWire; caption: string }) {
  const armed = report.armed.ms > 0;
  return (
    <div className="table-wrap">
      {armed ? null : (
        <p className="tiny muted" style={{ marginBottom: 6 }}>
          No Ballast orders rested in this window, so the book with and without Ballast is the same
          book. Armed and counterfactual columns appear with the first armed run.
        </p>
      )}
      <table className={armed ? "scorecard" : "scorecard single"}>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col" className="n">
              Unarmed
            </th>
            {armed ? (
              <>
                <th scope="col" className="n">
                  Armed, actual
                </th>
                <th scope="col" className="n">
                  Armed, without Ballast
                </th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {SCORECARD_ROWS.map((r) => (
            <tr key={r.key}>
              <td>
                <div className="metric-name">{r.name}</div>
                <div className="metric-def">{r.def}</div>
              </td>
              <td className="n" data-label="Unarmed">
                {cell(report.unarmed.actual[r.key], r.kind)}
              </td>
              {armed ? (
                <>
                  <td className="n" data-label="Armed, actual">
                    {cell(report.armed.actual[r.key], r.kind)}
                  </td>
                  <td className="n" data-label="Armed, without Ballast">
                    {cell(report.armed.counterfactual[r.key], r.kind)}
                  </td>
                </>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function metric(
  report: BookHealthReportWire | null | undefined,
  key: string,
): number | null {
  const m = report?.unarmed.actual[key];
  return m?.mean === null || m?.mean === undefined ? null : Number(m.mean);
}
