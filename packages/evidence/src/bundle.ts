import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "@ballast/core";
import type { CoverProof } from "@ballast/cover";
import type {
  CriticReport,
  DecisionRecord,
  SignedPolicy,
  SignedPolicyRenewal,
  SignedRenewalEnvelope,
} from "@ballast/governance";
import type { AnchorRecord, EvidenceDb, GuardTripRow } from "./db.js";

/**
 * The public evidence bundle: everything `ballast verify` needs, as canonical JSONL files plus a
 * manifest of their hashes. It carries only Ballast's own records (policies, reports, decisions,
 * anchors, cover proofs, Guard trips): no keys, no house internals, nothing from other makers.
 */
export const BUNDLE_FILES = {
  policies: "policies.jsonl",
  criticReports: "critic-reports.jsonl",
  renewalEnvelopes: "renewal-envelopes.jsonl",
  renewals: "renewals.jsonl",
  decisions: "decisions.jsonl",
  anchors: "anchors.jsonl",
  coverProofs: "cover-proofs.jsonl",
  guardTrips: "guard-trips.jsonl",
} as const;
export type BundlePart = keyof typeof BUNDLE_FILES;
export const BUNDLE_MANIFEST = "manifest.json";

export interface BundleContents {
  policies: SignedPolicy[];
  criticReports: CriticReport[];
  renewalEnvelopes: SignedRenewalEnvelope[];
  renewals: SignedPolicyRenewal[];
  decisions: DecisionRecord[];
  anchors: AnchorRecord[];
  coverProofs: CoverProof[];
  guardTrips: GuardTripRow[];
}

export interface BundleManifest {
  v: 1;
  createdMs: number;
  network: "mainnet" | "preprod";
  /** Public keys the publisher asserts. Verifiers should pin them out of band. */
  trust: { operatorPubkeys: string[]; daemonPubkeys: string[] };
  decisions: { firstSeq: number; lastSeq: number } | null;
  files: { part: BundlePart; name: string; sha256: string; records: number }[];
}

export function bundleFromDb(db: EvidenceDb): BundleContents {
  return {
    policies: db.policies().map((p) => p.signed),
    criticReports: db.criticReports(),
    renewalEnvelopes: db.renewalEnvelopes(),
    renewals: db.renewals(),
    decisions: db.decisions(),
    anchors: db.anchors(),
    coverProofs: db.coverProofs(),
    guardTrips: db.guardTrips(),
  };
}

export function writeBundle(
  dir: string,
  contents: BundleContents,
  meta: Pick<BundleManifest, "network" | "trust" | "createdMs">,
): BundleManifest {
  mkdirSync(dir, { recursive: true });
  const files: BundleManifest["files"] = [];
  for (const part of Object.keys(BUNDLE_FILES) as BundlePart[]) {
    const rows = contents[part] as unknown[];
    const text = rows.map((r) => `${canonicalize(r)}\n`).join("");
    const name = BUNDLE_FILES[part];
    writeFileSync(join(dir, name), text);
    files.push({ part, name, sha256: sha256Hex(text), records: rows.length });
  }
  const first = contents.decisions[0];
  const last = contents.decisions.at(-1);
  const manifest: BundleManifest = {
    v: 1,
    createdMs: meta.createdMs,
    network: meta.network,
    trust: meta.trust,
    decisions: first && last ? { firstSeq: first.seq, lastSeq: last.seq } : null,
    files,
  };
  writeFileSync(join(dir, BUNDLE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function exportBundle(
  db: EvidenceDb,
  dir: string,
  meta: Pick<BundleManifest, "network" | "trust" | "createdMs">,
): BundleManifest {
  return writeBundle(dir, bundleFromDb(db), meta);
}

export interface ReadBundle {
  manifest: BundleManifest;
  contents: BundleContents;
  /** File-level problems: a missing file, a hash or record-count mismatch, an unparsable line. */
  integrity: string[];
}

/** Reads a bundle back, checking every file against the manifest before trusting its records. */
export function readBundle(dir: string): ReadBundle {
  const manifest = JSON.parse(readFileSync(join(dir, BUNDLE_MANIFEST), "utf8")) as BundleManifest;
  const integrity: string[] = [];
  const contents = {} as Record<BundlePart, unknown[]>;
  for (const part of Object.keys(BUNDLE_FILES) as BundlePart[]) {
    const entry = manifest.files.find((f) => f.part === part);
    const name = BUNDLE_FILES[part];
    contents[part] = [];
    if (!entry) {
      integrity.push(`${name}: not listed in the manifest`);
      continue;
    }
    const path = join(dir, name);
    if (!existsSync(path)) {
      integrity.push(`${name}: missing`);
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (sha256Hex(text) !== entry.sha256)
      integrity.push(`${name}: sha256 does not match the manifest`);
    const lines = text.split("\n").filter((l) => l.length > 0);
    if (lines.length !== entry.records)
      integrity.push(`${name}: ${lines.length} records, manifest says ${entry.records}`);
    lines.forEach((l, i) => {
      try {
        contents[part].push(JSON.parse(l));
      } catch {
        integrity.push(`${name}:${i + 1}: not JSON`);
      }
    });
  }
  return { manifest, contents: contents as unknown as BundleContents, integrity };
}
