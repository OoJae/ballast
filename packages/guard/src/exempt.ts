/**
 * The Guard's exempt path (plan section 6): cancels, cancel-all, cancel-only replace-batches and
 * the reduce-only IOC buy-back are checked only by `route-allowlist` and `dry-run`, so the kill
 * path never waits on a fact that may be the very thing that went stale.
 *
 * It lives apart from guard.ts so the watchdog's CANCEL_ONLY build can use the Guard as its seam
 * to the signer without importing the engine (whose differ builds creates). `checkGuard` reaches
 * the same verdict for every risk-reducing request; a test pins the two together.
 */
import { checkRoute, type ProfileName, type RouteCheck } from "@ballast/strike-client/routes";
import type { GuardCheck, GuardRequest, GuardResult, GuardViolation } from "./types.js";

export type { GuardRequest, GuardResult } from "./types.js";

/** Cancels, cancel-all, cancel-only replace-batches and the reduce-only IOC buy-back. */
export function riskReducing(route: RouteCheck): boolean {
  if (!route.ok) return false;
  if (route.route === "order.cancel" || route.route === "order.cancel-all") return true;
  if (route.route === "order.replace-batch") return route.cost.creates === 0;
  // checkRoute admits POST /v2/order only as a reduce-only IOC buy-back.
  return route.route === "order.exit";
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function routeCheckOf(profile: ProfileName, request: GuardRequest): RouteCheck {
  try {
    return checkRoute(profile, request.method, request.path, request.body);
  } catch (e) {
    return { ok: false, reason: `route check threw: ${errText(e)}` };
  }
}

/** The dry-run rule's detail text, shared with checkGuard so both trails read the same. */
export function dryRunDetail(violations: number, dryRun: boolean): string {
  return violations > 0
    ? `DRY_RUN=${dryRun}; moot, blocked by ${violations} violation(s)`
    : dryRun
      ? "DRY_RUN held fire: all checks passed, nothing sent"
      : "DRY_RUN disabled: live execution authorized";
}

export interface ExemptInput {
  request: GuardRequest;
  profile: ProfileName;
  flags: { dryRun: boolean };
}

/**
 * The two exempt rules on a request that must be risk-reducing. Anything else (a create, a
 * refused route) is blocked here: this entry point never authorizes new risk.
 */
export function checkRiskReducing(input: ExemptInput): GuardResult {
  const route = routeCheckOf(input.profile, input.request);
  const reducing = riskReducing(route);
  const checks: GuardCheck[] = [];
  const violations: GuardViolation[] = [];
  let passed: boolean;
  let detail: string;
  if (!route.ok) {
    passed = false;
    detail = `route refused: ${route.reason}`;
  } else if (!reducing) {
    passed = false;
    detail = `${route.route} is not risk-reducing; only cancels and reduce-only exits pass here`;
  } else {
    passed = true;
    detail = `${route.route} allowed under ${input.profile}`;
  }
  checks.push({ rule: "route-allowlist", passed, detail });
  if (!passed) violations.push({ rule: "route-allowlist", detail });
  const dryRun = input.flags?.dryRun !== false;
  checks.push({ rule: "dry-run", passed: true, detail: dryRunDetail(violations.length, dryRun) });
  const decision: GuardResult["decision"] =
    violations.length > 0 ? "blocked" : dryRun ? "dry-run" : "execute";
  const first = violations[0];
  return {
    decision,
    violations,
    checks,
    reason:
      first !== undefined
        ? `blocked by ${first.rule}: ${first.detail}`
        : `all ${checks.length} safety checks passed`,
    riskReducing: reducing,
  };
}

/** The cancel-only signer seam: `send` is reached only on an "execute" decision. */
export async function guardedCancel<T>(
  input: ExemptInput,
  send: (request: GuardRequest) => Promise<T>,
): Promise<{ result: GuardResult; sent: T | null }> {
  const result = checkRiskReducing(input);
  if (result.decision !== "execute") return { result, sent: null };
  return { result, sent: await send(input.request) };
}
