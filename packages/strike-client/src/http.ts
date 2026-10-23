export interface HttpOptions {
  baseUrl: string;
  /** Strike sits behind Cloudflare, which returns 403 to default user agents. */
  userAgent: string;
  /** Cold stats calls can take ~28 s, so the default is generous. */
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class StrikeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`GET ${path} -> HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "StrikeHttpError";
  }
}

export interface PublicHttp {
  getJson<T = unknown>(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<T>;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export function backoffMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** attempt);
}

/**
 * Unauthenticated GET client for Strike's public endpoints. Retries network errors, 429 and
 * 5xx with capped exponential backoff (honouring Retry-After). Never used for writes: signed
 * requests consume a nonce even when they fail, so they must not be retried blindly.
 */
export function createPublicHttp(opts: HttpOptions): PublicHttp {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 40_000;
  const maxRetries = opts.maxRetries ?? 3;

  return {
    async getJson<T>(path: string, query?: Record<string, string | number | undefined>) {
      const url = new URL(path, opts.baseUrl);
      for (const [k, v] of Object.entries(query ?? {})) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await doFetch(url, {
            headers: { "User-Agent": opts.userAgent, Accept: "application/json" },
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          if (attempt >= maxRetries) throw err;
          await sleep(backoffMs(attempt));
          continue;
        }
        if (res.ok) return (await res.json()) as T;
        const body = await res.text();
        if (RETRYABLE.has(res.status) && attempt < maxRetries) {
          await sleep(retryAfterMs(res) ?? backoffMs(attempt));
          continue;
        }
        throw new StrikeHttpError(res.status, url.pathname + url.search, body);
      }
    },
  };
}

function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(30_000, seconds * 1000) : undefined;
}
