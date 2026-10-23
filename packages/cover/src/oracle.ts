import { type ParsedAddress, parseAddress, stakeAddressOf } from "./address.js";
import { MAX_R_BPS, NIGHT, NIGHT_UNIT } from "./config.js";
import type { KoiosReader, KoiosTip, KoiosUtxo } from "./koios.js";
import { buildCoverProof, type CoverProof } from "./proof.js";

/**
 * Cover per stake credential, in NIGHT base units (6 decimals), at one block height (§5):
 * only the pinned NIGHT asset, only unspent UTxOs that existed at the height, only at base
 * addresses whose payment credential is a key hash and whose stake credential is the bound one.
 * Script-locked (vesting, DEX, lending) UTxOs are excluded: the holder cannot simply spend them.
 */
export type CoverSubject =
  | { kind: "stake"; stakeAddress: string }
  | { kind: "address"; address: string };

export type ExclusionReason =
  | "script-payment"
  | "other-stake"
  | "pointer"
  | "enterprise"
  | "byron"
  | "wrong-network"
  | "unparseable"
  | "spent"
  | "after-height"
  | "unknown-height"
  | "duplicate";

export interface CoverUtxo {
  txHash: string;
  index: number;
  address: string;
  quantity: bigint;
  createdHeight: number;
}

export interface ExcludedUtxo {
  ref: string;
  reason: ExclusionReason;
  quantity: bigint;
}

export interface CoverComputation {
  subject: CoverSubject;
  height: number;
  included: CoverUtxo[];
  excluded: ExcludedUtxo[];
  coverBase: bigint;
  /** Units of other assets also named NIGHT, seen and ignored (display only). */
  lookalikeBase: bigint;
}

const NIGHT_NAME = NIGHT.assetNameHex;

/** Pinned-NIGHT quantity on one UTxO. Exact policy and exact asset name, nothing else. */
export function pinnedNightOf(u: Pick<KoiosUtxo, "asset_list">): bigint {
  let q = 0n;
  for (const a of u.asset_list ?? []) {
    if (a.policy_id === NIGHT.policyId && a.asset_name === NIGHT_NAME) q += BigInt(a.quantity);
  }
  return q;
}

function lookalikeOf(u: Pick<KoiosUtxo, "asset_list">): bigint {
  let q = 0n;
  for (const a of u.asset_list ?? []) {
    if (a.asset_name === NIGHT_NAME && a.policy_id !== NIGHT.policyId) q += BigInt(a.quantity);
  }
  return q;
}

export function utxoRef(txHash: string, index: number): string {
  return `${txHash}#${index}`;
}

/** Why a UTxO's address cannot count for `subject`, or null if it can. */
export function addressExclusion(address: string, subject: CoverSubject): ExclusionReason | null {
  let p: ParsedAddress;
  try {
    p = parseAddress(address);
  } catch {
    return "unparseable";
  }
  if (p.type === "byron") return "byron";
  if (p.network !== NIGHT.network) return "wrong-network";
  if (p.type === "reward") return "unparseable";
  if (p.payment.kind !== "key") return "script-payment";
  if (subject.kind === "address") return address === subject.address ? null : "other-stake";
  if (p.type === "pointer") return "pointer";
  if (p.type === "enterprise") return "enterprise";
  return stakeAddressOf(p.stake, p.network) === subject.stakeAddress ? null : "other-stake";
}

/** Pure: the same UTxO set and height always give the same cover. */
export function computeCover(
  subject: CoverSubject,
  utxos: readonly KoiosUtxo[],
  height: number,
): CoverComputation {
  const included: CoverUtxo[] = [];
  const excluded: ExcludedUtxo[] = [];
  const seen = new Set<string>();
  let lookalikeBase = 0n;
  for (const u of utxos) {
    const quantity = pinnedNightOf(u);
    const ref = utxoRef(u.tx_hash, u.tx_index);
    const reason: ExclusionReason | null = seen.has(ref)
      ? "duplicate"
      : (addressExclusion(u.address, subject) ??
        (u.is_spent === true
          ? "spent"
          : u.block_height === null || u.block_height === undefined
            ? "unknown-height"
            : u.block_height > height
              ? "after-height"
              : null));
    seen.add(ref);
    if (reason === null) lookalikeBase += lookalikeOf(u);
    if (quantity === 0n) continue;
    if (reason !== null) {
      excluded.push({ ref, reason, quantity });
      continue;
    }
    included.push({
      txHash: u.tx_hash,
      index: u.tx_index,
      address: u.address,
      quantity,
      createdHeight: u.block_height as number,
    });
  }
  included.sort((a, b) =>
    a.txHash === b.txHash ? a.index - b.index : a.txHash < b.txHash ? -1 : 1,
  );
  excluded.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const coverBase = included.reduce((s, u) => s + u.quantity, 0n);
  return { subject, height, included, excluded, coverBase, lookalikeBase };
}

export function assertRBps(rBps: number): void {
  if (!Number.isSafeInteger(rBps) || rBps < 0 || rBps > MAX_R_BPS) {
    throw new RangeError(`r must be an integer 0..${MAX_R_BPS} bps`);
  }
}

/** K_i = r_i·cover_i − short_i, in NIGHT base units, rounded down. Negative means breach. */
export function capacityBase(coverBase: bigint, rBps: number, shortBase: bigint): bigint {
  assertRBps(rBps);
  if (coverBase < 0n || shortBase < 0n) throw new RangeError("cover and short are non-negative");
  return (coverBase * BigInt(rBps)) / 10_000n - shortBase;
}

/** Exact decimal rendering of base units ("12.500000"). */
export function formatNight(base: bigint): string {
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const frac = (abs % NIGHT_UNIT).toString().padStart(NIGHT.decimals, "0");
  return `${neg ? "-" : ""}${abs / NIGHT_UNIT}.${frac}`;
}

/** Resolves a CLI or onboarding input (addr1… or stake1…) to what cover is measured over. */
export function subjectFor(input: string): CoverSubject {
  const p = parseAddress(input);
  if (p.type === "byron")
    throw new Error("Byron addresses have no stake credential; use a Shelley address");
  if (p.network !== NIGHT.network)
    throw new Error(`NIGHT is pinned on ${NIGHT.network}; got a ${p.network} address`);
  if (p.type === "reward" || p.type === "base") {
    return { kind: "stake", stakeAddress: stakeAddressOf(p.stake, p.network) };
  }
  if (p.type === "enterprise") return { kind: "address", address: input.trim() };
  throw new Error("pointer addresses cannot be bound to a stake credential");
}

export interface CoverOracleOptions {
  now?: () => number;
  /** Re-reads when the tip moves during a read, so a proof is consistent at one height. */
  maxTipRetries?: number;
}

/** Reads Koios and returns a Proof of Cover for one subject at the current tip. */
export class CoverOracle {
  constructor(
    private readonly koios: KoiosReader,
    private readonly opts: CoverOracleOptions = {},
  ) {}

  async proof(input: string | CoverSubject): Promise<CoverProof> {
    const subject = typeof input === "string" ? subjectFor(input) : input;
    const attempts = (this.opts.maxTipRetries ?? 3) + 1;
    let lastTip: KoiosTip | undefined;
    for (let i = 0; i < attempts; i++) {
      const before = await this.koios.tip();
      const utxos =
        subject.kind === "stake"
          ? await this.koios.accountUtxos([subject.stakeAddress])
          : await this.koios.addressUtxos([subject.address]);
      const after = await this.koios.tip();
      lastTip = after;
      if (before.hash !== after.hash) continue;
      const comp = computeCover(subject, utxos, after.block_height);
      return buildCoverProof(comp, after, (this.opts.now ?? Date.now)());
    }
    throw new Error(
      `chain tip kept moving during ${attempts} reads (last ${lastTip?.block_height ?? "?"}); no consistent proof`,
    );
  }
}
