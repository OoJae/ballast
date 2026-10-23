import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultQuotePolicy, safeParseQuotePolicy } from "@ballast/core";
import { HostKek, openSealedKey, readSealedKey, signPolicy } from "@ballast/governance";
import { DEFAULT_KEK_PATH } from "./keys.js";

const USAGE = `usage: ballast policy draft --out <file> [--market NIGHT-USD|ADA-USD] [--from ISO|now]
                           [--hours 1-24] [--prev <policy hash>]
       ballast policy sign --draft <file> --key <sealed operator key> --out-dir <dir> [--kek <path>]
  draft writes the plan's default QuotePolicy (section 5) with a fresh ULID, for the operator to
  edit. sign parses it strictly, signs it with the operator key and writes <policyId>.policy.json
  into the keeper's BALLAST_POLICY_DIR. Signing never activates anything: the keeper still runs the
  Critic, and only a PASS activates the policy.`;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48-bit ms timestamp, then 80 random bits, in Crockford base32. */
export function newUlid(nowMs: number, rand: (n: number) => Uint8Array = randomBytes): string {
  let t = BigInt(nowMs);
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = (CROCKFORD[Number(t % 32n)] as string) + time;
    t /= 32n;
  }
  let r = BigInt(`0x${Buffer.from(rand(10)).toString("hex")}`);
  let random = "";
  for (let i = 0; i < 16; i++) {
    random = (CROCKFORD[Number(r % 32n)] as string) + random;
    r /= 32n;
  }
  return time + random;
}

export function policyMain(args: readonly string[], env = process.env, now = Date.now): number {
  const [sub, ...rest] = args;
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (sub === "draft") return draft(flag, now());
  if (sub === "sign") return sign(flag, env, now());
  console.error(USAGE);
  return 2;
}

function draft(flag: (n: string) => string | undefined, nowMs: number): number {
  const out = flag("--out");
  const market = flag("--market") ?? "NIGHT-USD";
  const from = flag("--from") ?? "now";
  const hours = Number(flag("--hours") ?? "24");
  const prev = flag("--prev") ?? null;
  if (!out || (market !== "NIGHT-USD" && market !== "ADA-USD")) {
    console.error(USAGE);
    return 2;
  }
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) {
    console.error("--hours must be an integer from 1 to 24");
    return 2;
  }
  const validFromMs = from === "now" ? nowMs : Date.parse(from);
  if (!Number.isFinite(validFromMs)) {
    console.error(`--from: not a date: ${from}`);
    return 2;
  }
  if (existsSync(out)) {
    console.error(`refusing: ${out} already exists`);
    return 2;
  }
  const policy = defaultQuotePolicy({
    policyId: newUlid(nowMs),
    validFromMs,
    validForMs: hours * 3_600_000,
    market,
    prevPolicyHash: prev,
  });
  writeFileSync(out, `${JSON.stringify(policy, null, 2)}\n`);
  console.log(
    `draft ${policy.policyId} (${market}) written to ${out}\n` +
      `valid ${new Date(policy.validFromMs).toISOString()} → ${new Date(policy.validUntilMs).toISOString()}`,
  );
  return 0;
}

function sign(flag: (n: string) => string | undefined, env: NodeJS.ProcessEnv, nowMs: number) {
  const draftPath = flag("--draft");
  const keyPath = flag("--key");
  const outDir = flag("--out-dir");
  if (!draftPath || !keyPath || !outDir) {
    console.error(USAGE);
    return 2;
  }
  const parsed = safeParseQuotePolicy(JSON.parse(readFileSync(draftPath, "utf8")));
  if (!parsed.ok) {
    console.error(`refusing to sign: ${parsed.error}`);
    return 2;
  }
  const policy = parsed.policy;
  if (policy.validUntilMs <= nowMs) {
    console.error("refusing to sign: the policy window has already ended");
    return 2;
  }
  const out = join(outDir, `${policy.policyId}.policy.json`);
  if (existsSync(out)) {
    console.error(`refusing: ${out} already exists (signed policies are never overwritten)`);
    return 2;
  }
  const kek = HostKek.load(flag("--kek") ?? env.BALLAST_KEK_PATH ?? DEFAULT_KEK_PATH);
  const operator = openSealedKey(readSealedKey(keyPath), kek, "operator");
  const signed = signPolicy(policy, operator);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(out, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o644 });
  console.log(
    `signed policy ${signed.hash}\n  operator ${signed.operatorPubkey}\n  written to ${out}\n` +
      "The keeper sends it to the Critic at start; only a PASS activates it.",
  );
  return 0;
}
