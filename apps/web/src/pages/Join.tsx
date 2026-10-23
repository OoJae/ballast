import type {
  AccountCheckWire,
  ConnectFinishWire,
  ConnectStartWire,
  SignRequestWire,
} from "@ballast/api/holder-types";
import {
  GEOFENCE_STATEMENT,
  RESTRICTED_LIST_URL,
  RISK_DISCLOSURE,
  sha256HexOf,
} from "@ballast/cardano/messages";
import { type ReactNode, useEffect, useState } from "react";
import { footnotes, type SourceDef, SourceList } from "../components/Sources";
import { SignPreview, TxReview } from "../components/TxReview";
import { WalletPicker } from "../components/WalletPicker";
import { errorText, HolderApiError } from "../holder/api";
import { sessionPost, setAccount, signOut, useHolder } from "../holder/store";
import { useMe } from "../holder/useMe";
import {
  completeDeposit,
  finishConnect,
  finishConsent,
  type PreparedDeposit,
  prepareDeposit,
  startConnect,
  startConsent,
} from "../lib/flows";
import { fmtUtc } from "../lib/format";
import {
  accountVerdict,
  capacityPreview,
  cexplorerTx,
  currentStep,
  DEFAULT_R_BPS,
  EMPTY_PROGRESS,
  formatBase,
  JOIN_STEPS,
  type JoinProgress,
  type JoinStepId,
  type MarginAsset,
  parseDeposit,
  parseNight,
  parseR,
  stepIndex,
} from "../lib/join";
import { Link } from "../router";

const SOURCES: SourceDef[] = [
  {
    id: "restricted",
    title: "Strike Finance, Restricted Persons (last updated October 2026), read 23 Oct 2026",
    text: (
      <>
        Restricted jurisdictions: Strike's{" "}
        <a href={RESTRICTED_LIST_URL} rel="noreferrer">
          Restricted Persons
        </a>{" "}
        page, "Last updated: October 2026", read on 23 Oct 2026. The page is authoritative; the
        summary here is not a substitute for it.
      </>
    ),
  },
  {
    id: "connect",
    title: "Strike docs, Builder Connect: request-signature and verify-signature",
    text: (
      <>
        Builder Connect:{" "}
        <a href="https://docs.strikefinance.org/api/builder-codes/builder-connect" rel="noreferrer">
          docs.strikefinance.org/api/builder-codes/builder-connect
        </a>
        . One wallet signature creates the Strike account if needed, approves the builder up to the
        fee you sign, and registers one API key; any earlier key for the same builder is revoked.
      </>
    ),
  },
  {
    id: "account",
    title: "Strike's public account read: GET /v2/account?blockchain_address=, 404 user not found",
    text: (
      <>
        Account check: Strike's public <code>GET /v2/account?blockchain_address=</code> answers{" "}
        <code>404 user not found</code> until an account exists, then 200 with its balances.
      </>
    ),
  },
  {
    id: "deposit",
    title: "Strike docs, Deposit: quote, build-tx, wallet signs, confirm",
    text: (
      <>
        Deposit:{" "}
        <a href="https://docs.strikefinance.org/api/builder-codes/deposit" rel="noreferrer">
          docs.strikefinance.org/api/builder-codes/deposit
        </a>
        . Strike builds the transaction and picks the deposit address; your wallet signs it.
      </>
    ),
  },
];

function Step({
  id,
  current,
  children,
}: {
  id: JoinStepId;
  current: JoinStepId;
  children: ReactNode;
}) {
  const n = stepIndex(id);
  const at = stepIndex(current);
  const state = n < at ? "done" : n === at ? "current" : "locked";
  const title = JOIN_STEPS[n]?.title ?? id;
  return (
    <section
      className={`card join-step ${state}`}
      aria-labelledby={`step-${id}`}
      aria-current={state === "current" ? "step" : undefined}
    >
      <div className="card-head">
        <h2 id={`step-${id}`} className="card-title">
          <span className="step-num">{n + 1}</span>
          {title}
        </h2>
        <span className={`chip${state === "done" ? " good" : state === "current" ? " brass" : ""}`}>
          {state === "done" ? "Done" : state === "current" ? "Now" : "Later"}
        </span>
      </div>
      {state === "locked" ? null : children}
    </section>
  );
}

function Busy({ on, label }: { on: boolean; label: string }) {
  return on ? (
    <p className="small muted" aria-live="polite">
      {label}
    </p>
  ) : null;
}

function Problem({ error }: { error: unknown }) {
  if (!error) return null;
  const fallback = error instanceof HolderApiError && error.body.fallback === "strike-app";
  return (
    <div className="error-box" role="alert">
      {errorText(error)}
      {fallback ? (
        <p className="small" style={{ marginTop: 8 }}>
          Fund the account in{" "}
          <a href="https://www.strikefinance.org" rel="noreferrer">
            Strike's own app
          </a>{" "}
          with this same wallet instead. Ballast sees the deposit on Strike's public account read;
          nothing else changes.
        </p>
      ) : null}
    </div>
  );
}

export function Join() {
  const { wallet, session } = useHolder();
  const { me, refresh } = useMe(session?.token ?? null);
  const [p, setP] = useState<JoinProgress>(EMPTY_PROGRESS);
  const fn = footnotes(SOURCES);

  // Resume what the server already knows about this wallet (a reconnect, a second visit).
  useEffect(() => {
    setP((cur) => ({
      ...cur,
      signedIn: session !== null,
      accountId: session?.accountId ?? me?.accountId ?? null,
      deposited:
        cur.deposited ||
        (me?.funding.some((f) => f.kind === "deposit" && f.status !== "quoted") ?? false),
      consentHash: me?.consent?.hash ?? cur.consentHash,
      rBps: me?.consent ? me.consent.rBps : cur.rBps,
      maxShortBase: me?.consent ? BigInt(me.consent.maxShortBase) : cur.maxShortBase,
    }));
  }, [session, me]);

  const step = currentStep(p);
  return (
    <>
      <header className="page-head">
        <p className="overline brass">Join</p>
        <h1>Your NIGHT stays home. It becomes cover.</h1>
        <p className="lede">
          Eight steps, each one yours. Every signature is made by your own wallet; Ballast never
          holds your coins, and nothing quotes until the operator activates a signed policy for your
          account.
        </p>
      </header>

      <div className="join">
        <ol className="join-progress" aria-label="Steps">
          {JOIN_STEPS.map((s, i) => (
            <li
              key={s.id}
              className={i < stepIndex(step) ? "done" : i === stepIndex(step) ? "current" : ""}
            >
              {s.title}
            </li>
          ))}
        </ol>

        <div className="join-steps">
          <Step id="geofence" current={step}>
            <Geofence
              fn={fn("restricted")}
              onDone={() => setP((c) => ({ ...c, geofence: true }))}
              done={p.geofence}
            />
          </Step>
          <Step id="risk" current={step}>
            <Risk onDone={() => setP((c) => ({ ...c, risk: true }))} done={p.risk} />
          </Step>
          <Step id="wallet" current={step}>
            <WalletStep
              fn={fn("account")}
              signedIn={session !== null}
              address={wallet?.address ?? session?.address ?? null}
              onReady={(check) => {
                if (check.boundToYou && check.accountId) setAccount(check.accountId);
                refresh();
              }}
            />
          </Step>
          <Step id="connect" current={step}>
            <ConnectStep
              fn={fn("connect")}
              onDone={(r) => {
                setAccount(r.accountId);
                refresh();
              }}
            />
          </Step>
          <Step id="deposit" current={step}>
            <DepositStep
              fn={fn("deposit")}
              accountId={p.accountId}
              done={p.deposited}
              onDone={() => {
                setP((c) => ({ ...c, deposited: true }));
                refresh();
              }}
              onSkip={() => setP((c) => ({ ...c, depositSkipped: true }))}
            />
          </Step>
          <Step id="limits" current={step}>
            <LimitsStep
              coverBase={me?.cover ? BigInt(me.cover.coverBase) : null}
              coverStatus={me?.coverStatus ?? null}
              onDone={(rBps, maxShortBase) => setP((c) => ({ ...c, rBps, maxShortBase }))}
            />
          </Step>
          <Step id="consent" current={step}>
            <ConsentStep
              rBps={p.rBps}
              maxShortBase={p.maxShortBase}
              onDone={(hash) => {
                setP((c) => ({ ...c, consentHash: hash }));
                refresh();
              }}
            />
          </Step>
          <Step id="done" current={step}>
            <div className="awaiting">
              <span className="placeholder-tag">
                <span className="dot wait" aria-hidden="true" />
                Armed when the operator activates policy
              </span>
              <h3>Your account is ready. It is not quoting.</h3>
              <p>
                Ballast arms an account only under an operator-signed policy that has passed the
                Critic's replay, and holder #0 runs alone for 72 hours first. Until then nothing
                rests on Strike for you. Your consent hash is{" "}
                <span className="hash">{p.consentHash}</span>.
              </p>
              <Link to="/me" className="btn primary">
                Go to your account
              </Link>
            </div>
          </Step>
        </div>
      </div>

      {session ? (
        <p className="tiny muted" style={{ marginTop: 24 }}>
          Signed in as <span className="hash">{session.address}</span>.{" "}
          <button type="button" className="linkish" onClick={signOut}>
            Sign out
          </button>
        </p>
      ) : null}
      <SourceList sources={SOURCES} />
    </>
  );
}

function Geofence({ fn, onDone, done }: { fn: ReactNode; onDone: () => void; done: boolean }) {
  const [checked, setChecked] = useState(done);
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p className="small">
        Strike's services are not available to people in, from or acting for its restricted
        jurisdictions{fn}: comprehensively sanctioned regions, a long list of countries restricted
        by regulation (among them the United States, the United Kingdom, Canada and many EU
        countries), and anyone who is otherwise a Restricted Person under that page. Read the list
        there; it is the one that applies.
      </p>
      <p className="small muted">
        Ballast does not look up your IP address or location. It records only your own statement,
        tied to your wallet once you connect it.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          disabled={done}
        />
        <span>{GEOFENCE_STATEMENT}</span>
      </label>
      {done ? null : (
        <div>
          <button type="button" className="btn primary" disabled={!checked} onClick={onDone}>
            Continue
          </button>
        </div>
      )}
    </div>
  );
}

function Risk({ onDone, done }: { onDone: () => void; done: boolean }) {
  const [checked, setChecked] = useState(done);
  const lines = RISK_DISCLOSURE.split("\n");
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <ul className="checklist">
        {lines.map((l) => (
          <li key={l} className={l.startsWith("Zero-funding line") ? "zero-line" : undefined}>
            <span aria-hidden="true">•</span>
            <span>{l}</span>
          </li>
        ))}
      </ul>
      <label className="check">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          disabled={done}
        />
        <span>I have read this, including the zero-funding line.</span>
      </label>
      {done ? null : (
        <div>
          <button type="button" className="btn primary" disabled={!checked} onClick={onDone}>
            Continue
          </button>
        </div>
      )}
    </div>
  );
}

function WalletStep({
  fn,
  signedIn,
  address,
  onReady,
}: {
  fn: ReactNode;
  signedIn: boolean;
  address: string | null;
  onReady: (c: AccountCheckWire) => void;
}) {
  const [check, setCheck] = useState<AccountCheckWire | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const afterSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const post = sessionPost();
      await post("attest", {
        attest: true,
        statementSha256: await sha256HexOf(GEOFENCE_STATEMENT),
      });
      const c = await post<AccountCheckWire>("account/check", {});
      setCheck(c);
      if (accountVerdict(c).ok) onReady(c);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const verdict = check ? accountVerdict(check) : null;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p className="small">
        Use a wallet account that does nothing but this: it holds the NIGHT you want as cover and
        has never been used on Strike. In Lace or Eternl, add a new account, move that NIGHT to it,
        and keep a little ADA there for fees. One stake key binds to exactly one Ballast account.
      </p>
      {signedIn ? (
        <dl className="kv">
          <dt>Wallet</dt>
          <dd className="hash">{address}</dd>
          <dt>Strike account{fn}</dt>
          <dd>
            {check ? (check.status === 404 ? "404 · none yet" : `200 · ${check.accountId}`) : "—"}
          </dd>
        </dl>
      ) : (
        <WalletPicker onSignedIn={() => void afterSignIn()} />
      )}
      {signedIn && !check && !busy ? (
        <div>
          <button type="button" className="btn" onClick={() => void afterSignIn()}>
            Check this wallet's Strike account
          </button>
        </div>
      ) : null}
      <Busy on={busy} label="Recording your statement and reading Strike's public account check…" />
      {verdict ? <div className={verdict.ok ? "notice" : "error-box"}>{verdict.text}</div> : null}
      {verdict && !verdict.ok ? (
        <div>
          <button type="button" className="btn" onClick={signOut}>
            Use another wallet account
          </button>
        </div>
      ) : null}
      <Problem error={error} />
    </div>
  );
}

function ConnectStep({ fn, onDone }: { fn: ReactNode; onDone: (r: ConnectFinishWire) => void }) {
  const { wallet } = useHolder();
  const [start, setStart] = useState<ConnectStartWire | null>(null);
  const [done, setDone] = useState<ConnectFinishWire | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const begin = async () => {
    setBusy("Asking Strike for a Builder Connect challenge…");
    setError(null);
    try {
      setStart(await startConnect(sessionPost()));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  const sign = async () => {
    if (!start || !wallet) return;
    setBusy("Waiting for your wallet's signature…");
    setError(null);
    try {
      const r = await finishConnect(sessionPost(), wallet, start);
      setDone(r);
      onDone(r);
    } catch (err) {
      setError(err);
      setStart(null);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p className="small">
        One signature connects this wallet to Strike through Ballast's builder code{fn}. Ballast
        generates the account's API key on its own server and keeps it sealed; only its public half
        goes to Strike. The key can trade on your account but cannot move your money: deposits and
        withdrawals still need your wallet every time.
      </p>
      {!wallet ? (
        <p className="small muted">Your wallet session ended. Connect it again in step 3.</p>
      ) : null}
      {wallet && !start && !done ? (
        <div>
          <button
            type="button"
            className="btn primary"
            disabled={busy !== null}
            onClick={() => void begin()}
          >
            Connect to Strike
          </button>
        </div>
      ) : null}
      {start && !done ? (
        <>
          <SignPreview
            label="Your wallet will ask you to sign exactly this (Strike wrote it):"
            text={start.message}
          />
          <dl className="kv">
            <dt>Builder fee cap</dt>
            <dd>{start.feeShareBps} bps</dd>
            <dt>Strike before</dt>
            <dd>{start.accountBefore === 404 ? "404 · user not found" : "200 · account exists"}</dd>
          </dl>
          <div>
            <button
              type="button"
              className="btn primary"
              disabled={busy !== null}
              onClick={() => void sign()}
            >
              Sign in {wallet?.name ?? "your wallet"}
            </button>
          </div>
        </>
      ) : null}
      {done ? (
        <div className="notice">
          Strike's account check went <b>{done.flip.before}</b> → <b>{done.flip.after}</b> at{" "}
          {fmtUtc(done.flip.checkedAtMs)}. Account <span className="hash">{done.accountId}</span>,
          API key <span className="hash">{done.apiPublicKey}</span>.
        </div>
      ) : null}
      <Busy on={busy !== null} label={busy ?? ""} />
      <Problem error={error} />
    </div>
  );
}

function DepositStep({
  fn,
  accountId,
  done,
  onDone,
  onSkip,
}: {
  fn: ReactNode;
  accountId: string | null;
  done: boolean;
  onDone: () => void;
  onSkip: () => void;
}) {
  const { wallet } = useHolder();
  const [asset, setAsset] = useState<MarginAsset>("ADA");
  const [amount, setAmount] = useState("");
  const [prepared, setPrepared] = useState<PreparedDeposit | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const parsed = parseDeposit(amount, asset);
  const quote = async () => {
    if (!wallet || !accountId || !parsed.ok) return;
    setBusy("Two signatures approve the quote and the build; Strike then builds the transaction…");
    setError(null);
    try {
      setPrepared(await prepareDeposit(sessionPost(), wallet, accountId, asset, parsed.value));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  const sign = async () => {
    if (!wallet || !accountId || !prepared) return;
    setBusy(
      "Sign the transaction in your wallet; it then submits it, and one more signature confirms…",
    );
    setError(null);
    try {
      setTxHash((await completeDeposit(sessionPost(), wallet, accountId, prepared)).txHash);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  if (done || txHash) {
    return (
      <div className="notice">
        Deposit submitted.{" "}
        {txHash ? (
          <>
            Transaction{" "}
            <a href={cexplorerTx(txHash)} rel="noreferrer" className="hash">
              {txHash}
            </a>{" "}
            on cexplorer. Strike credits it after its confirmations.
          </>
        ) : (
          "Its transaction is listed on your account page."
        )}
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p className="small">
        Margin is your own ADA or USDM, deposited from this wallet{fn}. Strike builds the
        transaction to its own address; your wallet shows where it pays before you sign. Each step
        is approved by a short signature from your wallet, valid for 60 seconds.
      </p>
      {!prepared ? (
        <>
          <div className="row">
            <fieldset className="tabs" aria-label="Margin asset">
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
            <label className="field grow">
              Amount ({asset})
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={asset === "ADA" ? "100" : "50"}
              />
            </label>
            <button
              type="button"
              className="btn primary"
              disabled={!parsed.ok || busy !== null}
              onClick={() => void quote()}
            >
              Get a quote
            </button>
          </div>
          {amount && !parsed.ok ? (
            <p className="small" style={{ color: "var(--ask)" }}>
              {parsed.reason}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <dl className="kv">
            <dt>Credited as</dt>
            <dd className="num">${prepared.quote.quote.usd_value}</dd>
            <dt>Rate</dt>
            <dd className="num">
              {prepared.quote.quote.exchange_rate} USD per {asset}
            </dd>
            <dt>Quote expires</dt>
            <dd>{fmtUtc(prepared.quote.quote.expiration_at)}</dd>
          </dl>
          {wallet ? <TxReview summary={prepared.summary} own={wallet.address} /> : null}
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={busy !== null}
              onClick={() => void sign()}
            >
              Sign and submit in {wallet?.name ?? "your wallet"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => setPrepared(null)}
            >
              Start over
            </button>
          </div>
        </>
      )}
      <Busy on={busy !== null} label={busy ?? ""} />
      <Problem error={error} />
      <p className="tiny muted">
        Funded already, or funding in Strike's app?{" "}
        <button type="button" className="linkish" onClick={onSkip}>
          Skip this step
        </button>
        . Ballast cannot quote for an account without margin.
      </p>
    </div>
  );
}

function LimitsStep({
  coverBase,
  coverStatus,
  onDone,
}: {
  coverBase: bigint | null;
  coverStatus: string | null;
  onDone: (rBps: number, maxShortBase: bigint) => void;
}) {
  const [rText, setRText] = useState((DEFAULT_R_BPS / 10_000).toString());
  const [shortText, setShortText] = useState("");
  const r = parseR(rText);
  const s = parseNight(shortText);
  const preview =
    coverBase !== null && r.ok ? capacityPreview(coverBase, r.value, s.ok ? s.value : null) : null;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p className="small">
        <code>r</code> is the share of your wallet's NIGHT that may back asks at any moment: short +
        resting asks + pending never exceed <code>r ×</code> the NIGHT your stake key holds at the
        last block. The default is 0.5 and it can never be above 0.9. The max short caps it further,
        in NIGHT.
      </p>
      <div className="row">
        <label className="field">
          r
          <input
            type="text"
            inputMode="decimal"
            value={rText}
            onChange={(e) => setRText(e.target.value)}
            style={{ width: 110 }}
          />
        </label>
        <label className="field grow">
          Max short (NIGHT)
          <input
            type="text"
            inputMode="decimal"
            value={shortText}
            onChange={(e) => setShortText(e.target.value)}
            placeholder="12500"
          />
        </label>
      </div>
      {!r.ok ? (
        <p className="small" style={{ color: "var(--ask)" }}>
          {r.reason}
        </p>
      ) : null}
      {shortText && !s.ok ? (
        <p className="small" style={{ color: "var(--ask)" }}>
          {s.reason}
        </p>
      ) : null}
      <dl className="kv">
        <dt>Cover now</dt>
        <dd className="num">
          {coverBase !== null
            ? `${formatBase(coverBase)} NIGHT`
            : coverStatus === "not-configured"
              ? "the cover oracle is off on this server"
              : "not read yet"}
        </dd>
        <dt>r × cover</dt>
        <dd className="num">{preview ? `${formatBase(preview.byCover)} NIGHT` : "—"}</dd>
        <dt>Most you could be short</dt>
        <dd className="num">
          {preview ? `${formatBase(preview.effective)} NIGHT (set by ${preview.limitedBy})` : "—"}
        </dd>
      </dl>
      <div>
        <button
          type="button"
          className="btn primary"
          disabled={!r.ok || !s.ok}
          onClick={() => r.ok && s.ok && onDone(r.value, s.value)}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

function ConsentStep({
  rBps,
  maxShortBase,
  onDone,
}: {
  rBps: number | null;
  maxShortBase: bigint | null;
  onDone: (hash: string) => void;
}) {
  const { wallet } = useHolder();
  const [req, setReq] = useState<SignRequestWire | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const prepare = async () => {
    if (rBps === null || maxShortBase === null) return;
    setBusy(true);
    setError(null);
    try {
      setReq(await startConsent(sessionPost(), rBps, formatBase(maxShortBase).replace(/,/g, "")));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const sign = async () => {
    if (!wallet || !req) return;
    setBusy(true);
    setError(null);
    try {
      onDone((await finishConsent(sessionPost(), wallet, req)).hash);
    } catch (err) {
      setError(err);
      setReq(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p className="small">
        Your consent is a CIP-8 message your wallet signs. Ballast stores its SHA-256 hash with your
        account; the keeper records that hash in the signed decision chain when it first picks your
        account up.
      </p>
      {!req ? (
        <div>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void prepare()}
          >
            Show the consent text
          </button>
        </div>
      ) : (
        <>
          <SignPreview label="Your wallet will ask you to sign exactly this:" text={req.message} />
          <div>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !wallet}
              onClick={() => void sign()}
            >
              Sign in {wallet?.name ?? "your wallet"}
            </button>
          </div>
        </>
      )}
      <Problem error={error} />
    </div>
  );
}
