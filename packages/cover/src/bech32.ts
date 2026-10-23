/**
 * BIP-173 bech32 (not bech32m), as Cardano uses it (CIP-5). Cardano addresses exceed BIP-173's
 * 90-character limit, so the limit here is 1023 characters, which is what the checksum's error
 * detection supports.
 */
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const MAX_LENGTH = 1023;

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i] as number;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function convertBits(data: Iterable<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Bech32Error("invalid data value");
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new Bech32Error("invalid padding");
  }
  return out;
}

export class Bech32Error extends Error {
  constructor(message: string) {
    super(`bech32: ${message}`);
    this.name = "Bech32Error";
  }
}

export interface Bech32Decoded {
  hrp: string;
  bytes: Uint8Array;
}

export function bech32Decode(input: string): Bech32Decoded {
  if (input.length > MAX_LENGTH) throw new Bech32Error("too long");
  const lower = input.toLowerCase();
  if (input !== lower && input !== input.toUpperCase()) throw new Bech32Error("mixed case");
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) throw new Bech32Error("missing separator or data");
  const hrp = lower.slice(0, sep);
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i);
    if (c < 33 || c > 126) throw new Bech32Error("invalid human-readable part");
  }
  const data: number[] = [];
  for (const ch of lower.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v === -1) throw new Bech32Error(`invalid character ${JSON.stringify(ch)}`);
    data.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Bech32Error("bad checksum");
  return { hrp, bytes: Uint8Array.from(convertBits(data.slice(0, -6), 5, 8, false)) };
}

export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const lowerHrp = hrp.toLowerCase();
  const data = convertBits(bytes, 8, 5, true);
  const mod = polymod([...hrpExpand(lowerHrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >>> (5 * (5 - i))) & 31);
  const out = `${lowerHrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join("")}`;
  if (out.length > MAX_LENGTH) throw new Bech32Error("too long");
  return out;
}
