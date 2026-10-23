import type { SourceDef } from "./components/Sources";

/**
 * The few numbers that do not come from Ballast's API, each with where it came from. Everything
 * else on the site is fetched from the API and traced to sealed recordings.
 */
export const NIGHT_HOLDERS = 86_040;
export const NIGHT_POLICY = "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa";
export const NIGHT_ASSET = "4e49474854";
export const RECORDER_START = "2026-10-23 00:49 UTC";

export const HOLDERS_SOURCE: SourceDef = {
  id: "holders",
  title:
    "Koios, staked Cardano wallets holding NIGHT at the registry-pinned policy, counted by stake credential, 22 Oct 2026",
  text: (
    <>
      Staked Cardano wallets holding NIGHT: Koios (public Cardano indexer), counted by stake
      credential at the registry-pinned NIGHT asset (policy{" "}
      <span className="hash">{NIGHT_POLICY}</span>, asset name <code>{NIGHT_ASSET}</code>), snapshot
      of 22 Oct 2026. The cover oracle will recount it live.
    </>
  ),
};

export const API_LINK = (path: string) => (
  <a href={path} className="mono">
    GET {path}
  </a>
);
