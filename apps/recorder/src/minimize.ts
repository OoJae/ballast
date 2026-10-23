import type { LivePositions } from "@ballast/strike-client";

/** The fields the liquidation-aware floor needs, and nothing that identifies a trader. */
export interface FloorPosition {
  id: number;
  symbol: string;
  size: string;
  entry_price: string;
  mark_price: string;
  leverage: number;
  margin_mode: string;
  isolated_margin: string;
  liquidation_price: string;
  is_vault: boolean;
  create_timestamp: number;
}

/**
 * Live positions are public, but each row carries a wallet address, an ADA handle and an
 * account id. The recorder keeps only the recorded symbols and the fields the floor needs,
 * so recordings (and any evidence bundle published from them) identify no one.
 */
export function minimizeLivePositions(
  payload: LivePositions,
  symbols: readonly string[],
): { updated_at: number; positions: FloorPosition[] } {
  const wanted = new Set(symbols);
  return {
    updated_at: payload.updated_at,
    positions: payload.positions
      .filter((p) => wanted.has(p.symbol))
      .map((p) => ({
        id: p.id,
        symbol: p.symbol,
        size: p.size,
        entry_price: p.entry_price,
        mark_price: p.mark_price,
        leverage: p.leverage,
        margin_mode: p.margin_mode,
        isolated_margin: p.isolated_margin,
        liquidation_price: p.liquidation_price,
        is_vault: p.vault_id !== "",
        create_timestamp: p.create_timestamp,
      })),
  };
}
