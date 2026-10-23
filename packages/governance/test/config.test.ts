import { describe, expect, it } from "vitest";
import { describeConfig, loadGovernanceConfig, redactUrl, scrubUrl } from "../src/index.js";

const PK = "a".repeat(64);

describe("invariant 3: DRY_RUN by default; mainnet creates need BALLAST_ARM=1", () => {
  it("defaults to dry run, unarmed, mainnet, the latest Claude model, Advisor off", () => {
    const c = loadGovernanceConfig({});
    expect(c).toMatchObject({
      network: "mainnet",
      dryRun: true,
      armed: false,
      trustedOperators: [],
    });
    expect(c.advisor).toEqual({ enabled: false, model: "claude-opus-5-5" });
  });

  it("refuses a half-armed mainnet start", () => {
    expect(() => loadGovernanceConfig({ DRY_RUN: "false", BALLAST_OPERATOR_PUBKEYS: PK })).toThrow(
      /requires BALLAST_ARM=1/,
    );
    expect(
      loadGovernanceConfig({ DRY_RUN: "false", BALLAST_ARM: "1", BALLAST_OPERATOR_PUBKEYS: PK }),
    ).toMatchObject({ dryRun: false, armed: true, trustedOperators: [PK] });
    // preprod may run live without ARM, but never without an operator key.
    expect(() => loadGovernanceConfig({ BALLAST_NETWORK: "preprod", DRY_RUN: "false" })).toThrow(
      /BALLAST_OPERATOR_PUBKEYS/,
    );
  });

  it("strict enums: typos fail loudly instead of arming", () => {
    for (const env of [
      { DRY_RUN: "flase" },
      { DRY_RUN: "TRUE" },
      { BALLAST_ARM: "yes" },
      { BALLAST_NETWORK: "testnet" },
    ]) {
      expect(() => loadGovernanceConfig(env)).toThrow(/Invalid environment/);
    }
    expect(loadGovernanceConfig({ DRY_RUN: "" }).dryRun).toBe(true);
  });

  it("validates operator keys and the Advisor's prerequisites", () => {
    expect(() => loadGovernanceConfig({ BALLAST_OPERATOR_PUBKEYS: "xyz" })).toThrow(/64-hex/);
    expect(() => loadGovernanceConfig({ BALLAST_OPERATOR_PUBKEYS: `${PK},${PK}` })).toThrow(
      /duplicate/,
    );
    expect(() => loadGovernanceConfig({ BALLAST_ADVISOR: "on" })).toThrow(/ANTHROPIC_API_KEY/);
    const c = loadGovernanceConfig({
      BALLAST_ADVISOR: "on",
      ANTHROPIC_API_KEY: "sk-ant-secret-123",
    });
    expect(c.advisor.enabled).toBe(true);
    expect(JSON.stringify(describeConfig(c))).not.toContain("sk-ant-secret-123");
  });
});

describe("URL redaction (ported)", () => {
  it("elides key-bearing paths from logs and error text", () => {
    expect(redactUrl("https://api.koios.rest")).toBe("https://api.koios.rest");
    expect(redactUrl("https://gw.example/v1/SECRET")).toBe("https://gw.example/…");
    expect(redactUrl("not a url")).toBe("[unparseable-url]");
    expect(
      scrubUrl("failed: https://gw.example/v1/SECRET timed out", "https://gw.example/v1/SECRET"),
    ).toBe("failed: https://gw.example/… timed out");
  });
});
