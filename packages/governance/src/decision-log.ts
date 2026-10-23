import { canonicalize, sha256Hex } from "@ballast/core";
import { type DaemonKey, SIG_DOMAIN, verifyDomainSignature } from "./keys.js";
import { errorText, isHex64 } from "./types.js";

export const DECISION_KINDS = [
  "policy",
  "critic",
  "advisor",
  "requote",
  "keeper",
  "kill",
  "cover",
  "fill",
  "anchor",
  "consent",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** One proposed or executed operation. Integer units travel as decimal strings. */
export interface DecisionOp {
  route: string;
  clientOrderId?: string;
  side?: "buy" | "sell";
  priceTicks?: string;
  sizeSteps?: string;
  builderBps?: number;
  cancelOrderId?: string;
}

export interface DecisionGuard {
  decision: "execute" | "dry-run" | "blocked";
  checksHash: string;
  violations: string[];
}

/**
 * §6 DecisionRecord. `hash` = sha256(JCS(record without hash and sig)); `sig` is the daemon's
 * Ed25519 over `ballast/decision/v1:<hash>`. `prevHash` links each record to the one before,
 * so editing, dropping or reordering any record breaks every later link.
 */
export interface DecisionRecord {
  seq: number;
  prevHash: string | null;
  tsMs: number;
  kind: DecisionKind;
  policyHash?: string;
  accountId?: string;
  /** Digest of what the decision consumed (a report, proof, anchor payload or input set). */
  inputsDigest: string;
  /** Where the inputs sit in the recorder segments, when they came from recorded data. */
  inputsRef: { segment: string; offset: number } | null;
  ops?: DecisionOp[];
  guard?: DecisionGuard;
  hash: string;
  sig: string;
}

export type DecisionDraft = Omit<DecisionRecord, "seq" | "prevHash" | "tsMs" | "hash" | "sig">;

export function decisionHash(record: Omit<DecisionRecord, "hash" | "sig">): string {
  return sha256Hex(canonicalize(record));
}

const INT_STRING = /^\d+$/;

function draftIssues(d: DecisionDraft): string[] {
  const issues: string[] = [];
  if (!(DECISION_KINDS as readonly string[]).includes(d.kind))
    issues.push(`unknown kind ${d.kind}`);
  if (!isHex64(d.inputsDigest)) issues.push("inputsDigest must be a 64-hex digest");
  if (d.policyHash !== undefined && !isHex64(d.policyHash))
    issues.push("policyHash must be 64-hex");
  for (const op of d.ops ?? []) {
    for (const k of ["priceTicks", "sizeSteps", "cancelOrderId"] as const) {
      const v = op[k];
      if (v !== undefined && !INT_STRING.test(v)) issues.push(`op.${k} must be an integer string`);
    }
  }
  return issues;
}

export interface DecisionSink {
  append(record: DecisionRecord): void;
}

export interface DecisionLogOptions {
  key: DaemonKey;
  /** The last persisted record, so a restarted daemon continues the same chain. */
  head?: { seq: number; hash: string } | null;
  sink?: DecisionSink;
  now?: () => number;
}

/**
 * Append-only, hash-chained, daemon-signed log. The sink (the evidence DB) is written before
 * the head advances, so a failed write never leaves a gap that later records would paper over.
 */
export class DecisionLog {
  private seq: number;
  private prev: string | null;
  private lastTs = 0;
  private readonly now: () => number;

  constructor(private readonly opts: DecisionLogOptions) {
    if (opts.key.role !== "daemon") throw new TypeError("decision records are daemon-signed");
    this.seq = opts.head?.seq ?? 0;
    this.prev = opts.head?.hash ?? null;
    this.now = opts.now ?? Date.now;
  }

  append(draft: DecisionDraft): DecisionRecord {
    const issues = draftIssues(draft);
    if (issues.length > 0) throw new TypeError(`bad decision record: ${issues.join("; ")}`);
    // Timestamps never run backwards within a chain, even if the wall clock does.
    const tsMs = Math.max(this.lastTs, this.now());
    const body = { ...draft, seq: this.seq + 1, prevHash: this.prev, tsMs };
    const hash = decisionHash(body);
    const record: DecisionRecord = { ...body, hash, sig: this.opts.key.signDecisionHash(hash) };
    this.opts.sink?.append(record);
    this.seq = record.seq;
    this.prev = hash;
    this.lastTs = tsMs;
    return record;
  }

  head(): { seq: number; hash: string | null } {
    return { seq: this.seq, hash: this.prev };
  }
}

export interface ChainFailure {
  seq: number | null;
  reason: string;
}

export interface ChainReport {
  ok: boolean;
  checked: number;
  failures: ChainFailure[];
}

/**
 * Independent re-check of a run of records: hash, signature, seq continuity, prevHash links
 * and non-decreasing time. `startPrev` is the hash before the first record (null at genesis).
 */
export function verifyDecisionChain(
  records: readonly DecisionRecord[],
  trustedDaemons: readonly string[],
  opts: { startPrev?: string | null; startSeq?: number } = {},
): ChainReport {
  const failures: ChainFailure[] = [];
  let prev: string | null | undefined = opts.startPrev;
  let expectSeq = opts.startSeq ?? records[0]?.seq ?? 1;
  let lastTs = Number.NEGATIVE_INFINITY;
  if (opts.startPrev === undefined && expectSeq === 1) prev = null;
  for (const r of records) {
    const seq = Number.isSafeInteger(r?.seq) ? r.seq : null;
    const fail = (reason: string) => failures.push({ seq, reason });
    try {
      if (seq !== expectSeq) fail(`expected seq ${expectSeq}, found ${String(r.seq)}`);
      if (prev !== undefined && r.prevHash !== prev)
        fail("prevHash does not link to the previous record");
      if (!(DECISION_KINDS as readonly string[]).includes(r.kind)) fail(`unknown kind ${r.kind}`);
      if (!Number.isSafeInteger(r.tsMs) || r.tsMs < lastTs) fail("timestamp runs backwards");
      const { hash, sig, ...body } = r;
      if (decisionHash(body) !== hash) fail("hash does not recompute");
      const signedBy = trustedDaemons.find((pk) =>
        verifyDomainSignature(pk, SIG_DOMAIN.decision, hash, sig),
      );
      if (!signedBy) fail("signature does not verify under a trusted daemon key");
      prev = hash;
      lastTs = Number.isSafeInteger(r.tsMs) ? Math.max(lastTs, r.tsMs) : lastTs;
    } catch (err) {
      fail(`malformed record: ${errorText(err)}`);
      prev = undefined;
    }
    expectSeq = (seq ?? expectSeq) + 1;
  }
  return { ok: failures.length === 0, checked: records.length, failures };
}
