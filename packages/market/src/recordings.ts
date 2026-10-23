import { existsSync, readdirSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

/** One recorded line, `{"r":recvMs,"k":kind,"d":payload}`, tagged with its stream. */
export interface RecordLine {
  r: number;
  k: string;
  d: unknown;
  stream: string;
}

export interface SegmentFile {
  /** UTC hour, e.g. "2026-10-23T01". */
  hour: string;
  hourStartMs: number;
  stream: string;
  part: number;
  path: string;
  gz: boolean;
}

export interface RecordingFilter {
  streams?: readonly string[];
  /** Receive-time window [fromMs, toMs). */
  fromMs?: number;
  toMs?: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_RE = /^\d{2}$/;
const FILE_RE = /^([a-z0-9-]+)\.(\d+)\.jsonl(\.gz)?$/;
const HOUR_MS = 3_600_000;

/**
 * Segment files under a recordings root (`<day>/<HH>/<stream>.<part>.jsonl[.gz]`), ordered by
 * stream, hour and part. A sealed segment may briefly exist both raw and gzipped while it is
 * compressed; both hold the same bytes, so the raw file is used. `.tmp` files are ignored.
 */
export function listSegmentFiles(root: string, filter: RecordingFilter = {}): SegmentFile[] {
  if (!existsSync(root)) return [];
  const wanted = filter.streams ? new Set(filter.streams) : null;
  const byKey = new Map<string, SegmentFile>();
  for (const day of readdirSync(root).filter((d) => DAY_RE.test(d))) {
    for (const hh of readdirSync(join(root, day)).filter((h) => HOUR_RE.test(h))) {
      const hour = `${day}T${hh}`;
      const hourStartMs = Date.parse(`${hour}:00:00Z`);
      if (filter.toMs !== undefined && hourStartMs >= filter.toMs) continue;
      if (filter.fromMs !== undefined && hourStartMs + HOUR_MS <= filter.fromMs) continue;
      for (const name of readdirSync(join(root, day, hh))) {
        const m = FILE_RE.exec(name);
        if (!m) continue;
        const [, stream = "", part = "0", gzSuffix] = m;
        if (wanted && !wanted.has(stream)) continue;
        const key = `${stream}/${hour}/${part}`;
        const gz = gzSuffix !== undefined;
        if (byKey.has(key) && gz) continue;
        byKey.set(key, {
          hour,
          hourStartMs,
          stream,
          part: Number(part),
          path: join(root, day, hh, name),
          gz,
        });
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.stream.localeCompare(b.stream) || a.hourStartMs - b.hourStartMs || a.part - b.part,
  );
}

export interface ReadStats {
  lines: number;
  /** Unparsable lines, e.g. the partial last line of a segment still being written. */
  badLines: number;
}

/**
 * Opens a listed segment. The recorder seals one by renaming its `.gz` into place and only then
 * deleting the raw file (evidence/compress.ts), so a raw path listed earlier can vanish before it
 * is opened; its `.gz` is complete by then and holds the same records.
 */
async function openSegment(f: SegmentFile): Promise<{ handle: FileHandle; gz: boolean }> {
  try {
    return { handle: await open(f.path, "r"), gz: f.gz };
  } catch (e) {
    if (f.gz || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return { handle: await open(`${f.path}.gz`, "r"), gz: true };
  }
}

/** Streams one segment's records. */
export async function* readSegmentFile(
  f: SegmentFile,
  stats: ReadStats = { lines: 0, badLines: 0 },
): AsyncGenerator<RecordLine> {
  const { handle, gz } = await openSegment(f);
  const source = handle.createReadStream();
  const input = gz ? source.pipe(createGunzip()) : source;
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      let rec: { r?: unknown; k?: unknown; d?: unknown };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        stats.badLines += 1;
        continue;
      }
      if (typeof rec.r !== "number" || typeof rec.k !== "string") {
        stats.badLines += 1;
        continue;
      }
      stats.lines += 1;
      yield { r: rec.r, k: rec.k, d: rec.d, stream: f.stream };
    }
  } finally {
    rl.close();
    source.destroy();
    await handle.close().catch(() => {});
  }
}

async function* chain(files: readonly SegmentFile[], stats: ReadStats): AsyncGenerator<RecordLine> {
  for (const f of files) yield* readSegmentFile(f, stats);
}

/**
 * Every record in the window, all streams merged in receive-time order. Each stream keeps its own
 * order (its parts are concatenated); across streams the record with the smallest `r` goes first,
 * ties broken by stream name.
 */
export async function* readRecordings(
  root: string,
  filter: RecordingFilter = {},
  stats: ReadStats = { lines: 0, badLines: 0 },
): AsyncGenerator<RecordLine> {
  const files = listSegmentFiles(root, filter);
  const streams = [...new Set(files.map((f) => f.stream))].sort();
  const iters = streams.map((s) =>
    chain(
      files.filter((f) => f.stream === s),
      stats,
    ),
  );
  const heads: (RecordLine | null)[] = [];
  for (const it of iters) heads.push((await it.next()).value ?? null);
  const from = filter.fromMs ?? Number.NEGATIVE_INFINITY;
  const to = filter.toMs ?? Number.POSITIVE_INFINITY;
  try {
    for (;;) {
      let best = -1;
      for (let i = 0; i < heads.length; i++) {
        const h = heads[i];
        if (h && (best < 0 || h.r < (heads[best] as RecordLine).r)) best = i;
      }
      if (best < 0) return;
      const rec = heads[best] as RecordLine;
      heads[best] = (await (iters[best] as AsyncGenerator<RecordLine>).next()).value ?? null;
      if (rec.r >= from && rec.r < to) yield rec;
    }
  } finally {
    for (const it of iters) await it.return(undefined);
  }
}

/**
 * Latest hour start ≤ `atMs` from which an L3 replay can bootstrap every symbol: the hour's l3
 * segments hold a snapshot of each symbol received at or before `atMs`. Null if none does.
 */
export async function findL3Bootstrap(
  root: string,
  atMs: number,
  symbols: readonly string[],
): Promise<number | null> {
  const files = listSegmentFiles(root, { streams: ["l3"], toMs: atMs + 1 });
  const hours = [...new Set(files.map((f) => f.hourStartMs))].sort((a, b) => b - a);
  for (const h of hours) {
    const seen = new Set<string>();
    for (const f of files.filter((x) => x.hourStartMs === h)) {
      for await (const rec of readSegmentFile(f)) {
        if (rec.r > atMs) break;
        if (rec.k !== "snapshot") continue;
        const sym = (rec.d as { symbol?: unknown }).symbol;
        if (typeof sym === "string") seen.add(sym);
      }
    }
    if (symbols.every((s) => seen.has(s))) return h;
  }
  return null;
}
