import { parseArgs } from "node:util";
import {
  CoverOracle,
  type CoverProof,
  capacityBase,
  DEFAULT_R_BPS,
  formatNight,
  KoiosClient,
  type KoiosReader,
  loadCoverConfig,
  NIGHT,
  NIGHT_UNIT,
} from "@ballast/cover";

/**
 * `ballast cover <addr1…|stake1…> [--r-bps 5000] [--short <NIGHT>] [--json]`: read-only Proof of
 * Cover for one wallet at the current tip. The asset is the pinned NIGHT; there is no flag to
 * change it.
 */
export interface CoverArgs {
  input: string;
  rBps: number;
  shortBase: bigint;
  json: boolean;
}

/** Exact NIGHT decimal → base units (6 dp); no floats anywhere. */
export function nightToBase(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) throw new Error(`not a NIGHT amount with at most ${NIGHT.decimals} decimals: ${text}`);
  return BigInt(m[1] as string) * NIGHT_UNIT + BigInt((m[2] ?? "").padEnd(NIGHT.decimals, "0"));
}

export function parseCoverArgs(argv: readonly string[]): CoverArgs {
  const { values, positionals } = parseArgs({
    args: argv[0] === "--" ? argv.slice(1) : [...argv],
    allowPositionals: true,
    options: {
      "r-bps": { type: "string" },
      short: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 1)
    throw new Error("usage: ballast cover <addr1…|stake1…> [--r-bps n] [--short NIGHT] [--json]");
  const rBps = values["r-bps"] === undefined ? DEFAULT_R_BPS : Number(values["r-bps"]);
  if (!Number.isSafeInteger(rBps) || rBps < 0 || rBps > 9000)
    throw new Error("--r-bps must be an integer 0..9000");
  return {
    input: positionals[0] as string,
    rBps,
    shortBase: values.short === undefined ? 0n : nightToBase(values.short),
    json: values.json ?? false,
  };
}

export function renderCover(p: CoverProof, args: CoverArgs): string {
  const cover = BigInt(p.coverBase);
  const k = capacityBase(cover, args.rBps, args.shortBase);
  const reasons = new Map<string, { n: number; q: bigint }>();
  for (const e of p.excluded) {
    const cur = reasons.get(e.reason) ?? { n: 0, q: 0n };
    reasons.set(e.reason, { n: cur.n + 1, q: cur.q + BigInt(e.quantity) });
  }
  const subject =
    p.subject.kind === "stake" ? p.subject.stakeAddress : `${p.subject.address} (no stake key)`;
  const rows: [string, string][] = [
    ["subject", subject],
    ["asset", `${NIGHT.symbol} ${NIGHT.policyId}.${NIGHT.assetNameHex} (pinned)`],
    ["block height", `${p.height}  (tip ${p.tipHash.slice(0, 16)}…, slot ${p.tipSlot})`],
    ["cover", `${formatNight(cover)} NIGHT in ${p.utxos.length} spendable UTxO(s)`],
    [
      "excluded",
      reasons.size === 0
        ? "none"
        : [...reasons]
            .map(([r, x]) => `${r}: ${x.n} UTxO(s), ${formatNight(x.q)} NIGHT`)
            .join("; "),
    ],
    ["lookalikes", `${formatNight(BigInt(p.lookalikeBase))} of other assets named NIGHT, ignored`],
    [
      "capacity",
      `K = ${(args.rBps / 10_000).toFixed(2)} × ${formatNight(cover)} − ${formatNight(args.shortBase)} = ${formatNight(k)} NIGHT`,
    ],
    ["proof", p.hash],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  return `${rows.map(([a, b]) => `${a.padEnd(w)}  ${b}`).join("\n")}\n`;
}

export interface CoverDeps {
  koios?: KoiosReader;
  now?: () => number;
  out?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
}

export async function coverMain(argv: readonly string[], deps: CoverDeps = {}): Promise<number> {
  const args = parseCoverArgs(argv);
  const out = deps.out ?? ((s: string) => void process.stdout.write(s));
  const cfg = loadCoverConfig(deps.env ?? process.env);
  const koios =
    deps.koios ??
    new KoiosClient({
      baseUrl: cfg.koiosUrl,
      ...(cfg.koiosToken ? { token: cfg.koiosToken } : {}),
    });
  const proof = await new CoverOracle(koios, { ...(deps.now ? { now: deps.now } : {}) }).proof(
    args.input,
  );
  if (args.json) {
    const k = capacityBase(BigInt(proof.coverBase), args.rBps, args.shortBase);
    out(
      `${JSON.stringify({ proof, rBps: args.rBps, shortBase: args.shortBase.toString(), capacityBase: k.toString() }, null, 2)}\n`,
    );
  } else {
    out(renderCover(proof, args));
  }
  return 0;
}
