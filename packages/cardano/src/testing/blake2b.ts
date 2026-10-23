/**
 * BLAKE2b (RFC 7693), unkeyed, any output length up to 64 bytes. Tests only: it gives an
 * independent blake2b-224 (key hashes) and blake2b-256 (transaction ids) to check the
 * serialization library against. Slow (bigint words) and fine for that.
 */
const MASK = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK;

function compress(h: bigint[], block: Uint8Array, t: bigint, last: boolean): void {
  const m: bigint[] = [];
  for (let i = 0; i < 16; i++) {
    let w = 0n;
    for (let j = 7; j >= 0; j--) w = (w << 8n) | BigInt(block[i * 8 + j] ?? 0);
    m.push(w);
  }
  const v = [...h, ...IV];
  v[12] = (v[12] as bigint) ^ (t & MASK);
  v[13] = (v[13] as bigint) ^ (t >> 64n);
  if (last) v[14] = (v[14] as bigint) ^ MASK;
  const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
    v[a] = ((v[a] as bigint) + (v[b] as bigint) + x) & MASK;
    v[d] = rotr((v[d] as bigint) ^ (v[a] as bigint), 32n);
    v[c] = ((v[c] as bigint) + (v[d] as bigint)) & MASK;
    v[b] = rotr((v[b] as bigint) ^ (v[c] as bigint), 24n);
    v[a] = ((v[a] as bigint) + (v[b] as bigint) + y) & MASK;
    v[d] = rotr((v[d] as bigint) ^ (v[a] as bigint), 16n);
    v[c] = ((v[c] as bigint) + (v[d] as bigint)) & MASK;
    v[b] = rotr((v[b] as bigint) ^ (v[c] as bigint), 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10] as number[];
    const w = (i: number) => m[s[i] as number] as bigint;
    g(0, 4, 8, 12, w(0), w(1));
    g(1, 5, 9, 13, w(2), w(3));
    g(2, 6, 10, 14, w(4), w(5));
    g(3, 7, 11, 15, w(6), w(7));
    g(0, 5, 10, 15, w(8), w(9));
    g(1, 6, 11, 12, w(10), w(11));
    g(2, 7, 8, 13, w(12), w(13));
    g(3, 4, 9, 14, w(14), w(15));
  }
  for (let i = 0; i < 8; i++) h[i] = (h[i] as bigint) ^ (v[i] as bigint) ^ (v[i + 8] as bigint);
}

export function blake2b(data: Uint8Array, outLen: number): Uint8Array {
  if (!Number.isInteger(outLen) || outLen < 1 || outLen > 64) throw new RangeError("outLen 1-64");
  const h = [...IV];
  h[0] = (h[0] as bigint) ^ 0x01010000n ^ BigInt(outLen);
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  for (let i = 0; i < blocks; i++) {
    const block = new Uint8Array(128);
    block.set(data.subarray(i * 128, (i + 1) * 128));
    const last = i === blocks - 1;
    const t = BigInt(last ? data.length : (i + 1) * 128);
    compress(h, block, t, last);
  }
  const out = new Uint8Array(64);
  h.forEach((w, i) => {
    for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((w >> BigInt(8 * j)) & 0xffn);
  });
  return out.slice(0, outLen);
}

export const blake2b224 = (data: Uint8Array) => blake2b(data, 28);
export const blake2b256 = (data: Uint8Array) => blake2b(data, 32);
