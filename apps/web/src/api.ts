import type { BookFrame } from "@ballast/api/types";
import { useEffect, useRef, useState } from "react";

/** Same-origin by default (Vite proxies /api in dev and preview). */
const BASE: string = import.meta.env.VITE_API_BASE ?? "";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // Not JSON: keep the status line.
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export interface Loadable<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
}

/**
 * GETs `path` (null = idle). A 503 means the API is still indexing sealed hours; it retries
 * quietly instead of showing an error.
 */
export function useApi<T>(path: string | null): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ data: null, error: null, loading: !!path });
  useEffect(() => {
    if (!path) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState((s) => ({ data: s.data, error: null, loading: true }));
    const run = (attempt: number) => {
      getJson<T>(path, ctl.signal)
        .then((data) => setState({ data, error: null, loading: false }))
        .catch((error: unknown) => {
          if (ctl.signal.aborted) return;
          if (error instanceof ApiError && error.status === 503 && attempt < 30) {
            timer = setTimeout(() => run(attempt + 1), 3_000);
            return;
          }
          setState({
            data: null,
            error: error instanceof Error ? error : new Error(String(error)),
            loading: false,
          });
        });
    };
    run(0);
    return () => {
      ctl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [path]);
  return state;
}

export type StreamState = "connecting" | "open" | "reconnecting";

/** The current book over SSE, with the browser's own reconnect. */
export function useBookStream(symbol: string): { frame: BookFrame | null; state: StreamState } {
  const [frame, setFrame] = useState<BookFrame | null>(null);
  const [state, setState] = useState<StreamState>("connecting");
  const latest = useRef<BookFrame | null>(null);
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource(`${BASE}/api/stream/${encodeURIComponent(symbol)}`);
    let raf = 0;
    es.addEventListener("open", () => setState("open"));
    es.addEventListener("error", () => setState("reconnecting"));
    es.addEventListener("book", (e) => {
      latest.current = JSON.parse((e as MessageEvent<string>).data) as BookFrame;
      setState("open");
      // At most one render per animation frame, however fast frames arrive.
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          setFrame(latest.current);
        });
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      es.close();
    };
  }, [symbol]);
  return { frame, state };
}
