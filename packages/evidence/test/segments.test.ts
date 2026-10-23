import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { sha256Hex } from "@ballast/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPRESSED,
  type CompressedEntry,
  MANIFEST,
  type ManifestEntry,
  ROOTS,
  type RootEntry,
  SegmentWriter,
  verifyRecordings,
} from "../src/index.js";

const H0 = Date.parse("2026-10-23T01:10:00Z");
const H1 = Date.parse("2026-10-23T02:00:05Z");
const H2 = Date.parse("2026-10-23T03:00:05Z");
const SEG = "2026-10-23/01/l3.0.jsonl";

let root: string;
let clock: number;
const now = () => clock;

const readJsonl = <T>(file: string): T[] =>
  existsSync(join(root, file))
    ? readFileSync(join(root, file), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ballast-seg-"));
  clock = H0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("SegmentWriter", () => {
  it("writes one segment per stream and hour, seals on rotation, and roots the hour", async () => {
    const w = new SegmentWriter({ root, now });
    w.write("l3", "update", { seq: 1 }, H0);
    w.write("price", "trade", { p: "0.0386" }, H0 + 1);
    w.write("l3", "update", { seq: 2 }, H0 + 2);
    clock = H1;
    w.write("l3", "update", { seq: 3 }, H1);
    w.close();

    const manifest = readJsonl<ManifestEntry>(MANIFEST);
    const hour0 = manifest.filter((e) => e.hour === "2026-10-23T01");
    expect(hour0.map((e) => e.segment).sort()).toEqual([SEG, "2026-10-23/01/price.0.jsonl"]);
    const l3 = hour0.find((e) => e.stream === "l3");
    expect(l3?.lines).toBe(2);
    expect(l3?.sha256).toBe(sha256Hex(readFileSync(join(root, SEG))));

    // The ended hour is rooted; the current hour (02) is sealed by close() but not rooted yet.
    const roots = readJsonl<RootEntry>(ROOTS);
    expect(roots.map((r) => r.hour)).toEqual(["2026-10-23T01"]);
    expect(roots[0]?.prev).toBeNull();
    expect((await verifyRecordings(root)).ok).toBe(true);
  });

  it("chains roots and roots a closed hour once it has ended", async () => {
    let w = new SegmentWriter({ root, now });
    w.write("l3", "update", { seq: 1 }, H0);
    clock = H1;
    w.write("l3", "update", { seq: 2 }, H1);
    w.close();

    clock = H2;
    w = new SegmentWriter({ root, now });
    w.close();
    const roots = readJsonl<RootEntry>(ROOTS);
    expect(roots.map((r) => r.hour)).toEqual(["2026-10-23T01", "2026-10-23T02"]);
    expect(roots[1]?.prev).toBe(roots[0]?.chain);
    expect((await verifyRecordings(root)).ok).toBe(true);
  });

  it("adds a new part when restarted within the same hour", () => {
    let w = new SegmentWriter({ root, now });
    w.write("l3", "update", { seq: 1 }, H0);
    w.close();
    w = new SegmentWriter({ root, now });
    w.write("l3", "update", { seq: 2 }, H0 + 5);
    w.close();
    const segs = readJsonl<ManifestEntry>(MANIFEST).map((e) => e.segment);
    expect(segs).toEqual([SEG, "2026-10-23/01/l3.1.jsonl"]);
  });

  it("recovers a crashed segment, truncating a partial trailing line", async () => {
    const w = new SegmentWriter({ root, now });
    w.write("l3", "update", { seq: 1 }, H0);
    w.write("l3", "update", { seq: 2 }, H0 + 1);
    // Simulate a crash: no close(), plus a half-written line on disk.
    appendFileSync(join(root, SEG), '{"r":1,"k":"upd');

    clock = H1;
    const w2 = new SegmentWriter({ root, now });
    w2.close();
    const entry = readJsonl<ManifestEntry>(MANIFEST).find((e) => e.segment === SEG);
    expect(entry?.recovered).toBe(true);
    expect(entry?.lines).toBe(2);
    expect(entry?.firstRecvMs).toBe(H0);
    expect(entry?.lastRecvMs).toBe(H0 + 1);
    expect(entry?.truncatedBytes).toBe('{"r":1,"k":"upd'.length);
    expect((await verifyRecordings(root)).ok).toBe(true);
  });

  it("recovers a crashed multi-megabyte segment chunk by chunk", async () => {
    const w = new SegmentWriter({ root, now });
    const pad = "x".repeat(150);
    for (let i = 0; i < 20_000; i++) w.write("l3", "update", { seq: i, pad }, H0 + i);
    clock = H1;
    const w2 = new SegmentWriter({ root, now });
    w2.close();
    const entry = readJsonl<ManifestEntry>(MANIFEST).find((e) => e.segment === SEG);
    expect(entry?.lines).toBe(20_000);
    expect(entry?.bytes).toBeGreaterThan(3_000_000);
    expect(entry?.sha256).toBe(sha256Hex(readFileSync(join(root, SEG))));
    expect(entry?.lastRecvMs).toBe(H0 + 19_999);
    expect((await verifyRecordings(root)).ok).toBe(true);
  });

  it("detects tampering with any recorded byte", async () => {
    const w = new SegmentWriter({ root, now });
    w.write("l3", "update", { seq: 1, price: "0.038595" }, H0);
    clock = H1;
    w.tick();
    w.close();
    const path = join(root, SEG);
    writeFileSync(path, readFileSync(path, "utf8").replace("0.038595", "0.038596"));
    const report = await verifyRecordings(root);
    expect(report.ok).toBe(false);
    expect(report.segments.failed[0]?.reason).toBe("sha256 mismatch");
  });

  it("rejects stream names that would escape the directory layout", () => {
    const w = new SegmentWriter({ root, now });
    expect(() => w.write("../x", "k", {}, H0)).toThrow(/invalid stream/);
    w.close();
  });
});

describe("SegmentWriter compression", () => {
  const sealOneHour = (compress: boolean) => {
    const w = new SegmentWriter({ root, now, compress });
    w.write("l3", "update", { seq: 1, price: "0.038595" }, H0);
    w.write("l3", "update", { seq: 2, price: "0.038600" }, H0 + 1);
    clock = H1;
    w.tick();
    w.close();
    return w;
  };

  it("replaces a sealed segment with verified gzip and still verifies against the raw hash", async () => {
    await sealOneHour(true).drain();
    expect(existsSync(join(root, SEG))).toBe(false);
    expect(existsSync(join(root, `${SEG}.gz`))).toBe(true);
    const [c] = readJsonl<CompressedEntry>(COMPRESSED);
    expect(c?.segment).toBe(SEG);
    const report = await verifyRecordings(root);
    expect(report).toMatchObject({ ok: true, segments: { checked: 1, compressed: 1 } });
  });

  it("detects a tampered compressed segment", async () => {
    await sealOneHour(true).drain();
    const forged = '{"r":0,"k":"update","d":{"seq":1,"price":"9.99"}}\n';
    writeFileSync(join(root, `${SEG}.gz`), gzipSync(forged));
    const reasons = (await verifyRecordings(root)).segments.failed.map((f) => f.reason);
    expect(reasons).toContain("gz sha256 mismatch");
    expect(reasons).toContain("sha256 mismatch");
  });

  it("resumes a compression that was interrupted mid-write", async () => {
    sealOneHour(false);
    writeFileSync(join(root, `${SEG}.gz.tmp`), "partial garbage");
    const w = new SegmentWriter({ root, now, compress: true });
    w.close();
    await w.drain();
    expect(existsSync(join(root, SEG))).toBe(false);
    expect(existsSync(join(root, `${SEG}.gz.tmp`))).toBe(false);
    expect((await verifyRecordings(root)).ok).toBe(true);
  });

  it("finishes a compression interrupted after the atomic rename", async () => {
    sealOneHour(false);
    writeFileSync(join(root, `${SEG}.gz`), gzipSync(readFileSync(join(root, SEG))));
    const w = new SegmentWriter({ root, now, compress: true });
    w.close();
    await w.drain();
    expect(existsSync(join(root, SEG))).toBe(false);
    expect(readJsonl<CompressedEntry>(COMPRESSED).map((c) => c.segment)).toEqual([SEG]);
    expect((await verifyRecordings(root)).ok).toBe(true);
  });

  it("refuses to delete the raw segment when the gzip does not round-trip", async () => {
    sealOneHour(false);
    writeFileSync(join(root, `${SEG}.gz`), gzipSync("not the same content\n"));
    const errors: string[] = [];
    const w = new SegmentWriter({
      root,
      now,
      compress: true,
      onCompressError: (s) => errors.push(s),
    });
    w.close();
    await w.drain();
    expect(errors).toEqual([SEG]);
    expect(existsSync(join(root, SEG))).toBe(true);
  });
});
