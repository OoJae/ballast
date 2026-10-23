/**
 * The texts a holder's wallet signs for Ballast itself (not for Strike), browser-safe. Each is
 * plain text the wallet shows verbatim, signed as hex(utf8) with CIP-8 `signData`:
 * - sign-in (Sign-In-With-Cardano): proves control of the address for a session;
 * - holder proof: approves exactly one funding request to Strike, for 60 s;
 * - consent: r, max short and the attestations, whose sha256 Ballast stores.
 * Every message names its purpose on the first line, so a signature made for one can never be
 * parsed as another.
 */

export const RESTRICTED_LIST_URL = "https://www.strikefinance.org/restricted";

/** At most this old when the server checks it (CLAUDE.md, plan §7: "≤ 60 s old"). */
export const HOLDER_PROOF_MAX_AGE_MS = 60_000;
/** Browser clocks drift; a proof stamped a little ahead is tolerated, not more. */
export const HOLDER_PROOF_MAX_FUTURE_MS = 5_000;

export const GEOFENCE_STATEMENT =
  "I am not a resident of, citizen of, or located in any Restricted Jurisdiction listed at " +
  `${RESTRICTED_LIST_URL}, I am not a Restricted Person as defined there, and I will not use a ` +
  "VPN or proxy to get around that list.";

/**
 * The risk disclosure shown on /join. Its sha256 goes into the consent message, so the consent
 * commits to exactly this text. The zero-funding line is deliberate: shorts may earn nothing.
 */
export const RISK_DISCLOSURE = [
  "Ballast quotes covered asks on Strike from your own Strike account, with your wallet's NIGHT as cover.",
  "When an ask fills you are short NIGHT on Strike and long the same NIGHT in your wallet. Price moves change both legs, but fees, funding and slippage on the way out are real costs.",
  "Zero-funding line: if funding paid to shorts is zero or turns negative, you earn only the maker rebate, or nothing, and you can lose money.",
  "Your margin (ADA or USDM) sits on Strike, not in your wallet. If the short moves against you and margin runs low, Strike can liquidate it.",
  "Strike is an independent venue. Ballast is not affiliated with Strike Finance and cannot recover funds Strike holds.",
  "Recovery is yours: Stop cancels every Ballast order, Close buys the short back reduce-only, and Withdraw returns margin to this wallet with your own signature.",
].join("\n");

export interface SignInFields {
  domain: string;
  address: string;
  stakeAddress: string;
  nonce: string;
  issuedAtMs: number;
}

export function signInMessage(f: SignInFields): string {
  return [
    "Sign in to Ballast with your Cardano wallet.",
    `Domain: ${f.domain}`,
    `Wallet: ${f.address}`,
    `Stake: ${f.stakeAddress}`,
    `Nonce: ${f.nonce}`,
    `Issued: ${new Date(f.issuedAtMs).toISOString()}`,
    "Signing proves you control this wallet. It moves no funds and authorizes no trade.",
  ].join("\n");
}

export interface HolderProofFields {
  accountId: string;
  address: string;
  method: "POST";
  path: string;
  bodySha256: string;
  issuedAtMs: number;
  nonce: string;
}

const PROOF_TITLE = "Ballast holder proof";
const PROOF_TAIL =
  "This approves one request to Strike for your own account. It expires after 60 seconds.";

export function holderProofMessage(f: HolderProofFields): string {
  return [
    PROOF_TITLE,
    "Version: 1",
    `Account: ${f.accountId}`,
    `Wallet: ${f.address}`,
    `Request: ${f.method} ${f.path}`,
    `Body-SHA256: ${f.bodySha256}`,
    `Issued: ${new Date(f.issuedAtMs).toISOString()}`,
    `Nonce: ${f.nonce}`,
    PROOF_TAIL,
  ].join("\n");
}

const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Strict inverse of holderProofMessage: every line, in order, nothing extra. */
export function parseHolderProofMessage(text: string): HolderProofFields | { error: string } {
  const lines = text.split("\n");
  if (lines.length !== 9 || lines[0] !== PROOF_TITLE || lines[8] !== PROOF_TAIL) {
    return { error: "not a Ballast holder proof" };
  }
  const field = (i: number, name: string): string | undefined => {
    const line = lines[i] ?? "";
    return line.startsWith(`${name}: `) ? line.slice(name.length + 2) : undefined;
  };
  if (field(1, "Version") !== "1") return { error: "unsupported holder proof version" };
  const accountId = field(2, "Account");
  const address = field(3, "Wallet");
  const request = field(4, "Request");
  const bodySha256 = field(5, "Body-SHA256");
  const issued = field(6, "Issued");
  const nonce = field(7, "Nonce");
  if (!accountId || !address || !request || !bodySha256 || !issued || !nonce) {
    return { error: "holder proof is missing a field" };
  }
  const m = /^(POST) (\/v2(?:\/[a-z-]+)+)$/.exec(request);
  if (!m) return { error: "holder proof request line is malformed" };
  if (!/^[0-9a-f]{64}$/.test(bodySha256)) return { error: "holder proof body hash is malformed" };
  if (!ISO_MS_RE.test(issued)) return { error: "holder proof time is malformed" };
  if (!UUID_RE.test(nonce)) return { error: "holder proof nonce must be a lowercase UUID" };
  return {
    accountId,
    address,
    method: "POST",
    path: m[2] as string,
    bodySha256,
    issuedAtMs: Date.parse(issued),
    nonce,
  };
}

export interface ConsentFields {
  accountId: string;
  address: string;
  stakeAddress: string;
  rBps: number;
  /** Max short in NIGHT base units (6 decimals). */
  maxShortBase: bigint;
  feeShareBps: number;
  riskSha256: string;
  nonce: string;
  issuedAtMs: number;
}

function night(base: bigint): string {
  const whole = base / 1_000_000n;
  const frac = (base % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function consentMessage(f: ConsentFields): string {
  const r = (f.rBps / 10_000).toFixed(2);
  return [
    "Ballast holder consent",
    "Version: 1",
    `Account: ${f.accountId}`,
    `Wallet: ${f.address}`,
    `Stake: ${f.stakeAddress}`,
    `Cover ratio r: ${r} (${f.rBps} bps). Short + resting asks + pending stay at most r times the NIGHT this stake key holds, checked every block.`,
    `Max short: ${night(f.maxShortBase)} NIGHT`,
    `Builder fee cap: ${f.feeShareBps} bps`,
    `Restricted jurisdictions: ${GEOFENCE_STATEMENT}`,
    `Risk disclosure read: sha256 ${f.riskSha256}`,
    "Arming: nothing quotes until the operator activates a signed policy for this account. I can stop at any time from /me.",
    `Nonce: ${f.nonce}`,
    `Issued: ${new Date(f.issuedAtMs).toISOString()}`,
  ].join("\n");
}

/**
 * RFC 8785 (JCS) for the JSON Ballast signs over: strings, booleans, null, safe integers,
 * arrays and objects with keys sorted by UTF-16 code units. Anything else throws, so a body
 * that could serialize two ways is refused instead of hashed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) throw new TypeError("only safe integers are canonical");
      return String(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("only plain objects are canonical");
      }
      const entries = Object.entries(value as Record<string, unknown>).filter(
        ([, v]) => v !== undefined,
      );
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`cannot canonicalize ${typeof value}`);
  }
}

/** SHA-256 of UTF-8 text with WebCrypto (browser and Node ≥ 20 alike). */
export async function sha256HexOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let out = "";
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, "0");
  return out;
}

/** The body hash a holder proof binds: sha256 of the body's canonical JSON. */
export function bodySha256(body: unknown): Promise<string> {
  return sha256HexOf(canonicalJson(body));
}
