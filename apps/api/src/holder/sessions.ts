import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type HolderAddress,
  holderAddress,
  signInMessage,
  utf8ToHex,
  verifyCip8,
} from "@ballast/cardano";
import type { SessionWire, SignRequestWire } from "../holder-types.js";
import { HolderError } from "./errors.js";

/**
 * Sign-In-With-Cardano: the server writes a CIP-8 challenge naming the domain, the wallet and a
 * fresh nonce; the wallet signs it; the server checks the COSE signature against that address
 * and issues a bearer token. The token lives only in the page's memory, so nothing
 * auto-connects and a reload signs in again.
 */
export interface HolderSession {
  address: string;
  stakeAddress: string;
  paymentKeyHash: string;
  accountId: string | null;
  expiresAtMs: number;
}

/** Messages waiting for exactly one wallet signature, each with a short life. */
export class PendingSignatures<T> {
  private readonly items = new Map<string, { req: SignRequestWire; data: T }>();

  constructor(
    private readonly now: () => number,
    private readonly ttlMs: number,
    private readonly max = 10_000,
  ) {}

  add(message: string, data: T, nonce: string = randomUUID()): SignRequestWire {
    this.sweep();
    if (this.items.size >= this.max) {
      const oldest = this.items.keys().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
    const req = {
      nonce,
      message,
      payload: utf8ToHex(message),
      expiresAtMs: this.now() + this.ttlMs,
    };
    this.items.set(nonce, { req, data });
    return req;
  }

  /** Single use: the entry is gone whether or not the signature that follows is good. */
  take(nonce: unknown): { req: SignRequestWire; data: T } {
    const item = typeof nonce === "string" ? this.items.get(nonce) : undefined;
    if (typeof nonce === "string") this.items.delete(nonce);
    if (!item || item.req.expiresAtMs <= this.now()) {
      throw new HolderError(400, "that signing request is unknown or expired: start again");
    }
    return item;
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, v] of this.items) if (v.req.expiresAtMs <= now) this.items.delete(k);
  }
}

export interface SessionOptions {
  now: () => number;
  domain: string;
  network: "mainnet" | "testnet";
  ttlMs?: number;
  challengeTtlMs?: number;
}

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export class HolderSessions {
  private readonly sessions = new Map<string, HolderSession>();
  private readonly challenges: PendingSignatures<HolderAddress>;

  constructor(private readonly opts: SessionOptions) {
    this.challenges = new PendingSignatures(opts.now, opts.challengeTtlMs ?? 5 * 60_000);
  }

  /** Parses a holder address and checks its network; one wallet account, payment + stake key. */
  parseAddress(address: unknown): HolderAddress {
    let h: HolderAddress;
    try {
      h = holderAddress(String(address ?? ""));
    } catch (err) {
      throw new HolderError(400, err instanceof Error ? err.message : "not a Cardano address");
    }
    if (h.network !== this.opts.network) {
      throw new HolderError(400, `this Ballast takes ${this.opts.network} wallets`);
    }
    return h;
  }

  challenge(address: unknown): SignRequestWire {
    const h = this.parseAddress(address);
    const nonce = randomUUID();
    const message = signInMessage({
      domain: this.opts.domain,
      address: h.address,
      stakeAddress: h.stakeAddress,
      nonce,
      issuedAtMs: this.opts.now(),
    });
    return this.challenges.add(message, h, nonce);
  }

  signIn(
    nonce: unknown,
    signature: unknown,
    accountFor: (stake: string) => string | null,
  ): SessionWire {
    const { req, data: h } = this.challenges.take(nonce);
    const v = verifyCip8(String(signature ?? ""), { address: h.address, payloadHex: req.payload });
    if (!v.ok) throw new HolderError(401, `sign-in signature refused: ${v.reason}`);
    const token = randomBytes(32).toString("base64url");
    const s: HolderSession = {
      address: h.address,
      stakeAddress: h.stakeAddress,
      paymentKeyHash: h.paymentKeyHash,
      accountId: accountFor(h.stakeAddress),
      expiresAtMs: this.opts.now() + (this.opts.ttlMs ?? 30 * 60_000),
    };
    this.sessions.set(hashToken(token), s);
    return {
      token,
      expiresAtMs: s.expiresAtMs,
      address: s.address,
      stakeAddress: s.stakeAddress,
      accountId: s.accountId,
    };
  }

  /** The session behind an `Authorization: Bearer` header, or a 401. */
  require(authorization: string | undefined): HolderSession {
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    const s = m ? this.sessions.get(hashToken(m[1] as string)) : undefined;
    if (!s || s.expiresAtMs <= this.opts.now()) {
      if (m) this.sessions.delete(hashToken(m[1] as string));
      throw new HolderError(401, "sign in with your wallet first");
    }
    return s;
  }

  end(authorization: string | undefined): void {
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    if (m) this.sessions.delete(hashToken(m[1] as string));
  }
}
