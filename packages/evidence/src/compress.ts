import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { canonicalize } from "@ballast/core";
import type { ManifestEntry } from "./segments.js";

export const COMPRESSED = "compressed.jsonl";

/** A sealed segment stored as gzip. The Merkle leaf is still the sha256 of the raw bytes. */
export interface CompressedEntry {
  v: 1;
  segment: string;
  gz: string;
  gzBytes: number;
  gzSha256: string;
  compressedMs: number;
}

export interface Digest {
  sha256: string;
  bytes: number;
  lines: number;
}

/** Streams a file (optionally through gunzip) into sha256, counting bytes and newlines. */
export async function digestFile(path: string, gunzip: boolean): Promise<Digest> {
  const hash = createHash("sha256");
  let bytes = 0;
  let lines = 0;
  const source = createReadStream(path);
  const stream: AsyncIterable<Buffer> = gunzip ? source.pipe(createGunzip()) : source;
  for await (const chunk of stream) {
    hash.update(chunk);
    bytes += chunk.length;
    for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, i + 1)) lines += 1;
  }
  return { sha256: hash.digest("hex"), bytes, lines };
}

/** Append-only index of compressed segments, tolerant of a partial trailing line. */
export class CompressedIndex {
  private readonly entries = new Map<string, CompressedEntry>();
  private readonly fd: number;

  constructor(root: string, existing: CompressedEntry[]) {
    for (const e of existing) this.entries.set(e.segment, e);
    this.fd = openSync(join(root, COMPRESSED), "a");
  }

  has(segment: string): boolean {
    return this.entries.has(segment);
  }

  get(segment: string): CompressedEntry | undefined {
    return this.entries.get(segment);
  }

  add(entry: CompressedEntry): void {
    writeSync(this.fd, `${canonicalize(entry)}\n`);
    fsyncSync(this.fd);
    this.entries.set(entry.segment, entry);
  }

  close(): void {
    closeSync(this.fd);
  }
}

/**
 * Compresses one sealed segment without trusting the output. Every step is crash-safe:
 * 1. gzip to `<segment>.gz.tmp`;
 * 2. decompress it again and require the manifest's raw sha256, bytes and line count;
 * 3. atomically rename to `<segment>.gz`;
 * 4. index it;
 * 5. only then delete the raw file.
 * An interrupted run is resumed by calling this again for the same entry.
 */
export async function compressSegment(
  root: string,
  entry: ManifestEntry,
  index: CompressedIndex,
  now: () => number = Date.now,
): Promise<void> {
  const raw = join(root, entry.segment);
  const gzRel = `${entry.segment}.gz`;
  const gz = join(root, gzRel);
  const tmp = `${gz}.tmp`;
  rmSync(tmp, { force: true });

  if (!existsSync(gz)) {
    if (!existsSync(raw)) throw new Error(`compress: ${entry.segment} has neither raw nor gz file`);
    await pipeline(createReadStream(raw), createGzip({ level: 6 }), createWriteStream(tmp));
    await requireRawContent(tmp, entry);
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, gz);
  } else {
    await requireRawContent(gz, entry);
  }

  if (!index.has(entry.segment)) {
    const { sha256 } = await digestFile(gz, false);
    index.add({
      v: 1,
      segment: entry.segment,
      gz: gzRel,
      gzBytes: statSync(gz).size,
      gzSha256: sha256,
      compressedMs: now(),
    });
  }
  rmSync(raw, { force: true });
}

async function requireRawContent(gzPath: string, entry: ManifestEntry): Promise<void> {
  const d = await digestFile(gzPath, true);
  if (d.sha256 !== entry.sha256 || d.bytes !== entry.bytes || d.lines !== entry.lines) {
    throw new Error(`compress: ${entry.segment} gzip round-trip does not match the manifest`);
  }
}
