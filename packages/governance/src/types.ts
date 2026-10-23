/** One evaluated rule. Every rule is evaluated and recorded, so a failure report is complete. */
export interface GateCheck {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface GateResult {
  ok: boolean;
  checks: GateCheck[];
}

export const HEX64_RE = /^[0-9a-f]{64}$/;
export const HEX128_RE = /^[0-9a-f]{128}$/;

export function isHex64(v: unknown): v is string {
  return typeof v === "string" && HEX64_RE.test(v);
}

export function gate(checks: GateCheck[]): GateResult {
  return { ok: checks.length > 0 && checks.every((c) => c.passed), checks };
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
