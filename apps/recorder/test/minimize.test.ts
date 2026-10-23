import type { LivePosition } from "@ballast/strike-client";
import { describe, expect, it } from "vitest";
import { minimizeLivePositions } from "../src/minimize.js";

const row = (over: Partial<LivePosition>): LivePosition => ({
  id: 1,
  create_timestamp: 1,
  account_id: "acct",
  blockchain_address: "addr1qxyz",
  ada_handle: "handle",
  vault_id: "",
  symbol: "NIGHT-USD",
  margin_mode: "cross",
  leverage: 10,
  size: "10004",
  entry_price: "0.04",
  mark_price: "0.0382",
  margin: "38",
  isolated_margin: "0",
  cross_balance: "448",
  accumulated_funding_fees: "-1",
  liquidation_price: "0",
  ...over,
});

describe("minimizeLivePositions", () => {
  it("keeps only recorded symbols and drops every identifying field", () => {
    const out = minimizeLivePositions(
      {
        updated_at: 5,
        positions: [
          row({ id: 1 }),
          row({ id: 2, symbol: "BTC-USD" }),
          row({ id: 3, vault_id: "v1" }),
        ],
      },
      ["NIGHT-USD"],
    );
    expect(out.positions.map((p) => p.id)).toEqual([1, 3]);
    expect(out.positions[1]?.is_vault).toBe(true);
    const text = JSON.stringify(out);
    for (const secret of [
      "acct",
      "addr1qxyz",
      "handle",
      "cross_balance",
      "accumulated_funding_fees",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
