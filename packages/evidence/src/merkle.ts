import { createHash } from "node:crypto";

const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);

/**
 * RFC 6962 §2.1 Merkle Tree Hash. Leaf and node hashes are domain-separated (0x00 / 0x01)
 * so no leaf can be passed off as an inner node; the split point is the largest power of
 * two below n. Anyone can recompute it from the segment hashes in the manifest.
 */
export function merkleRoot(leaves: readonly Uint8Array[]): Buffer {
  if (leaves.length === 0) return createHash("sha256").digest();
  const [only] = leaves;
  if (leaves.length === 1 && only) return createHash("sha256").update(LEAF).update(only).digest();
  const k = largestPowerOfTwoBelow(leaves.length);
  return createHash("sha256")
    .update(NODE)
    .update(merkleRoot(leaves.slice(0, k)))
    .update(merkleRoot(leaves.slice(k)))
    .digest();
}

export function merkleRootHex(leafHashesHex: readonly string[]): string {
  return merkleRoot(leafHashesHex.map((h) => Buffer.from(h, "hex"))).toString("hex");
}

function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}
