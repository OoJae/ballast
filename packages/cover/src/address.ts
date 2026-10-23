import { bech32Decode, bech32Encode } from "./bech32.js";

/**
 * Shelley address parsing per CIP-19 (header nibble = type, low nibble = network) and CIP-5
 * prefixes. Cover counts only UTxOs whose payment credential is a key hash, so the credential
 * kind is read from the address bytes themselves, never from a provider's annotation.
 */
export type CardanoNetwork = "mainnet" | "testnet";
export type CredentialKind = "key" | "script";

export interface Credential {
  kind: CredentialKind;
  /** 28-byte blake2b-224 hash, lowercase hex. */
  hashHex: string;
}

export type ParsedAddress =
  | { type: "base"; network: CardanoNetwork; payment: Credential; stake: Credential }
  | {
      type: "pointer";
      network: CardanoNetwork;
      payment: Credential;
      pointer: { slot: bigint; txIndex: bigint; certIndex: bigint };
    }
  | { type: "enterprise"; network: CardanoNetwork; payment: Credential }
  | { type: "reward"; network: CardanoNetwork; stake: Credential }
  | { type: "byron" };

export class AddressError extends Error {
  constructor(message: string) {
    super(`address: ${message}`);
    this.name = "AddressError";
  }
}

const HASH_LEN = 28;
const BYRON_RE = /^(?:Ae2|DdzFF)[1-9A-HJ-NP-Za-km-z]{20,}$/;

function networkOf(nibble: number): CardanoNetwork {
  if (nibble === 1) return "mainnet";
  if (nibble === 0) return "testnet";
  throw new AddressError(`unknown network id ${nibble}`);
}

function cred(kind: CredentialKind, bytes: Uint8Array): Credential {
  return { kind, hashHex: Buffer.from(bytes).toString("hex") };
}

function readNat(bytes: Uint8Array, at: number): [bigint, number] {
  let v = 0n;
  let i = at;
  for (;;) {
    const b = bytes[i];
    if (b === undefined) throw new AddressError("truncated pointer");
    v = (v << 7n) | BigInt(b & 0x7f);
    i += 1;
    if ((b & 0x80) === 0) return [v, i];
    if (i - at > 9) throw new AddressError("pointer component too long");
  }
}

/** Parses a bech32 Shelley address or stake address. Byron (base58) is recognized, not decoded. */
export function parseAddress(text: string): ParsedAddress {
  const s = text.trim();
  if (BYRON_RE.test(s)) return { type: "byron" };
  let decoded: ReturnType<typeof bech32Decode>;
  try {
    decoded = bech32Decode(s);
  } catch (err) {
    throw new AddressError(err instanceof Error ? err.message : String(err));
  }
  const { hrp, bytes } = decoded;
  const header = bytes[0];
  if (header === undefined) throw new AddressError("empty payload");
  const type = header >> 4;
  const network = networkOf(header & 0x0f);
  const isReward = type === 14 || type === 15;
  const expectedHrp = isReward
    ? network === "mainnet"
      ? "stake"
      : "stake_test"
    : network === "mainnet"
      ? "addr"
      : "addr_test";
  if (hrp !== expectedHrp)
    throw new AddressError(`prefix ${hrp} does not match the header (${expectedHrp})`);
  const body = bytes.subarray(1);
  const first = body.subarray(0, HASH_LEN);
  const second = body.subarray(HASH_LEN, 2 * HASH_LEN);
  switch (type) {
    case 0:
    case 1:
    case 2:
    case 3:
      if (body.length !== 2 * HASH_LEN) throw new AddressError("base address must be 57 bytes");
      return {
        type: "base",
        network,
        payment: cred(type & 1 ? "script" : "key", first),
        stake: cred(type & 2 ? "script" : "key", second),
      };
    case 4:
    case 5: {
      if (body.length < HASH_LEN + 3) throw new AddressError("pointer address too short");
      let at = HASH_LEN;
      const [slot, a] = readNat(body, at);
      const [txIndex, b] = readNat(body, a);
      const [certIndex, c] = readNat(body, b);
      at = c;
      if (at !== body.length) throw new AddressError("trailing bytes after pointer");
      return {
        type: "pointer",
        network,
        payment: cred(type === 5 ? "script" : "key", first),
        pointer: { slot, txIndex, certIndex },
      };
    }
    case 6:
    case 7:
      if (body.length !== HASH_LEN) throw new AddressError("enterprise address must be 29 bytes");
      return { type: "enterprise", network, payment: cred(type === 7 ? "script" : "key", first) };
    case 14:
    case 15:
      if (body.length !== HASH_LEN) throw new AddressError("stake address must be 29 bytes");
      return { type: "reward", network, stake: cred(type === 15 ? "script" : "key", first) };
    default:
      throw new AddressError(`unsupported address type ${type}`);
  }
}

/** The bech32 stake address (stake1… / stake_test1…) of a stake credential. */
export function stakeAddressOf(stake: Credential, network: CardanoNetwork): string {
  const header = ((stake.kind === "script" ? 15 : 14) << 4) | (network === "mainnet" ? 1 : 0);
  if (!/^[0-9a-f]{56}$/.test(stake.hashHex))
    throw new AddressError("credential hash must be 28 bytes");
  return bech32Encode(
    network === "mainnet" ? "stake" : "stake_test",
    Uint8Array.from([header, ...Buffer.from(stake.hashHex, "hex")]),
  );
}

/** The canonical stake address for an input that has one (base or stake address), else null. */
export function stakeAddressFor(text: string): string | null {
  const p = parseAddress(text);
  if (p.type === "base") return stakeAddressOf(p.stake, p.network);
  if (p.type === "reward") return stakeAddressOf(p.stake, p.network);
  return null;
}
