/**
 * Mempool spend detection (D10). A pending transaction that spends any UTxO counted as cover
 * means the holder is moving coins: capacity drops to r = 0 at once, before the block lands.
 *
 * VERIFY: the Ogmios v6 LocalTxMonitor protocol (JSON-RPC `acquireMempool`, `nextTransaction`
 * with `fields: "all"`, `releaseMempool`) and the shape of a transaction's `inputs`
 * (`{ transaction: { id }, index }`) are from memory, not checked against a live node or the
 * Ogmios docs in this session. Until D10 runs, only the interface and the pure spend matcher
 * are used; the stub source never emits.
 */
import type { CoverProof } from "./proof.js";

export interface UtxoRefPair {
  txHash: string;
  index: number;
}

export interface MempoolSpend {
  txId: string;
  inputs: UtxoRefPair[];
  seenAtMs: number;
}

export interface MempoolSpendSource {
  subscribe(onSpend: (spend: MempoolSpend) => void): () => void;
}

/** Placeholder until an Ogmios endpoint is provisioned and D10 verifies the protocol. */
export class OgmiosMempoolStub implements MempoolSpendSource {
  subscribe(_onSpend: (spend: MempoolSpend) => void): () => void {
    return () => {};
  }
}

export interface CoverSpendAlert {
  subject: CoverProof["subject"];
  txId: string;
  spentRefs: string[];
  /** Effective r until the next block's proof: always 0. */
  rBps: 0;
}

/** Pure matcher: which proofs a pending spend touches. */
export function spendsAgainstCover(
  spend: MempoolSpend,
  proofs: readonly CoverProof[],
): CoverSpendAlert[] {
  const spent = new Set(spend.inputs.map((i) => `${i.txHash}#${i.index}`));
  const alerts: CoverSpendAlert[] = [];
  for (const p of proofs) {
    const hit = p.utxos.filter((u) => spent.has(u.ref)).map((u) => u.ref);
    if (hit.length > 0)
      alerts.push({ subject: p.subject, txId: spend.txId, spentRefs: hit, rBps: 0 });
  }
  return alerts;
}

/** Wires a source to the current proofs; `onAlert` should cancel first (invariant 1). */
export function watchCoverSpends(
  source: MempoolSpendSource,
  currentProofs: () => readonly CoverProof[],
  onAlert: (alert: CoverSpendAlert) => void,
): () => void {
  return source.subscribe((spend) => {
    for (const a of spendsAgainstCover(spend, currentProofs())) onAlert(a);
  });
}
