import { canonicalize, sha256Hex } from "@ballast/core";
import { COVER_MAX_AGE_MS, NIGHT } from "./config.js";
import type { KoiosReader, KoiosTip } from "./koios.js";
import {
  addressExclusion,
  type CoverComputation,
  type CoverSubject,
  type ExclusionReason,
  pinnedNightOf,
  utxoRef,
} from "./oracle.js";

/**
 * Proof of Cover: everything needed to recompute one cover figure at one block height. Anyone can
 * re-check it with only public data: the listed UTxO refs, their quantities of the pinned asset,
 * and that each was unspent at the height.
 */
export interface CoverProof {
  v: 1;
  subject: CoverSubject;
  asset: { policyId: string; assetNameHex: string; decimals: number };
  height: number;
  tipHash: string;
  tipSlot: number;
  tipTime: number;
  utxos: { ref: string; address: string; quantity: string; createdHeight: number }[];
  excluded: { ref: string; reason: ExclusionReason; quantity: string }[];
  coverBase: string;
  checkedAtMs: number;
  hash: string;
}

export function coverProofHash(p: Omit<CoverProof, "hash">): string {
  return sha256Hex(canonicalize(p));
}

export function buildCoverProof(
  c: CoverComputation,
  tip: KoiosTip,
  checkedAtMs: number,
): CoverProof {
  if (tip.block_height !== c.height) throw new Error("proof height must be the tip it was read at");
  const body: Omit<CoverProof, "hash"> = {
    v: 1,
    subject: c.subject,
    asset: { policyId: NIGHT.policyId, assetNameHex: NIGHT.assetNameHex, decimals: NIGHT.decimals },
    height: c.height,
    tipHash: tip.hash,
    tipSlot: tip.abs_slot,
    tipTime: tip.block_time,
    utxos: c.included.map((u) => ({
      ref: utxoRef(u.txHash, u.index),
      address: u.address,
      quantity: u.quantity.toString(),
      createdHeight: u.createdHeight,
    })),
    excluded: c.excluded.map((e) => ({
      ref: e.ref,
      reason: e.reason,
      quantity: e.quantity.toString(),
    })),
    coverBase: c.coverBase.toString(),
    checkedAtMs,
  };
  return { ...body, hash: coverProofHash(body) };
}

/** Cover older than 60 s must not back a create (invariant 10). */
export function isCoverFresh(
  p: Pick<CoverProof, "checkedAtMs">,
  nowMs: number,
  maxAgeMs = COVER_MAX_AGE_MS,
): boolean {
  return nowMs - p.checkedAtMs <= maxAgeMs && p.checkedAtMs <= nowMs;
}

const REF_RE = /^[0-9a-f]{64}#\d+$/;
const DIGITS = /^\d+$/;

/** Offline re-check: pin, hash, sums, each UTxO's eligibility, ordering and uniqueness. */
export function verifyCoverProof(p: CoverProof): string[] {
  const failures: string[] = [];
  try {
    const { hash, ...body } = p;
    if (coverProofHash(body) !== hash) failures.push("proof hash does not recompute");
    if (
      p.asset.policyId !== NIGHT.policyId ||
      p.asset.assetNameHex !== NIGHT.assetNameHex ||
      p.asset.decimals !== NIGHT.decimals
    ) {
      failures.push("proof is not for the pinned NIGHT asset");
    }
    let sum = 0n;
    const refs = new Set<string>();
    let prev = "";
    for (const u of p.utxos) {
      if (!REF_RE.test(u.ref)) failures.push(`bad UTxO ref ${u.ref}`);
      if (refs.has(u.ref)) failures.push(`duplicate UTxO ${u.ref}`);
      refs.add(u.ref);
      const key = `${u.ref.slice(0, 64)}#${u.ref.slice(65).padStart(10, "0")}`;
      if (key <= prev) failures.push(`UTxOs out of order at ${u.ref}`);
      prev = key;
      if (!DIGITS.test(u.quantity) || BigInt(u.quantity) === 0n)
        failures.push(`bad quantity at ${u.ref}`);
      else sum += BigInt(u.quantity);
      if (!Number.isSafeInteger(u.createdHeight) || u.createdHeight > p.height) {
        failures.push(`${u.ref} was created after height ${p.height}`);
      }
      const why = addressExclusion(u.address, p.subject);
      if (why !== null) failures.push(`${u.ref} cannot count as cover (${why})`);
    }
    if (!DIGITS.test(p.coverBase) || BigInt(p.coverBase) !== sum)
      failures.push("coverBase is not the sum of its UTxOs");
  } catch (err) {
    failures.push(`malformed proof: ${err instanceof Error ? err.message : String(err)}`);
  }
  return failures;
}

export interface CoverRecheck {
  ok: boolean;
  failures: string[];
  /** UTxOs spent since: still valid at the height if the spend landed after it (see VERIFY). */
  spentSince: string[];
}

/**
 * Online re-check against Koios: every listed UTxO exists at the stated address with the stated
 * pinned-NIGHT quantity and creation height.
 */
export async function recheckCoverProof(
  p: CoverProof,
  koios: Pick<KoiosReader, "utxoInfo">,
): Promise<CoverRecheck> {
  const failures: string[] = [];
  const spentSince: string[] = [];
  const rows = p.utxos.length ? await koios.utxoInfo(p.utxos.map((u) => u.ref)) : [];
  const byRef = new Map(rows.map((r) => [utxoRef(r.tx_hash, r.tx_index), r]));
  for (const u of p.utxos) {
    const r = byRef.get(u.ref);
    if (!r) {
      failures.push(`${u.ref} not found on chain`);
      continue;
    }
    if (r.address !== u.address) failures.push(`${u.ref} is at a different address`);
    if (pinnedNightOf(r).toString() !== u.quantity)
      failures.push(`${u.ref} holds a different NIGHT quantity`);
    if (r.block_height !== u.createdHeight)
      failures.push(`${u.ref} was created at a different height`);
    // VERIFY: utxo_info says only whether a UTxO is spent now, not at which height. A spend
    // after the proof's height leaves the proof valid; proving that needs the spending
    // transaction's block (Koios tx_info on the spender), which v1 does not look up.
    if (r.is_spent === true) spentSince.push(u.ref);
  }
  return { ok: failures.length === 0, failures, spentSince };
}
