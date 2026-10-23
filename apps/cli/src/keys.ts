import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AnchorWalletKey, HostKek, StrikeKey, writeSealedKey } from "@ballast/governance";
import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";

export const DEFAULT_KEK_PATH = join(homedir(), ".ballast", "host.kek");

const USAGE = `usage: ballast keys new-strike --out <file> [--kek <path>]
       ballast keys new-anchor --network <preprod|mainnet> --out <file> [--kek <path>]
  Generates an Ed25519 Strike API-wallet key, seals it under the host KEK (created with mode
  0600 if missing; default ${DEFAULT_KEK_PATH} or $BALLAST_KEK_PATH) and prints ONLY the public key.
  Register that public key on the Strike app's API Wallets page. The private key never leaves the
  sealed file. new-anchor seals a CIP-20 anchor wallet key the same way and prints its enterprise
  address, to fund from a faucet (preprod) or with at most 20 ADA (mainnet).`;

/** `ballast keys new-strike`: an API wallet for day-one tests, sealed at rest (invariant 25). */
export function keysMain(args: readonly string[], env = process.env): number {
  const [sub, ...rest] = args;
  if (sub !== "new-strike" && sub !== "new-anchor") {
    console.error(USAGE);
    return 2;
  }
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const out = flag("--out");
  if (!out) {
    console.error(USAGE);
    return 2;
  }
  if (existsSync(out)) {
    console.error(`refusing: ${out} already exists (sealed keys are never overwritten)`);
    return 2;
  }
  const kekPath = flag("--kek") ?? env.BALLAST_KEK_PATH ?? DEFAULT_KEK_PATH;
  const created = !existsSync(kekPath);
  const kek = created ? HostKek.create(kekPath) : HostKek.load(kekPath);
  const kekNote = created ? `created host KEK ${kekPath} (mode 0600)\n` : "";
  if (sub === "new-anchor") {
    const network = flag("--network");
    if (network !== "preprod" && network !== "mainnet") {
      console.error(USAGE);
      return 2;
    }
    const key = AnchorWalletKey.generate();
    writeSealedKey(out, key.seal(kek));
    console.log(
      `${kekNote}sealed anchor key: ${out}\n${network} address: ${anchorAddress(key, network)}`,
    );
    return 0;
  }
  const key = StrikeKey.generate();
  writeSealedKey(out, key.seal(kek));
  console.log(
    `${kekNote}sealed Strike key: ${out}\npublic key (register this on the API Wallets page): ${key.publicKeyHex}`,
  );
  return 0;
}

/** The anchor wallet's enterprise address: inputs and change for CIP-20 anchors both live here. */
export function anchorAddress(key: AnchorWalletKey, network: "preprod" | "mainnet"): string {
  const keyHash = key.useSeed((seed) => CSL.PrivateKey.from_normal_bytes(seed).to_public().hash());
  return CSL.EnterpriseAddress.new(
    network === "mainnet" ? 1 : 0,
    CSL.Credential.from_keyhash(keyHash),
  )
    .to_address()
    .to_bech32(undefined);
}
