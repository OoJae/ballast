import type { BookFrame, WireLevel } from "@ballast/api/types";
import type { ReactNode } from "react";
import { fmtBps, fmtPrice, fmtQty, fmtUsd } from "../lib/format";

interface Row {
  px: number;
  qty: number;
  ballast: number;
  usd: number;
  cum: number;
}

function rows(levels: WireLevel[], n: number): Row[] {
  let cum = 0;
  return levels.slice(0, n).map(([px, qty, ballast]) => {
    const usd = px * qty;
    cum += usd;
    return { px, qty, ballast, usd, cum };
  });
}

const BAND = 0.005;

/**
 * The book as a ladder: asks above the waterline (the reference mid), bids below, a bar per
 * level scaled to its USD, Ballast's share of a level in oxide red, and the ±0.5% band marked.
 */
export function Ladder({ frame, depth = 8 }: { frame: BookFrame; depth?: number }) {
  const base = frame.symbol.split("-")[0] ?? "";
  const asks = rows(frame.asks, depth);
  const bids = rows(frame.bids, depth);
  const max = Math.max(1, ...asks.map((r) => r.usd), ...bids.map((r) => r.usd));
  const ref = frame.ref;
  const bandAsk = ref === null ? null : ref * (1 + BAND);
  const bandBid = ref === null ? null : ref * (1 - BAND);
  const w = (x: number) => `${Math.max(0.6, (x / max) * 100).toFixed(2)}%`;

  const row = (r: Row, side: "bid" | "ask") => (
    <li
      key={`${side}-${r.px}`}
      className="ladder-row"
      aria-label={`${side === "ask" ? "Ask" : "Bid"} ${fmtPrice(r.px, frame.symbol)}, ${fmtQty(r.qty)} ${base}${r.ballast > 0 ? `, ${fmtQty(r.ballast)} of it Ballast's` : ""}, ${fmtUsd(r.cum)} cumulative`}
    >
      <span className={`ladder-bar ${side}`} style={{ width: w(r.usd) }} />
      {r.ballast > 0 ? (
        <span className="ladder-bar ballast" style={{ width: w(r.ballast * r.px) }} />
      ) : null}
      <span className={`cell ${side === "ask" ? "px-ask" : "px-bid"}`}>
        {fmtPrice(r.px, frame.symbol)}
      </span>
      <span className="cell r">{fmtQty(r.qty)}</span>
      <span className="cell r muted">{fmtUsd(r.cum, { compact: true })}</span>
    </li>
  );

  // Asks are listed far-to-near so the best ask sits on the waterline.
  const askItems: ReactNode[] = [];
  let askBandShown = false;
  for (const r of [...asks].reverse()) {
    if (!askBandShown && bandAsk !== null && r.px <= bandAsk) {
      askItems.push(
        <li key="ask-band" className="ladder-band" aria-hidden="true">
          +0.5% from mid
        </li>,
      );
      askBandShown = true;
    }
    askItems.push(row(r, "ask"));
  }
  if (!askBandShown && bandAsk !== null) {
    askItems.push(
      <li key="ask-band" className="ladder-band" aria-hidden="true">
        +0.5% from mid
      </li>,
    );
  }
  const bidItems: ReactNode[] = [];
  let bidBandShown = false;
  for (const r of bids) {
    if (!bidBandShown && bandBid !== null && r.px < bandBid) {
      bidItems.push(
        <li key="bid-band" className="ladder-band" aria-hidden="true">
          −0.5% from mid
        </li>,
      );
      bidBandShown = true;
    }
    bidItems.push(row(r, "bid"));
  }

  return (
    <div className="ladder">
      <div className="ladder-row ladder-head" aria-hidden="true">
        <span className="cell">Price</span>
        <span className="cell r">Size ({base})</span>
        <span className="cell r">Total</span>
      </div>
      <ul className="ladder-side" aria-label={`Asks, ${frame.symbol}, farthest first`}>
        {askItems}
      </ul>
      <div className="waterline">
        <span>
          mid <b className="num">{fmtPrice(ref, frame.symbol)}</b>
        </span>
        <span>
          spread <b className="num">{fmtBps(frame.spreadBps)}</b> bps
        </span>
      </div>
      <ul className="ladder-side" aria-label={`Bids, ${frame.symbol}, nearest first`}>
        {bidItems}
      </ul>
    </div>
  );
}
