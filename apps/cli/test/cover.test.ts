import { describe, expect, it } from "vitest";
import { coverMain, nightToBase, parseCoverArgs } from "../src/cover.js";
import { fakeKoios, HOME, STAKE } from "./fixture.js";

describe("ballast cover", () => {
  it("parses NIGHT amounts exactly, with no floats", () => {
    expect(nightToBase("520")).toBe(520_000_000n);
    expect(nightToBase("0.000001")).toBe(1n);
    expect(nightToBase("12.5")).toBe(12_500_000n);
    expect(() => nightToBase("1.0000001")).toThrow();
    expect(() => nightToBase("-1")).toThrow();
    expect(() => nightToBase("1e3")).toThrow();
  });

  it("parses arguments; there is no flag to change the asset", () => {
    expect(parseCoverArgs([HOME])).toEqual({ input: HOME, rBps: 5000, shortBase: 0n, json: false });
    expect(parseCoverArgs(["--", STAKE, "--r-bps", "9000", "--short", "520"])).toMatchObject({
      rBps: 9000,
      shortBase: 520_000_000n,
    });
    expect(() => parseCoverArgs([HOME, "--r-bps", "9500"])).toThrow(/0\.\.9000/);
    expect(() => parseCoverArgs([HOME, "--policy", "abc"])).toThrow();
    expect(() => parseCoverArgs([])).toThrow(/usage/);
  });

  it("reports cover, capacity and the proof for an address", async () => {
    let out = "";
    const code = await coverMain([HOME, "--short", "520"], {
      koios: fakeKoios(),
      now: () => 1,
      out: (s) => {
        out += s;
      },
      env: {},
    });
    expect(code).toBe(0);
    expect(out).toContain(`subject       ${STAKE}`);
    expect(out).toContain("cover         25500.000000 NIGHT in 2 spendable UTxO(s)");
    expect(out).toContain("K = 0.50 × 25500.000000 − 520.000000 = 12230.000000 NIGHT");
    expect(out).toMatch(/block height {2}100 /);
  });

  it("emits JSON with the full proof", async () => {
    let out = "";
    await coverMain([STAKE, "--json"], {
      koios: fakeKoios(),
      now: () => 1,
      out: (s) => {
        out += s;
      },
      env: {},
    });
    const j = JSON.parse(out);
    expect(j).toMatchObject({
      rBps: 5000,
      capacityBase: "12750000000",
      proof: { coverBase: "25500000000", height: 100 },
    });
  });
});
