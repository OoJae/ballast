import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST, type ManifestEntry, ROOTS, type RootEntry } from "@ballast/evidence";

export const HOUR_MS = 3_600_000;

/**
 * Parses a JSONL file the recorder may be appending to: a partial trailing line is skipped, any
 * other bad line is an error (the ledger must not be silently misread).
 */
function readJsonlTolerant<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const out: T[] = [];
  lines.forEach((line, i) => {
    if (line.length === 0) return;
    try {
      out.push(JSON.parse(line) as T);
    } catch (err) {
      if (i < lines.length - 1) throw err;
    }
  });
  return out;
}

export interface Ledger {
  manifest: ManifestEntry[];
  roots: RootEntry[];
}

export function readLedger(root: string): Ledger {
  return {
    manifest: readJsonlTolerant<ManifestEntry>(join(root, MANIFEST)),
    roots: readJsonlTolerant<RootEntry>(join(root, ROOTS)),
  };
}

export const hourStartMs = (hour: string): number => Date.parse(`${hour}:00:00Z`);

/**
 * The sealed range: from the first rooted hour to the end of the last one. Only rooted hours
 * count, because only their bytes are fixed by a hash chain a third party can recompute.
 */
export function sealedRange(roots: readonly RootEntry[]): { fromMs: number; toMs: number } | null {
  if (roots.length === 0) return null;
  const starts = roots.map((r) => hourStartMs(r.hour));
  return { fromMs: Math.min(...starts), toMs: Math.max(...starts) + HOUR_MS };
}

/** A cheap fingerprint of the ledger: changes whenever an hour is rooted. */
export function ledgerKey(l: Ledger): string {
  return `${l.roots.length}:${l.roots.at(-1)?.chain ?? "none"}`;
}
