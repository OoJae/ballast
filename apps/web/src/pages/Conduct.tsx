import { Checklist } from "../components/Awaiting";
import { ANCHOR_URL, DECISIONS, EVIDENCE_URL } from "../evidence";
import { fmtUtc, shortHash } from "../lib/format";
import { Link } from "../router";

const ENTRY: Record<string, string> = {
  policy: "Policy activated after a Critic PASS",
  anchor: "Log and recordings anchored on Cardano (preprod)",
};

/** Ballast's orders on Strike mainnet so far: all day-one tests, all labelled (bal_d…). */
const DAY_ONE: { test: string; what: string; outcome: string }[] = [
  {
    test: "D2",
    what: "2 post-only asks 4% above the mark, one per quoting route",
    outcome: 'Strike shows Builder{Code:"Ballast", FeeBps:10} on both; cancelled, no fill',
  },
  {
    test: "D8",
    what: "20 replace-batches of one far ask",
    outcome: "all accepted at 57 ops/min; cancelled, no fill",
  },
  {
    test: "D7",
    what: "100 far asks, each killed by a cancel-all",
    outcome: "cancel confirmed in p50 285 ms, p99 814 ms; no fill",
  },
  {
    test: "D3",
    what: "1 covered ask of 272 NIGHT at the mark, the best ask on the book",
    outcome:
      "bought by the team's probe account: maker rebate earned, builder fee $0.01; labelled PROBE, excluded from KPIs",
  },
];

export function Conduct() {
  return (
    <>
      <header className="page-head">
        <p className="overline brass">Proof of Conduct</p>
        <h1>Every order accounted for</h1>
        <p className="lede">
          A maker account does one thing: Ballast's covered asks, under a signed policy. Every
          decision is signed into a hash chain, and the chain is anchored on Cardano.
        </p>
      </header>

      <section className="section" aria-labelledby="log-title">
        <div className="section-head">
          <h2 id="log-title">The log</h2>
          <p>Daemon-signed, hash-chained entries, as published in the evidence bundle.</p>
        </div>
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">Signed decision log</caption>
            <thead>
              <tr>
                <th scope="col">Seq</th>
                <th scope="col">Time</th>
                <th scope="col">Entry</th>
                <th scope="col">Hash</th>
                <th scope="col">Links to</th>
              </tr>
            </thead>
            <tbody>
              {DECISIONS.map((d) => (
                <tr key={d.seq}>
                  <td className="n">{d.seq}</td>
                  <td>{fmtUtc(d.tsMs)}</td>
                  <td>
                    {ENTRY[d.kind] ?? d.kind}
                    {d.kind === "anchor" ? (
                      <>
                        {" "}
                        (<a href={ANCHOR_URL}>tx</a>)
                      </>
                    ) : null}
                  </td>
                  <td className="hash">{shortHash(d.hash)}</td>
                  <td className="hash">{d.prevHash ? shortHash(d.prevHash) : "genesis"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section" aria-labelledby="dayone-title">
        <div className="section-head">
          <h2 id="dayone-title">Ballast's orders on Strike mainnet so far</h2>
          <p>
            All of them day-one tests from holder #0, the team's own account, on 23 Oct 2026. Each
            carries a <code>bal_d…</code> client id.
          </p>
        </div>
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">Day-one test orders</caption>
            <thead>
              <tr>
                <th scope="col">Test</th>
                <th scope="col">Orders</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {DAY_ONE.map((r) => (
                <tr key={r.test}>
                  <td>{r.test}</td>
                  <td>{r.what}</td>
                  <td>{r.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small">
          Details and evidence files: <a href={EVIDENCE_URL}>EVIDENCE.md</a>.
        </p>
      </section>

      <section className="section" aria-labelledby="audit-title">
        <div className="section-head">
          <h2 id="audit-title">The live audit, once holder #0 arms</h2>
          <p>
            A public process re-checks every maker account every 60 seconds, reading only Strike's
            own endpoints.
          </p>
        </div>
        <Checklist
          items={[
            {
              title: "Only Ballast orders",
              body: (
                <>
                  every entry in <code>/v2/openOrders</code> and <code>/v2/history/order</code> is a{" "}
                  <code>bal_</code> order that parses to a signed policy, carrying the Ballast
                  builder code within its fee cap.
                </>
              ),
            },
            {
              title: "No vault shares",
              body: (
                <>
                  <code>/v2/vault/positions</code> is empty for the account.
                </>
              ),
            },
            {
              title: "Only covered shorts",
              body: "positions are NIGHT (or ADA) shorts no larger than r × the cover Koios shows.",
            },
            {
              title: "Foreign activity is flagged",
              body: 'any manual order or other position marks the account "paused: non-Ballast activity" in public.',
            },
          ]}
        />
        <p className="small muted">
          Accounts appear by an opt-in handle or an opaque index, never by address. See also{" "}
          <Link to="/policies">the signed policy</Link> each order resolves to.
        </p>
      </section>
    </>
  );
}
