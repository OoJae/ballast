import { createHash } from "node:crypto";
import { bech32Encode, type KoiosUtxo, NIGHT } from "../src/index.js";

/** Synthetic fixtures only: hashes derived from labels, never real wallets. */
export function h28(label: string): string {
  return createHash("sha256").update(`ballast-cover-test:${label}`).digest("hex").slice(0, 56);
}

export function h32(label: string): string {
  return createHash("sha256").update(`ballast-cover-tx:${label}`).digest("hex");
}

type Kind = "key" | "script";

function enc(hrp: string, header: number, ...hashes: string[]): string {
  return bech32Encode(hrp, Uint8Array.from([header, ...Buffer.from(hashes.join(""), "hex")]));
}

export function baseAddr(
  pay: string,
  stake: string,
  kinds: [Kind, Kind] = ["key", "key"],
  mainnet = true,
): string {
  const type = (kinds[0] === "script" ? 1 : 0) | (kinds[1] === "script" ? 2 : 0);
  return enc(mainnet ? "addr" : "addr_test", (type << 4) | (mainnet ? 1 : 0), h28(pay), h28(stake));
}

export function enterpriseAddr(pay: string, kind: Kind = "key", mainnet = true): string {
  return enc(
    mainnet ? "addr" : "addr_test",
    ((kind === "script" ? 7 : 6) << 4) | (mainnet ? 1 : 0),
    h28(pay),
  );
}

export function stakeAddr(stake: string, kind: Kind = "key", mainnet = true): string {
  return enc(
    mainnet ? "stake" : "stake_test",
    ((kind === "script" ? 15 : 14) << 4) | (mainnet ? 1 : 0),
    h28(stake),
  );
}

export function pointerAddr(pay: string): string {
  return bech32Encode(
    "addr",
    Uint8Array.from([(4 << 4) | 1, ...Buffer.from(h28(pay), "hex"), 0x81, 0x00, 0x02, 0x03]),
  );
}

export const LOOKALIKE_POLICY = h28("some-other-night-token");

export function night(quantity: bigint | number, policyId: string = NIGHT.policyId) {
  return {
    policy_id: policyId,
    asset_name: NIGHT.assetNameHex,
    fingerprint: "asset1synthetic",
    decimals: 6,
    quantity: String(quantity),
  };
}

export function utxo(
  label: string,
  address: string,
  assets: ReturnType<typeof night>[],
  over: Partial<KoiosUtxo> = {},
): KoiosUtxo {
  return {
    tx_hash: h32(label),
    tx_index: 0,
    address,
    value: "1500000",
    stake_address: null,
    payment_cred: null,
    block_height: 100,
    block_time: 1_792_000_000,
    asset_list: assets,
    is_spent: false,
    ...over,
  };
}
