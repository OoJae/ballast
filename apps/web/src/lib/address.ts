/**
 * Offline check of a Cardano mainnet address or stake address: bech32 charset, checksum and
 * prefix. Nothing is sent anywhere; the cover calculator only calls the API once this passes.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i] as number;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  return [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)];
}

export type AddressCheck =
  | { ok: true; kind: "address" | "stake"; normalized: string }
  | { ok: false; reason: string };

export function checkCardanoAddress(input: string): AddressCheck {
  const s = input.trim();
  if (s.length === 0) return { ok: false, reason: "Paste an addr1… or stake1… address." };
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) {
    return { ok: false, reason: "Mixed case is not valid bech32." };
  }
  const lower = s.toLowerCase();
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) return { ok: false, reason: "Not a bech32 address." };
  const hrp = lower.slice(0, sep);
  if (hrp === "addr_test" || hrp === "stake_test") {
    return { ok: false, reason: "That is a testnet address; Ballast covers mainnet only." };
  }
  if (hrp !== "addr" && hrp !== "stake") {
    return { ok: false, reason: "Expected an addr1… or stake1… mainnet address." };
  }
  const data: number[] = [];
  for (const c of lower.slice(sep + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) return { ok: false, reason: `"${c}" is not a bech32 character.` };
    data.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) {
    return { ok: false, reason: "Checksum mismatch: a character is wrong or missing." };
  }
  return { ok: true, kind: hrp === "addr" ? "address" : "stake", normalized: lower };
}
