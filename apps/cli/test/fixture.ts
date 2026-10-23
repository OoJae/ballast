import { createHash } from "node:crypto";
import {
  bech32Encode,
  CoverOracle,
  type CoverProof,
  type KoiosReader,
  type KoiosTip,
  type KoiosUtxo,
  NIGHT,
} from "@ballast/cover";
import { anchorRecordDigest, anchorRoots, cip20Metadata } from "@ballast/evidence/anchor";
import type { BundleContents } from "@ballast/evidence/bundle";
import {
  type CriticRunOutput,
  DaemonKey,
  DecisionLog,
  issueRenewal,
  OperatorKey,
  runCriticGate,
  type SignedPolicy,
  signPolicy,
  signRenewalEnvelope,
} from "@ballast/governance";

/** A complete synthetic evidence trail: keys, policy, reports, decisions, renewal, anchor, cover. */
export const T0 = Date.parse("2026-10-23T00:00:00Z");
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
const seed = (l: string) => createHash("sha256").update(`ballast-cli-test:${l}`).digest();
const h = (l: string, n = 64) =>
  createHash("sha256").update(`cli-fixture:${l}`).digest("hex").slice(0, n);

export const operator = OperatorKey.fromSeed(seed("operator"));
export const daemon = DaemonKey.fromSeed(seed("daemon"));

export const STAKE = bech32Encode(
  "stake",
  Uint8Array.from([0xe1, ...Buffer.from(h("stake", 56), "hex")]),
);
export const HOME = bech32Encode(
  "addr",
  Uint8Array.from([
    0x01,
    ...Buffer.from(h("pay", 56), "hex"),
    ...Buffer.from(h("stake", 56), "hex"),
  ]),
);

const passOutput: CriticRunOutput = {
  dataRoot: h("data"),
  simGitSha: "4622508",
  seed: "7",
  scenarios: [
    {
      id: "last-24h",
      window: { fromMs: T0 - DAY, toMs: T0 },
      violations: { cover: 0, floor: 0, p2: 0, static: 0, rate: 0 },
      fills: 3,
      armedHours: 10,
      maxCombinedDrawdownMicroUsd: "-100",
    },
  ],
  verdict: "PASS",
};

export const night = (q: bigint) => ({
  policy_id: NIGHT.policyId,
  asset_name: NIGHT.assetNameHex,
  quantity: String(q),
});
export const UTXOS: KoiosUtxo[] = [
  {
    tx_hash: h("u1"),
    tx_index: 0,
    address: HOME,
    value: "2000000",
    block_height: 90,
    asset_list: [night(25_000_000_000n)],
    is_spent: false,
  },
  {
    tx_hash: h("u2"),
    tx_index: 1,
    address: HOME,
    value: "2000000",
    block_height: 95,
    asset_list: [night(500_000_000n)],
    is_spent: false,
  },
];
export const TIP: KoiosTip = {
  hash: h("tip"),
  epoch_no: 663,
  abs_slot: 201_000_000,
  block_height: 100,
  block_time: 1_792_700_000,
};

export function fakeKoios(
  metadata = new Map<string, Record<string, unknown> | null>(),
): KoiosReader {
  return {
    tip: async () => TIP,
    accountUtxos: async () => UTXOS,
    addressUtxos: async () => UTXOS,
    utxoInfo: async (refs) => UTXOS.filter((u) => refs.includes(`${u.tx_hash}#${u.tx_index}`)),
    txMetadata: async (hashes) =>
      hashes.map((tx_hash) => ({ tx_hash, metadata: metadata.get(tx_hash) ?? null })),
  };
}

export const ANCHOR_TX = h("anchor-tx");
export const SEGMENTS = [
  { segment: "2026-10-23/00/l3.0.jsonl", sha256: h("seg-l3") },
  { segment: "2026-10-23/00/price.0.jsonl", sha256: h("seg-price") },
];

export async function buildContents(): Promise<{
  contents: BundleContents;
  chainMetadata: Map<string, Record<string, unknown> | null>;
}> {
  const policy: SignedPolicy = signPolicy(
    {
      v: 1,
      policyId: "01JFIXTUREPOLICY000000001",
      prevPolicyHash: null,
      validFromMs: T0,
      validUntilMs: T0 + DAY,
      renewals: 2,
    },
    operator,
  );
  const report = await runCriticGate({
    runner: { run: async () => passOutput },
    signed: policy,
    daemonKey: daemon,
    now: () => T0 - HOUR,
  });
  const renewalReport = await runCriticGate({
    runner: { run: async () => passOutput },
    signed: policy,
    daemonKey: daemon,
    now: () => T0 + DAY - HOUR,
  });
  const envelope = signRenewalEnvelope(policy, 2, operator, T0);
  const renewal = issueRenewal(
    {
      base: policy,
      envelope,
      prior: {
        hash: policy.hash,
        index: 0,
        validFromMs: T0,
        validUntilMs: T0 + DAY,
        criticReportHash: report.hash,
      },
      report: renewalReport,
      trips: [],
      nowMs: T0 + DAY - HOUR,
      trustedOperators: [operator.publicKeyHex],
      trustedDaemons: [daemon.publicKeyHex],
    },
    daemon,
  );
  if (!renewal.ok) throw new Error("fixture renewal failed");

  let t = T0;
  const log = new DecisionLog({ key: daemon, now: () => t });
  const decisions = [];
  decisions.push(
    log.append({
      kind: "critic",
      policyHash: policy.hash,
      inputsDigest: report.hash,
      inputsRef: null,
    }),
  );
  decisions.push(
    log.append({
      kind: "policy",
      policyHash: policy.hash,
      inputsDigest: report.hash,
      inputsRef: null,
    }),
  );
  const proof: CoverProof = await new CoverOracle(fakeKoios(), { now: () => T0 + 1_000 }).proof(
    HOME,
  );
  t = T0 + 1_000;
  decisions.push(
    log.append({ kind: "cover", accountId: "acct-1", inputsDigest: proof.hash, inputsRef: null }),
  );
  for (const [i, at] of [T0 + HOUR, T0 + 2 * HOUR, T0 + DAY + HOUR].entries()) {
    if (at > T0 + DAY) {
      t = T0 + DAY - HOUR;
      decisions.push(
        log.append({
          kind: "critic",
          policyHash: policy.hash,
          inputsDigest: renewalReport.hash,
          inputsRef: null,
        }),
      );
      decisions.push(
        log.append({
          kind: "policy",
          policyHash: policy.hash,
          inputsDigest: renewal.signed.hash,
          inputsRef: null,
        }),
      );
    }
    t = at;
    decisions.push(
      log.append({
        kind: "requote",
        policyHash: policy.hash,
        accountId: "acct-1",
        inputsDigest: h(`inputs-${i}`),
        inputsRef: { segment: SEGMENTS[0]?.segment as string, offset: 100 * i },
        ops: [
          {
            route: "POST /v2/order/replace-batch",
            clientOrderId: `bal_${policy.hash.slice(0, 6)}_acct01_1_${i.toString(36)}`,
            side: "sell",
            priceTicks: "38700",
            sizeSteps: "260",
            builderBps: 10,
          },
        ],
        guard: { decision: "dry-run", checksHash: h(`checks-${i}`), violations: [] },
      }),
    );
  }
  const roots = anchorRoots(
    decisions.map((d) => d.hash),
    SEGMENTS.map((s) => s.sha256),
  );
  t = T0 + DAY + 2 * HOUR;
  const anchor = {
    v: 1 as const,
    ...roots,
    firstSeq: 1,
    lastSeq: decisions.length,
    segments: SEGMENTS,
    network: "mainnet" as const,
    txHash: ANCHOR_TX,
    createdMs: t,
  };
  decisions.push(
    log.append({ kind: "anchor", inputsDigest: anchorRecordDigest(anchor), inputsRef: null }),
  );
  const chainMetadata = new Map<string, Record<string, unknown> | null>([
    [
      ANCHOR_TX,
      JSON.parse(
        JSON.stringify(
          cip20Metadata({
            root: roots.root,
            firstSeq: 1,
            lastSeq: anchor.lastSeq,
            segmentCount: 2,
          }),
        ),
      ),
    ],
  ]);
  return {
    chainMetadata,
    contents: {
      policies: [policy],
      criticReports: [report, renewalReport],
      renewalEnvelopes: [envelope],
      renewals: [renewal.signed],
      decisions,
      anchors: [anchor],
      coverProofs: [proof],
      guardTrips: [
        { ruleId: "rate-budget", tsMs: T0 + 3 * HOUR, safetyClass: false, detail: "429 x3" },
      ],
    },
  };
}

export const TRUST = {
  operatorPubkeys: [operator.publicKeyHex],
  daemonPubkeys: [daemon.publicKeyHex],
};
