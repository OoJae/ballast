/** An HTTP answer the fake gives instead of a 2xx: Strike's `{"error": ...}` shape. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly payload: Record<string, unknown>,
  ) {
    super(String(payload.error));
  }
}

export function bad(error: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(400, { error, ...extra });
}
