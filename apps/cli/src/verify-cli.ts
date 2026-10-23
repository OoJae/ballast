import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { KOIOS_PREPROD_URL, KoiosClient, type KoiosReader, loadCoverConfig } from "@ballast/cover";
import { MANIFEST, type ManifestEntry } from "@ballast/evidence";
import { koiosAnchorLookup, renderVerifyTable, runVerify, type VerifyOptions } from "./verify.js";

/**
 * `ballast verify --bundle <dir> [--from seq] [--to seq] [--account id]
 *   [--operator-pubkey hex]… [--daemon-pubkey hex]… [--offline] [--live-cover]
 *   [--recordings dir] [--json file|-]`
 * Exit code 0 when no check fails, 1 otherwise.
 */
export interface VerifyCliArgs {
  bundle: string;
  fromSeq?: number;
  toSeq?: number;
  account?: string;
  operatorPubkeys: string[];
  daemonPubkeys: string[];
  offline: boolean;
  liveCover: boolean;
  recordings?: string;
  json?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

function seqArg(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--${name} must be a decision seq ≥ 1`);
  return n;
}

export function parseVerifyArgs(argv: readonly string[]): VerifyCliArgs {
  const { values } = parseArgs({
    args: argv[0] === "--" ? argv.slice(1) : [...argv],
    options: {
      bundle: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      account: { type: "string" },
      "operator-pubkey": { type: "string", multiple: true },
      "daemon-pubkey": { type: "string", multiple: true },
      offline: { type: "boolean", default: false },
      "live-cover": { type: "boolean", default: false },
      recordings: { type: "string" },
      json: { type: "string" },
    },
  });
  if (!values.bundle) throw new Error("--bundle <dir> is required");
  const keys = (list: string[] | undefined, name: string) => {
    for (const k of list ?? [])
      if (!HEX64.test(k)) throw new Error(`--${name} must be a 64-hex public key`);
    return list ?? [];
  };
  const fromSeq = seqArg(values.from, "from");
  const toSeq = seqArg(values.to, "to");
  if (fromSeq !== undefined && toSeq !== undefined && toSeq < fromSeq)
    throw new Error("--to must be ≥ --from");
  if (values.offline && values["live-cover"])
    throw new Error("--live-cover needs network access; drop --offline");
  return {
    bundle: values.bundle,
    ...(fromSeq !== undefined ? { fromSeq } : {}),
    ...(toSeq !== undefined ? { toSeq } : {}),
    ...(values.account ? { account: values.account } : {}),
    operatorPubkeys: keys(values["operator-pubkey"], "operator-pubkey"),
    daemonPubkeys: keys(values["daemon-pubkey"], "daemon-pubkey"),
    offline: values.offline ?? false,
    liveCover: values["live-cover"] ?? false,
    ...(values.recordings ? { recordings: values.recordings } : {}),
    ...(values.json ? { json: values.json } : {}),
  };
}

function recordingsManifest(root: string): Map<string, string> {
  const path = join(root, MANIFEST);
  if (!existsSync(path)) throw new Error(`no ${MANIFEST} under ${root}`);
  const map = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    const e = JSON.parse(line) as ManifestEntry;
    map.set(e.segment, e.sha256);
  }
  return map;
}

function bundleNetwork(dir: string): string | null {
  try {
    return (
      (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { network?: string })
        .network ?? null
    );
  } catch {
    return null;
  }
}

export interface VerifyDeps {
  koios?: KoiosReader;
  out?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
}

export async function verifyMain(argv: readonly string[], deps: VerifyDeps = {}): Promise<number> {
  const a = parseVerifyArgs(argv);
  const out = deps.out ?? ((s: string) => void process.stdout.write(s));
  const env = deps.env ?? process.env;
  const cfg = loadCoverConfig(env);
  // A preprod bundle's anchors live on preprod: follow the bundle unless KOIOS_URL says otherwise.
  const koiosUrl =
    !env.KOIOS_URL && bundleNetwork(a.bundle) === "preprod" ? KOIOS_PREPROD_URL : cfg.koiosUrl;
  const koios =
    deps.koios ??
    (a.offline
      ? null
      : new KoiosClient({
          baseUrl: koiosUrl,
          ...(cfg.koiosToken ? { token: cfg.koiosToken } : {}),
        }));
  const opts: VerifyOptions = {
    bundleDir: a.bundle,
    operatorPubkeys: a.operatorPubkeys,
    daemonPubkeys: a.daemonPubkeys,
    anchorLookup: koios && !a.offline ? koiosAnchorLookup(koios) : null,
    coverRecheck: a.liveCover ? koios : null,
    recordingsManifest: a.recordings ? recordingsManifest(a.recordings) : null,
    ...(a.fromSeq !== undefined ? { fromSeq: a.fromSeq } : {}),
    ...(a.toSeq !== undefined ? { toSeq: a.toSeq } : {}),
    ...(a.account ? { account: a.account } : {}),
  };
  const result = await runVerify(opts);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (a.json === "-") out(json);
  else {
    out(renderVerifyTable(result));
    if (a.json) writeFileSync(a.json, json);
  }
  return result.ok ? 0 : 1;
}
