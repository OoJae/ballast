import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bech32Encode, type KoiosReader, type KoiosUtxo, NIGHT } from "@ballast/cover";
import { REFERENCE_MARKETS } from "@ballast/engine";
import { afterEach, describe, expect, it } from "vitest";
import * as d2 from "../src/dayone/d2-builder-attribution.js";
import * as d3 from "../src/dayone/d3-builder-fee-on-maker.js";
import * as d6 from "../src/dayone/d6-mark-probe.js";
import * as d7 from "../src/dayone/d7-kill-latency.js";
import * as d8 from "../src/dayone/d8-socket-and-rate-limits.js";
import * as d10 from "../src/dayone/d10-cover-oracle.js";
import { type DayOneRig, dayOneRig, forbidNetwork } from "./dayone-m6-helpers.js";

/**
 * The M6 day-one scripts are BUILT and dry-run tested only; nothing here reaches Strike or
 * Cardano. Live procedures run against @ballast/fake-strike on loopback (the only override the
 * scripts accept) to prove the code paths, and D10 against a synthetic Koios reader.
 */
let rig: DayOneRig | undefined;
afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

const SCRIPTS = [d2, d3, d6, d7, d8, d10];
const GO = ["--live", "--yes-i-approve", "--eligible-host"];

function nightRig(r: DayOneRig): void {
  r.fake.market.marketsPayload = { ...REFERENCE_MARKETS };
  r.fake.market.setPrice("NIGHT-USD", { mark: "0.03835", index: "0.0383" });
  r.fake.engine.restMarketOrder("NIGHT-USD", "buy", "0.0383", "400000");
  r.fake.engine.restMarketOrder("NIGHT-USD", "sell", "0.03875", "30000");
}

describe("M6 day-one scripts: dry run is the default and touches nothing", () => {
  for (const s of SCRIPTS) {
    it(`${s.PLAN.id} prints its plan and the section 11 pass condition and writes evidence`, async () => {
      rig = await dayOneRig();
      const restore = forbidNetwork();
      let text = "";
      try {
        const r = await s.main(["--out", join(rig.dir, "out")], {}, (x) => {
          text += x;
        });
        expect(r.pass).toBeNull();
      } finally {
        restore();
      }
      expect(text).toContain(`${s.PLAN.id}: ${s.PLAN.title}`);
      expect(text).toContain(`PASS CONDITION: ${s.PLAN.pass}`);
      for (const step of s.PLAN.steps) expect(text).toContain(step);
      expect(text).toContain("DRY RUN: nothing was sent");
      const [ev] = rig.evidence();
      expect(ev?.mode).toBe("dry-run");
      expect(ev?.id).toBe(s.PLAN.id);
      expect(rig.fake.requests).toEqual([]);
    });
  }

  it("refuses unknown flags and --dry-run with --live", async () => {
    await expect(d7.main(["--trails", "3"], {}, () => {})).rejects.toThrow(/unknown argument/);
    await expect(d7.main(["--dry-run", "--live"], {}, () => {})).rejects.toThrow(/not both/);
  });
});

describe("M6 day-one scripts: the mainnet gate", () => {
  for (const s of SCRIPTS) {
    it(`${s.PLAN.id} --live needs --yes-i-approve, --eligible-host and BALLAST_ARM=1`, async () => {
      rig = await dayOneRig();
      await expect(s.main(["--live"], rig.env, () => {})).rejects.toThrow(/BALLAST_ARM=1/);
      await expect(s.main([...GO], rig.env, () => {})).rejects.toThrow(/missing BALLAST_ARM=1/);
      await expect(
        s.main(["--live", "--yes-i-approve"], { ...rig.env, BALLAST_ARM: "1" }, () => {}),
      ).rejects.toThrow(/eligible-host/);
      expect(rig.fake.requests).toEqual([]);
    });
  }
});

describe("M6 day-one scripts: live procedures against the fake", () => {
  it("D2 reads Builder{Code:ballast, FeeBps:10} on both routes and cleans up", async () => {
    rig = await dayOneRig();
    nightRig(rig);
    const a = rig.account("d2");
    const r = await d2.main(
      [...GO, "--account", a.id, "--key", a.keyFile, "--out", join(rig.dir, "out")],
      { ...rig.env, BALLAST_ARM: "1" },
      () => {},
    );
    const ev = rig.evidence()[0] as { attribution: { ok: boolean; publicBuilder: unknown }[] };
    expect(ev.attribution.map((x) => x.publicBuilder)).toEqual([
      { Code: "ballast", FeeBps: 10 },
      { Code: "ballast", FeeBps: 10 },
    ]);
    expect(r.pass).toBe(true);
    expect(rig.fake.engine.workingOrders(a.id)).toEqual([]);
  }, 60_000);

  it("D3 records the maker's builder_fee when the (simulated) human probe lifts the ask", async () => {
    rig = await dayOneRig();
    nightRig(rig);
    const a = rig.account("d3");
    const builder = rig.account("builder");
    rig.fake.balances.set(builder.id, "100");
    const x = rig;
    const r = await d3.main(
      [
        ...GO,
        "--account",
        a.id,
        "--key",
        a.keyFile,
        "--builder-account",
        builder.id,
        "--builder-key",
        builder.keyFile,
        "--wait-min",
        "1",
        "--out",
        join(rig.dir, "out"),
      ],
      { ...rig.env, BALLAST_ARM: "1" },
      (line) => {
        const m = /buy (\d+) NIGHT-USD at ([\d.]+)/.exec(line);
        if (m) {
          // The probe from another master family takes the ask; the builder is paid.
          setTimeout(() => {
            x.fake.engine.marketTake("NIGHT-USD", "buy", m[1] as string, m[2] as string);
            x.fake.balances.set(builder.id, "100.01");
          }, 300);
        }
      },
    );
    const ev = rig.evidence()[0] as { fill: { builderFee: string; maker: boolean } | null };
    expect(ev.fill?.maker).toBe(true);
    expect(ev.fill?.builderFee).toMatch(/[1-9]/);
    expect(r.pass).toBe(true);
  }, 90_000);

  it("D7 times cancel-all to CANCELED and to L3 removal, with concurrent watchdog cancels", async () => {
    rig = await dayOneRig();
    nightRig(rig);
    const a = rig.account("d7");
    const r = await d7.main(
      [
        ...GO,
        "--account",
        a.id,
        "--key",
        a.keyFile,
        "--trials",
        "4",
        "--concurrent-every",
        "2",
        "--out",
        join(rig.dir, "out"),
      ],
      { ...rig.env, BALLAST_ARM: "1" },
      () => {},
    );
    const ev = rig.evidence()[0] as {
      trials: { concurrent: boolean; streamMs: number | null; l3Ms: number | null }[];
      l3: { n: number; p50: number; p99: number };
    };
    expect(ev.trials).toHaveLength(4);
    expect(ev.trials.filter((t) => t.concurrent)).toHaveLength(2);
    expect(ev.trials.every((t) => t.streamMs !== null && t.l3Ms !== null)).toBe(true);
    expect(ev.l3.n).toBe(4);
    expect(r.pass).toBe(true);
  }, 90_000);

  it("D8 runs bounded socket rounds and spaced replace-batches, recording what Strike answers", async () => {
    rig = await dayOneRig();
    nightRig(rig);
    const a = rig.account("d8");
    const r = await d8.main(
      [
        ...GO,
        "--account",
        a.id,
        "--key",
        a.keyFile,
        "--rounds",
        "2,3",
        "--batches",
        "2",
        "--spacing-ms",
        "2000",
        "--round-pause-ms",
        "10",
        "--out",
        join(rig.dir, "out"),
      ],
      { ...rig.env, BALLAST_ARM: "1" },
      () => {},
    );
    const ev = rig.evidence()[0] as {
      sockets: { n: number; live: number }[];
      replaceBatches: { status: number }[];
    };
    expect(ev.sockets).toEqual([
      { n: 2, live: 2, refused: [] },
      { n: 3, live: 3, refused: [] },
    ]);
    expect(ev.replaceBatches.map((b) => b.status)).toEqual([200, 200]);
    expect(r.pass).toBe(true);
    expect(rig.fake.engine.workingOrders(a.id)).toEqual([]);
  }, 90_000);

  it("D10 measures block arrivals, enforces a single binding and shows a spend drops r to 0", async () => {
    rig = await dayOneRig();
    const h = (l: string, n: number) => createHash("sha256").update(l).digest("hex").slice(0, n);
    const stake = bech32Encode(
      "stake",
      Uint8Array.from([0xe1, ...Buffer.from(h("stake", 56), "hex")]),
    );
    const addr = bech32Encode(
      "addr",
      Uint8Array.from([
        0x01,
        ...Buffer.from(h("pay", 56), "hex"),
        ...Buffer.from(h("stake", 56), "hex"),
      ]),
    );
    const t0 = Date.now();
    const height = () => 12_000_000 + Math.floor((Date.now() - t0) / 400);
    const koios: KoiosReader = {
      tip: async () => ({
        hash: h(`tip${height()}`, 64),
        epoch_no: 600,
        abs_slot: height() * 20,
        block_height: height(),
        block_time: Math.floor(Date.now() / 1000),
      }),
      accountUtxos: async (): Promise<KoiosUtxo[]> => [
        {
          tx_hash: h("utxo", 64),
          tx_index: 0,
          address: addr,
          value: "2000000",
          block_height: 11_999_000,
          asset_list: [
            { policy_id: NIGHT.policyId, asset_name: NIGHT.assetNameHex, quantity: "25000000000" },
          ],
          is_spent: false,
        },
      ],
      addressUtxos: async () => [],
      utxoInfo: async () => [],
      txMetadata: async () => [],
    };
    const r = await d10.main(
      [
        ...GO,
        "--stake",
        stake,
        "--addresses",
        addr,
        "--minutes",
        "0.05",
        "--every-s",
        "0.2",
        "--out",
        join(rig.dir, "out"),
      ],
      { BALLAST_ARM: "1" },
      () => {},
      { koios },
    );
    const ev = rig.evidence()[0] as {
      binding: { memoryRefused: boolean; dbRefused: boolean };
      blockArrivals: number;
      mempool: { matcherRZero: boolean };
      lastCoverBase: string;
    };
    expect(ev.binding).toEqual({ memoryRefused: true, dbRefused: true });
    expect(ev.blockArrivals).toBeGreaterThanOrEqual(3);
    expect(ev.mempool.matcherRZero).toBe(true);
    expect(ev.lastCoverBase).toBe("25000000000");
    expect(r.pass).toBe(true);
  }, 60_000);

  it("D6's dry run fits the replica on recordings when given them (read-only)", async () => {
    rig = await dayOneRig();
    const fixture = fileURLToPath(
      new URL("../../../packages/market/test/fixtures/rec", import.meta.url),
    );
    const restore = forbidNetwork();
    try {
      await d6.main(
        ["--recordings", fixture, "--hours", "2", "--out", join(rig.dir, "out")],
        {},
        () => {},
      );
    } finally {
      restore();
    }
    const ev = rig.evidence()[0] as { wouldSend: { fit: unknown } };
    expect(ev.wouldSend.fit).toBeDefined();
  }, 120_000);
});
