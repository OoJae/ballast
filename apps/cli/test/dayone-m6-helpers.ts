import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeStrike } from "@ballast/fake-strike";
import { HostKek, StrikeKey, writeSealedKey } from "@ballast/governance";

/**
 * Test rig for the day-one scripts: a fake Strike on loopback (the only override the scripts
 * accept), a temp KEK and a sealed key per account. Nothing here can reach real Strike.
 */
export interface DayOneRig {
  fake: FakeStrike;
  dir: string;
  env: NodeJS.ProcessEnv;
  account(label: string, family?: string): { id: string; keyFile: string };
  evidence(): Record<string, unknown>[];
  stop(): Promise<void>;
}

export const BTC_RULES = {
  symbol: "BTC-USD",
  order_tick_price: "0.1",
  order_limit_step_size: "0.00001",
};

export async function dayOneRig(): Promise<DayOneRig> {
  const fake = new FakeStrike({ priceIntervalMs: 50 });
  await fake.start();
  const dir = mkdtempSync(join(tmpdir(), "ballast-dayone-"));
  const kekPath = join(dir, "host.kek");
  const kek = HostKek.create(kekPath);
  return {
    fake,
    dir,
    env: {
      BALLAST_DAYONE_API_URL: fake.baseUrl,
      BALLAST_DAYONE_WS_URL: fake.wsOrigin,
      BALLAST_KEK_PATH: kekPath,
    },
    account(label, family) {
      const key = StrikeKey.generate();
      const keyFile = join(dir, `${label}.strike.json`);
      writeSealedKey(keyFile, key.seal(kek));
      const id = `acct-${label}`;
      fake.addAccount({
        publicKeyHex: key.publicKeyHex,
        accountId: id,
        ...(family ? { family } : {}),
      });
      return { id, keyFile };
    },
    evidence() {
      const out = join(dir, "out");
      try {
        return readdirSync(out).map((f) => JSON.parse(readFileSync(join(out, f), "utf8")));
      } catch {
        return [];
      }
    },
    stop: () => fake.stop(),
  };
}

/** A fetch that fails the test if a dry run ever touches the network. */
export function forbidNetwork(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("a dry run must not touch the network");
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}
