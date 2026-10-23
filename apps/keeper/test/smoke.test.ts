import { afterEach, describe, expect, it, vi } from "vitest";
import { activate, type KeeperHarness, restingAsks, startKeeper } from "./harness.js";

let h: KeeperHarness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe("keeper smoke", () => {
  it("quotes a fingerprinted post-only ask under an active policy", async () => {
    h = await startKeeper();
    await activate(h);
    h.daemon.start();
    const id = h.accounts[0]?.id as string;
    const harness = h;
    await vi.waitFor(() => expect(restingAsks(harness, id).length).toBeGreaterThan(0), {
      timeout: 8_000,
      interval: 50,
    });
    const ask = restingAsks(h, id)[0];
    expect(ask?.clientOrderId).toMatch(/^bal_[0-9a-f]{6}_[0-9a-f]{6}_1_[0-9a-z]+$/);
    expect(ask?.postOnly).toBe(true);
    expect(ask?.builderFeeBps).toBe(10);
  }, 20_000);
});
