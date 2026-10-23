import { describe, expect, it } from "vitest";
import { parseAccounts } from "../src/accounts-file.js";
import { describeKeeperConfig, loadKeeperConfig, resolveArming } from "../src/config.js";
import { operator, stakeAddressFor } from "./harness.js";

/** Invariant 3: DRY_RUN by default; mainnet creates need ARM=1 AND --mainnet; half-armed refused. */
const OP = { BALLAST_OPERATOR_PUBKEYS: operator.publicKeyHex };

describe("arming (invariant 3)", () => {
  it("DRY_RUN is the default", () => {
    const c = loadKeeperConfig({});
    expect(c.mode).toBe("dry-run");
    expect(c.dryRun).toBe(true);
    expect(c.armed).toBe(false);
  });

  it("arms only with DRY_RUN=false + BALLAST_ARM=1 + --mainnet (and an operator key)", () => {
    const c = loadKeeperConfig({ DRY_RUN: "false", BALLAST_ARM: "1", ...OP }, ["--mainnet"]);
    expect(c.mode).toBe("armed");
  });

  it("refuses every half-armed combination, naming what is missing", () => {
    const cases: [Record<string, string>, string[]][] = [
      [{ BALLAST_ARM: "1" }, []],
      [{ BALLAST_ARM: "1" }, ["--mainnet"]],
      [{}, ["--mainnet"]],
      [{ DRY_RUN: "false", BALLAST_ARM: "1", ...OP }, []],
      [{ DRY_RUN: "false", ...OP }, ["--mainnet"]],
      [{ DRY_RUN: "false", BALLAST_NETWORK: "preprod", ...OP }, []],
    ];
    for (const [env, argv] of cases) {
      expect(() => loadKeeperConfig(env, argv), JSON.stringify([env, argv])).toThrow(/Refusing/);
    }
    for (const a of [
      { dryRun: true, armed: true, mainnetFlag: false },
      { dryRun: false, armed: false, mainnetFlag: true },
      { dryRun: true, armed: false, mainnetFlag: true },
    ]) {
      expect(() => resolveArming(a)).toThrow(/half-armed/);
    }
  });

  it("strict enums: a typo fails loudly instead of arming", () => {
    expect(() => loadKeeperConfig({ DRY_RUN: "flase" })).toThrow(/Invalid environment/);
    expect(() => loadKeeperConfig({ BALLAST_ARM: "yes" })).toThrow(/Invalid environment/);
    expect(() => loadKeeperConfig({}, ["--armed"])).toThrow(/unknown argument/);
  });

  it("armed creates go to Strike's own hosts only", () => {
    expect(() =>
      loadKeeperConfig(
        { DRY_RUN: "false", BALLAST_ARM: "1", STRIKE_API_URL: "http://127.0.0.1:9999", ...OP },
        ["--mainnet"],
      ),
    ).toThrow(/non-Strike host/);
  });

  it("loading Strike keys needs the eligible-host attestation (hosting rule)", () => {
    expect(() => loadKeeperConfig({ BALLAST_ACCOUNTS_FILE: "accounts.json" })).toThrow(
      /restricted jurisdictions/,
    );
    expect(
      loadKeeperConfig({ BALLAST_ACCOUNTS_FILE: "accounts.json", BALLAST_ELIGIBLE_HOST: "1" })
        .eligibleHost,
    ).toBe(true);
  });

  it("describeKeeperConfig never prints a secret", () => {
    const c = loadKeeperConfig({
      TELEGRAM_BOT_TOKEN: "123456:SECRETSECRET",
      TELEGRAM_CHAT_ID: "1",
    });
    expect(JSON.stringify(describeKeeperConfig(c))).not.toContain("SECRET");
  });
});

describe("accounts file (identifiers come only from config)", () => {
  const entry = {
    accountId: "019a0c2e-1111-7000-8000-000000000001",
    stakeAddress: stakeAddressFor("acct"),
    strikeKeyFile: "data/keys/a.json",
  };
  it("parses with fail-safe defaults (r 0.5, fee 0 until D0/D2)", () => {
    const [a] = parseAccounts([entry]);
    expect(a?.rBps).toBe(5_000n);
    expect(a?.approvedBuilderBps).toBe(0);
    expect(a?.holder0).toBe(false);
  });
  it("refuses a stake credential bound twice, r above 0.9 and unknown fields", () => {
    expect(() => parseAccounts([entry, { ...entry, accountId: "other" }])).toThrow(/bound twice/);
    expect(() => parseAccounts([{ ...entry, rBps: 9_500 }])).toThrow();
    expect(() => parseAccounts([{ ...entry, vault_id: "x" }])).toThrow();
  });
});
