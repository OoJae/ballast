import { Awaiting, Checklist } from "../components/Awaiting";
import { Link } from "../router";

export function Makers() {
  return (
    <>
      <header className="page-head">
        <p className="overline brass">Makers</p>
        <h1>The holders behind the asks</h1>
        <p className="lede">
          Every Ballast maker is a Cardano holder quoting from their own Strike account, with their
          own coins as cover. Profiles are opt-in; the default is an aggregate count.
        </p>
      </header>
      <section className="section">
        <Awaiting title="No maker has armed yet">
          <p>
            Holder #0, the team's own account, arms first and is always allocated last. Outside
            holders follow once it has run 72 hours with zero cover violations. Each opted-in maker
            gets a profile showing:
          </p>
          <Checklist
            items={[
              { title: "Handle", body: "an ADA handle the maker chooses to show, or nothing." },
              {
                title: "Cover",
                body: "the NIGHT their stake credential holds on Koios, block by block.",
              },
              { title: "Quotes", body: "their resting asks on L3, highlighted in the book." },
              { title: "Fills", body: "public maker fills, each tied to a signed policy." },
            ]}
          />
          <p className="small muted">
            Until then, the book is measured without them on{" "}
            <Link to="/book-health">Book Health</Link>.
          </p>
        </Awaiting>
      </section>
    </>
  );
}
