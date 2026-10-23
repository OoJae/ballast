/**
 * In-browser re-check of the recorder's hourly evidence, using only WebCrypto. It recomputes
 * each hour's RFC 6962 Merkle root from the published segment hashes and walks the hash chain
 * (sha256 of the JCS form of {hour, prev, root}); it trusts nothing the API says about either.
 */

const enc = new TextEncoder();

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const buf = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", buf));
}

const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);

async function mth(leaves: readonly Uint8Array[]): Promise<Uint8Array> {
  if (leaves.length === 0) return sha256();
  if (leaves.length === 1) return sha256(LEAF, leaves[0] as Uint8Array);
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return sha256(NODE, await mth(leaves.slice(0, k)), await mth(leaves.slice(k)));
}

/** RFC 6962 Merkle Tree Hash over leaf hashes given as hex. */
export async function merkleRootHex(leavesHex: readonly string[]): Promise<string> {
  return bytesToHex(await mth(leavesHex.map(hexToBytes)));
}

/** The recorder's chain link: sha256 over the JCS (sorted-key) JSON of {hour, prev, root}. */
export async function chainHashHex(
  prev: string | null,
  hour: string,
  root: string,
): Promise<string> {
  const jcs = `{"hour":${JSON.stringify(hour)},"prev":${prev === null ? "null" : JSON.stringify(prev)},"root":${JSON.stringify(root)}}`;
  return bytesToHex(await sha256(enc.encode(jcs)));
}

export interface HourEvidence {
  hour: string;
  root: string;
  prev: string | null;
  chain: string;
  leaves: string[];
  segments: { sha256: string }[];
}

export interface HourCheck {
  hour: string;
  /** The segment hashes listed for the hour are the leaves the root commits to. */
  leavesMatch: boolean;
  rootOk: boolean;
  chainOk: boolean;
  /** `prev` is the previous hour's chain hash (null for the first hour). */
  linkOk: boolean;
}

export async function checkChain(hours: readonly HourEvidence[]): Promise<HourCheck[]> {
  const out: HourCheck[] = [];
  let prevChain: string | null = null;
  for (const h of hours) {
    const leavesMatch =
      h.leaves.length === h.segments.length &&
      h.leaves.every((l, i) => h.segments[i]?.sha256 === l);
    let rootOk = false;
    let chainOk = false;
    try {
      rootOk = (await merkleRootHex(h.leaves)) === h.root;
      chainOk = (await chainHashHex(h.prev, h.hour, h.root)) === h.chain;
    } catch {
      // Malformed hex: both stay false.
    }
    out.push({ hour: h.hour, leavesMatch, rootOk, chainOk, linkOk: h.prev === prevChain });
    prevChain = h.chain;
  }
  return out;
}
