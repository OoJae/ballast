import { Awaiting, Checklist } from "../components/Awaiting";
import { Link } from "../router";

export function Conduct() {
  return (
    <>
      <header className="page-head">
        <p className="overline brass">Proof of Conduct</p>
        <h1>Every order accounted for</h1>
        <p className="lede">
          Each maker account will be audited every 60 seconds by a public process that reads only
          Strike's own endpoints. A maker account does one thing: Ballast's covered asks, under a
          signed policy.
        </p>
      </header>
      <section className="section">
        <Awaiting title="No maker account is armed yet">
          <p>
            When holder #0 arms, a row per maker account appears here, refreshed every minute, with
            the result of each check below and the time it last passed. Until then there is nothing
            to audit, so nothing is shown.
          </p>
          <Checklist
            items={[
              {
                title: "Only Ballast orders",
                body: (
                  <>
                    every entry in <code>/v2/openOrders</code> and <code>/v2/history/order</code> is
                    a <code>bal_</code> order that parses to a signed policy, carrying the Ballast
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
            <Link to="/policies">the signed policies</Link> each order resolves to.
          </p>
        </Awaiting>
      </section>
    </>
  );
}
