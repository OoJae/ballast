/**
 * Pure logic behind /join and /me: input parsing, the step machine and the numbers each screen
 * shows. No DOM, no fetch, so it is unit-tested in Node.
 */

export const DEFAULT_R_BPS = 5000;
export const MAX_R_BPS = 9000;
export const NIGHT_DECIMALS = 6;

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const no = <T>(reason: string): Parsed<T> => ({ ok: false, reason });

/** Exact decimal → integer base units, no floats: "12.5" with 6 decimals → 12500000n. */
export function toBaseUnits(text: string, decimals: number): bigint | null {
  const re = new RegExp(`^(\\d{1,15})(?:\\.(\\d{1,${decimals}}))?$`);
  const m = re.exec(text.trim().replace(/,/g, ""));
  if (!m) return null;
  return (
    BigInt(m[1] as string) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0"))
  );
}

/** Base units → "12,500.5" (trailing zeros trimmed). */
export function formatBase(base: bigint | string, decimals = NIGHT_DECIMALS): string {
  const b = typeof base === "string" ? BigInt(base) : base;
  const neg = b < 0n;
  const abs = neg ? -b : b;
  const unit = 10n ** BigInt(decimals);
  const whole = (abs / unit).toLocaleString("en-US");
  const frac = (abs % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "−" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** r as the holder types it ("0.5"), in basis points: above 0, at most 0.9. */
export function parseR(text: string): Parsed<number> {
  const m = /^(0?)\.(\d{1,4})$|^(0|1)$/.exec(text.trim());
  if (!m) return no("Enter r as a decimal such as 0.5.");
  const bps = m[3] !== undefined ? Number(m[3]) * 10_000 : Number((m[2] as string).padEnd(4, "0"));
  if (bps <= 0) return no("r must be more than 0.");
  if (bps > MAX_R_BPS) return no("r can be at most 0.9: some NIGHT always stays uncommitted.");
  return ok(bps);
}

export function parseNight(text: string): Parsed<bigint> {
  const v = toBaseUnits(text, NIGHT_DECIMALS);
  if (v === null) return no("Enter a NIGHT amount with at most 6 decimals.");
  if (v <= 0n) return no("The amount must be more than zero.");
  return ok(v);
}

export type MarginAsset = "ADA" | "USDM";

/**
 * Deposit amounts in the asset's smallest unit, as Strike's quote takes them: lovelace for ADA.
 * VERIFY: USDM is taken as 6 decimals; D5 checks the quote's usd_value (FRICTION 2026-10-23).
 */
export function parseDeposit(text: string, asset: MarginAsset): Parsed<string> {
  const v = toBaseUnits(text, 6);
  if (v === null) return no(`Enter an ${asset} amount with at most 6 decimals.`);
  if (v <= 0n) return no("The amount must be more than zero.");
  return ok(v.toString());
}

/** Withdrawals are in USD: Strike's minimum is $5 and the fee $1 (strike-withdraw). */
export function parseWithdrawUsd(text: string): Parsed<string> {
  const t = text.trim();
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(t)) return no("Enter a USD amount with at most 2 decimals.");
  if (Number(t) < 5) return no("Strike's minimum withdrawal is $5 (the fee is $1).");
  return ok(t.replace(/^0+(?=\d)/, ""));
}

/** What r and the max short allow against the cover the wallet holds now. */
export function capacityPreview(coverBase: bigint, rBps: number, maxShortBase: bigint | null) {
  const byCover = (coverBase * BigInt(rBps)) / 10_000n;
  const effective = maxShortBase === null || maxShortBase > byCover ? byCover : maxShortBase;
  return { byCover, effective, limitedBy: effective === byCover ? "cover" : "max short" } as const;
}

export const cexplorerTx = (hash: string) => `https://cexplorer.io/tx/${hash}`;

export const JOIN_STEPS = [
  { id: "geofence", title: "Where you are" },
  { id: "risk", title: "The risks" },
  { id: "wallet", title: "A dedicated wallet account" },
  { id: "connect", title: "Connect to Strike" },
  { id: "deposit", title: "Deposit margin" },
  { id: "limits", title: "Choose r and max short" },
  { id: "consent", title: "Sign your consent" },
  { id: "done", title: "Waiting for the operator" },
] as const;
export type JoinStepId = (typeof JOIN_STEPS)[number]["id"];

export interface JoinProgress {
  geofence: boolean;
  risk: boolean;
  signedIn: boolean;
  accountId: string | null;
  deposited: boolean;
  depositSkipped: boolean;
  rBps: number | null;
  maxShortBase: bigint | null;
  consentHash: string | null;
}

export const EMPTY_PROGRESS: JoinProgress = {
  geofence: false,
  risk: false,
  signedIn: false,
  accountId: null,
  deposited: false,
  depositSkipped: false,
  rBps: null,
  maxShortBase: null,
  consentHash: null,
};

/** The first step not yet done: steps unlock strictly in order. */
export function currentStep(p: JoinProgress): JoinStepId {
  if (!p.geofence) return "geofence";
  if (!p.risk) return "risk";
  if (!p.signedIn) return "wallet";
  if (!p.accountId) return "connect";
  if (!p.deposited && !p.depositSkipped) return "deposit";
  if (p.rBps === null || p.maxShortBase === null) return "limits";
  if (!p.consentHash) return "consent";
  return "done";
}

export function stepIndex(id: JoinStepId): number {
  return JOIN_STEPS.findIndex((s) => s.id === id);
}

/** Why an existing Strike account cannot become a Ballast maker account, if it cannot. */
export function accountVerdict(c: { status: 404 | 200; foreign: string[]; boundToYou: boolean }) {
  if (c.status === 404)
    return {
      ok: true,
      text: "Strike has no account for this wallet yet: Builder Connect will create one.",
    };
  if (c.boundToYou) return { ok: true, text: "This wallet is already your Ballast maker account." };
  if (c.foreign.length === 0)
    return { ok: true, text: "Strike has an account for this wallet, and it is empty." };
  return {
    ok: false,
    text: `This wallet's Strike account has been used (${c.foreign.join("; ")}). Ballast quotes only from a dedicated account: use a fresh wallet account.`,
  };
}

/** Stop before revoke: revoking the API wallet does not cancel resting orders (plan §4). */
export const REVOCATION_STEPS = [
  {
    title: "Stop",
    body: "Press Stop here first. Ballast cancels every order it has resting for you and arms nothing more.",
  },
  {
    title: "Close",
    body: "If you are short, Close buys it back with reduce-only orders. Check Strike shows no open position.",
  },
  {
    title: "Withdraw",
    body: "Withdraw your margin to this same wallet. Strike pays only the wallet you connected with, and your wallet signs it.",
  },
  {
    title: "Revoke",
    body: "Only then revoke Ballast's API wallet in the Strike app. Revoking does not cancel resting orders, which is why Stop comes first.",
  },
] as const;

export interface LedgerRow {
  kind: "deposit" | "withdrawal";
  usdValue: string | null;
  status: string;
}

/** Margin moved in and out, in USD cents, from the rows Ballast recorded (strings in, no floats). */
export function marginTotals(rows: readonly LedgerRow[]) {
  const cents = (v: string | null) => {
    const m = /^(\d+)(?:\.(\d{1,2})\d*)?$/.exec(v ?? "");
    return m ? BigInt(m[1] as string) * 100n + BigInt((m[2] ?? "").padEnd(2, "0")) : 0n;
  };
  let deposited = 0n;
  let withdrawn = 0n;
  for (const r of rows) {
    if (r.status !== "submitted" && r.status !== "confirmed") continue;
    if (r.kind === "deposit") deposited += cents(r.usdValue);
    else withdrawn += cents(r.usdValue);
  }
  return { depositedCents: deposited, withdrawnCents: withdrawn };
}

export function fmtCents(c: bigint): string {
  return `$${(c / 100n).toLocaleString("en-US")}.${(c % 100n).toString().padStart(2, "0")}`;
}
