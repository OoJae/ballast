import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadKeeperConfig } from "../../keeper/src/config.js";
import { daemonKey } from "../../keeper/test/harness.js";
import { loadWatchdogConfig } from "../src/config.js";
import { ROOT } from "./graph.js";

/** deploy/: the units default to a dry run, carry the hosting rule, and the env templates parse. */
const read = (f: string) => readFileSync(join(ROOT, "deploy", f), "utf8");

function envFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1] as string] = m[2] as string;
  }
  return env;
}

describe("deploy templates", () => {
  for (const unit of ["ballast-keeper.service", "ballast-watchdog.service"]) {
    it(`${unit} states the hosting rule and starts in DRY_RUN (no live --mainnet line)`, () => {
      const text = read(unit);
      expect(text).toMatch(/NOT in any of Strike's restricted\s*\n?#?\s*jurisdictions/);
      expect(text).toContain("https://www.strikefinance.org/restricted");
      expect(text).toMatch(/never through a VPN or proxy/i);
      const live = text.split("\n").filter((l) => l.startsWith("ExecStart="));
      expect(live).toHaveLength(1);
      expect(live[0]).not.toContain("--mainnet");
    });
  }

  it("keeper.env.example loads as a dry run with no keys", () => {
    const c = loadKeeperConfig(envFile(read("keeper.env.example")));
    expect(c.mode).toBe("dry-run");
    expect(c.accountsFile).toBeNull();
    expect(c.eligibleHost).toBe(false);
  });

  it("watchdog.env.example refuses to start until the keeper's daemon key is pinned", () => {
    const env = envFile(read("watchdog.env.example"));
    expect(() => loadWatchdogConfig(env)).toThrow(/BALLAST_TRUSTED_DAEMONS/);
    const c = loadWatchdogConfig({ ...env, BALLAST_TRUSTED_DAEMONS: daemonKey.publicKeyHex });
    expect(c.mode).toBe("dry-run");
    expect(c.heartbeat.deadlineMs).toBe(10_000);
  });
});
