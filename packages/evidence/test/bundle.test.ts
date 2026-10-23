import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonKey, DecisionLog } from "@ballast/governance";
import { afterAll, describe, expect, it } from "vitest";
import { exportBundle, readBundle } from "../src/bundle.js";
import { openEvidenceDb } from "../src/db.js";

const dir = mkdtempSync(join(tmpdir(), "ballast-bundle-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const daemon = DaemonKey.fromSeed(createHash("sha256").update("ballast-bundle-test").digest());

function sample(name: string) {
  const db = openEvidenceDb(":memory:");
  const log = new DecisionLog({ key: daemon, sink: db.decisionSink(), now: () => 1_000 });
  for (let i = 0; i < 4; i++)
    log.append({ kind: "cover", inputsDigest: `${i}`.repeat(64), inputsRef: null });
  db.insertGuardTrip({ ruleId: "rate-budget", tsMs: 5, safetyClass: false, detail: "429 x3" });
  const out = join(dir, name);
  const manifest = exportBundle(db, out, {
    network: "mainnet",
    trust: { operatorPubkeys: [], daemonPubkeys: [daemon.publicKeyHex] },
    createdMs: 9,
  });
  return { db, out, manifest };
}

describe("public evidence bundle", () => {
  it("exports canonical JSONL with a hash manifest and reads back identically", () => {
    const { db, out, manifest } = sample("ok");
    expect(manifest.decisions).toEqual({ firstSeq: 1, lastSeq: 4 });
    expect(manifest.files.find((f) => f.part === "decisions")?.records).toBe(4);
    const back = readBundle(out);
    expect(back.integrity).toEqual([]);
    expect(back.contents.decisions).toEqual(db.decisions());
    expect(back.contents.guardTrips).toEqual(db.guardTrips());
  });

  it("flags an edited, truncated or missing file", () => {
    const { out } = sample("tampered");
    const path = join(out, "decisions.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").replace('"cover"', '"kill"'));
    expect(readBundle(out).integrity).toEqual([
      "decisions.jsonl: sha256 does not match the manifest",
    ]);
    const lines = readFileSync(path, "utf8").split("\n");
    writeFileSync(path, `${lines.slice(0, 2).join("\n")}\n`);
    expect(readBundle(out).integrity).toContain("decisions.jsonl: 2 records, manifest says 4");
    unlinkSync(join(out, "anchors.jsonl"));
    expect(readBundle(out).integrity).toContain("anchors.jsonl: missing");
  });
});
