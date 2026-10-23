import { sha256Hex } from "@ballast/core";
import { assertClientOrderId } from "@ballast/strike-client";

/**
 * Client order ids, `bal_<policy6>_<acct6>_<lvl|x>_<seq36>` (plan section 6, ~24 characters).
 * Each resolves to a decision (seq), then a policy (its hash prefix), then a signature. One
 * decision creates at most one order per account and level, so ids are unique per create, as
 * replace-batch requires.
 *
 * acct6 hashes the account id: Strike account ids are UUIDv7, whose leading hex digits are a
 * timestamp shared by every account created around the same time.
 */
export type OrderLevel = 1 | 2 | 3 | "x";

export interface ClientIdParts {
  policy6: string;
  acct6: string;
  level: OrderLevel;
  seq: bigint;
}

export const CLIENT_ID_RE = /^bal_([0-9a-f]{6})_([0-9a-f]{6})_([123x])_([0-9a-z]{1,13})$/;
const HEX64 = /^[0-9a-f]{64}$/;
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

export function policyTag(policyHash: string): string {
  if (!HEX64.test(policyHash)) throw new TypeError("policy hash must be a lowercase sha256 hex");
  return policyHash.slice(0, 6);
}

export function accountTag(accountId: string): string {
  if (accountId.length === 0) throw new TypeError("empty account id");
  return sha256Hex(`ballast/account/${accountId}`).slice(0, 6);
}

export function clientOrderId(p: {
  policyHash: string;
  accountId: string;
  level: OrderLevel;
  seq: bigint;
}): string {
  if (p.seq < 0n || p.seq >= 36n ** 13n) throw new RangeError("decision seq out of range");
  if (p.level !== "x" && ![1, 2, 3].includes(p.level)) throw new RangeError("level must be 1-3");
  const id = `bal_${policyTag(p.policyHash)}_${accountTag(p.accountId)}_${p.level}_${p.seq.toString(36)}`;
  assertClientOrderId(id);
  return id;
}

/** Null for anything that is not a well-formed Ballast id (manual or foreign orders). */
export function parseClientOrderId(id: string): ClientIdParts | null {
  const m = CLIENT_ID_RE.exec(id);
  if (!m) return null;
  const [, policy6 = "", acct6 = "", lvl = "", seq36 = ""] = m;
  // Canonical base-36 only: no leading zeros, so each seq has exactly one spelling.
  if (seq36.length > 1 && seq36.startsWith("0")) return null;
  let seq = 0n;
  for (const ch of seq36) seq = seq * 36n + BigInt(BASE36.indexOf(ch));
  const level: OrderLevel = lvl === "x" ? "x" : lvl === "1" ? 1 : lvl === "2" ? 2 : 3;
  return { policy6, acct6, level, seq };
}
