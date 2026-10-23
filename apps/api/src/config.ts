import { z } from "zod";

const SYMBOL_RE = /^[A-Z0-9]+-USD$/;
const intFrom = (def: number, min: number) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min)).default(def);

const EnvSchema = z.object({
  API_PORT: intFrom(8787, 1),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  RECORDINGS_ROOT: z.string().min(1).default("data/recordings"),
  API_SYMBOLS: z.string().default("NIGHT-USD,ADA-USD"),
  /** "replay" (default) plays sealed recordings; "live" opens Strike's public L3 feed. */
  BOOK_SOURCE: z.enum(["replay", "live"]).default("replay"),
  CORS_ORIGINS: z.string().default("*"),
  INDEX_REFRESH_MS: intFrom(60_000, 5_000),
  ARCHIVE_FRAME_MS: intFrom(5_000, 1_000),
  ARCHIVE_HOURS: intFrom(24, 1),
  // Used only by the live source.
  STRIKE_API_URL: z.url().default("https://api.strikefinance.org"),
  STRIKE_WS_URL: z
    .string()
    .regex(/^wss?:\/\/[^/]+$/, "origin only, e.g. wss://api.strikefinance.org")
    .default("wss://api.strikefinance.org"),
  API_USER_AGENT: z.string().min(3).default("ballast-api/0.1"),
});

export interface ApiConfig {
  port: number;
  host: string;
  recordingsRoot: string;
  symbols: string[];
  source: "replay" | "live";
  corsOrigins: "*" | string[];
  indexRefreshMs: number;
  archiveFrameMs: number;
  archiveHours: number;
  strike: { apiUrl: string; wsUrl: string; userAgent: string };
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const e = EnvSchema.parse(env);
  const symbols = e.API_SYMBOLS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (symbols.length === 0 || symbols.length > 10) {
    throw new Error("API_SYMBOLS must list 1-10 symbols");
  }
  for (const s of symbols) {
    if (!SYMBOL_RE.test(s)) throw new Error(`API_SYMBOLS: invalid symbol ${s}`);
  }
  if (e.ARCHIVE_FRAME_MS % 1_000 !== 0) {
    throw new Error("ARCHIVE_FRAME_MS must be a whole number of seconds");
  }
  const origins = e.CORS_ORIGINS.trim();
  return {
    port: e.API_PORT,
    host: e.API_HOST,
    recordingsRoot: e.RECORDINGS_ROOT,
    symbols,
    source: e.BOOK_SOURCE,
    corsOrigins:
      origins === "*"
        ? "*"
        : origins
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean),
    indexRefreshMs: e.INDEX_REFRESH_MS,
    archiveFrameMs: e.ARCHIVE_FRAME_MS,
    archiveHours: e.ARCHIVE_HOURS,
    strike: { apiUrl: e.STRIKE_API_URL, wsUrl: e.STRIKE_WS_URL, userAgent: e.API_USER_AGENT },
  };
}
