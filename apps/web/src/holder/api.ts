import type { HolderErrorWire } from "@ballast/api/holder-types";
import type { Post } from "../lib/flows";

const BASE: string = import.meta.env.VITE_API_BASE ?? "";

/** A refusal from the holder routes; `fallback` says the Strike-app funding path applies. */
export class HolderApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: HolderErrorWire,
  ) {
    super(body.error);
    this.name = "HolderApiError";
  }
}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  token: string | null,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}/api/holder/${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Not JSON: fall through with the status line.
  }
  if (!res.ok) {
    const b = (json as HolderErrorWire | null) ?? { error: `HTTP ${res.status}` };
    throw new HolderApiError(res.status, { ...b, error: b.error ?? `HTTP ${res.status}` });
  }
  return json as T;
}

/** The `post` the flows take, bound to the session's bearer token (kept in memory only). */
export function poster(token: string | null): Post {
  return <T>(path: string, body: unknown) => call<T>("POST", path, token, body);
}

export function holderGet<T>(path: string, token: string): Promise<T> {
  return call<T>("GET", path, token);
}

export function errorText(err: unknown): string {
  if (err instanceof HolderApiError) return err.body.error;
  if (err instanceof Error) return err.message;
  return String(err);
}
