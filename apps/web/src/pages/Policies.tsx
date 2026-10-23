import { Awaiting, Checklist } from "../components/Awaiting";

export function Policies() {
  return (
    <>
      <header className="page-head">
        <p className="overline brass">Policies</p>
        <h1>The rules, signed before the first order</h1>
        <p className="lede">
          Ballast quotes only inside a parametric policy that the operator signs with an offline
          key. A deterministic replay of recorded L3, the Critic, must pass it first. Prices come
          from live state, so market moves never need a new policy.
        </p>
      </header>
      <section className="section">
        <Awaiting title="No policy has been activated yet">
          <p>
            The chain of signed policies appears here from the first activation, newest first, each
            linked to the one before it by hash. Every Ballast order id resolves to one of them.
          </p>
          <Checklist
            items={[
              {
                title: "The policy",
                body: "market, validity (24 h at most), price offsets and floor buffer, ladder shape, sizing caps, leverage and margin bands, fee caps, exit mode and requote limits; hashed as canonical JSON (RFC 8785).",
              },
              {
                title: "The signature",
                body: "the operator's Ed25519 signature over that hash, and the previous policy's hash.",
              },
              {
                title: "The Critic report",
                body: "a deterministic replay over the last 24 h and a stress library, with violations by kind and a PASS or FAIL. A FAIL, or any error, means no activation.",
              },
              {
                title: "Advisor notes",
                body: "plain-language explanations of each change, marked non-blocking: the language model can explain a policy, never sign, block or trade.",
              },
            ]}
          />
        </Awaiting>
      </section>
    </>
  );
}
