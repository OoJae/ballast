import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  KOIOS_MAINNET_URL,
  KOIOS_PREPROD_URL,
  KoiosClient,
  type KoiosReader,
  type KoiosUtxo,
} from "@ballast/cover";
import { ROOTS, type RootEntry } from "@ballast/evidence";
import {
  type AnchorUtxo,
  anchorRecordDigest,
  anchorRoots,
  type BuiltAnchorTx,
  buildAnchorTx,
  MAINNET_PARAMS,
  PREPROD_PARAMS,
  parseCip20Anchor,
} from "@ballast/evidence/anchor";
import {
  type AnchorRecord,
  acquireDaemonLockOrThrow,
  type EvidenceDb,
  openEvidenceDb,
} from "@ballast/evidence/db";
import {
  type AnchorWalletKey,
  type DaemonKey,
  DecisionLog,
  HostKek,
  openSealedKey,
  readSealedKey,
} from "@ballast/governance";
import { anchorAddress, DEFAULT_KEK_PATH } from "./keys.js";

/**
 * `ballast anchor`: commits the decisions and sealed recorder hours since the last anchor to one
 * Merkle root, records a daemon-signed "anchor" decision over it, and builds the CIP-20 self-send
 * from the anchor wallet (plan section 6). It holds the daemon lock, so it never runs alongside
 * the keeper (invariant 12). Building is offline. Submitting is the only Cardano write path in
 * Ballast: preprod needs --submit, mainnet also needs --yes-i-approve and BALLAST_ARM=1.
 */
const USAGE = `usage: ballast anchor --network <preprod|mainnet> --anchor-key <file> --daemon-key <file>
                      [--db data/ballast.sqlite] [--recordings data/recordings] [--kek <path>]
                      [--koios-url <url>] [--submit] [--yes-i-approve] [--wait-s 600]`;

export const KOIOS_URLS = { preprod: KOIOS_PREPROD_URL, mainnet: KOIOS_MAINNET_URL } as const;
const USER_AGENT = "ballast-anchor/0.1";
/** About two hours of slots: an unsubmitted build cannot be replayed much later. */
const TTL_SLOTS = 7_200;

type Network = "preprod" | "mainnet";

export type AnchorPlan =
  | { kind: "nothing"; reason: string }
  | { kind: "resume"; record: AnchorRecord }
  | { kind: "new"; record: AnchorRecord };

/** Every segment of every sealed hour, in roots order, that no earlier anchor already covers. */
function unanchoredSegments(roots: readonly RootEntry[], anchors: readonly AnchorRecord[]) {
  const done = new Set(anchors.flatMap((a) => a.segments.map((s) => s.segment)));
  const out: { segment: string; sha256: string }[] = [];
  for (const r of roots) {
    r.segments.forEach((segment, i) => {
      const sha256 = r.leaves[i];
      if (sha256 && !done.has(segment)) out.push({ segment, sha256 });
    });
  }
  return out;
}

/**
 * What the next anchor covers. An anchor that was built but never submitted is resumed as is,
 * so a failed submit never forks the record. Otherwise: decisions after the last anchor, up to
 * the head, and the sealed hours not yet anchored.
 */
export function planAnchor(
  db: EvidenceDb,
  roots: readonly RootEntry[],
  network: Network,
  nowMs: number,
): AnchorPlan {
  const anchors = db.anchors();
  const last = anchors.at(-1);
  if (last && last.txHash === null) {
    if (last.network !== network) {
      return { kind: "nothing", reason: `an unsubmitted ${last.network} anchor is pending` };
    }
    return { kind: "resume", record: last };
  }
  const firstSeq = (last?.lastSeq ?? 0) + 1;
  const head = db.decisionHead();
  if (!head || head.seq < firstSeq) {
    return {
      kind: "nothing",
      reason: head
        ? "no decisions since the last anchor"
        : "the decision log is empty: run the keeper (DRY_RUN is fine) first",
    };
  }
  const decisions = db.decisions(firstSeq, head.seq);
  const segments = unanchoredSegments(roots, anchors);
  const record: AnchorRecord = {
    v: 1,
    ...anchorRoots(
      decisions.map((d) => d.hash),
      segments.map((s) => s.sha256),
    ),
    firstSeq,
    lastSeq: head.seq,
    segments,
    network,
    txHash: null,
    createdMs: nowMs,
  };
  return { kind: "new", record };
}

/** True when a daemon-signed "anchor" decision after the record's range commits to it. */
function isCommitted(db: EvidenceDb, record: AnchorRecord): boolean {
  const digest = anchorRecordDigest(record);
  return db
    .decisions(record.lastSeq + 1)
    .some((d) => d.kind === "anchor" && d.inputsDigest === digest);
}

/**
 * Stores the record and its signed "anchor" decision. The record goes first: if the decision
 * append then fails, the next run resumes the record and appends the decision.
 */
export function commitAnchor(
  db: EvidenceDb,
  plan: Exclude<AnchorPlan, { kind: "nothing" }>,
  daemonKey: DaemonKey,
  nowMs: () => number,
): AnchorRecord {
  if (plan.kind === "new") db.insertAnchor(plan.record, nowMs());
  if (!isCommitted(db, plan.record)) {
    const log = new DecisionLog({
      key: daemonKey,
      head: db.decisionHead(),
      sink: db.decisionSink(),
      now: nowMs,
    });
    log.append({ kind: "anchor", inputsDigest: anchorRecordDigest(plan.record), inputsRef: null });
  }
  return plan.record;
}

export function toAnchorUtxo(u: KoiosUtxo): AnchorUtxo {
  return {
    txHash: u.tx_hash,
    index: u.tx_index,
    address: u.address,
    lovelace: BigInt(u.value),
    assets: (u.asset_list ?? []).map((a) => ({
      policyId: a.policy_id,
      assetNameHex: a.asset_name ?? "",
      quantity: BigInt(a.quantity),
    })),
  };
}

export async function buildForRecord(
  record: AnchorRecord,
  key: AnchorWalletKey,
  koios: Pick<KoiosReader, "tip" | "addressUtxos">,
): Promise<BuiltAnchorTx> {
  const network = record.network as Network;
  const address = anchorAddress(key, network);
  const [tip, utxos] = await Promise.all([koios.tip(), koios.addressUtxos([address])]);
  return buildAnchorTx({
    network,
    utxos: utxos.filter((u) => u.is_spent !== true).map(toAnchorUtxo),
    changeAddress: address,
    signingKey: key,
    payload: {
      root: record.root,
      firstSeq: record.firstSeq,
      lastSeq: record.lastSeq,
      segmentCount: record.segments.length,
    },
    params: network === "mainnet" ? MAINNET_PARAMS : PREPROD_PARAMS,
    ttlSlot: tip.abs_slot + TTL_SLOTS,
  });
}

/** POST /submittx with the raw CBOR (Koios's only write route). Returns the tx hash Koios echoes. */
export async function submitTx(
  baseUrl: string,
  txHex: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!/^https:\/\/([a-z0-9-]+\.)*koios\.rest\/api\/v1$/.test(baseUrl)) {
    throw new Error(`refusing to submit to ${baseUrl}: only https://*.koios.rest/api/v1`);
  }
  const res = await fetchImpl(`${baseUrl}/submittx`, {
    method: "POST",
    headers: { "content-type": "application/cbor", "user-agent": USER_AGENT },
    body: Buffer.from(txHex, "hex"),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`submittx ${res.status}: ${text.slice(0, 300)}`);
  return text.replace(/"/g, "").trim();
}

/** Polls tx_metadata until the anchor is on chain and matches the record, or the wait runs out. */
export async function awaitOnChain(
  koios: Pick<KoiosReader, "txMetadata">,
  record: AnchorRecord,
  txHash: string,
  waitMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = Date.now,
): Promise<"confirmed" | "mismatch" | "timeout"> {
  const until = now() + waitMs;
  while (now() < until) {
    const rows = await koios.txMetadata([txHash]).catch(() => []);
    const row = rows.find((r) => r.tx_hash === txHash);
    if (row) {
      const p = parseCip20Anchor(row.metadata);
      const ok =
        p !== null &&
        p.root === record.root &&
        p.firstSeq === record.firstSeq &&
        p.lastSeq === record.lastSeq &&
        p.segmentCount === record.segments.length;
      return ok ? "confirmed" : "mismatch";
    }
    await sleep(10_000);
  }
  return "timeout";
}

function readRoots(recordings: string): RootEntry[] {
  let text: string;
  try {
    text = readFileSync(join(recordings, ROOTS), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as RootEntry);
}

export interface AnchorDeps {
  env?: NodeJS.ProcessEnv;
  koios?: KoiosReader;
  fetchImpl?: typeof fetch;
  now?: () => number;
  out?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export async function anchorMain(args: readonly string[], deps: AnchorDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const out = deps.out ?? ((s: string) => void process.stdout.write(`${s}\n`));
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (name: string) => args.includes(name);
  const network = flag("--network");
  const anchorKeyPath = flag("--anchor-key");
  const daemonKeyPath = flag("--daemon-key") ?? env.BALLAST_DAEMON_KEY_FILE;
  if ((network !== "preprod" && network !== "mainnet") || !anchorKeyPath || !daemonKeyPath) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const submit = has("--submit");
  if (submit && network === "mainnet" && (!has("--yes-i-approve") || env.BALLAST_ARM !== "1")) {
    process.stderr.write(
      "refusing: a mainnet anchor spends real ADA; it needs --yes-i-approve and BALLAST_ARM=1\n",
    );
    return 2;
  }
  const waitS = Number(flag("--wait-s") ?? "600");
  const baseUrl = (flag("--koios-url") ?? KOIOS_URLS[network]).replace(/\/+$/, "");
  const koios = deps.koios ?? new KoiosClient({ baseUrl, userAgent: USER_AGENT });

  const kek = HostKek.load(flag("--kek") ?? env.BALLAST_KEK_PATH ?? DEFAULT_KEK_PATH);
  const daemonKey = openSealedKey(readSealedKey(daemonKeyPath), kek, "daemon");
  const anchorKey = openSealedKey(readSealedKey(anchorKeyPath), kek, "anchor");

  const db = openEvidenceDb(flag("--db") ?? env.BALLAST_DB_PATH ?? "data/ballast.sqlite");
  acquireDaemonLockOrThrow(db, process.pid, now(), 15_000);
  try {
    const roots = readRoots(flag("--recordings") ?? env.BALLAST_RECORDINGS ?? "data/recordings");
    const plan = planAnchor(db, roots, network, now());
    if (plan.kind === "nothing") {
      out(`nothing to anchor: ${plan.reason}`);
      return plan.reason.startsWith("an unsubmitted") ? 2 : 0;
    }
    const record = commitAnchor(db, plan, daemonKey, now);
    out(
      `${plan.kind === "resume" ? "resuming" : "new"} anchor ${record.root}\n` +
        `  decisions ${record.firstSeq}-${record.lastSeq}, ${record.segments.length} segment(s), ${network}`,
    );
    const built = await buildForRecord(record, anchorKey, koios);
    out(
      `  tx ${built.txHash}  fee ${built.feeLovelace} lovelace  inputs ${built.inputs.join(", ")}`,
    );
    if (!submit) {
      out("built only (pass --submit to send it)");
      return 0;
    }
    const echoed = await submitTx(baseUrl, built.txHex, deps.fetchImpl ?? fetch);
    if (echoed !== built.txHash) {
      throw new Error(`Koios echoed tx ${echoed}, expected ${built.txHash}`);
    }
    db.setAnchorTx(record.root, built.txHash, "submitted");
    out(`  submitted ${built.txHash}`);
    const status = await awaitOnChain(koios, record, built.txHash, waitS * 1_000, deps.sleep, now);
    if (status === "confirmed") db.setAnchorTx(record.root, built.txHash, "confirmed");
    if (status === "mismatch") db.setAnchorTx(record.root, built.txHash, "failed");
    out(
      `  ${status === "timeout" ? `not seen on chain within ${waitS}s (still submitted)` : status}`,
    );
    return status === "mismatch" ? 1 : 0;
  } finally {
    db.releaseDaemonLock(process.pid);
    db.close();
  }
}
