import type { WalletId } from "@ballast/cardano/cip30";
import { useEffect, useState } from "react";
import { errorText } from "../holder/api";
import { connectAndSignIn, installedWallets } from "../holder/store";

/**
 * Lace or Eternl, chosen by a click. Before that click nothing is enabled, read or signed; the
 * list only reflects which extensions injected themselves into the page.
 */
export function WalletPicker({ onSignedIn }: { onSignedIn?: () => void }) {
  const [wallets, setWallets] = useState(installedWallets);
  const [busy, setBusy] = useState<WalletId | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Extensions can inject a moment after load.
    const t = setTimeout(() => setWallets(installedWallets()), 800);
    return () => clearTimeout(t);
  }, []);
  const connect = async (id: WalletId) => {
    setBusy(id);
    setError(null);
    try {
      await connectAndSignIn(id);
      onSignedIn?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {wallets.length === 0 ? (
        <p className="small muted">
          No Lace or Eternl extension found in this browser. Install{" "}
          <a href="https://www.lace.io" rel="noreferrer">
            Lace
          </a>{" "}
          or{" "}
          <a href="https://eternl.io" rel="noreferrer">
            Eternl
          </a>
          , then reload this page.
        </p>
      ) : (
        <div className="row">
          {wallets.map((w) => (
            <button
              key={w.id}
              type="button"
              className="btn primary"
              disabled={busy !== null}
              onClick={() => void connect(w.id)}
            >
              {w.icon ? <img src={w.icon} alt="" width={18} height={18} /> : null}
              {busy === w.id ? `Waiting for ${w.name}…` : `Connect ${w.name}`}
            </button>
          ))}
        </div>
      )}
      <p className="tiny muted">
        Connecting asks your wallet for its address, then for one signature that signs you in to
        Ballast. That signature moves no funds and authorizes no trade.
      </p>
      {error ? (
        <div className="error-box" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
