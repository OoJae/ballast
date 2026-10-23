import { describe, expect, it } from "vitest";
import {
  checkGuard,
  checkRiskReducing,
  type GuardInput,
  type GuardRequest,
  guardedCancel,
} from "../src/index.js";
import { baseInput, firstCreate } from "./helpers.js";

/**
 * The exempt path (exempt.ts) is what the watchdog's CANCEL_ONLY build uses as its seam to the
 * signer. For every risk-reducing request it must reach exactly checkGuard's verdict and trail,
 * and it must block everything else.
 */
const REDUCING: GuardRequest[] = [
  {
    method: "DELETE",
    path: "/v2/order/cancel-all",
    body: { symbol: "NIGHT-USD" },
    builderFeeBps: 0,
  },
  {
    method: "DELETE",
    path: "/v2/order/cancel",
    body: { symbol: "NIGHT-USD", order_id: 33_428_501n },
    builderFeeBps: 0,
  },
  {
    method: "POST",
    path: "/v2/order/replace-batch",
    body: { replacements: [{ cancel: { order_id: 33_428_501n, symbol: "NIGHT-USD" } }] },
    builderFeeBps: 0,
  },
  {
    method: "POST",
    path: "/v2/order",
    body: {
      client_order_id: "bal_aaaaaa_bbbbbb_x_7",
      symbol: "NIGHT-USD",
      side: "buy",
      type: "limit",
      size: "100",
      price: "0.0399",
      time_in_force: "IOC",
      reduce_only: true,
    },
    builderFeeBps: 0,
  },
];

function full(request: GuardRequest, profile: GuardInput["profile"], dryRun: boolean): GuardInput {
  const i = baseInput();
  // Strip every fact: the exempt path must not need any of them.
  return {
    ...i,
    request,
    profile,
    flags: { ...i.flags, dryRun },
    policy: null,
    critic: null,
    allocator: null,
  };
}

describe("exempt path", () => {
  it("agrees with checkGuard on every risk-reducing request, profile and DRY_RUN", () => {
    for (const request of REDUCING) {
      for (const profile of ["AUTONOMOUS", "CANCEL_ONLY"] as const) {
        for (const dryRun of [true, false]) {
          const a = checkGuard(full(request, profile, dryRun));
          const b = checkRiskReducing({ request, profile, flags: { dryRun } });
          if (profile === "CANCEL_ONLY" && request.method === "POST") {
            // The buy-back and replace-batch are AUTONOMOUS-only: checkRoute refuses them under
            // CANCEL_ONLY, so checkGuard runs the quoting rules and both block.
            expect(a.decision).toBe("blocked");
            expect(b.decision).toBe("blocked");
            continue;
          }
          expect(b, `${request.path} ${profile} ${dryRun}`).toEqual(a);
        }
      }
    }
  });

  it("blocks creates, mixed replace-batches and refused routes", () => {
    const create = baseInput().request;
    const mixed: GuardRequest = {
      ...create,
      body: {
        replacements: [
          { cancel: { order_id: 33_428_501n, symbol: "NIGHT-USD" } },
          { new_order: firstCreate(baseInput()) },
        ],
      },
    };
    const refused: GuardRequest = { ...create, path: "/v2/order/replace" };
    for (const request of [create, mixed, refused]) {
      for (const profile of ["AUTONOMOUS", "CANCEL_ONLY"] as const) {
        const r = checkRiskReducing({ request, profile, flags: { dryRun: false } });
        expect(r.decision).toBe("blocked");
        expect(r.violations.map((v) => v.rule)).toEqual(["route-allowlist"]);
      }
    }
  });

  it("guardedCancel reaches the sender only on execute", async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
      return "sent";
    };
    const cancel = REDUCING[0] as GuardRequest;
    const dry = await guardedCancel(
      { request: cancel, profile: "CANCEL_ONLY", flags: { dryRun: true } },
      send,
    );
    expect(dry.sent).toBeNull();
    expect(dry.result.decision).toBe("dry-run");
    const live = await guardedCancel(
      { request: cancel, profile: "CANCEL_ONLY", flags: { dryRun: false } },
      send,
    );
    expect(live.sent).toBe("sent");
    const create = await guardedCancel(
      { request: baseInput().request, profile: "CANCEL_ONLY", flags: { dryRun: false } },
      send,
    );
    expect(create.sent).toBeNull();
    expect(calls).toBe(1);
  });
});
