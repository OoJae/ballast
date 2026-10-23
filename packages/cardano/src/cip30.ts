import { bech32Decode, bech32Encode } from "@ballast/cover/bech32";

/**
 * CIP-30 wallet plumbing, browser-safe (no Node built-ins, no DOM types): the web app imports it
 * as `@ballast/cardano/cip30`, and the server-side checks import the same encoders.
 *
 * Strike's Cardano rules (strike-auth, builder-connect.md, strike-withdraw):
 * - addresses go to Strike as bech32 (addr1…), but CIP-30 hands them out as hex bytes;
 * - `signData` takes a hex payload: Builder Connect's text is hex-encoded by us, withdrawal
 *   `message_to_sign` is already hex and must be signed as-is;
 * - the signature goes back as `coseSign1Hex:coseKeyHex` (or JSON `{signature, key}`).
 */

/** CIP-30 `DataSignature`: hex CBOR of a COSE_Sign1 and of a COSE_Key. */
export interface DataSignature {
  signature: string;
  key: string;
}

/** The CIP-30 full API, the subset Ballast calls. Every value is hex-encoded bytes. */
export interface Cip30Api {
  getNetworkId(): Promise<number>;
  getUtxos(amount?: string, paginate?: { page: number; limit: number }): Promise<string[] | null>;
  getUsedAddresses(paginate?: { page: number; limit: number }): Promise<string[]>;
  getChangeAddress(): Promise<string>;
  getRewardAddresses(): Promise<string[]>;
  signTx(tx: string, partialSign?: boolean): Promise<string>;
  signData(addr: string, payload: string): Promise<DataSignature>;
  submitTx(tx: string): Promise<string>;
}

/** What a wallet injects at `window.cardano[id]` before it is enabled. */
export interface Cip30Wallet {
  name?: string;
  icon?: string;
  apiVersion?: string;
  enable(): Promise<Cip30Api>;
  isEnabled?(): Promise<boolean>;
}

/** The global object wallets inject into (`window` in a browser). */
export interface InjectedRoot {
  cardano?: Record<string, Cip30Wallet | undefined>;
}

/** Lace and Eternl are the wallets D4 tests; others stay off until they pass it too. */
export const SUPPORTED_WALLETS = [
  { id: "lace", name: "Lace" },
  { id: "eternl", name: "Eternl" },
] as const;
export type WalletId = (typeof SUPPORTED_WALLETS)[number]["id"];

export interface DiscoveredWallet {
  id: WalletId;
  name: string;
  icon: string | null;
}

/**
 * The supported wallets that are installed. Reads only what the extension injected; it never
 * calls `enable()`, so browsing never prompts or connects anything.
 */
export function discoverWallets(root: InjectedRoot | undefined): DiscoveredWallet[] {
  const out: DiscoveredWallet[] = [];
  for (const w of SUPPORTED_WALLETS) {
    const injected = root?.cardano?.[w.id];
    if (injected && typeof injected.enable === "function") {
      out.push({
        id: w.id,
        name: typeof injected.name === "string" && injected.name ? injected.name : w.name,
        icon: typeof injected.icon === "string" && injected.icon ? injected.icon : null,
      });
    }
  }
  return out;
}

export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletError";
  }
}

const HEX_RE = /^(?:[0-9a-f]{2})*$/;

export function isHex(text: string): boolean {
  return HEX_RE.test(text);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.toLowerCase();
  if (!isHex(h)) throw new WalletError("not an even-length hex string");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** hex(utf8(text)): the payload Builder Connect and Ballast's own messages are signed over. */
export function utf8ToHex(text: string): string {
  return bytesToHex(new TextEncoder().encode(text));
}

/** Decodes a hex payload as strict UTF-8 (a bad byte throws rather than becoming U+FFFD). */
export function hexToUtf8(hex: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(hex));
}

export type Network = "mainnet" | "testnet";

/** CIP-19 header: the high nibble is the address type, the low nibble the network id. */
function header(bytes: Uint8Array): { type: number; networkId: number } {
  const h = bytes[0];
  if (h === undefined) throw new WalletError("empty address");
  return { type: h >> 4, networkId: h & 0x0f };
}

/** A CIP-30 hex address as bech32 (addr / addr_test, or stake / stake_test for rewards). */
export function addressHexToBech32(hex: string): string {
  const bytes = hexToBytes(hex);
  const { type, networkId } = header(bytes);
  if (type === 8) throw new WalletError("Byron addresses are not supported");
  if (networkId !== 0 && networkId !== 1) throw new WalletError(`unknown network ${networkId}`);
  const reward = type === 14 || type === 15;
  const prefix = reward ? "stake" : "addr";
  return bech32Encode(networkId === 1 ? prefix : `${prefix}_test`, bytes);
}

export function bech32ToAddressHex(address: string): string {
  return bytesToHex(bech32Decode(address.trim()).bytes);
}

/** Base addresses (types 0-3) carry a stake credential; only a key-hash one can bind. */
export function stakeAddressOfAddressHex(hex: string): string | null {
  const bytes = hexToBytes(hex);
  const { type, networkId } = header(bytes);
  if (type > 3 || bytes.length !== 57) return null;
  const script = (type & 2) !== 0;
  const reward = new Uint8Array(29);
  reward[0] = ((script ? 15 : 14) << 4) | networkId;
  reward.set(bytes.subarray(29, 57), 1);
  return bech32Encode(networkId === 1 ? "stake" : "stake_test", reward);
}

/** The payment key hash of a base or enterprise address with a key (not script) credential. */
export function paymentKeyHashOfAddressHex(hex: string): string | null {
  const bytes = hexToBytes(hex);
  const { type } = header(bytes);
  if (type !== 0 && type !== 2 && type !== 4 && type !== 6) return null;
  if (bytes.length < 29) return null;
  return bytesToHex(bytes.subarray(1, 29));
}

/** Strike's Cardano signature string: `coseSign1Hex:coseKeyHex`. */
export function toStrikeSignature(sig: DataSignature): string {
  const s = String(sig.signature ?? "").toLowerCase();
  const k = String(sig.key ?? "").toLowerCase();
  if (!s || !k || !isHex(s) || !isHex(k)) {
    throw new WalletError("the wallet returned a signature that is not hex COSE");
  }
  return `${s}:${k}`;
}

/** Accepts both forms Strike accepts: `sig:key` or JSON `{"signature","key"}`. */
export function parseStrikeSignature(text: string): DataSignature {
  const t = text.trim();
  if (t.startsWith("{")) {
    let j: unknown;
    try {
      j = JSON.parse(t);
    } catch {
      throw new WalletError("signature JSON does not parse");
    }
    const o = j as Partial<DataSignature> | null;
    if (!o || typeof o.signature !== "string" || typeof o.key !== "string") {
      throw new WalletError("signature JSON needs string signature and key fields");
    }
    return parseStrikeSignature(`${o.signature}:${o.key}`);
  }
  const parts = t.split(":");
  if (parts.length !== 2) throw new WalletError("signature must be coseSign1Hex:coseKeyHex");
  const [signature = "", key = ""] = parts.map((p) => p.toLowerCase());
  if (!signature || !key || !isHex(signature) || !isHex(key)) {
    throw new WalletError("signature parts must be non-empty hex");
  }
  return { signature, key };
}

export interface ConnectedWallet {
  id: WalletId;
  name: string;
  api: Cip30Api;
  network: Network;
  /** The wallet's own address, hex, as CIP-30 returns it. */
  addressHex: string;
  /** The same address as bech32: what Strike stores and what every signature binds to. */
  address: string;
  stakeAddress: string;
}

/**
 * Enables one wallet (the wallet asks the user) and reads the address Ballast binds to: the
 * wallet's change address, which must be a mainnet base address with a key stake credential so
 * its NIGHT can count as cover.
 */
export async function connectWallet(
  root: InjectedRoot | undefined,
  id: WalletId,
  expect: Network = "mainnet",
): Promise<ConnectedWallet> {
  const injected = root?.cardano?.[id];
  const meta = SUPPORTED_WALLETS.find((w) => w.id === id);
  if (!meta) throw new WalletError(`${id} is not a supported wallet`);
  if (!injected || typeof injected.enable !== "function") {
    throw new WalletError(`${meta.name} is not installed in this browser`);
  }
  const api = await injected.enable();
  const networkId = await api.getNetworkId();
  const network: Network = networkId === 1 ? "mainnet" : "testnet";
  if (network !== expect) {
    throw new WalletError(`switch ${meta.name} to ${expect}; it is on ${network}`);
  }
  // VERIFY: Eternl in multi-address mode may rotate its change address; D4 records which
  // address each wallet returns, and Ballast binds to that one exactly (FRICTION 2026-10-23).
  const addressHex = (await api.getChangeAddress()).toLowerCase();
  const stakeAddress = stakeAddressOfAddressHex(addressHex);
  if (!stakeAddress || paymentKeyHashOfAddressHex(addressHex) === null) {
    throw new WalletError("use a wallet account whose address has a payment key and a stake key");
  }
  if (stakeAddress.startsWith("stake1") !== (network === "mainnet")) {
    throw new WalletError("the address network does not match the wallet network");
  }
  const reward = bech32Decode(stakeAddress).bytes;
  if ((reward[0] ?? 0) >> 4 !== 14) {
    throw new WalletError("script stake credentials cannot hold cover for Ballast");
  }
  return {
    id,
    name: meta.name,
    api,
    network,
    addressHex,
    address: addressHexToBech32(addressHex),
    stakeAddress,
  };
}

/**
 * One CIP-30 `signData` in Strike's format. `payloadHex` is signed exactly as given, so callers
 * pass `utf8ToHex(text)` for text and a withdrawal's `message_to_sign` untouched.
 */
export async function signDataForStrike(
  api: Pick<Cip30Api, "signData">,
  address: string,
  payloadHex: string,
): Promise<string> {
  const payload = payloadHex.toLowerCase();
  if (!isHex(payload) || payload.length === 0) throw new WalletError("payload must be hex");
  return toStrikeSignature(await api.signData(bech32ToAddressHex(address), payload));
}

/** Cardanoscan-style explorers key a tx by its 64-hex id. */
export function isTxHash(text: string): boolean {
  return /^[0-9a-f]{64}$/.test(text);
}
