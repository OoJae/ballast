import { createHash, type Hash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalize, sha256Hex } from "@ballast/core";
import { COMPRESSED, type CompressedEntry, CompressedIndex, compressSegment } from "./compress.js";
import { merkleRootHex } from "./merkle.js";

/** One sealed JSONL segment: its bytes are fixed and its sha256 is a Merkle leaf. */
export interface ManifestEntry {
  v: 1;
  /** Path relative to the recordings root, always with "/" separators. */
  segment: string;
  stream: string;
  /** UTC hour the segment belongs to, e.g. "2026-10-23T01". */
  hour: string;
  part: number;
  lines: number;
  bytes: number;
  sha256: string;
  firstRecvMs: number | null;
  lastRecvMs: number | null;
  sealedMs: number;
  /** True when sealed by crash recovery at startup instead of a clean rotation. */
  recovered: boolean;
  /** Bytes of a partial trailing line removed during recovery (0 on clean seals). */
  truncatedBytes: number;
}

/** Hourly Merkle root over every segment of an hour, hash-chained to the previous root. */
export interface RootEntry {
  v: 1;
  hour: string;
  segments: string[];
  leaves: string[];
  root: string;
  prev: string | null;
  chain: string;
  sealedMs: number;
}

export interface SegmentWriterOptions {
  root: string;
  now?: () => number;
  /** Gzip each sealed segment in the background (verified round-trip, crash-safe). */
  compress?: boolean;
  onSeal?: (entry: ManifestEntry) => void;
  onRoot?: (entry: RootEntry) => void;
  onCompressError?: (segment: string, err: unknown) => void;
}

export const MANIFEST = "manifest.jsonl";
export const ROOTS = "roots.jsonl";

const STREAM_RE = /^[a-z0-9-]+$/;
const SEGMENT_RE = /^(\d{4}-\d{2}-\d{2})\/(\d{2})\/([a-z0-9-]+)\.(\d+)\.jsonl$/;
const CHUNK = 1 << 20;

export function hourKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13);
}

export function segmentRelPath(stream: string, hour: string, part: number): string {
  return `${hour.slice(0, 10)}/${hour.slice(11, 13)}/${stream}.${part}.jsonl`;
}

export function chainHash(prev: string | null, hour: string, root: string): string {
  return sha256Hex(canonicalize({ hour, prev, root }));
}

interface OpenSegment {
  stream: string;
  hour: string;
  part: number;
  rel: string;
  fd: number;
  hash: Hash;
  lines: number;
  bytes: number;
  firstRecvMs: number | null;
  lastRecvMs: number | null;
  recovered: boolean;
  truncatedBytes: number;
}

/**
 * Append-only recorder storage. Each (stream, UTC hour) gets its own JSONL segment.
 * - A segment is sealed (fsynced, hashed, added to the manifest) when its hour ends or on close.
 * - Once an hour is over, all its segments are rolled into a Merkle root chained to the
 *   previous root, so changing any recorded byte breaks verification from that hour on.
 * - Sealed segments can be gzipped; the leaf stays the hash of the raw bytes.
 */
export class SegmentWriter {
  private readonly open = new Map<string, OpenSegment>();
  private readonly sealed = new Map<string, ManifestEntry>();
  private readonly rootedHours = new Set<string>();
  private lastChain: string | null = null;
  private lastNow = 0;
  private closed = false;
  private readonly manifestFd: number;
  private readonly rootsFd: number;
  private readonly index: CompressedIndex;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: SegmentWriterOptions) {
    mkdirSync(opts.root, { recursive: true });
    for (const e of readJsonlRepairingTail<ManifestEntry>(join(opts.root, MANIFEST))) {
      this.sealed.set(e.segment, e);
    }
    for (const r of readJsonlRepairingTail<RootEntry>(join(opts.root, ROOTS))) {
      this.rootedHours.add(r.hour);
      this.lastChain = r.chain;
    }
    this.index = new CompressedIndex(
      opts.root,
      readJsonlRepairingTail<CompressedEntry>(join(opts.root, COMPRESSED)),
    );
    this.manifestFd = openSync(join(opts.root, MANIFEST), "a");
    this.rootsFd = openSync(join(opts.root, ROOTS), "a");
    this.recover(hourKey(this.now()));
    this.rootCompletedHours(hourKey(this.now()));
    if (opts.compress) {
      for (const e of this.sealed.values()) {
        if (!this.index.has(e.segment) || existsSync(join(opts.root, e.segment))) {
          this.enqueueCompression(e);
        }
      }
    }
  }

  write(stream: string, kind: string, data: unknown, recvMs: number): void {
    if (this.closed) throw new Error("SegmentWriter is closed");
    if (!STREAM_RE.test(stream)) throw new Error(`invalid stream name: ${stream}`);
    const hour = hourKey(this.now());
    this.rotate(hour);
    const seg = this.segmentFor(stream, hour);
    const buf = Buffer.from(`${JSON.stringify({ r: recvMs, k: kind, d: data })}\n`, "utf8");
    writeSync(seg.fd, buf);
    seg.hash.update(buf);
    seg.lines += 1;
    seg.bytes += buf.length;
    seg.firstRecvMs ??= recvMs;
    seg.lastRecvMs = recvMs;
  }

  /** Seals and roots hours that have ended. Call periodically so quiet streams still seal. */
  tick(): void {
    if (!this.closed) this.rotate(hourKey(this.now()));
  }

  /**
   * Seals every open segment. The current hour is rooted only after it ends, because a restart
   * within the same hour adds further parts. Pending compression continues; await drain().
   */
  close(): void {
    if (this.closed) return;
    for (const seg of [...this.open.values()]) this.seal(seg);
    this.rootCompletedHours(hourKey(this.now()));
    closeSync(this.manifestFd);
    closeSync(this.rootsFd);
    this.closed = true;
    this.queue = this.queue.then(() => this.index.close());
  }

  /** Resolves once every queued compression has finished (or failed and been reported). */
  drain(): Promise<void> {
    return this.queue;
  }

  get openSegments(): number {
    return this.open.size;
  }

  private now(): number {
    const t = Math.max(this.lastNow, (this.opts.now ?? Date.now)());
    this.lastNow = t;
    return t;
  }

  private rotate(hour: string): void {
    let sealedAny = false;
    for (const seg of [...this.open.values()]) {
      if (seg.hour < hour) {
        this.seal(seg);
        sealedAny = true;
      }
    }
    if (sealedAny) this.rootCompletedHours(hour);
  }

  private segmentFor(stream: string, hour: string): OpenSegment {
    const existing = this.open.get(stream);
    if (existing && existing.hour === hour) return existing;
    let part = 0;
    for (const e of this.sealed.values()) {
      if (e.stream === stream && e.hour === hour) part = Math.max(part, e.part + 1);
    }
    const rel = segmentRelPath(stream, hour, part);
    const path = join(this.opts.root, rel);
    mkdirSync(dirname(path), { recursive: true });
    const seg: OpenSegment = {
      stream,
      hour,
      part,
      rel,
      fd: openSync(path, "a"),
      hash: createHash("sha256"),
      lines: 0,
      bytes: 0,
      firstRecvMs: null,
      lastRecvMs: null,
      recovered: false,
      truncatedBytes: 0,
    };
    this.open.set(stream, seg);
    return seg;
  }

  private seal(seg: OpenSegment): void {
    fsyncSync(seg.fd);
    closeSync(seg.fd);
    // Recovery seals old-hour segments that were never in the map; only drop our own entry.
    if (this.open.get(seg.stream) === seg) this.open.delete(seg.stream);
    const entry: ManifestEntry = {
      v: 1,
      segment: seg.rel,
      stream: seg.stream,
      hour: seg.hour,
      part: seg.part,
      lines: seg.lines,
      bytes: seg.bytes,
      sha256: seg.hash.digest("hex"),
      firstRecvMs: seg.firstRecvMs,
      lastRecvMs: seg.lastRecvMs,
      sealedMs: this.now(),
      recovered: seg.recovered,
      truncatedBytes: seg.truncatedBytes,
    };
    writeSync(this.manifestFd, `${canonicalize(entry)}\n`);
    fsyncSync(this.manifestFd);
    this.sealed.set(entry.segment, entry);
    this.opts.onSeal?.(entry);
    if (this.opts.compress) this.enqueueCompression(entry);
  }

  private enqueueCompression(entry: ManifestEntry): void {
    const now = () => this.now();
    this.queue = this.queue
      .then(() => compressSegment(this.opts.root, entry, this.index, now))
      .catch((err: unknown) => this.opts.onCompressError?.(entry.segment, err));
  }

  /** Roots every hour before `currentHour` that is fully sealed and not yet rooted. */
  private rootCompletedHours(currentHour: string): void {
    const openHours = new Set([...this.open.values()].map((s) => s.hour));
    const byHour = new Map<string, ManifestEntry[]>();
    for (const e of this.sealed.values()) {
      if (e.hour >= currentHour || this.rootedHours.has(e.hour) || openHours.has(e.hour)) continue;
      byHour.set(e.hour, [...(byHour.get(e.hour) ?? []), e]);
    }
    for (const hour of [...byHour.keys()].sort()) {
      const entries = (byHour.get(hour) ?? []).sort((a, b) => (a.segment < b.segment ? -1 : 1));
      const leaves = entries.map((e) => e.sha256);
      const root = merkleRootHex(leaves);
      const entry: RootEntry = {
        v: 1,
        hour,
        segments: entries.map((e) => e.segment),
        leaves,
        root,
        prev: this.lastChain,
        chain: chainHash(this.lastChain, hour, root),
        sealedMs: this.now(),
      };
      writeSync(this.rootsFd, `${canonicalize(entry)}\n`);
      fsyncSync(this.rootsFd);
      this.rootedHours.add(hour);
      this.lastChain = entry.chain;
      this.opts.onRoot?.(entry);
    }
  }

  /**
   * Startup crash recovery. A segment file with no manifest entry was left open by a crash.
   * A partial trailing line is truncated, then the file is either sealed (past hours) or
   * reopened for append with its existing bytes already hashed (current hour).
   */
  private recover(currentHour: string): void {
    for (const rel of listSegments(this.opts.root)) {
      if (this.sealed.has(rel)) continue;
      const m = SEGMENT_RE.exec(rel);
      if (!m) continue;
      const [, day, hh, stream, partStr] = m;
      if (!day || !hh || !stream || !partStr) continue;
      const hour = `${day}T${hh}`;
      const path = join(this.opts.root, rel);
      const scan = scanAndRepair(path);
      const seg: OpenSegment = {
        stream,
        hour,
        part: Number(partStr),
        rel,
        fd: openSync(path, "a"),
        hash: scan.hash,
        lines: scan.lines,
        bytes: scan.bytes,
        firstRecvMs: scan.firstRecvMs,
        lastRecvMs: scan.lastRecvMs,
        recovered: true,
        truncatedBytes: scan.truncatedBytes,
      };
      const clash = this.open.get(stream);
      if (hour !== currentHour || (clash && clash.part > seg.part)) {
        this.seal(seg);
        continue;
      }
      if (clash) this.seal(clash);
      this.open.set(stream, seg);
    }
  }
}

function listSegments(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const day of readdirSync(root).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    for (const hh of readdirSync(join(root, day)).sort()) {
      if (!/^\d{2}$/.test(hh)) continue;
      for (const f of readdirSync(join(root, day, hh)).sort()) {
        if (f.endsWith(".jsonl")) out.push(`${day}/${hh}/${f}`);
      }
    }
  }
  return out;
}

/**
 * Hashes a crashed segment in 1 MiB chunks (it may be hundreds of MB) after truncating any
 * partial trailing line, and pulls the first and last receive times from the boundary lines.
 */
function scanAndRepair(path: string): {
  hash: Hash;
  lines: number;
  bytes: number;
  truncatedBytes: number;
  firstRecvMs: number | null;
  lastRecvMs: number | null;
} {
  const fd = openSync(path, "r+");
  try {
    const size = fstatSync(fd).size;
    const keep = lastNewlineEnd(fd, size);
    if (keep < size) {
      ftruncateSync(fd, keep);
      fsyncSync(fd);
    }
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(CHUNK);
    let lines = 0;
    let firstLine: string | null = null;
    let head = "";
    for (let pos = 0; pos < keep; ) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, keep - pos), pos);
      const chunk = buf.subarray(0, n);
      hash.update(chunk);
      for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, i + 1)) lines += 1;
      if (firstLine === null) {
        head += chunk.toString("utf8");
        const nl = head.indexOf("\n");
        if (nl !== -1) firstLine = head.slice(0, nl);
      }
      pos += n;
    }
    return {
      hash,
      lines,
      bytes: keep,
      truncatedBytes: size - keep,
      firstRecvMs: recvOf(firstLine),
      lastRecvMs: recvOf(lastLine(fd, keep)),
    };
  } finally {
    closeSync(fd);
  }
}

/** Offset just past the last "\n" in the file (0 if there is none), scanning backwards. */
function lastNewlineEnd(fd: number, size: number): number {
  const buf = Buffer.allocUnsafe(64 * 1024);
  for (let end = size; end > 0; ) {
    const start = Math.max(0, end - buf.length);
    const n = readSync(fd, buf, 0, end - start, start);
    const i = buf.subarray(0, n).lastIndexOf(0x0a);
    if (i !== -1) return start + i + 1;
    end = start;
  }
  return 0;
}

function lastLine(fd: number, keep: number): string | null {
  if (keep === 0) return null;
  const prevEnd = lastNewlineEnd(fd, keep - 1);
  const buf = Buffer.allocUnsafe(keep - 1 - prevEnd);
  readSync(fd, buf, 0, buf.length, prevEnd);
  return buf.toString("utf8");
}

function recvOf(line: string | null): number | null {
  if (!line) return null;
  try {
    const r = (JSON.parse(line) as { r?: unknown }).r;
    return typeof r === "number" ? r : null;
  } catch {
    return null;
  }
}

/** Reads a JSONL index file, truncating a partial trailing line left by a crash mid-append. */
export function readJsonlRepairingTail<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path);
  const keep = content.lastIndexOf(0x0a) + 1;
  if (keep < content.length) {
    const fd = openSync(path, "r+");
    ftruncateSync(fd, keep);
    fsyncSync(fd);
    closeSync(fd);
  }
  return content
    .subarray(0, keep)
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T);
}
