import { type MicroUsd, microUsd, type RefPrice, refAtLeastBps } from "@ballast/core";

/**
 * Per-market caps from plan section 5 ("Per-market structure" and "Guard caps"). NIGHT is the
 * KPI market; ADA is an optional carry leg; a future Cardano-native listing comes from config
 * with NIGHT's caps unless it says otherwise.
 */
export interface MarketCaps {
  symbol: string;
  /** Asks sit at or above index × (1 + this). */
  minOffsetBps: bigint;
  maxLevels: number;
  /** Effective leverage (short + resting asks) / equity, ×100. */
  maxLeverageX100: bigint;
  maxEntryBuilderBps: bigint;
  holder0MaxShort: MicroUsd;
  holder0MaxUnpaired: MicroUsd;
  /** Index vs CEX median. */
  referenceSanityBps: bigint;
  /** Armed only while the market trades this far over index (ADA: 5 bps); null = always. */
  armPremiumBps: bigint | null;
  kpi: boolean;
}

export const NIGHT_CAPS: MarketCaps = {
  symbol: "NIGHT-USD",
  minOffsetBps: 38n,
  maxLevels: 3,
  maxLeverageX100: 200n,
  maxEntryBuilderBps: 10n,
  holder0MaxShort: microUsd(2_000_000_000n),
  holder0MaxUnpaired: microUsd(300_000_000n),
  referenceSanityBps: 50n,
  armPremiumBps: null,
  kpi: true,
};

export const ADA_CAPS: MarketCaps = {
  symbol: "ADA-USD",
  minOffsetBps: 5n,
  maxLevels: 1,
  maxLeverageX100: 300n,
  maxEntryBuilderBps: 2n,
  holder0MaxShort: microUsd(1_000_000_000n),
  holder0MaxUnpaired: microUsd(500_000_000n),
  referenceSanityBps: 30n,
  armPremiumBps: 5n,
  kpi: false,
};

export interface ArmListConfig {
  /** Quoted markets in priority order. Listings beyond NIGHT and ADA come from config only. */
  markets: readonly MarketCaps[];
}

export const DEFAULT_ARM_LIST: ArmListConfig = { markets: [NIGHT_CAPS, ADA_CAPS] };

/** A future listing (e.g. SNEK): NIGHT's structure, the same invariant, ≤ 2x and ≤ 10 bps. */
export function listingCaps(symbol: string, over: Partial<Omit<MarketCaps, "symbol">> = {}) {
  if (!/^[A-Z0-9]+-USD$/.test(symbol)) throw new TypeError(`bad listing symbol ${symbol}`);
  return { ...NIGHT_CAPS, kpi: true, ...over, symbol } satisfies MarketCaps;
}

export interface ArmInput {
  index: RefPrice | null;
  mark: RefPrice | null;
  /** Live funding estimate vs the holder's floor, for the ADA carry leg (null = no floor). */
  fundingAtOrAboveFloor?: boolean | null;
}

export type ArmDecision = { armed: true } | { armed: false; reason: string };

export function capsFor(cfg: ArmListConfig, symbol: string): MarketCaps | undefined {
  return cfg.markets.find((m) => m.symbol === symbol);
}

/**
 * Whether a market may be quoted at all right now. Unknown symbols never are. A market with an
 * arm premium (ADA) is armed only while its mark is ≥ index × (1 + premium) and funding is not
 * below the holder's floor: Ballast sells only into a market that trades over index.
 */
export function armDecision(cfg: ArmListConfig, symbol: string, input: ArmInput): ArmDecision {
  const caps = capsFor(cfg, symbol);
  if (!caps) return { armed: false, reason: `${symbol} is not on the arm list` };
  if (!input.index || !input.mark || input.index.num <= 0n || input.mark.num <= 0n) {
    return { armed: false, reason: "no index or mark" };
  }
  if (caps.armPremiumBps !== null) {
    if (!refAtLeastBps(input.mark, input.index, caps.armPremiumBps)) {
      return {
        armed: false,
        reason: `${symbol} trades less than ${caps.armPremiumBps} bps over index`,
      };
    }
    if (input.fundingAtOrAboveFloor === false) {
      return { armed: false, reason: "funding is below the holder's floor" };
    }
  }
  return { armed: true };
}
