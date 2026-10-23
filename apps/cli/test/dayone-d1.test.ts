import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, PLAN } from "../src/dayone/d1-testnet-semantics.js";
import { BTC_RULES, type DayOneRig, dayOneRig, forbidNetwork } from "./dayone-m6-helpers.js";

let rig: DayOneRig | undefined;
afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

describe("D1 testnet semantics", () => {
  it("defaults to a dry run: prints the plan and pass condition, writes evidence, no network", async () => {
    rig = await dayOneRig();
    const restore = forbidNetwork();
    let text = "";
    try {
      const r = await main(["--out", join(rig.dir, "out")], {}, (s) => {
        text += s;
      });
      expect(r.pass).toBeNull();
    } finally {
      restore();
    }
    expect(text).toContain("PASS CONDITION:");
    expect(text).toContain(PLAN.pass);
    expect(text).toContain("strike-testnet");
    const [ev] = rig.evidence();
    expect(ev?.mode).toBe("dry-run");
    expect(JSON.stringify(ev?.wouldSend)).toContain("post_only");
  });

  it("refuses --live without approval and the hosting attestation", async () => {
    rig = await dayOneRig();
    await expect(main(["--live"], rig.env, () => {})).rejects.toThrow(
      /--yes-i-approve.*--eligible-host/,
    );
    await expect(main(["--live", "--yes-i-approve"], rig.env, () => {})).rejects.toThrow(
      /eligible-host/,
    );
  });

  it("only a loopback override of the testnet host is accepted", async () => {
    rig = await dayOneRig();
    const env = { ...rig.env, BALLAST_DAYONE_API_URL: "https://evil.example" };
    await expect(
      main(
        ["--live", "--yes-i-approve", "--eligible-host", "--account", "a", "--key", "k"],
        env,
        () => {},
      ),
    ).rejects.toThrow(/loopback/);
  });

  it("the live procedure passes against the fake, which implements the documented semantics", async () => {
    rig = await dayOneRig();
    rig.fake.market.marketsPayload = { "BTC-USD": BTC_RULES };
    rig.fake.engine.restMarketOrder("BTC-USD", "buy", "99000", "1");
    rig.fake.engine.restMarketOrder("BTC-USD", "sell", "100000", "1");
    const a = rig.account("d1");
    const r = await main(
      [
        "--live",
        "--yes-i-approve",
        "--eligible-host",
        "--account",
        a.id,
        "--key",
        a.keyFile,
        "--out",
        join(rig.dir, "out"),
      ],
      rig.env,
      () => {},
    );
    const ev = rig.evidence()[0] as { results: Record<string, { ok?: boolean }> };
    expect(ev.results.staticFailure?.ok).toBe(true);
    expect(ev.results.crossMidBatch?.ok).toBe(true);
    expect(ev.results.unknownSymbol?.ok).toBe(true);
    expect(r.pass).toBe(true);
    expect(rig.fake.engine.workingOrders(a.id)).toEqual([]);
  }, 60_000);
});
