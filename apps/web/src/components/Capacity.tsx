import type { CapacityResponse } from "@ballast/api/types";
import type { ReactNode } from "react";
import { fmtDuration, fmtUsd } from "../lib/format";

function Meter({
  label,
  value,
  max,
  color,
  shown,
  note,
}: {
  label: ReactNode;
  value: number | null;
  max: number;
  color: string;
  shown: string;
  note: ReactNode;
}) {
  const pct = value === null ? 0 : Math.min(100, (value / max) * 100);
  return (
    <div className="meter-row">
      <div className="meter-label">
        <span>{label}</span>
        <b>{shown}</b>
      </div>
      <div className="meter-track" aria-hidden="true">
        {value !== null && value > 0 ? (
          <div className="meter-fill" style={{ width: `${pct}%`, background: color }} />
        ) : null}
      </div>
      <div className="stat-note">{note}</div>
    </div>
  );
}

/**
 * How much Ballast could absorb: committed cover (K) against the taker buy flow it would meet
 * and the asks it could buy back from. All three on one USD scale.
 */
export function CapacityGauge({ cap, fn }: { cap: CapacityResponse; fn?: ReactNode }) {
  const flow = cap.takerBuyFlow?.usd ?? 0;
  const exit = cap.exitDepthUsd ?? 0;
  const max = Math.max(1, flow, exit);
  const hours = cap.window ? fmtDuration(cap.window.toMs - cap.window.fromMs) : "—";
  return (
    <div className="meter">
      <Meter
        label="Cover committed"
        value={null}
        max={max}
        color="var(--ballast)"
        shown="—"
        note="Coming with the cover oracle. No holder is armed yet."
      />
      <Meter
        label={<>Taker buy flow{fn}</>}
        value={flow}
        max={max}
        color="var(--ask)"
        shown={fmtUsd(flow)}
        note={`${cap.takerBuyFlow?.buys ?? 0} taker ${cap.takerBuyFlow?.buys === 1 ? "buy" : "buys"} on L3 over the last ${hours} of sealed recordings.`}
      />
      <Meter
        label="Exit depth within 2%"
        value={exit}
        max={max}
        color="var(--bid)"
        shown={fmtUsd(exit)}
        note="Time-weighted asks within 2% of the mid, Ballast excluded: what a forced buy-back could lift."
      />
    </div>
  );
}
