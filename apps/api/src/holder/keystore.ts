import { join } from "node:path";
import {
  type HostKek,
  openSealedKey,
  readSealedKey,
  type SealedKey,
  StrikeKey,
  writeSealedKey,
} from "@ballast/governance";
import { ApiWalletSigner } from "@ballast/strike-client";

/**
 * The holder role's API wallets: generated here, sealed at rest under the host KEK (AES-256-GCM,
 * role and public key bound as AAD), and opened only into an ApiWalletSigner. Only the public
 * key is ever sent to Strike; neither the seed nor the sealed blob leaves this process.
 */
export class HolderKeyStore {
  constructor(
    private readonly dir: string,
    private readonly kek: HostKek,
  ) {}

  /** A fresh key per Builder Connect: Strike refuses a key it has seen (500). */
  generate(nowMs: number): { publicKeyHex: string; sealed: SealedKey } {
    const key = StrikeKey.generate();
    return { publicKeyHex: key.publicKeyHex, sealed: key.seal(this.kek, nowMs) };
  }

  /** Writes the sealed key once (0600, never overwritten) and returns its path. */
  persist(accountId: string, sealed: SealedKey): string {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(accountId)) throw new Error("unexpected Strike account id");
    const path = join(this.dir, accountId, `${sealed.publicKeyHex}.json`);
    writeSealedKey(path, sealed);
    return path;
  }

  signer(source: string | SealedKey): ApiWalletSigner {
    const sealed = typeof source === "string" ? readSealedKey(source) : source;
    const key = openSealedKey(sealed, this.kek, "strike");
    return key.useSeed((seed) => ApiWalletSigner.fromSeed(seed));
  }
}
