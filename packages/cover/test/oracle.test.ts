import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CoverOracle,
  type CoverProof,
  capacityBase,
  computeCover,
  coverProofHash,
  formatNight,
  isCoverFresh,
  type KoiosReader,
  type KoiosTip,
  type KoiosUtxo,
  NIGHT,
  recheckCoverProof,
  subjectFor,
  verifyCoverProof,
} from "../src/index.js";
import {
  baseAddr,
  enterpriseAddr,
  h32,
  LOOKALIKE_POLICY,
  night,
  pointerAddr,
  stakeAddr,
  utxo,
} from "./synth.js";

const STAKE = stakeAddr("holder");
const subject = { kind: "stake" as const, stakeAddress: STAKE };
const HOME = baseAddr("holder-pay", "holder");
const HOME2 = baseAddr("holder-pay-2", "holder");

/** One wallet seen through Koios account_utxos, with every case the oracle must handle. */
function walletUtxos(): KoiosUtxo[] {
  return [
    utxo("a", HOME, [night(25_000_000_000n)]),
    utxo("b", HOME2, [night(1_500_000n), night(9_999_000_000n, LOOKALIKE_POLICY)]),
    utxo("vesting", baseAddr("vesting-script", "holder", ["script", "key"]), [
      night(70_000_000_000n),
    ]),
    utxo("lookalike-only", HOME, [night(5_000_000_000n, LOOKALIKE_POLICY)]),
    utxo("ada-only", HOME, []),
    utxo("other-stake", baseAddr("holder-pay", "someone-else"), [night(3_000_000n)]),
    utxo("pointer", pointerAddr("holder-pay"), [night(4_000_000n)]),
    utxo("enterprise", enterpriseAddr("holder-pay"), [night(6_000_000n)]),
    utxo("testnet", baseAddr("holder-pay", "holder", ["key", "key"], false), [night(7_000_000n)]),
    utxo("spent", HOME, [night(8_000_000n)], { is_spent: true }),
    utxo("future", HOME, [night(9_000_000n)], { block_height: 101 }),
    utxo("no-height", HOME, [night(10_000_000n)], { block_height: null }),
    utxo("a", HOME, [night(25_000_000_000n)]),
    utxo("multi", HOME, [night(1n), night(2n)], { tx_index: 3 }),
  ];
}

describe("cover oracle math on synthetic UTxO sets", () => {
  it("counts only pinned NIGHT at key-hash base addresses on the bound stake key, at the height", () => {
    const c = computeCover(subject, walletUtxos(), 100);
    expect(c.coverBase).toBe(25_000_000_000n + 1_500_000n + 3n);
    expect(c.included.map((u) => u.txHash)).toEqual([h32("a"), h32("b"), h32("multi")].sort());
    const reasons = Object.fromEntries(c.excluded.map((e) => [e.ref.slice(0, 64), e.reason]));
    expect(reasons).toEqual({
      [h32("vesting")]: "script-payment",
      [h32("other-stake")]: "other-stake",
      [h32("pointer")]: "pointer",
      [h32("enterprise")]: "enterprise",
      [h32("testnet")]: "wrong-network",
      [h32("spent")]: "spent",
      [h32("future")]: "after-height",
      [h32("no-height")]: "unknown-height",
      [h32("a")]: "duplicate",
    });
    // Lookalike "NIGHT" tokens are seen, reported and never counted.
    expect(c.lookalikeBase).toBe(9_999_000_000n + 5_000_000_000n);
    expect(formatNight(c.coverBase)).toBe("25001.500003");
  });

  it("is order-independent and deterministic", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(walletUtxos(), { minLength: 0 }), (subset) => {
        const a = computeCover(subject, subset, 100);
        const b = computeCover(subject, [...subset].reverse(), 100);
        return a.coverBase === b.coverBase && a.included.length === b.included.length;
      }),
    );
  });

  it("property: cover equals the sum over eligible UTxOs, whatever else is mixed in", () => {
    const eligible = fc.record({
      q: fc.bigInt({ min: 1n, max: 10n ** 15n }),
      i: fc.nat({ max: 50 }),
    });
    const noise = fc.constantFrom(
      (q: bigint, i: number) =>
        utxo(`v${i}`, baseAddr(`s${i}`, "holder", ["script", "key"]), [night(q)]),
      (q: bigint, i: number) => utxo(`o${i}`, baseAddr(`p${i}`, `x${i}`), [night(q)]),
      (q: bigint, i: number) => utxo(`l${i}`, HOME, [night(q, LOOKALIKE_POLICY)]),
      (q: bigint, i: number) => utxo(`f${i}`, HOME, [night(q)], { block_height: 101 + i }),
    );
    fc.assert(
      fc.property(
        fc.uniqueArray(eligible, { selector: (e) => e.i, maxLength: 20 }),
        fc.array(fc.tuple(noise, eligible), { maxLength: 20 }),
        (good, bad) => {
          const set = [
            ...good.map((g) => utxo(`g${g.i}`, g.i % 2 ? HOME : HOME2, [night(g.q)])),
            ...bad.map(([mk, e]) => mk(e.q, e.i)),
          ];
          const expected = good.reduce((s, g) => s + g.q, 0n);
          return computeCover(subject, set, 100).coverBase === expected;
        },
      ),
    );
  });

  it("capacity K = r·cover − short, floored, with r ≤ 0.9", () => {
    expect(capacityBase(25_000_000_000n, 5000, 520_000_000n)).toBe(12_500_000_000n - 520_000_000n);
    expect(capacityBase(3n, 5000, 0n)).toBe(1n);
    expect(capacityBase(10n, 5000, 6n)).toBe(-1n);
    expect(() => capacityBase(1n, 9001, 0n)).toThrow(/0\.\.9000/);
    expect(() => capacityBase(1n, 0.5, 0n)).toThrow();
    expect(() => capacityBase(-1n, 5000, 0n)).toThrow();
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.integer({ min: 0, max: 9000 }),
        (cover, r) => {
          const k = capacityBase(cover, r, 0n);
          return (
            k <= (cover * 9n) / 10n &&
            k * 10_000n <= cover * BigInt(r) &&
            (k + 1n) * 10_000n > cover * BigInt(r)
          );
        },
      ),
    );
  });

  it("resolves inputs to a stake credential; refuses pointer and testnet inputs", () => {
    expect(subjectFor(HOME)).toEqual(subject);
    expect(subjectFor(STAKE)).toEqual(subject);
    expect(subjectFor(enterpriseAddr("solo"))).toEqual({
      kind: "address",
      address: enterpriseAddr("solo"),
    });
    expect(() => subjectFor(pointerAddr("x"))).toThrow(/pointer/);
    expect(() => subjectFor(stakeAddr("x", "key", false))).toThrow(/mainnet/);
  });
});

function fakeKoios(tips: KoiosTip[], utxos: KoiosUtxo[]): KoiosReader & { calls: string[] } {
  let t = 0;
  const calls: string[] = [];
  return {
    calls,
    tip: async () => {
      calls.push("tip");
      return tips[Math.min(t++, tips.length - 1)] as KoiosTip;
    },
    accountUtxos: async (s) => {
      calls.push(`account_utxos:${s.join(",")}`);
      return utxos;
    },
    addressUtxos: async () => utxos,
    utxoInfo: async (refs) => utxos.filter((u) => refs.includes(`${u.tx_hash}#${u.tx_index}`)),
    txMetadata: async () => [],
  };
}

const tip = (height: number): KoiosTip => ({
  hash: h32(`block-${height}`),
  epoch_no: 663,
  abs_slot: 200_000_000 + height,
  block_height: height,
  block_time: 1_792_000_000 + height * 20,
});

describe("CoverOracle and Proof of Cover", () => {
  it("reads at one consistent tip and emits a recomputable proof", async () => {
    const k = fakeKoios([tip(100), tip(101), tip(101), tip(101)], walletUtxos());
    const proof = await new CoverOracle(k, { now: () => 1_000 }).proof(HOME);
    // The tip moved during the first read, so the oracle read again at 101.
    expect(proof.height).toBe(101);
    expect(k.calls.filter((c) => c === "tip")).toHaveLength(4);
    expect(k.calls).toContain(`account_utxos:${STAKE}`);
    expect(proof.asset).toEqual({
      policyId: NIGHT.policyId,
      assetNameHex: NIGHT.assetNameHex,
      decimals: 6,
    });
    expect(verifyCoverProof(proof)).toEqual([]);
    expect(isCoverFresh(proof, 61_000)).toBe(true);
    expect(isCoverFresh(proof, 61_001)).toBe(false);
  });

  it("gives up rather than mix heights when the tip never settles", async () => {
    const k = fakeKoios(
      [tip(1), tip(2), tip(3), tip(4), tip(5), tip(6), tip(7), tip(8), tip(9)],
      [],
    );
    await expect(new CoverOracle(k, { maxTipRetries: 2 }).proof(HOME)).rejects.toThrow(
      /kept moving/,
    );
  });

  it("tamper: any edit to a proof fails verification", async () => {
    const proof = await new CoverOracle(fakeKoios([tip(100)], walletUtxos()), {
      now: () => 1,
    }).proof(STAKE);
    const edits: ((p: CoverProof) => void)[] = [
      (p) => {
        (p.utxos[0] as { quantity: string }).quantity = "26000000000";
      },
      (p) => {
        p.coverBase = "1";
      },
      (p) => {
        p.height = 50;
      },
      (p) => {
        p.asset.policyId = LOOKALIKE_POLICY;
      },
      (p) => {
        p.utxos.push({
          ref: `${h32("vesting")}#0`,
          address: baseAddr("vesting-script", "holder", ["script", "key"]),
          quantity: "1",
          createdHeight: 1,
        });
      },
      (p) => {
        p.subject = { kind: "stake", stakeAddress: stakeAddr("thief") };
      },
    ];
    for (const edit of edits) {
      const copy = structuredClone(proof);
      edit(copy);
      expect(verifyCoverProof(copy).length, String(edit)).toBeGreaterThan(0);
    }
    // Even with the hash recomputed, the content checks still catch a forged UTxO.
    const forged = structuredClone(proof);
    forged.utxos.push({
      ref: `${"f".repeat(64)}#0`,
      address: baseAddr("vesting-script", "holder", ["script", "key"]),
      quantity: "5",
      createdHeight: 1,
    });
    forged.coverBase = String(BigInt(forged.coverBase) + 5n);
    const { hash: _x, ...body } = forged;
    forged.hash = coverProofHash(body);
    expect(verifyCoverProof(forged)).toEqual([expect.stringMatching(/script-payment/)]);
  });

  it("online re-check: refs exist with the same quantities; later spends are reported", async () => {
    const set = walletUtxos();
    const proof = await new CoverOracle(fakeKoios([tip(100)], set), { now: () => 1 }).proof(STAKE);
    expect(await recheckCoverProof(proof, fakeKoios([tip(100)], set))).toEqual({
      ok: true,
      failures: [],
      spentSince: [],
    });
    const later = set.map((u) => (u.tx_hash === h32("b") ? { ...u, is_spent: true } : u));
    expect((await recheckCoverProof(proof, fakeKoios([tip(100)], later))).spentSince).toEqual([
      `${h32("b")}#0`,
    ]);
    const shrunk = set.map((u) => (u.tx_hash === h32("a") ? { ...u, asset_list: [night(1n)] } : u));
    expect((await recheckCoverProof(proof, fakeKoios([tip(100)], shrunk))).failures).toEqual([
      `${h32("a")}#0 holds a different NIGHT quantity`,
    ]);
  });
});
