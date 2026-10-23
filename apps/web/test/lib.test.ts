import { randomBytes } from "node:crypto";
import { chainHash, merkleRootHex as nodeMerkle } from "@ballast/evidence";
import { describe, expect, it } from "vitest";
import { checkCardanoAddress } from "../src/lib/address.js";
import { fmtPctFrom, fmtUsd } from "../src/lib/format.js";
import { chainHashHex, checkChain, merkleRootHex } from "../src/lib/verify.js";

const hex = () => randomBytes(32).toString("hex");

describe("in-browser evidence check", () => {
  it("recomputes the recorder's RFC 6962 roots exactly", async () => {
    for (const n of [0, 1, 2, 3, 5, 8, 13]) {
      const leaves = Array.from({ length: n }, hex);
      expect(await merkleRootHex(leaves)).toBe(nodeMerkle(leaves));
    }
  });

  it("recomputes the recorder's chain links exactly", async () => {
    const root = hex();
    expect(await chainHashHex(null, "2026-10-23T00", root)).toBe(
      chainHash(null, "2026-10-23T00", root),
    );
    const prev = hex();
    expect(await chainHashHex(prev, "2026-10-23T01", root)).toBe(
      chainHash(prev, "2026-10-23T01", root),
    );
  });

  it("flags a broken root, link or leaf list", async () => {
    const mk = async (hour: string, prev: string | null) => {
      const leaves = [hex(), hex()];
      const root = nodeMerkle(leaves);
      return {
        hour,
        root,
        prev,
        chain: chainHash(prev, hour, root),
        leaves,
        segments: leaves.map((sha256) => ({ sha256 })),
      };
    };
    const a = await mk("2026-10-23T00", null);
    const b = await mk("2026-10-23T01", a.chain);
    const good = await checkChain([a, b]);
    expect(good.every((c) => c.rootOk && c.chainOk && c.linkOk && c.leavesMatch)).toBe(true);

    const tampered = { ...b, leaves: [hex(), b.leaves[1] as string] };
    const [, bad] = await checkChain([a, tampered]);
    expect(bad).toMatchObject({ rootOk: false, leavesMatch: false });
    const [, unlinked] = await checkChain([a, { ...b, prev: hex() }]);
    expect(unlinked).toMatchObject({ linkOk: false, chainOk: false });
  });
});

describe("Cardano address check", () => {
  it("accepts CIP-19 mainnet vectors", () => {
    expect(
      checkCardanoAddress(
        "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x",
      ),
    ).toMatchObject({ ok: true, kind: "address" });
    expect(
      checkCardanoAddress("stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw"),
    ).toMatchObject({ ok: true, kind: "stake" });
  });

  it("rejects typos, testnet and other chains", () => {
    const good =
      "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x";
    expect(checkCardanoAddress(`${good.slice(0, -1)}y`).ok).toBe(false);
    expect(checkCardanoAddress(good.replace("qx2f", "qx2b")).ok).toBe(false);
    expect(checkCardanoAddress("addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jh").ok).toBe(
      false,
    );
    expect(checkCardanoAddress("0x52908400098527886E0F7030069857D2E4169EE7").ok).toBe(false);
    expect(checkCardanoAddress("").ok).toBe(false);
    expect(checkCardanoAddress("addr1QX2fxv").ok).toBe(false);
  });
});

describe("format", () => {
  it("formats money and distances", () => {
    expect(fmtUsd(15_699.9)).toBe("$15,700");
    expect(fmtUsd(15_699.9, { compact: true })).toBe("$15.7K");
    expect(fmtUsd(null)).toBe("—");
    expect(fmtPctFrom(0.0385, 0.03832)).toBe("+0.47%");
    expect(fmtPctFrom(0.0381, 0.03832)).toBe("−0.57%");
  });
});
