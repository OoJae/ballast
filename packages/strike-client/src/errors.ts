/** Strike answered with a non-2xx status. `code` is the `{"error": ...}` text. */
export class StrikeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: string,
    readonly method: string,
    readonly path: string,
    readonly failedIndex?: number,
  ) {
    super(`${method} ${path} -> HTTP ${status}: ${code || body.slice(0, 200)}`);
    this.name = "StrikeApiError";
  }
}

/** Refused locally before signing: no nonce was used and nothing reached Strike. */
export class StrikeRefusedError extends Error {
  constructor(
    readonly kind: "route" | "rate" | "builder-fee" | "clock",
    readonly reason: string,
    readonly retryAfterMs?: number,
  ) {
    super(`refused (${kind}): ${reason}`);
    this.name = "StrikeRefusedError";
  }
}

/**
 * The request may or may not have reached Strike (timeout, reset). For a write the outcome is
 * unknown: treat the create as pending and resolve it via the silent-drop lookup, never resend.
 */
export class StrikeTransportError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly write: boolean,
    readonly cause: unknown,
  ) {
    super(`${method} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "StrikeTransportError";
  }
}
