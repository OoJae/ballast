import { type Steps, sha256Hex, steps } from "@ballast/core";
import { canonicalPrice, compareDecimalStrings, type L3Order } from "@ballast/strike-client";

/**
 * L3 order ids are opaque, so Ballast finds its own orders on L3 by price plus a fingerprinted
 * size: every create's size is ≡ code (mod M) in steps, with the code derived from the account
 * and level. An `open` at our price with exactly our size is ours; from then on it is tracked by
 * its L3 id, because partial fills change the size. M = 100 steps costs at most 99 NIGHT
 * (≈ $3.80) of size per order.
 */
export const FINGERPRINT_MODULUS = 100n;

export function fingerprintCode(
  accountId: string,
  level: number | "x",
  modulus: bigint = FINGERPRINT_MODULUS,
): bigint {
  if (modulus < 2n) throw new RangeError("modulus must be ≥ 2");
  const h = BigInt(`0x${sha256Hex(`ballast/fp/${accountId}/${level}`).slice(0, 12)}`);
  return (h % (modulus - 1n)) + 1n;
}

/** The largest q′ ≤ qty with q′ ≡ code (mod M); null when no positive one exists. */
export function fingerprintSize(
  qty: Steps,
  code: bigint,
  modulus: bigint = FINGERPRINT_MODULUS,
): Steps | null {
  if (code <= 0n || code >= modulus) throw new RangeError("code must be in [1, M − 1]");
  let q = (qty / modulus) * modulus + code;
  if (q > qty) q -= modulus;
  return q > 0n ? steps(q) : null;
}

export const hasFingerprint = (qty: Steps, code: bigint, modulus = FINGERPRINT_MODULUS) =>
  qty > 0n && qty % modulus === code;

export interface ExpectedOrder {
  /** Our handle, e.g. the client order id. */
  key: string;
  price: string;
  size: string;
}

/**
 * Attributes freshly opened L3 orders to our creates: at each expected price, an order of
 * exactly the expected size that is not already attributed. The newest such order wins, since a
 * new order joins the tail of its level. Unmatched creates stay unattributed (counted as resting
 * by the reconciler, never assumed gone).
 */
export function matchOwnOrders(
  side: ReadonlyMap<string, readonly L3Order[]>,
  expected: readonly ExpectedOrder[],
  attributed: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const taken = new Set(attributed);
  const out = new Map<string, string>();
  for (const e of expected) {
    const queue = side.get(canonicalPrice(e.price)) ?? [];
    for (let i = queue.length - 1; i >= 0; i--) {
      const o = queue[i] as L3Order;
      if (taken.has(o.id) || compareDecimalStrings(o.size, e.size) !== 0) continue;
      out.set(e.key, o.id);
      taken.add(o.id);
      break;
    }
  }
  return out;
}
