import { createHash, createPublicKey, verify } from "node:crypto";

/**
 * Helpers private to the fake. It shares no code with @ballast/strike-client on purpose: a
 * signature that verifies here was checked by an independent implementation of the spec.
 */

/** Fixed-point decimals with 18 places, as bigint. */
export const SCALE = 10n ** 18n;
const DEC_RE = /^(-)?(\d+)(?:\.(\d{1,18}))?$/;

export function toFixed(value: unknown): bigint | undefined {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string") return undefined;
  const m = DEC_RE.exec(text);
  if (!m) return undefined;
  const [, sign, int = "0", frac = ""] = m;
  const v = BigInt(int) * SCALE + BigInt(frac.padEnd(18, "0"));
  return sign ? -v : v;
}

export function fmt(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const int = a / SCALE;
  const frac = (a % SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

export function mulFixed(a: bigint, b: bigint): bigint {
  return (a * b) / SCALE;
}

type Reviver = (this: unknown, key: string, value: unknown, ctx?: { source?: string }) => unknown;

const reviver: Reviver = (_k, v, ctx) =>
  typeof v === "number" && !Number.isSafeInteger(v) && ctx?.source && /^-?\d+$/.test(ctx.source)
    ? BigInt(ctx.source)
    : v;

export function parseJson(text: string): unknown {
  return (JSON.parse as (t: string, r: Reviver) => unknown)(text, reviver);
}

export function toJson(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(toJson).join(",")}]`;
  const parts: string[] = [];
  for (const [k, x] of Object.entries(v)) {
    if (x !== undefined) parts.push(`${JSON.stringify(k)}:${toJson(x)}`);
  }
  return `{${parts.join(",")}}`;
}

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function ed25519Verify(pubHex: string, message: string, sigHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(pubHex) || !/^[0-9a-fA-F]{128}$/.test(sigHex)) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(pubHex, "hex")]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
