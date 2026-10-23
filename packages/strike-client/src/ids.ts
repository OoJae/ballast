/**
 * Client order id rules, kept apart from the order builders (orders.ts) so the route allowlist
 * and the cancel-only build can check ids without importing anything that builds a create.
 */
export const RESERVED_CLIENT_ID_PREFIXES = [
  "copy:",
  "liq_",
  "bankrupt_",
  "adl_",
  "if_transfer_",
  "if_adl_",
  "vault_wd_",
] as const;

/** Every Ballast order is a `bal_` order (Proof of Conduct); Strike caps ids at 256 chars. */
const CLIENT_ID_RE = /^bal_[A-Za-z0-9_-]{1,252}$/;

export function assertClientOrderId(id: string): void {
  if (!CLIENT_ID_RE.test(id)) throw new TypeError(`client_order_id must match ${CLIENT_ID_RE}`);
  if (RESERVED_CLIENT_ID_PREFIXES.some((p) => id.startsWith(p))) {
    throw new TypeError(`client_order_id uses a reserved prefix: ${id}`);
  }
}
