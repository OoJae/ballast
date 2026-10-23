import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KoiosReader, KoiosTip, KoiosTxMetadata, KoiosUtxo } from "@ballast/cover";
import type { RootEntry } from "@ballast/evidence";
import { exportBundle } from "@ballast/evidence/bundle";
import { openEvidenceDb } from "@ballast/evidence/db";
import {
  AnchorWalletKey,
  DaemonKey,
  DecisionLog,
  HostKek,
  writeSealedKey,
} from "@ballast/governance";
import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anchorMain, commitAnchor, planAnchor, submitTx } from "../src/anchor.js";
import { anchorAddress } from "../src/keys.js";
import { koiosAnchorLookup, runVerify } from "../src/verify.js";

const seed = (l: string) => createHash("sha256").update(`ballast-anchor-test:${l}`).digest();
const h = (l: string) => createHash("sha256").update(`anchor-fixture:${l}`).digest("hex");
const T0 = Date.parse("2026-10-23T09:00:00Z");
const daemon = DaemonKey.fromSeed(seed("daemon"));
const anchorKey = AnchorWalletKey.fromSeed(seed("anchor"));

function rootEntry(hour: string, n: number): RootEntry {
  const segments = Array.from({ length: n }, (_, i) => `2026-10-23/${hour}/l3.${i}.jsonl`);
  return {
    v: 1,
    hour: `2026-10-23T${hour}`,
    segments,
    leaves: segments.map((s) => h(s)),
    root: h(`root-${hour}`),
    prev: null,
    chain: h(`chain-${hour}`),
    sealedMs: T0,
  };
}

function appendKeeperDecisions(db: ReturnType<typeof openEvidenceDb>, n: number) {
  const log = new DecisionLog({
    key: daemon,
    head: db.decisionHead(),
    sink: db.decisionSink(),
    now: () => T0,
  });
  for (let i = 0; i < n; i++)
    log.append({ kind: "keeper", inputsDigest: h(`k${i}`), inputsRef: null });
}

describe("planAnchor / commitAnchor", () => {
  it("refuses to anchor an empty decision log", () => {
    const db = openEvidenceDb(":memory:");
    const plan = planAnchor(db, [rootEntry("00", 2)], "preprod", T0);
    expect(plan).toEqual({
      kind: "nothing",
      reason: expect.stringMatching(/decision log is empty/),
    });
  });

  it("covers decisions and sealed hours since the last anchor, and signs a commitment", () => {
    const db = openEvidenceDb(":memory:");
    appendKeeperDecisions(db, 3);
    const roots = [rootEntry("00", 2), rootEntry("01", 3)];
    const plan = planAnchor(db, roots, "preprod", T0);
    expect(plan.kind).toBe("new");
    if (plan.kind === "nothing") throw new Error("unreachable");
    const rec = commitAnchor(db, plan, daemon, () => T0);
    expect([rec.firstSeq, rec.lastSeq, rec.segments.length]).toEqual([1, 3, 5]);
    const head = db.decisions().at(-1);
    expect(head?.kind).toBe("anchor");
    expect(head?.seq).toBe(4);

    // The unsubmitted anchor is resumed, never forked, and not committed twice.
    const again = planAnchor(db, [...roots, rootEntry("02", 1)], "preprod", T0 + 1);
    expect(again).toEqual({ kind: "resume", record: rec });
    if (again.kind === "nothing") throw new Error("unreachable");
    commitAnchor(db, again, daemon, () => T0 + 1);
    expect(db.decisions()).toHaveLength(4);
    // A pending anchor for one network blocks a different network.
    expect(planAnchor(db, roots, "mainnet", T0).kind).toBe("nothing");

    // Once it has a tx, the next anchor starts at the anchor decision and takes only new hours.
    db.setAnchorTx(rec.root, h("tx1"), "submitted");
    const next = planAnchor(db, [...roots, rootEntry("02", 1)], "preprod", T0 + 2);
    if (next.kind !== "new") throw new Error(`expected a new anchor, got ${next.kind}`);
    expect([next.record.firstSeq, next.record.lastSeq]).toEqual([4, 4]);
    expect(next.record.segments.map((s) => s.segment)).toEqual(["2026-10-23/02/l3.0.jsonl"]);
  });
});

describe("submitTx", () => {
  it("only talks to Koios", async () => {
    await expect(submitTx("https://evil.example/api/v1", "00")).rejects.toThrow(/only https/);
    await expect(submitTx("http://preprod.koios.rest/api/v1", "00")).rejects.toThrow(/only https/);
  });
});

describe("ballast anchor (preprod, end to end against a fake Koios)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ballast-anchor-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setup() {
    const kekPath = join(dir, "host.kek");
    const kek = HostKek.create(kekPath);
    writeSealedKey(join(dir, "daemon.json"), daemon.seal(kek));
    writeSealedKey(join(dir, "anchor.json"), anchorKey.seal(kek));
    const recordings = join(dir, "recordings");
    mkdirSync(recordings);
    const roots = [rootEntry("00", 2), rootEntry("01", 2)];
    writeFileSync(
      join(recordings, "roots.jsonl"),
      roots.map((r) => `${JSON.stringify(r)}\n`).join(""),
    );
    const dbPath = join(dir, "ballast.sqlite");
    const db = openEvidenceDb(dbPath);
    appendKeeperDecisions(db, 2);
    db.close();

    const address = anchorAddress(anchorKey, "preprod");
    const onChain = new Map<string, Record<string, unknown> | null>();
    const koios: KoiosReader = {
      tip: async () =>
        ({
          hash: h("tip"),
          epoch_no: 321,
          abs_slot: 137_000_000,
          block_height: 4_000_000,
          block_time: 0,
        }) as KoiosTip,
      addressUtxos: async (addrs) => {
        expect(addrs).toEqual([address]);
        return [
          {
            tx_hash: h("faucet"),
            tx_index: 0,
            address,
            value: "10000000",
            asset_list: [],
          } as KoiosUtxo,
        ];
      },
      accountUtxos: async () => [],
      utxoInfo: async () => [],
      txMetadata: async (hashes): Promise<KoiosTxMetadata[]> =>
        hashes
          .filter((x) => onChain.has(x))
          .map((x) => ({ tx_hash: x, metadata: onChain.get(x) ?? null })),
    };
    const submitted: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      expect(url).toBe("https://preprod.koios.rest/api/v1/submittx");
      const tx = CSL.FixedTransaction.from_bytes(new Uint8Array(init.body as Buffer));
      const hash = tx.transaction_hash().to_hex();
      // What a chain indexer would return: the metadata decoded back out of the signed CBOR.
      const md = tx.auxiliary_data()?.metadata()?.get(CSL.BigNum.from_str("674"));
      const json = md && CSL.decode_metadatum_to_json_str(md, CSL.MetadataJsonSchema.NoConversions);
      onChain.set(hash, json ? { "674": JSON.parse(json) } : null);
      submitted.push(hash);
      return new Response(JSON.stringify(hash), { status: 202 });
    }) as unknown as typeof fetch;
    const common = [
      "--network",
      "preprod",
      "--anchor-key",
      join(dir, "anchor.json"),
      "--daemon-key",
      join(dir, "daemon.json"),
      "--kek",
      kekPath,
      "--db",
      dbPath,
      "--recordings",
      recordings,
    ];
    return { koios, fetchImpl, submitted, common, dbPath };
  }

  it("builds without submitting by default", async () => {
    const { koios, fetchImpl, submitted, common, dbPath } = setup();
    const lines: string[] = [];
    expect(
      await anchorMain(common, { koios, fetchImpl, out: (s) => lines.push(s), now: () => T0 }),
    ).toBe(0);
    expect(submitted).toEqual([]);
    expect(lines.join("\n")).toMatch(/built only/);
    const db = openEvidenceDb(dbPath);
    expect(db.anchors()[0]?.txHash).toBeNull();
    db.close();
  });

  it("submits, sees the anchor on chain, and the exported bundle verifies against it", async () => {
    const { koios, fetchImpl, submitted, common, dbPath } = setup();
    const lines: string[] = [];
    const deps = {
      koios,
      fetchImpl,
      out: (s: string) => lines.push(s),
      now: () => T0,
      sleep: async () => {},
    };
    expect(await anchorMain([...common, "--submit"], deps)).toBe(0);
    expect(submitted).toHaveLength(1);
    expect(lines.join("\n")).toMatch(/confirmed/);

    const db = openEvidenceDb(dbPath);
    const [a] = db.anchors();
    expect(a?.txHash).toBe(submitted[0]);
    expect([a?.firstSeq, a?.lastSeq, a?.segments.length]).toEqual([1, 2, 4]);
    const bundle = join(dir, "bundle");
    exportBundle(db, bundle, {
      network: "preprod",
      trust: { operatorPubkeys: [], daemonPubkeys: [daemon.publicKeyHex] },
      createdMs: T0,
    });
    db.close();
    const result = await runVerify({
      bundleDir: bundle,
      daemonPubkeys: [daemon.publicKeyHex],
      anchorLookup: koiosAnchorLookup(koios),
      coverRecheck: null,
      recordingsManifest: null,
    });
    const anchors = result.checks.find((c) => c.id === "anchors");
    expect(anchors?.status).toBe("PASS");
    expect(anchors?.detail).toMatch(/1 anchor\(s\) match the chain/);
    const chain = result.checks.find((c) => c.id === "decision-chain");
    expect(chain?.status).toBe("PASS");
  });

  it("refuses a mainnet submit without the approval flag and BALLAST_ARM=1", async () => {
    const { koios, fetchImpl, common } = setup();
    const mainnet = common.map((x) => (x === "preprod" ? "mainnet" : x));
    const deps = { koios, fetchImpl, out: () => {}, now: () => T0, env: {} };
    expect(await anchorMain([...mainnet, "--submit"], deps)).toBe(2);
    expect(await anchorMain([...mainnet, "--submit", "--yes-i-approve"], deps)).toBe(2);
  });
});
