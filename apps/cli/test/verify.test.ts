import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BundleContents, writeBundle } from "@ballast/evidence/bundle";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderVerifyTable, runVerify, type VerifyOptions } from "../src/verify.js";
import { parseVerifyArgs, verifyMain } from "../src/verify-cli.js";
import { ANCHOR_TX, buildContents, DAY, fakeKoios, HOUR, T0, TRUST } from "./fixture.js";

const dir = mkdtempSync(join(tmpdir(), "ballast-verify-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let base: BundleContents;
let metadata: Map<string, Record<string, unknown> | null>;
beforeAll(async () => {
  const b = await buildContents();
  base = b.contents;
  metadata = b.chainMetadata;
});

let n = 0;
/** Writes a bundle with a fresh, self-consistent manifest, so only semantic checks can catch edits. */
function bundle(contents: BundleContents): string {
  const out = join(dir, `b${n++}`);
  writeBundle(out, contents, { network: "mainnet", trust: TRUST, createdMs: T0 });
  return out;
}

const opts = (bundleDir: string, over: Partial<VerifyOptions> = {}): VerifyOptions => ({
  bundleDir,
  ...TRUST,
  anchorLookup: async (hashes) => new Map(hashes.map((x) => [x, metadata.get(x) ?? null])),
  coverRecheck: fakeKoios(),
  ...over,
});

const statusOf = (r: Awaited<ReturnType<typeof runVerify>>) =>
  Object.fromEntries(r.checks.map((c) => [c.id, c.status]));

describe("ballast verify v1", () => {
  it("passes a genuine bundle: chain, policies, reports, activations and renewal, anchor, cover", async () => {
    const r = await runVerify(opts(bundle(base)));
    expect(statusOf(r)).toEqual({
      bundle: "PASS",
      trust: "PASS",
      "decision-chain": "PASS",
      policies: "PASS",
      "critic-reports": "PASS",
      activation: "PASS",
      anchors: "PASS",
      cover: "PASS",
      fills: "SKIP",
      "l3-presence": "SKIP",
      allocator: "SKIP",
      "book-health": "SKIP",
    });
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.id === "activation")?.detail).toBe(
      "2 activation(s) replayed, 3 create(s) each under the policy in force",
    );
    const table = renderVerifyTable(r);
    expect(table).toMatch(/^PASS {2}Bundle files/m);
    expect(table).toMatch(/VERIFY PASS/);
  });

  it("warns, but does not fail, offline or with unpinned keys", async () => {
    const r = await runVerify(
      opts(bundle(base), {
        anchorLookup: null,
        coverRecheck: null,
        operatorPubkeys: [],
        daemonPubkeys: [],
      }),
    );
    expect(statusOf(r)).toMatchObject({
      trust: "WARN",
      anchors: "WARN",
      cover: "WARN",
      "decision-chain": "PASS",
    });
    expect(r.ok).toBe(true);
  });

  it("fails when the publisher's keys are not the pinned ones", async () => {
    const r = await runVerify(
      opts(bundle(base), { daemonPubkeys: ["a".repeat(64)], operatorPubkeys: ["b".repeat(64)] }),
    );
    expect(statusOf(r)).toMatchObject({
      "decision-chain": "FAIL",
      policies: "FAIL",
      "critic-reports": "FAIL",
      activation: "FAIL",
    });
    expect(r.ok).toBe(false);
  });

  it("fails when the on-chain anchor differs or is missing", async () => {
    const wrong = new Map(metadata);
    wrong.set(ANCHOR_TX, { "674": { msg: ["c".repeat(64), "seq 1-9", "segments 2"] } });
    const r1 = await runVerify(opts(bundle(base), { anchorLookup: async () => wrong }));
    expect(statusOf(r1).anchors).toBe("FAIL");
    const r2 = await runVerify(opts(bundle(base), { anchorLookup: async () => new Map() }));
    expect(statusOf(r2).anchors).toBe("FAIL");
    const r3 = await runVerify(
      opts(bundle(base), {
        recordingsManifest: new Map([["2026-10-23/00/l3.0.jsonl", "0".repeat(64)]]),
      }),
    );
    expect(statusOf(r3).anchors).toBe("FAIL");
  });

  it("invariant 2 retro-check: a create with no policy in force fails", async () => {
    const late = structuredClone(base);
    // Drop the renewal: the requote 25 h in has no window in force.
    late.decisions = late.decisions.filter(
      (d) => !(d.kind === "policy" && d.inputsDigest === late.renewals[0]?.hash),
    );
    const r = await runVerify(opts(bundle(late)));
    expect(statusOf(r).activation).toBe("FAIL");
    expect(r.checks.find((c) => c.id === "activation")?.failures.join(" ")).toMatch(
      /no policy in force/,
    );
  });

  it("tamper: modifying any field of any signed or committed record makes verify fail (exhaustive)", async () => {
    type Part =
      | "policies"
      | "criticReports"
      | "renewalEnvelopes"
      | "renewals"
      | "decisions"
      | "anchors"
      | "coverProofs";
    const parts: Part[] = [
      "policies",
      "criticReports",
      "renewalEnvelopes",
      "renewals",
      "decisions",
      "anchors",
      "coverProofs",
    ];
    const leaves = (v: unknown, path: (string | number)[] = []): (string | number)[][] =>
      v !== null && typeof v === "object"
        ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
            leaves(x, [...path, Array.isArray(v) ? Number(k) : k]),
          )
        : [path];
    const tamper = (old: unknown): unknown =>
      typeof old === "number"
        ? old + 1
        : typeof old === "boolean"
          ? !old
          : old === null
            ? "x"
            : /^[0-9a-f]+$/.test(String(old)) && String(old).length > 1
              ? `${String(old).slice(0, -1)}${String(old).endsWith("0") ? "1" : "0"}`
              : `${String(old)}x`;
    const undetected: string[] = [];
    let edits = 0;
    for (const part of parts) {
      for (const [idx, record] of (base[part] as unknown[]).entries()) {
        for (const path of leaves(record)) {
          const copy = structuredClone(base);
          // biome-ignore lint/suspicious/noExplicitAny: walking a JSON path to tamper with it
          let node: any = (copy[part] as unknown[])[idx];
          for (const k of path.slice(0, -1)) node = node[k];
          const leaf = path[path.length - 1] as string | number;
          node[leaf] = tamper(node[leaf]);
          edits += 1;
          if ((await runVerify(opts(bundle(copy)))).ok)
            undetected.push(`${part}[${idx}].${path.join(".")}`);
        }
      }
    }
    expect(edits).toBeGreaterThan(200);
    expect(undetected).toEqual([]);
  });

  it("tamper: random multi-field edits are caught too", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 1, max: 10_000 }),
        async (i, delta) => {
          const copy = structuredClone(base);
          const d = copy.decisions[i] as { tsMs: number; seq: number };
          d.tsMs += delta;
          d.seq += delta;
          return !(await runVerify(opts(bundle(copy)))).ok;
        },
      ),
      { numRuns: 25 },
    );
  });

  it("tamper: deleting or reordering decision records fails verify", async () => {
    const dropped = structuredClone(base);
    dropped.decisions.splice(3, 1);
    expect((await runVerify(opts(bundle(dropped)))).ok).toBe(false);
    const swapped = structuredClone(base);
    const [a, b] = [swapped.decisions[2], swapped.decisions[3]];
    if (a && b) [swapped.decisions[2], swapped.decisions[3]] = [b, a];
    expect((await runVerify(opts(bundle(swapped)))).ok).toBe(false);
  });

  it("checks a seq slice against the record before it", async () => {
    const r = await runVerify(opts(bundle(base), { fromSeq: 3, toSeq: 5 }));
    expect(r.checks.find((c) => c.id === "decision-chain")).toMatchObject({
      status: "PASS",
      detail: "3 record(s), seq 3..5",
    });
  });
});

describe("verify CLI", () => {
  it("parses arguments strictly", () => {
    expect(
      parseVerifyArgs(["--", "--bundle", "b", "--from", "2", "--daemon-pubkey", "a".repeat(64)]),
    ).toMatchObject({
      bundle: "b",
      fromSeq: 2,
      daemonPubkeys: ["a".repeat(64)],
      offline: false,
    });
    expect(() => parseVerifyArgs([])).toThrow(/--bundle/);
    expect(() => parseVerifyArgs(["--bundle", "b", "--from", "0"])).toThrow(/seq/);
    expect(() => parseVerifyArgs(["--bundle", "b", "--from", "5", "--to", "2"])).toThrow(/≥/);
    expect(() => parseVerifyArgs(["--bundle", "b", "--daemon-pubkey", "xyz"])).toThrow(/64-hex/);
    expect(() => parseVerifyArgs(["--bundle", "b", "--offline", "--live-cover"])).toThrow(
      /offline/,
    );
  });

  it("prints a table or JSON and exits 0 on PASS, 1 on FAIL", async () => {
    const good = bundle(base);
    const keys = TRUST.daemonPubkeys
      .flatMap((k) => ["--daemon-pubkey", k])
      .concat(TRUST.operatorPubkeys.flatMap((k) => ["--operator-pubkey", k]));
    let out = "";
    const koios = fakeKoios(metadata);
    expect(
      await verifyMain(["--bundle", good, ...keys, "--live-cover"], {
        koios,
        out: (s) => {
          out += s;
        },
      }),
    ).toBe(0);
    expect(out).toMatch(/VERIFY PASS/);
    out = "";
    expect(
      await verifyMain(["--bundle", good, ...keys, "--json", "-"], {
        koios,
        out: (s) => {
          out += s;
        },
      }),
    ).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true });
    const bad = structuredClone(base);
    (bad.decisions[1] as { tsMs: number }).tsMs += 1;
    expect(await verifyMain(["--bundle", bundle(bad), ...keys], { koios, out: () => {} })).toBe(1);
  });

  it("the requote decided 25 h in is covered only by the daemon-issued renewal", () => {
    const req = base.decisions.filter((d) => d.kind === "requote").at(-1);
    expect(req?.tsMs).toBe(T0 + DAY + HOUR);
  });
});
