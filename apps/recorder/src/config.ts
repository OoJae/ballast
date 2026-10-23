import { z } from "zod";

const SYMBOL_RE = /^[A-Z0-9]+-USD$/;

const EnvSchema = z.object({
  STRIKE_API_URL: z.url().default("https://api.strikefinance.org"),
  STRIKE_WS_URL: z
    .string()
    .regex(/^wss?:\/\/[^/]+$/, "origin only, e.g. wss://api.strikefinance.org")
    .default("wss://api.strikefinance.org"),
  RECORDER_SYMBOLS: z.string().default("NIGHT-USD,ADA-USD"),
  RECORDER_DATA_DIR: z.string().min(1).default("data/recordings"),
  RECORDER_USER_AGENT: z.string().min(3).default("ballast-recorder/0.1"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
});

export interface RecorderConfig {
  apiUrl: string;
  wsUrl: string;
  symbols: string[];
  dataDir: string;
  userAgent: string;
  logLevel: z.infer<typeof EnvSchema>["LOG_LEVEL"];
  /** REST poll intervals (ms). WebSocket streams carry the high-frequency data. */
  intervals: {
    depth: number;
    premiumIndex: number;
    livePositions: number;
    markets: number;
    ticker24h: number;
    trades: number;
    time: number;
    health: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RecorderConfig {
  const e = EnvSchema.parse(env);
  const symbols = e.RECORDER_SYMBOLS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (symbols.length === 0 || symbols.length > 10) {
    throw new Error("RECORDER_SYMBOLS must list 1-10 symbols (one L3 connection)");
  }
  for (const s of symbols) {
    if (!SYMBOL_RE.test(s)) throw new Error(`RECORDER_SYMBOLS: invalid symbol ${s}`);
  }
  return {
    apiUrl: e.STRIKE_API_URL,
    wsUrl: e.STRIKE_WS_URL,
    symbols,
    dataDir: e.RECORDER_DATA_DIR,
    userAgent: e.RECORDER_USER_AGENT,
    logLevel: e.LOG_LEVEL,
    intervals: {
      depth: 15_000,
      premiumIndex: 5_000,
      livePositions: 300_000,
      markets: 600_000,
      ticker24h: 300_000,
      trades: 600_000,
      time: 300_000,
      health: 60_000,
    },
  };
}
