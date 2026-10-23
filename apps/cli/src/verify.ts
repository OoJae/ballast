import {
  type CoverProof,
  type KoiosReader,
  recheckCoverProof,
  verifyCoverProof,
} from "@ballast/cover";
import { anchorRecordDigest, anchorRoots, parseCip20Anchor } from "@ballast/evidence/anchor";
import { type BundleContents, readBundle } from "@ballast/evidence/bundle";
import {
  type CriticReport,
  checkPolicySignature,
  type DecisionRecord,
  PolicyRegistry,
  type SignedPolicy,
  verifyCriticReport,
  verifyDecisionChain,
} from "@ballast/governance";

/**
 * `ballast verify` v1 (§7): re-checks a public evidence bundle with no trust in the publisher
 * beyond the public keys a verifier pins. Each check reports PASS, FAIL, WARN (verified only
 * partly, e.g. offline) or SKIP (not built yet, with the milestone that adds it).
 */
export type CheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";

export interface VerifyCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  failures: string[];
}

export interface VerifyResult {
  ok: boolean;
  bundle: string;
  checks: VerifyCheck[];
}

/** Returns each transaction's metadata (Koios tx_metadata shape), or null if not found. */
export type AnchorLookup = (
  txHashes: string[],
) => Promise<Map<string, Record<string, unknown> | null>>;

export function koiosAnchorLookup(koios: Pick<KoiosReader, "txMetadata">): AnchorLookup {
  return async (hashes) => {
    const rows = await koios.txMetadata(hashes);
    return new Map(rows.map((r) => [r.tx_hash, r.metadata]));
  };
}

export interface VerifyOptions {
  bundleDir: string;
  /** Pinned keys. Without them the bundle's own manifest keys are used, with a WARN. */
  operatorPubkeys?: string[];
  daemonPubkeys?: string[];
  fromSeq?: number;
  toSeq?: number;
  account?: string;
  /** null = offline: anchors are recomputed but not compared with the chain. */
  anchorLookup: AnchorLookup | null;
  /** When set, every cover proof's UTxOs are re-read from Koios. */
  coverRecheck?: Pick<KoiosReader, "utxoInfo"> | null;
  /** Segment sha256 by path, from the recordings manifest, to tie anchors to the recordings. */
  recordingsManifest?: Map<string, string> | null;
}

const MAX_LISTED = 20;

function check(
  id: string,
  title: string,
  failures: string[],
  pass: string,
  extra: Partial<VerifyCheck> = {},
): VerifyCheck {
  return {
    id,
    title,
    status: failures.length > 0 ? "FAIL" : "PASS",
    detail: failures.length > 0 ? `${failures.length} problem(s)` : pass,
    failures: failures.slice(0, MAX_LISTED),
    ...extra,
  };
}

function skip(id: string, title: string, detail: string): VerifyCheck {
  return { id, title, status: "SKIP", detail, failures: [] };
}

/**
 * Invariant 2, re-checked from the record: replay every policy decision through a fresh
 * registry (each activation and renewal must pass every rule at its recorded time), then require
 * every create to name the policy in force when it was decided, with a `bal_` client id.
 */
function checkActivations(
  c: BundleContents,
  operators: string[],
  daemons: string[],
  range: { from: number; to: number },
  account: string | undefined,
): VerifyCheck {
  const failures: string[] = [];
  const policies = new Map<string, SignedPolicy>(c.policies.map((p) => [p.hash, p]));
  const reports = new Map<string, CriticReport>(c.criticReports.map((r) => [r.hash, r]));
  const renewals = new Map(c.renewals.map((r) => [r.hash, r]));
  const envelopes = c.renewalEnvelopes;
  // All trips go in: the renewal rules decide what is safety-class, not the stored flag.
  const trips = c.guardTrips.map((t) => ({ ruleId: t.ruleId, tsMs: t.tsMs }));
  const reg = new PolicyRegistry({ trustedOperators: operators, trustedDaemons: daemons });
  let activations = 0;
  let creates = 0;
  for (const d of c.decisions) {
    if (d.kind === "policy") {
      const renewal = renewals.get(d.inputsDigest);
      if (renewal) {
        const env = envelopes.find((e) => e.hash === renewal.renewal.envelopeHash);
        if (env) reg.attachEnvelope(env);
        const r = reg.applyRenewal(renewal, reports.get(renewal.renewal.criticReportHash), trips);
        if (!r.ok) failures.push(`seq ${d.seq}: renewal refused (${failedRules(r.checks)})`);
        else activations += 1;
        continue;
      }
      const sp = d.policyHash ? policies.get(d.policyHash) : undefined;
      if (!sp) {
        failures.push(`seq ${d.seq}: activation names a policy not in the bundle`);
        continue;
      }
      const r = reg.activate(sp, reports.get(d.inputsDigest), d.tsMs);
      if (!r.ok)
        failures.push(
          `seq ${d.seq}: activation of ${sp.hash.slice(0, 12)}… refused (${failedRules(r.checks)})`,
        );
      else activations += 1;
      continue;
    }
    const createOps = (d.ops ?? []).filter((o) => o.clientOrderId !== undefined);
    if (createOps.length === 0 || d.seq < range.from || d.seq > range.to) continue;
    if (account !== undefined && d.accountId !== account) continue;
    creates += createOps.length;
    if (d.guard?.decision === "blocked") continue;
    const w = reg.activeAt(d.tsMs);
    if (!w) failures.push(`seq ${d.seq}: ${createOps.length} create(s) with no policy in force`);
    else if (d.policyHash !== w.policyHash)
      failures.push(`seq ${d.seq}: creates name a policy that was not in force`);
    for (const o of createOps) {
      if (!/^bal_[A-Za-z0-9_-]+$/.test(o.clientOrderId as string))
        failures.push(`seq ${d.seq}: non-bal_ client id`);
    }
  }
  return check(
    "activation",
    "Invariant 2: every create under an active, signed, Critic-passed policy",
    failures,
    `${activations} activation(s) replayed, ${creates} create(s) each under the policy in force`,
  );
}

function failedRules(checks: { rule: string; passed: boolean }[]): string {
  return checks
    .filter((c) => !c.passed)
    .map((c) => c.rule)
    .join(", ");
}

async function checkAnchors(c: BundleContents, opts: VerifyOptions): Promise<VerifyCheck> {
  const title = "Merkle roots against CIP-20 anchors";
  if (c.anchors.length === 0) return skip("anchors", title, "no anchors in the bundle yet");
  const failures: string[] = [];
  const bySeq = new Map<number, DecisionRecord>(c.decisions.map((d) => [d.seq, d]));
  const committed = new Set(
    c.decisions.filter((d) => d.kind === "anchor").map((d) => d.inputsDigest),
  );
  for (const a of c.anchors) {
    // The record itself is unsigned; a signed "anchor" decision must commit to all of it.
    if (!committed.has(anchorRecordDigest(a))) {
      failures.push(`anchor ${a.root.slice(0, 12)}…: not committed by any signed anchor decision`);
    }
    const hashes: string[] = [];
    for (let s = a.firstSeq; s <= a.lastSeq; s++) {
      const d = bySeq.get(s);
      if (!d) {
        failures.push(`anchor ${a.root.slice(0, 12)}…: decision ${s} missing from the bundle`);
        break;
      }
      hashes.push(d.hash);
    }
    if (opts.recordingsManifest) {
      for (const seg of a.segments) {
        const local = opts.recordingsManifest.get(seg.segment);
        if (local !== seg.sha256)
          failures.push(
            `anchor ${a.root.slice(0, 12)}…: segment ${seg.segment} differs from the recordings`,
          );
      }
    }
    const r = anchorRoots(
      hashes,
      a.segments.map((s) => s.sha256),
    );
    if (
      r.decisionsRoot !== a.decisionsRoot ||
      r.segmentsRoot !== a.segmentsRoot ||
      r.root !== a.root
    ) {
      failures.push(`anchor ${a.root.slice(0, 12)}…: roots do not recompute`);
    }
  }
  const onChain = c.anchors.filter((a) => a.txHash !== null);
  if (!opts.anchorLookup || onChain.length === 0) {
    const why = !opts.anchorLookup ? "offline" : "no anchor transaction yet";
    return failures.length > 0
      ? check("anchors", title, failures, "")
      : {
          id: "anchors",
          title,
          status: "WARN",
          detail: `${c.anchors.length} root(s) recompute; chain not checked (${why})`,
          failures: [],
        };
  }
  let found: Map<string, Record<string, unknown> | null>;
  try {
    found = await opts.anchorLookup(onChain.map((a) => a.txHash as string));
  } catch (err) {
    failures.push(`anchor lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return check("anchors", title, failures, "");
  }
  for (const a of onChain) {
    const p = parseCip20Anchor(found.get(a.txHash as string));
    if (!p)
      failures.push(`tx ${a.txHash?.slice(0, 12)}…: no Ballast CIP-20 anchor in its metadata`);
    else if (
      p.root !== a.root ||
      p.firstSeq !== a.firstSeq ||
      p.lastSeq !== a.lastSeq ||
      p.segmentCount !== a.segments.length
    ) {
      failures.push(`tx ${a.txHash?.slice(0, 12)}…: on-chain anchor does not match the bundle`);
    }
  }
  const pending = c.anchors.length - onChain.length;
  const result = check("anchors", title, failures, `${onChain.length} anchor(s) match the chain`);
  if (result.status === "PASS" && pending > 0) {
    return {
      ...result,
      status: "WARN",
      detail: `${result.detail}; ${pending} built but not yet on chain`,
    };
  }
  return result;
}

async function checkCover(
  proofs: CoverProof[],
  decisions: DecisionRecord[],
  recheck: VerifyOptions["coverRecheck"],
): Promise<VerifyCheck> {
  const title = "Proof of Cover at each block height";
  if (proofs.length === 0) return skip("cover", title, "no cover proofs in the bundle yet");
  const failures: string[] = [];
  const committed = new Set(decisions.filter((d) => d.kind === "cover").map((d) => d.inputsDigest));
  let spentLater = 0;
  for (const p of proofs) {
    if (!committed.has(p.hash))
      failures.push(
        `proof ${String(p.hash).slice(0, 12)}…: not committed by any signed cover decision`,
      );
    for (const f of verifyCoverProof(p))
      failures.push(`proof ${p.hash?.slice(0, 12)}… @${p.height}: ${f}`);
    if (recheck) {
      const r = await recheckCoverProof(p, recheck);
      for (const f of r.failures) failures.push(`proof ${p.hash.slice(0, 12)}… live: ${f}`);
      spentLater += r.spentSince.length;
    }
  }
  const out = check(
    "cover",
    title,
    failures,
    `${proofs.length} proof(s) recompute${recheck ? " and match Koios" : ""}`,
  );
  if (out.status === "PASS" && !recheck)
    return {
      ...out,
      status: "WARN",
      detail: `${out.detail}; UTxOs not re-read (use --live-cover)`,
    };
  if (out.status === "PASS" && spentLater > 0) {
    // VERIFY: a UTxO spent after the proof's height is fine; v1 does not yet prove the spend height.
    return {
      ...out,
      detail: `${out.detail}; ${spentLater} UTxO(s) spent since (spend height not checked)`,
    };
  }
  return out;
}

export async function runVerify(opts: VerifyOptions): Promise<VerifyResult> {
  const checks: VerifyCheck[] = [];
  const { manifest, contents: c, integrity } = readBundle(opts.bundleDir);
  checks.push(
    check(
      "bundle",
      "Bundle files match their manifest hashes",
      integrity,
      `${manifest.files.length} files`,
    ),
  );

  const pinned = opts.operatorPubkeys?.length && opts.daemonPubkeys?.length;
  const operators = opts.operatorPubkeys?.length
    ? opts.operatorPubkeys
    : manifest.trust.operatorPubkeys;
  const daemons = opts.daemonPubkeys?.length ? opts.daemonPubkeys : manifest.trust.daemonPubkeys;
  checks.push({
    id: "trust",
    title: "Trusted operator and daemon keys",
    status: daemons.length === 0 ? "FAIL" : pinned ? "PASS" : "WARN",
    detail: pinned
      ? `pinned: ${operators.length} operator, ${daemons.length} daemon`
      : "taken from the bundle's own manifest; pin them with --operator-pubkey/--daemon-pubkey",
    failures: daemons.length === 0 ? ["no daemon public key to verify signatures against"] : [],
  });

  const from = opts.fromSeq ?? 1;
  const to = opts.toSeq ?? Number.MAX_SAFE_INTEGER;
  const slice = c.decisions.filter((d) => d.seq >= from && d.seq <= to);
  const prev = c.decisions.find((d) => d.seq === from - 1);
  const chain = verifyDecisionChain(slice, daemons, {
    ...(from === 1
      ? { startPrev: null, startSeq: 1 }
      : prev
        ? { startPrev: prev.hash, startSeq: from }
        : {}),
  });
  const chainCheck = check(
    "decision-chain",
    "Decision records: hash chain and daemon signatures",
    chain.failures.map((f) => `seq ${f.seq ?? "?"}: ${f.reason}`),
    `${chain.checked} record(s), seq ${slice[0]?.seq ?? "-"}..${slice.at(-1)?.seq ?? "-"}`,
  );
  if (slice.length === 0) chainCheck.status = c.decisions.length > 0 ? "WARN" : "SKIP";
  checks.push(chainCheck);

  const policyFailures: string[] = [];
  for (const sp of c.policies) {
    const r = checkPolicySignature(sp, operators);
    if (!r.passed) policyFailures.push(`policy ${String(sp.hash).slice(0, 12)}…: ${r.detail}`);
  }
  checks.push(
    check(
      "policies",
      "Policy signatures (operator key, ≤ 24 h windows)",
      policyFailures,
      `${c.policies.length} signed policy(ies)`,
    ),
  );

  const reportFailures: string[] = [];
  for (const r of c.criticReports) {
    for (const f of verifyCriticReport(r, daemons))
      reportFailures.push(`report ${String(r.hash).slice(0, 12)}…: ${f}`);
  }
  checks.push(
    check(
      "critic-reports",
      "Critic reports: daemon signatures and verdicts",
      reportFailures,
      `${c.criticReports.length} report(s), ${c.criticReports.filter((r) => r.verdict === "PASS").length} PASS`,
    ),
  );
  checks.push(checkActivations(c, operators, daemons, { from, to }, opts.account));
  checks.push(await checkAnchors(c, opts));
  checks.push(await checkCover(c.coverProofs, c.decisions, opts.coverRecheck ?? null));
  checks.push(
    skip(
      "fills",
      "Public fills (role=maker, trade_id, client_order_id) → decision → policy",
      "TODO M7: needs live fills",
    ),
  );
  checks.push(
    skip(
      "l3-presence",
      "L3 presence and removal of every order",
      "TODO M7: needs live orders on L3",
    ),
  );
  checks.push(
    skip(
      "allocator",
      "Recomputation of the allocator's decisions",
      "TODO M3: needs packages/engine",
    ),
  );
  checks.push(
    skip(
      "book-health",
      "Recomputation of Book Health",
      "run `pnpm ballast book-health` on the recordings",
    ),
  );

  return { ok: checks.every((x) => x.status !== "FAIL"), bundle: opts.bundleDir, checks };
}

export function renderVerifyTable(r: VerifyResult): string {
  const w = Math.max(...r.checks.map((c) => c.title.length));
  const lines = r.checks.map((c) => `${c.status.padEnd(4)}  ${c.title.padEnd(w)}  ${c.detail}`);
  for (const c of r.checks) for (const f of c.failures) lines.push(`      ${c.id}: ${f}`);
  lines.push("", r.ok ? "VERIFY PASS (no check failed)" : "VERIFY FAIL");
  return `${lines.join("\n")}\n`;
}
