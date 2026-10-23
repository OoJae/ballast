import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPRESSED, type CompressedEntry, digestFile } from "./compress.js";
import { merkleRootHex } from "./merkle.js";
import { chainHash, MANIFEST, type ManifestEntry, ROOTS, type RootEntry } from "./segments.js";

export interface VerifyReport {
  ok: boolean;
  segments: { checked: number; compressed: number; failed: { segment: string; reason: string }[] };
  roots: { checked: number; failed: { hour: string; reason: string }[] };
  /** Segment files with no manifest entry yet: normally the current hour's open segments. */
  unsealed: string[];
}

/**
 * Independent re-check of a recordings directory, sharing no state with the writer:
 * - re-hashes every sealed segment (through gunzip for compressed ones);
 * - recomputes every hourly Merkle root from the manifest;
 * - walks the root hash chain from the first hour.
 */
export async function verifyRecordings(root: string): Promise<VerifyReport> {
  const manifest = readJsonl<ManifestEntry>(join(root, MANIFEST));
  const roots = readJsonl<RootEntry>(join(root, ROOTS));
  const compressed = new Map(
    readJsonl<CompressedEntry>(join(root, COMPRESSED)).map((c) => [c.segment, c]),
  );
  const report: VerifyReport = {
    ok: true,
    segments: { checked: 0, compressed: 0, failed: [] },
    roots: { checked: 0, failed: [] },
    unsealed: [],
  };
  const segFail = (segment: string, reason: string) => {
    report.ok = false;
    report.segments.failed.push({ segment, reason });
  };
  const rootFail = (hour: string, reason: string) => {
    report.ok = false;
    report.roots.failed.push({ hour, reason });
  };

  const seen = new Set<string>();
  for (const e of manifest) {
    report.segments.checked += 1;
    if (seen.has(e.segment)) segFail(e.segment, "duplicate manifest entry");
    seen.add(e.segment);
    const raw = join(root, e.segment);
    const gz = join(root, `${e.segment}.gz`);
    let digest: { sha256: string; bytes: number; lines: number };
    if (existsSync(raw)) {
      digest = await digestFile(raw, false);
    } else if (existsSync(gz)) {
      report.segments.compressed += 1;
      const c = compressed.get(e.segment);
      if (!c) segFail(e.segment, "gz file not in compression index");
      else if ((await digestFile(gz, false)).sha256 !== c.gzSha256) {
        segFail(e.segment, "gz sha256 mismatch");
      }
      try {
        digest = await digestFile(gz, true);
      } catch (err) {
        segFail(e.segment, `gunzip failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    } else {
      segFail(e.segment, "file missing");
      continue;
    }
    if (digest.bytes !== e.bytes)
      segFail(e.segment, `bytes ${digest.bytes} != manifest ${e.bytes}`);
    if (digest.sha256 !== e.sha256) segFail(e.segment, "sha256 mismatch");
    if (digest.lines !== e.lines)
      segFail(e.segment, `lines ${digest.lines} != manifest ${e.lines}`);
  }

  let prev: string | null = null;
  for (const r of roots) {
    report.roots.checked += 1;
    const entries = manifest
      .filter((e) => e.hour === r.hour)
      .sort((a, b) => (a.segment < b.segment ? -1 : 1));
    const segments = entries.map((e) => e.segment);
    if (JSON.stringify(segments) !== JSON.stringify(r.segments)) {
      rootFail(r.hour, "segment set differs from manifest");
    }
    if (merkleRootHex(entries.map((e) => e.sha256)) !== r.root) rootFail(r.hour, "root mismatch");
    if (r.prev !== prev) rootFail(r.hour, "chain break: prev does not match previous root");
    if (chainHash(r.prev, r.hour, r.root) !== r.chain) rootFail(r.hour, "chain hash mismatch");
    prev = r.chain;
  }

  for (const rel of listJsonl(root)) if (!seen.has(rel)) report.unsealed.push(rel);
  return report;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T);
}

function listJsonl(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const day of readdirSync(root)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    for (const hh of readdirSync(join(root, day))) {
      for (const f of readdirSync(join(root, day, hh))) {
        if (f.endsWith(".jsonl")) out.push(`${day}/${hh}/${f}`);
      }
    }
  }
  return out.sort();
}
