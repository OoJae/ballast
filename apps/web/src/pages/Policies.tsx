import { Checklist } from "../components/Awaiting";
import { BUNDLE_URL, CRITIC_REPORTS, ENVELOPES, POLICIES, usd } from "../evidence";
import { fmtUtc } from "../lib/format";

/** One signed policy, set out like a Load Line Certificate: what may be loaded, and who signed. */
function Certificate() {
  const p = POLICIES[0];
  if (!p) return null;
  const q = p.policy;
  const critic = CRITIC_REPORTS.find((r) => r.policyHash === p.hash);
  const env = ENVELOPES.find((e) => e.envelope.basePolicyHash === p.hash);
  const now = Date.now();
  const state =
    now < q.validFromMs
      ? "not yet valid"
      : now <= q.validUntilMs
        ? "in force"
        : "base window ended";
  return (
    <article className="certificate" aria-labelledby="cert-title">
      <header className="cert-head">
        <p className="label">Load line certificate · policy {q.policyId}</p>
        <h2 id="cert-title">
          {q.market}, asks only, r ≤ {(q.sizing.rMaxBps / 10_000).toFixed(2)}
        </h2>
        <p className="hash">sha256 {p.hash}</p>
      </header>
      <dl className="kv cert-kv">
        <dt>Validity</dt>
        <dd>
          {fmtUtc(q.validFromMs)} → {fmtUtc(q.validUntilMs)} ({state})
          {env
            ? `; renewable daily up to ${env.envelope.maxRenewals} times, never past ${fmtUtc(env.envelope.notAfterMs)}, each renewal only after a fresh Critic PASS`
            : ""}
        </dd>
        <dt>Prices</dt>
        <dd>
          First ask at least {q.pricing.minOffsetBps} bps above the index; levels{" "}
          {q.pricing.levelSpacingBps.join(" and ")} bps further up; never below the
          liquidation-aware floor plus {q.pricing.liqBufferBps} bps
        </dd>
        <dt>Load line</dt>
        <dd>
          short + resting asks + pending ≤ {(q.sizing.rMaxBps / 10_000).toFixed(2)} × the NIGHT in
          the holder's wallet
        </dd>
        <dt>Caps</dt>
        <dd>
          {usd(q.sizing.preD6DepthCapMicroUsd)} of depth before test D6;{" "}
          {usd(q.sizing.perAccountMaxShortMicroUsd)} short per account;{" "}
          {usd(q.sizing.aggregateMaxShortMicroUsd)} across all accounts; leverage ≤{" "}
          {(q.risk.maxLeverageX100 / 100).toFixed(1)}×
        </dd>
        <dt>Fees</dt>
        <dd>
          Builder fee {q.fees.entryBuilderBps} bps on entries, {q.fees.exitBuilderBps} on exits
        </dd>
        <dt>Signed by</dt>
        <dd className="hash">operator {p.operatorPubkey}</dd>
        <dt>Survey</dt>
        <dd>
          {critic
            ? `Critic ${critic.verdict}: ${critic.reason}, replayed by sim ${critic.simGitSha}`
            : "no Critic report"}
        </dd>
      </dl>
      {critic ? (
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">Critic scenarios for this policy</caption>
            <thead>
              <tr>
                <th scope="col">Scenario</th>
                <th scope="col" className="n">
                  Fills
                </th>
                <th scope="col" className="n">
                  Armed h
                </th>
                <th scope="col" className="n">
                  Violations
                </th>
              </tr>
            </thead>
            <tbody>
              {critic.scenarios.map((s) => (
                <tr key={s.id}>
                  <td>{s.id}</td>
                  <td className="n">{s.fills}</td>
                  <td className="n">{s.armedHours.toFixed(2)}</td>
                  <td className="n">{Object.values(s.violations).reduce((a, b) => a + b, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="small muted">
        The certificate, its Critic report and its renewal envelope are in the{" "}
        <a href={BUNDLE_URL}>published evidence bundle</a>; <code>ballast verify</code> re-checks
        the operator signature and the report. Stamped: preprod evidence bundle; the policy governs
        NIGHT-USD on Strike mainnet.
      </p>
    </article>
  );
}

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
        <Certificate />
      </section>
      <section className="section" aria-labelledby="carries">
        <h2 id="carries">What every certificate carries</h2>
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
              body: "a deterministic replay over recorded hours and a stress library, with violations by kind and a PASS or FAIL. A FAIL, or any error, means no activation.",
            },
            {
              title: "Advisor notes",
              body: "plain-language explanations of each change, marked non-blocking: the language model can explain a policy, never sign, block or trade.",
            },
          ]}
        />
      </section>
    </>
  );
}
