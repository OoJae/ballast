import { randomBytes } from "node:crypto";
import { FakeStrike, type FakeStrikeOptions } from "@ballast/fake-strike";
import {
  ApiWalletSigner,
  apiTimeSource,
  createPublicHttp,
  RateLimiter,
  ServerClock,
  SignedClient,
  type SignedClientOptions,
  type SignerProfile,
} from "../src/index.js";

export const UA = "ballast-test/0.1";

/** RFC 8032 section 7.1, test 1. */
export const RFC8032_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
export const RFC8032_PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

export interface Harness {
  fake: FakeStrike;
  signer: ApiWalletSigner;
  accountId: string;
  clock: ServerClock;
  rate: RateLimiter;
  client: SignedClient;
  makeClient: (over?: Partial<SignedClientOptions>) => SignedClient;
  stop: () => Promise<void>;
}

export async function startHarness(
  opts: {
    fake?: FakeStrikeOptions;
    profile?: SignerProfile;
    family?: string;
    client?: Partial<SignedClientOptions>;
  } = {},
): Promise<Harness> {
  const fake = new FakeStrike(opts.fake);
  await fake.start();
  const signer = ApiWalletSigner.fromSeed(randomBytes(32));
  const accountId = `acct-${signer.publicKeyHex.slice(0, 8)}`;
  fake.addAccount({
    publicKeyHex: signer.publicKeyHex,
    accountId,
    approvedBuilderFeeBps: 10,
    ...(opts.family ? { family: opts.family } : {}),
  });
  const clock = new ServerClock({
    fetchServerTimeMs: apiTimeSource(createPublicHttp({ baseUrl: fake.baseUrl, userAgent: UA })),
    samples: 3,
  });
  await clock.sync();
  // Start each test with only its own requests in the log.
  fake.requests.length = 0;
  const rate = new RateLimiter();
  const makeClient = (over: Partial<SignedClientOptions> = {}) =>
    new SignedClient({
      baseUrl: fake.baseUrl,
      userAgent: UA,
      signer,
      clock,
      profile: opts.profile ?? "AUTONOMOUS",
      rate,
      account: accountId,
      builderFee: { capBps: 10, defaultBps: 10 },
      sleep: async () => {},
      ...opts.client,
      ...over,
    });
  return {
    fake,
    signer,
    accountId,
    clock,
    rate,
    client: makeClient(),
    makeClient,
    stop: () => fake.stop(),
  };
}

/** Add a second account to a running fake (another master family unless `family` is given). */
export function addAccount(h: Harness, family?: string) {
  const signer = ApiWalletSigner.fromSeed(randomBytes(32));
  const accountId = `acct-${signer.publicKeyHex.slice(0, 8)}`;
  const account = h.fake.addAccount({
    publicKeyHex: signer.publicKeyHex,
    accountId,
    ...(family ? { family } : {}),
  });
  const client = new SignedClient({
    baseUrl: h.fake.baseUrl,
    userAgent: UA,
    signer,
    clock: h.clock,
    profile: "AUTONOMOUS",
    rate: new RateLimiter(),
    account: accountId,
    sleep: async () => {},
  });
  return { signer, accountId, account, client };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
