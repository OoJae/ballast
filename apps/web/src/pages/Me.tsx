import type { MeWire } from "@ballast/api/holder-types";
import { type ReactNode, useState } from "react";
import { Awaiting } from "../components/Awaiting";
import { footnotes, type SourceDef, SourceList } from "../components/Sources";
import { Stat } from "../components/Stat";
import { SignPreview, TxReview } from "../components/TxReview";
import { WalletPicker } from "../components/WalletPicker";
import { errorText, HolderApiError } from "../holder/api";
import { sessionPost, signOut, useHolder } from "../holder/store";
import { useMe } from "../holder/useMe";
import { completeWithdrawal, type PreparedWithdrawal, prepareWithdrawal } from "../lib/flows";
import { fmtUtc, shortHash } from "../lib/format";
import {
  capacityPreview,
  cexplorerTx,
  DEFAULT_R_BPS,
  fmtCents,
  formatBase,
  type MarginAsset,
  marginTotals,
  parseWithdrawUsd,
  REVOCATION_STEPS,
} from "../lib/join";
import { Link } from "../router";

function sources(me: MeWire | null): SourceDef[] {
  const c = me?.cover;
  return [
    {
      id: "cover",
      title: c
        ? `Koios, pinned NIGHT at this stake key, block ${c.height}; Proof of Cover ${c.proofHash}`
        : "Koios, pinned NIGHT at this stake key, via Ballast's cover oracle",
      text: (
        <>
          Cover: Ballast's cover oracle reading Koios for the registry-pinned NIGHT asset at your
          stake key
          {c
            ? ` at block ${c.height.toLocaleString("en-US")} (tip ${shortHash(c.tipHash, 8)})`
            : ""}
          . Script-locked, Byron and other-stake UTxOs are excluded.{" "}
          {c ? (
            <>
              Proof hash <span className="hash">{c.proofHash}</span>; recheck any time with{" "}
              <code>pnpm cover {me?.stakeAddress}</code>.
            </>
          ) : null}
        </>
      ),
    },
    {
      id: "strike",
      title: "Strike's public GET /v2/account?blockchain_address= for this wallet",
      text: (
        <>
          Strike balance: Strike's public <code>GET /v2/account?blockchain_address=</code> for this
          wallet, read when this page loaded.
        </>
      ),
    },
    {
      id: "ledger",
      title: "Ballast's own record of each deposit and withdrawal it relayed for you",
      text: (
        <>
          Deposits and withdrawals: Ballast's record of each request it relayed for you, with the
          Cardano transaction your wallet submitted. Strike's own history is the reference.
        </>
      ),
    },
  ];
}

export function Me() {
  const { wallet, session } = useHolder();
  const { me, error, refresh } = useMe(session?.token ?? null);
  const srcs = sources(me);
  const fn = footnotes(srcs);
  return (
    <>
      <header className="page-head">
        <p className="overline brass">Your account</p>
        <h1>{me?.accountId ? "Cover, quotes and margin" : "Your Ballast account"}</h1>
        <p className="lede">
          Only you see this page, and only after your wallet signs you in. Browsing the rest of
          Ballast needs no wallet; nothing here connects by itself.
        </p>
      </header>
      {!session ? (
        <section className="section">
          <div className="card" style={{ display: "grid", gap: 14 }}>
            <h2 className="card-title">Sign in with your wallet</h2>
            <WalletPicker />
            <p className="small muted">
              New here? <Link to="/join">Join</Link> walks through connecting and funding.
            </p>
          </div>
        </section>
      ) : (
        <>
          {error ? <div className="error-box">{error}</div> : null}
          {me && !me.accountId ? (
            <div className="notice">
              This wallet has no Ballast account yet. <Link to="/join">Join</Link> to connect it.
            </div>
          ) : null}
          {me ? (
            <Overview me={me} fn={fn} />
          ) : (
            <div className="chart-skeleton" style={{ height: 160 }} />
          )}
          {me?.accountId ? (
            <>
              <Quotes />
              <FundingLedger />
              <Margin me={me} fn={fn} />
              <Actions me={me} wallet={wallet} onChange={refresh} />
              <Revocation />
            </>
          ) : null}
          <p className="tiny muted" style={{ marginTop: 24 }}>
            Signed in as <span className="hash">{session.address}</span>.{" "}
            <button type="button" className="linkish" onClick={signOut}>
              Sign out
            </button>
          </p>
          <SourceList sources={srcs} />
        </>
      )}
    </>
  );
}

function Meter({
  label,
  value,
  max,
  color,
  note,
}: {
  label: string;
  value: bigint;
  max: bigint;
  color: string;
  note: ReactNode;
}) {
  const pct = max > 0n ? Number((value * 10_000n) / max) / 100 : 0;
  return (
    <div className="meter-row">
      <div className="meter-label">
        <span>{label}</span>
        <b>{formatBase(value)} NIGHT</b>
      </div>
      <div className="meter-track" aria-hidden="true">
        {value > 0n ? (
          <div
            className="meter-fill"
            style={{ width: `${Math.min(100, pct)}%`, background: color }}
          />
        ) : null}
      </div>
      <div className="stat-note">{note}</div>
    </div>
  );
}

function Overview({ me, fn }: { me: MeWire; fn: (id: string) => ReactNode }) {
  const rBps = me.consent?.rBps ?? me.account?.rBps ?? DEFAULT_R_BPS;
  const cover = me.cover ? BigInt(me.cover.coverBase) : null;
  const maxShort = me.consent ? BigInt(me.consent.maxShortBase) : null;
  const cap = cover !== null ? capacityPreview(cover, rBps, maxShort) : null;
  const committed = 0n; // short + resting + pending: nothing quotes before M7.
  const status = me.account?.status ?? "not connected";
  return (
    <section className="section" aria-labelledby="cover-title">
      <div className="section-head">
        <div style={{ display: "grid", gap: 8 }}>
          <p className="overline">Proof of Cover</p>
          <h2 id="cover-title">
            {cap && cover !== null
              ? `Short ${formatBase(committed)} ≤ ${formatBase(cap.effective)} covered of ${formatBase(cover)} in wallet`
              : "Cover"}
          </h2>
        </div>
        <span className={`chip${me.account?.status === "paused" ? " bad" : ""}`}>
          {status === "paused"
            ? `Paused: ${me.account?.pausedReason ?? ""}`
            : "Not armed: waiting for the operator's policy"}
        </span>
      </div>
      <div className="grid grid-2">
        <div className="card meter">
          {cover !== null && cap ? (
            <>
              <Meter
                label="NIGHT in your wallet"
                value={cover}
                max={cover}
                color="var(--cf)"
                note={
                  <>
                    at block {me.cover?.height.toLocaleString("en-US")}
                    {fn("cover")}
                  </>
                }
              />
              <Meter
                label={`Capacity (r = ${(rBps / 10_000).toFixed(2)})`}
                value={cap.effective}
                max={cover}
                color="var(--ballast)"
                note={`set by ${cap.limitedBy}; never above 0.9 × cover`}
              />
              <Meter
                label="Short + resting asks + pending"
                value={committed}
                max={cover}
                color="var(--ask)"
                note="nothing quotes until the operator arms your account"
              />
            </>
          ) : (
            <p className="small muted">
              {me.coverStatus === "not-configured"
                ? "The cover oracle is off on this server, so cover is not shown."
                : "Koios could not be read just now; cover appears when it answers."}
            </p>
          )}
        </div>
        <div className="card">
          <div className="stats" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
            <Stat
              label="r"
              value={(rBps / 10_000).toFixed(2)}
              note={me.consent ? "from your signed consent" : "default until you consent"}
            />
            <Stat
              label="Max short"
              value={maxShort !== null ? formatBase(maxShort) : "—"}
              unit="NIGHT"
              note="from your consent"
            />
            <Stat
              label="UTxOs counted"
              value={me.cover ? String(me.cover.utxos) : "—"}
              note={me.cover ? `${me.cover.excluded} excluded` : "—"}
            />
            <Stat
              label="Consent"
              value={me.consent ? shortHash(me.consent.hash, 6) : "—"}
              note={me.consent ? fmtUtc(me.consent.signedAtMs) : "not signed yet"}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function Quotes() {
  return (
    <section className="section">
      <div className="grid grid-2">
        <Awaiting tag="Placeholder · M7" title="Resting asks">
          <p className="small">
            Your post-only asks on NIGHT-USD, each a <code>bal_</code> order tied to a signed
            policy, with its place in Strike's L3 book. Nothing rests until the operator arms your
            account.
          </p>
        </Awaiting>
        <Awaiting tag="Placeholder · M7" title="Fills">
          <p className="small">
            Each maker fill with its public trade id and the policy behind it, so you can check it
            with <code>ballast verify</code>.
          </p>
        </Awaiting>
      </div>
    </section>
  );
}

/** Funding paid to (or by) your short, against the zero line the risk disclosure names. */
function FundingLedger() {
  return (
    <section className="section" aria-labelledby="funding-title">
      <div className="section-head">
        <div style={{ display: "grid", gap: 8 }}>
          <p className="overline">Funding ledger</p>
          <h2 id="funding-title">Funding received as a short, against zero</h2>
        </div>
        <p>Shorts are paid when funding is positive. It can be zero, or negative.</p>
      </div>
      <div className="card">
        <svg
          className="zero-chart"
          viewBox="0 0 600 120"
          role="img"
          aria-label="Funding over time: no entries yet, shown against the zero-funding line"
        >
          <line x1="0" y1="60" x2="600" y2="60" className="zero-line-stroke" />
          <text x="8" y="52" className="depth-label">
            zero funding
          </text>
          <text x="592" y="80" textAnchor="end" className="depth-label">
            no position yet
          </text>
        </svg>
        <p className="tiny muted" style={{ marginTop: 8 }}>
          Entries appear here from Strike's funding history once you hold a short (M7). Above the
          line you were paid; on it you earn only the maker rebate; below it you paid.
        </p>
      </div>
    </section>
  );
}

function Margin({ me, fn }: { me: MeWire; fn: (id: string) => ReactNode }) {
  const totals = marginTotals(me.funding);
  return (
    <section className="section" aria-labelledby="margin-title">
      <div className="section-head">
        <div style={{ display: "grid", gap: 8 }}>
          <p className="overline">Margin</p>
          <h2 id="margin-title">Deposits and withdrawals{fn("ledger")}</h2>
        </div>
        <p>
          Strike balance{fn("strike")}:{" "}
          {me.strike === null
            ? "could not be read"
            : me.strike.status === 404
              ? "no account yet"
              : `$${me.strike.walletBalance ?? "—"}`}
        </p>
      </div>
      <div className="card">
        {me.funding.length === 0 ? (
          <p className="small muted">Nothing deposited through Ballast yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th className="n">USD</th>
                  <th>Status</th>
                  <th>Cardano tx</th>
                </tr>
              </thead>
              <tbody>
                {me.funding.map((f) => (
                  <tr key={`${f.kind}-${f.requestId}`}>
                    <td>{fmtUtc(f.updatedAtMs)}</td>
                    <td>
                      {f.kind === "deposit" ? "Deposit" : "Withdrawal"} · {f.asset}
                    </td>
                    <td className="n num">{f.usdValue ?? "—"}</td>
                    <td>{f.status}</td>
                    <td>
                      {f.txHash ? (
                        <a href={cexplorerTx(f.txHash)} rel="noreferrer" className="hash">
                          {shortHash(f.txHash, 8)}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="tiny muted" style={{ marginTop: 8 }}>
          Submitted through Ballast: {fmtCents(totals.depositedCents)} in,{" "}
          {fmtCents(totals.withdrawnCents)} out.
        </p>
      </div>
    </section>
  );
}

function Actions({
  me,
  wallet,
  onChange,
}: {
  me: MeWire;
  wallet: ReturnType<typeof useHolder>["wallet"];
  onChange: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asset, setAsset] = useState<MarginAsset>("ADA");
  const [usd, setUsd] = useState("");
  const [prepared, setPrepared] = useState<PreparedWithdrawal | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const parsed = parseWithdrawUsd(usd);
  const accountId = me.accountId as string;
  const paused = me.account?.status === "paused";
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  const stop = () =>
    run("Stopping…", async () => {
      await sessionPost()("stop", {});
      onChange();
    });
  const quote = () =>
    run("Two short signatures approve the estimate and the quote…", async () => {
      if (!wallet || !parsed.ok) return;
      setPrepared(await prepareWithdrawal(sessionPost(), wallet, accountId, asset, parsed.value));
    });
  const sign = () =>
    run(
      "Sign the withdrawal message, then the small funding transaction, then confirm…",
      async () => {
        if (!wallet || !prepared) return;
        setSent((await completeWithdrawal(sessionPost(), wallet, accountId, prepared)).withdrawId);
        setPrepared(null);
        onChange();
      },
    );
  const fallback = error instanceof HolderApiError && error.body.fallback === "strike-app";
  return (
    <section className="section" aria-labelledby="actions-title">
      <div className="section-head">
        <div style={{ display: "grid", gap: 8 }}>
          <p className="overline">Stop, Close, Withdraw</p>
          <h2 id="actions-title">Your way out, in order</h2>
        </div>
      </div>
      <div className="grid grid-3">
        <div className="card" style={{ display: "grid", gap: 10, alignContent: "start" }}>
          <h3 className="card-title">Stop</h3>
          <p className="small">
            Pauses your account so the keeper arms nothing for it. Once quoting runs, Stop also
            cancels every Ballast order first.
          </p>
          <div>
            <button
              type="button"
              className="btn"
              disabled={paused || busy !== null}
              onClick={() => void stop()}
            >
              {paused ? "Stopped" : "Stop"}
            </button>
          </div>
        </div>
        <div className="card" style={{ display: "grid", gap: 10, alignContent: "start" }}>
          <h3 className="card-title">Close</h3>
          <p className="small">
            Buys a short back with reduce-only orders. You hold no short: nothing has ever quoted
            for this account.
          </p>
          <div>
            <button type="button" className="btn" disabled>
              Nothing to close
            </button>
          </div>
        </div>
        <div className="card" style={{ display: "grid", gap: 10, alignContent: "start" }}>
          <h3 className="card-title">Withdraw</h3>
          <p className="small">
            Margin back to this wallet, signed by your wallet. $5 minimum, $1 fee; your wallet also
            pays about 2 ADA plus fees toward the payout transaction.
          </p>
          {sent ? (
            <div className="notice">
              Withdrawal <span className="hash">{shortHash(sent, 8)}</span> accepted by Strike; it
              settles in the queue.
            </div>
          ) : null}
          {!prepared ? (
            <>
              <fieldset className="tabs" aria-label="Withdraw as">
                {(["ADA", "USDM"] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    aria-pressed={asset === a}
                    onClick={() => setAsset(a)}
                  >
                    {a}
                  </button>
                ))}
              </fieldset>
              <label className="field">
                Amount (USD)
                <input
                  type="text"
                  inputMode="decimal"
                  value={usd}
                  onChange={(e) => setUsd(e.target.value)}
                  placeholder="20"
                />
              </label>
              {usd && !parsed.ok ? (
                <p className="small" style={{ color: "var(--ask)" }}>
                  {parsed.reason}
                </p>
              ) : null}
              <div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!parsed.ok || !wallet || busy !== null}
                  onClick={() => void quote()}
                >
                  Get a withdrawal quote
                </button>
              </div>
              {!wallet ? <p className="tiny muted">Reconnect your wallet to withdraw.</p> : null}
            </>
          ) : null}
        </div>
      </div>
      {prepared ? (
        <div className="card" style={{ display: "grid", gap: 14 }}>
          {prepared.quote.message ? (
            <SignPreview
              label="Strike's message your wallet will sign (shown decoded; signed as the hex Strike sent):"
              text={prepared.quote.message}
            />
          ) : null}
          {prepared.quote.summary && wallet ? (
            <TxReview summary={prepared.quote.summary} own={wallet.address} />
          ) : null}
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={busy !== null}
              onClick={() => void sign()}
            >
              Sign in {wallet?.name ?? "your wallet"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => setPrepared(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {busy ? (
        <p className="small muted" aria-live="polite">
          {busy}
        </p>
      ) : null}
      {error ? (
        <div className="error-box" role="alert">
          {errorText(error)}
          {fallback ? (
            <p className="small" style={{ marginTop: 8 }}>
              Withdraw in{" "}
              <a href="https://www.strikefinance.org" rel="noreferrer">
                Strike's own app
              </a>{" "}
              with this wallet instead.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Revocation() {
  return (
    <section className="section" aria-labelledby="revoke-title">
      <div className="section-head">
        <div style={{ display: "grid", gap: 8 }}>
          <p className="overline">Leaving</p>
          <h2 id="revoke-title">Revoking Ballast: Stop before revoke</h2>
        </div>
      </div>
      <div className="card steps">
        {REVOCATION_STEPS.map((s) => (
          <div className="step" key={s.title}>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
