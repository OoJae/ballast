import type { SessionWire } from "@ballast/api/holder-types";
import {
  type ConnectedWallet,
  connectWallet,
  type DiscoveredWallet,
  discoverWallets,
  type InjectedRoot,
  type WalletId,
} from "@ballast/cardano/cip30";
import { useSyncExternalStore } from "react";
import { signIn } from "../lib/flows";
import { poster } from "./api";

/**
 * The holder's wallet and session, in memory only: no storage, no auto-connect. A reload
 * forgets both, and browsing never touches a wallet until the holder clicks Connect.
 */
interface HolderState {
  wallet: ConnectedWallet | null;
  session: SessionWire | null;
}

let state: HolderState = { wallet: null, session: null };
const listeners = new Set<() => void>();

function set(next: HolderState): void {
  state = next;
  for (const l of listeners) l();
}

export function useHolder(): HolderState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
    () => state,
  );
}

const root = (): InjectedRoot | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as InjectedRoot);

/** Installed Lace/Eternl, read from what the extensions injected; never enables anything. */
export function installedWallets(): DiscoveredWallet[] {
  return discoverWallets(root());
}

/** Click → the wallet asks to connect → one signData signs in to Ballast. */
export async function connectAndSignIn(id: WalletId): Promise<HolderState> {
  const wallet = await connectWallet(root(), id);
  const session = await signIn(poster(null), wallet);
  set({ wallet, session });
  return state;
}

export function setAccount(accountId: string): void {
  if (state.session) set({ ...state, session: { ...state.session, accountId } });
}

export function signOut(): void {
  const token = state.session?.token ?? null;
  set({ wallet: null, session: null });
  if (token) void poster(token)("session/end", {}).catch(() => {});
}

/** The post function for the current session. */
export function sessionPost() {
  return poster(state.session?.token ?? null);
}
