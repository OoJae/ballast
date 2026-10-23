import { createPrivateKey, createPublicKey, type KeyObject, randomBytes, sign } from "node:crypto";
import type { Cip30Api, DataSignature, InjectedRoot } from "../cip30.js";
import { addressHexToBech32, bytesToHex, hexToBytes, utf8ToHex, WalletError } from "../cip30.js";
import { bodySha256, holderProofMessage } from "../messages.js";
import { blake2b224, blake2b256 } from "./blake2b.js";
import * as C from "./cbor.js";

/**
 * A CIP-30 wallet in Node, for tests and dry runs only: no real wallet, no value. Its COSE and
 * witness encodings, key hashes and transaction ids come from this package's own CBOR and
 * BLAKE2b code, never from the Emurgo libraries the verifiers use, so a passing round trip means
 * two independent implementations agree.
 */
const PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

class Ed25519Key {
  readonly publicKey: Uint8Array;
  readonly #key: KeyObject;

  constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new TypeError("seed must be 32 bytes");
    this.#key = createPrivateKey({
      key: Buffer.concat([PKCS8_SEED_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
    const spki = createPublicKey(this.#key).export({ format: "der", type: "spki" });
    this.publicKey = Uint8Array.from(spki.subarray(spki.length - 32));
  }

  sign(message: Uint8Array): Uint8Array {
    return Uint8Array.from(sign(null, message, this.#key));
  }
}

export interface TestUtxo {
  txHash: string;
  index: number;
  lovelace: bigint;
  assets?: { policyId: string; assetNameHex: string; quantity: bigint }[];
}

/** One-shot changes to the next signData, for refusal tests. */
export interface SignDataTweaks {
  /** Address bytes to put in the protected header instead of the requested address. */
  headerAddressHex?: string;
  /** Sign with the stake key or an unrelated key instead of the payment key. */
  key?: "payment" | "stake" | "stranger";
  /** Mark the payload as hashed (CIP-8 `hashed: true`) and sign its blake2b-224. */
  hashed?: boolean;
  /** Algorithm id in the protected header (EdDSA is -8). */
  alg?: number;
  /** Flip one bit of the signature. */
  corrupt?: boolean;
  /** Sign this payload instead of the requested one. */
  payloadHex?: string;
}

export interface TestWalletOptions {
  network?: "mainnet" | "testnet";
  utxos?: TestUtxo[];
  paymentSeed?: Uint8Array;
  stakeSeed?: Uint8Array;
}

export class TestWallet implements Cip30Api {
  readonly network: "mainnet" | "testnet";
  readonly addressHex: string;
  readonly address: string;
  readonly rewardAddressHex: string;
  readonly stakeAddress: string;
  readonly paymentKeyHash: string;
  readonly stakeKeyHash: string;
  readonly paymentPublicKeyHex: string;
  readonly submitted: { txHex: string; txHash: string }[] = [];
  utxos: TestUtxo[];
  nextSignData: SignDataTweaks | undefined;
  signDataCalls = 0;
  signTxCalls = 0;
  readonly #payment: Ed25519Key;
  readonly #stake: Ed25519Key;
  readonly #stranger = new Ed25519Key(randomBytes(32));

  constructor(opts: TestWalletOptions = {}) {
    this.network = opts.network ?? "mainnet";
    this.#payment = new Ed25519Key(opts.paymentSeed ?? randomBytes(32));
    this.#stake = new Ed25519Key(opts.stakeSeed ?? randomBytes(32));
    const net = this.network === "mainnet" ? 1 : 0;
    const pay = blake2b224(this.#payment.publicKey);
    const stake = blake2b224(this.#stake.publicKey);
    this.paymentKeyHash = bytesToHex(pay);
    this.stakeKeyHash = bytesToHex(stake);
    this.paymentPublicKeyHex = bytesToHex(this.#payment.publicKey);
    // CIP-19 type 0: base address, key payment credential, key stake credential.
    this.addressHex = bytesToHex(Uint8Array.from([net, ...pay, ...stake]));
    this.rewardAddressHex = bytesToHex(Uint8Array.from([0xe0 | net, ...stake]));
    this.address = addressHexToBech32(this.addressHex);
    this.stakeAddress = addressHexToBech32(this.rewardAddressHex);
    this.utxos = opts.utxos ?? [
      { txHash: bytesToHex(randomBytes(32)), index: 0, lovelace: 250_000_000n },
      { txHash: bytesToHex(randomBytes(32)), index: 1, lovelace: 40_000_000n },
    ];
  }

  /** `window`-like root with this wallet injected as `id` (Lace by default). */
  root(id = "lace"): InjectedRoot {
    return {
      cardano: { [id]: { name: id, icon: "", apiVersion: "0.1.0", enable: async () => this } },
    };
  }

  async getNetworkId(): Promise<number> {
    return this.network === "mainnet" ? 1 : 0;
  }

  async getUtxos(): Promise<string[]> {
    return this.utxos.map((u) => bytesToHex(C.encode(utxoCbor(u, hexToBytes(this.addressHex)))));
  }

  async getUsedAddresses(): Promise<string[]> {
    return [this.addressHex];
  }

  async getChangeAddress(): Promise<string> {
    return this.addressHex;
  }

  async getRewardAddresses(): Promise<string[]> {
    return [this.rewardAddressHex];
  }

  async signData(addr: string, payload: string): Promise<DataSignature> {
    this.signDataCalls += 1;
    const tweaks = this.nextSignData ?? {};
    this.nextSignData = undefined;
    const own = addr.toLowerCase() === this.addressHex || addr.toLowerCase() === this.address;
    // Wallets refuse to sign for an address they do not hold (CIP-30 DataSignError).
    if (!own) throw new WalletError("ProofGeneration: address not in this wallet");
    const headerAddr = hexToBytes(tweaks.headerAddressHex ?? this.addressHex);
    let body = hexToBytes(tweaks.payloadHex ?? payload);
    if (tweaks.hashed) body = blake2b224(body);
    const protectedBytes = C.encode(
      C.map([
        [C.uint(1), C.int(tweaks.alg ?? -8)],
        [C.text("address"), C.bytes(headerAddr)],
      ]),
    );
    const toSign = C.encode(
      C.array([
        C.text("Signature1"),
        C.bytes(protectedBytes),
        C.bytes(new Uint8Array()),
        C.bytes(body),
      ]),
    );
    const key =
      tweaks.key === "stake"
        ? this.#stake
        : tweaks.key === "stranger"
          ? this.#stranger
          : this.#payment;
    const sig = key.sign(toSign);
    if (tweaks.corrupt) sig[0] = (sig[0] ?? 0) ^ 1;
    const sign1 = C.array([
      C.bytes(protectedBytes),
      C.map([[C.text("hashed"), C.bool(tweaks.hashed === true)]]),
      C.bytes(body),
      C.bytes(sig),
    ]);
    const coseKey = C.map([
      [C.uint(1), C.uint(1)],
      [C.uint(3), C.nint(-8)],
      [C.nint(-1), C.uint(6)],
      [C.nint(-2), C.bytes(key.publicKey)],
    ]);
    return { signature: bytesToHex(C.encode(sign1)), key: bytesToHex(C.encode(coseKey)) };
  }

  /** CIP-30 signTx: returns only a witness set with this wallet's payment-key signature. */
  async signTx(tx: string, _partialSign = false): Promise<string> {
    this.signTxCalls += 1;
    const hash = blake2b256(txBodyBytes(tx));
    const witness = C.array([C.bytes(this.#payment.publicKey), C.bytes(this.#payment.sign(hash))]);
    return bytesToHex(C.encode(C.map([[C.uint(0), C.array([witness])]])));
  }

  async submitTx(tx: string): Promise<string> {
    const txHash = bytesToHex(blake2b256(txBodyBytes(tx)));
    this.submitted.push({ txHex: tx, txHash });
    return txHash;
  }
}

/** The exact body bytes of a transaction (item 0 of the top-level array). */
export function txBodyBytes(txHex: string): Uint8Array {
  const bytes = hexToBytes(txHex);
  const top = C.decode(bytes);
  const body = top.items?.[0];
  if (top.value.t !== "array" || !body) throw new WalletError("not a transaction");
  return bytes.slice(body.start, body.end);
}

/** Independent transaction id: blake2b-256 of the body bytes as encoded. */
export function independentTxHash(txHex: string): string {
  return bytesToHex(blake2b256(txBodyBytes(txHex)));
}

/** CIP-30 `TransactionUnspentOutput`: [input, legacy output]. */
export function utxoCbor(u: TestUtxo, address: Uint8Array): C.Cbor {
  const value =
    u.assets && u.assets.length > 0
      ? C.array([
          C.uint(u.lovelace),
          C.map(
            u.assets.map((a) => [
              C.bytes(hexToBytes(a.policyId)),
              C.map([[C.bytes(hexToBytes(a.assetNameHex)), C.uint(a.quantity)]]),
            ]),
          ),
        ])
      : C.uint(u.lovelace);
  return C.array([
    C.array([C.bytes(hexToBytes(u.txHash)), C.uint(u.index)]),
    C.array([C.bytes(address), value]),
  ]);
}

export interface HolderProof {
  /** hex(utf8(holder proof message)). */
  payload: string;
  /** `coseSign1Hex:coseKeyHex`. */
  signature: string;
}

/** What the web app does before each funding call: sign a proof for exactly this body. */
export async function signHolderProof(
  wallet: Cip30Api & { address: string },
  f: { accountId: string; path: string; body: unknown; issuedAtMs?: number; nonce?: string },
): Promise<HolderProof> {
  const message = holderProofMessage({
    accountId: f.accountId,
    address: wallet.address,
    method: "POST",
    path: f.path,
    bodySha256: await bodySha256(f.body),
    issuedAtMs: f.issuedAtMs ?? Date.now(),
    nonce: f.nonce ?? crypto.randomUUID(),
  });
  const payload = utf8ToHex(message);
  const ds = await wallet.signData(wallet.address, payload);
  return { payload, signature: `${ds.signature}:${ds.key}` };
}
