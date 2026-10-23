import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPRESSED,
  chainHash,
  digestFile,
  MANIFEST,
  merkleRootHex,
  ROOTS,
} from "@ballast/evidence";

const FIXTURE = fileURLToPath(
  new URL("../../../packages/market/test/fixtures/rec/2026-10-23/00", import.meta.url),
);
export const FIXTURE_HOUR = "2026-10-23T00";
export const FIXTURE_HOUR_MS = Date.parse("2026-10-23T00:00:00Z");
/** The fixture's recorded minute: NIGHT-USD and ADA-USD, from 00:54:45 UTC. */
export const FIXTURE_FROM_MS = 1_792_716_885_000;

/**
 * The market package's 60 s recording, sealed the way the recorder seals an hour: gz segments,
 * a manifest with raw-byte sha256s, a compression index, and a rooted, chained hour.
 */
export async function sealedFixtureRoot(temps: string[]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "ballast-api-"));
  temps.push(root);
  const dir = join(root, "2026-10-23", "00");
  mkdirSync(dir, { recursive: true });
  const manifest: string[] = [];
  const compressed: string[] = [];
  const entries: { segment: string; sha256: string }[] = [];
  for (const name of readdirSync(FIXTURE).sort()) {
    copyFileSync(join(FIXTURE, name), join(dir, name));
    const segment = `2026-10-23/00/${name.replace(/\.gz$/, "")}`;
    const raw = await digestFile(join(dir, name), true);
    const gz = await digestFile(join(dir, name), false);
    const [stream = "", part = "0"] = name.split(".");
    manifest.push(
      JSON.stringify({
        v: 1,
        segment,
        stream,
        hour: FIXTURE_HOUR,
        part: Number(part),
        lines: raw.lines,
        bytes: raw.bytes,
        sha256: raw.sha256,
        firstRecvMs: null,
        lastRecvMs: null,
        sealedMs: FIXTURE_HOUR_MS + 3_600_000,
        recovered: false,
        truncatedBytes: 0,
      }),
    );
    compressed.push(
      JSON.stringify({
        v: 1,
        segment,
        gz: `${segment}.gz`,
        gzBytes: gz.bytes,
        gzSha256: gz.sha256,
        compressedMs: FIXTURE_HOUR_MS + 3_600_000,
      }),
    );
    entries.push({ segment, sha256: raw.sha256 });
  }
  entries.sort((a, b) => (a.segment < b.segment ? -1 : 1));
  const leaves = entries.map((e) => e.sha256);
  const merkle = merkleRootHex(leaves);
  const rootEntry = {
    v: 1,
    hour: FIXTURE_HOUR,
    segments: entries.map((e) => e.segment),
    leaves,
    root: merkle,
    prev: null,
    chain: chainHash(null, FIXTURE_HOUR, merkle),
    sealedMs: FIXTURE_HOUR_MS + 3_600_000,
  };
  writeFileSync(join(root, MANIFEST), `${manifest.join("\n")}\n`);
  writeFileSync(join(root, COMPRESSED), `${compressed.join("\n")}\n`);
  writeFileSync(join(root, ROOTS), `${JSON.stringify(rootEntry)}\n`);
  return root;
}

export function cleanup(temps: string[]): void {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
}
