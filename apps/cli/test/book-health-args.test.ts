import { describe, expect, it } from "vitest";
import { parseBookHealthArgs } from "../src/book-health-args.js";

const NOW = Date.parse("2026-10-23T03:00:00Z");
const FIRST = Date.parse("2026-10-23T00:00:00Z");
const opts = { nowMs: NOW, firstHourMs: () => FIRST };

describe("book-health arguments", () => {
  it("defaults to the first recorded hour through now, both markets", () => {
    expect(parseBookHealthArgs([], opts)).toEqual({
      root: "data/recordings",
      symbols: ["NIGHT-USD", "ADA-USD"],
      fromMs: FIRST,
      toMs: NOW,
    });
  });

  it("accepts pnpm's forwarded `--` and explicit options", () => {
    const a = parseBookHealthArgs(
      [
        "--",
        "--root",
        "/r",
        "--from",
        "2026-10-23T01:00:00Z",
        "--to",
        "2026-10-23T02:00:00Z",
        "--symbols",
        "NIGHT-USD",
        "--json",
        "out.json",
      ],
      opts,
    );
    expect(a).toEqual({
      root: "/r",
      symbols: ["NIGHT-USD"],
      fromMs: FIRST + 3_600_000,
      toMs: FIRST + 7_200_000,
      json: "out.json",
    });
  });

  it("rejects a bad or empty window and an empty symbol list", () => {
    expect(() => parseBookHealthArgs(["--from", "yesterday"], opts)).toThrow();
    expect(() =>
      parseBookHealthArgs(["--from", "2026-10-23T02:00:00Z", "--to", "2026-10-23T01:00:00Z"], opts),
    ).toThrow();
    expect(() => parseBookHealthArgs(["--symbols", ","], opts)).toThrow();
    expect(() => parseBookHealthArgs(["--bogus"], opts)).toThrow();
  });
});
