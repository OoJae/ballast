import type { ReactNode } from "react";

export function Stat({
  label,
  value,
  unit,
  note,
  fn,
  wide,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  note?: ReactNode;
  fn?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`stat${wide ? " wide" : ""}`}>
      <div className="stat-label">
        {label}
        {fn}
      </div>
      <div className="stat-value">
        {value}
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}
