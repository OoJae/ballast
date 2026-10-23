import {
  AddressError,
  bech32Decode,
  type CardanoNetwork,
  type ParsedAddress,
  parseAddress,
  stakeAddressOf,
} from "@ballast/cover";

/**
 * Server-side address facts, on top of @ballast/cover's CIP-19 parser (the one the cover oracle
 * and the stake binding already trust), so onboarding and cover can never disagree about which
 * stake key an address belongs to.
 */
export interface HolderAddress {
  /** Canonical lowercase bech32. */
  address: string;
  /** Raw address bytes as hex: the CIP-8 `address` header carries these. */
  bytesHex: string;
  network: CardanoNetwork;
  paymentKeyHash: string;
  stakeAddress: string;
}

/**
 * A holder address is a Shelley base address with key-hash payment and stake credentials: the
 * payment key signs CIP-8 messages and transactions, the stake key is what cover binds to.
 */
export function holderAddress(text: string): HolderAddress {
  const address = text.trim().toLowerCase();
  const p: ParsedAddress = parseAddress(address);
  if (p.type !== "base") {
    throw new AddressError("a holder address must be a base address (payment + stake key)");
  }
  if (p.payment.kind !== "key") throw new AddressError("the payment credential must be a key");
  if (p.stake.kind !== "key") throw new AddressError("the stake credential must be a key");
  return {
    address,
    bytesHex: Buffer.from(bech32Decode(address).bytes).toString("hex"),
    network: p.network,
    paymentKeyHash: p.payment.hashHex,
    stakeAddress: stakeAddressOf(p.stake, p.network),
  };
}

/** The payment key hash of any key-payment Shelley address (base, enterprise or pointer). */
export function paymentKeyHashOf(text: string): string | null {
  const p = parseAddress(text.trim());
  if (p.type === "byron" || p.type === "reward") return null;
  return p.payment.kind === "key" ? p.payment.hashHex : null;
}

/** Raw bytes of a bech32 address, hex. */
export function addressBytesHex(text: string): string {
  return Buffer.from(bech32Decode(text.trim()).bytes).toString("hex");
}

/** Strike: build-tx's `user_address` may be "any address with the same payment key". */
export function samePaymentKey(a: string, b: string): boolean {
  const ka = paymentKeyHashOf(a);
  return ka !== null && ka === paymentKeyHashOf(b);
}
