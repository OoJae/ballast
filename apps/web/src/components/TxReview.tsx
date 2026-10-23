import type { TxSummaryWire } from "@ballast/api/holder-types";
import { shortHash } from "../lib/format";
import { formatBase } from "../lib/join";

/**
 * What a transaction does, decoded from its bytes by the API before the wallet's own screen
 * shows it. The wallet's confirmation is the one that counts; this is a second look.
 */
/** An output's id on chain is `txHash#index`: a stable key for each row. */
function outputRefs(s: TxSummaryWire) {
  return s.outputs.map((o, index) => ({ ...o, ref: `${s.txHash}#${index}` }));
}

export function TxReview({ summary, own }: { summary: TxSummaryWire; own: string }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <dl className="kv">
        <dt>Transaction</dt>
        <dd className="hash">{summary.txHash}</dd>
        <dt>Network fee</dt>
        <dd className="num">{formatBase(summary.feeLovelace)} ADA</dd>
        <dt>Inputs</dt>
        <dd className="num">{summary.inputs.length} of your UTxOs</dd>
      </dl>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Pays to</th>
              <th className="n">ADA</th>
              <th className="n">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {outputRefs(summary).map((o) => (
              <tr key={o.ref}>
                <td className="hash">
                  {o.address === own ? "your wallet (change)" : shortHash(o.address, 14)}
                </td>
                <td className="n num">{formatBase(o.lovelace)}</td>
                <td className="n num">
                  {o.assets.length === 0
                    ? "—"
                    : o.assets
                        .map((a) => `${formatBase(a.quantity)} ${shortHash(a.policyId, 6)}`)
                        .join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The exact text a wallet is about to be asked to sign. */
export function SignPreview({ text, label }: { text: string; label: string }) {
  return (
    <figure className="signbox">
      <figcaption className="tiny muted">{label}</figcaption>
      <pre>{text}</pre>
    </figure>
  );
}
