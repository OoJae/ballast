/**
 * The bound accounts the keeper quotes for, from a local JSON file (never from model output or
 * an API response: identifiers come only from config, invariant 15). Each entry names the holder's
 * Strike account, the stake credential its cover is measured over, the holder's r and caps, and
 * the sealed Strike API key file (AES-256-GCM under the host KEK, invariant 25).
 */
import { readFileSync } from "node:fs";
import { type MicroUsd, microUsd } from "@ballast/core";
import { z } from "zod";
import type { AccountConfig } from "./account.js";

const Entry = z.strictObject({
  accountId: z.string().min(1).max(128),
  stakeAddress: z.string().regex(/^stake1[0-9a-z]{20,120}$/, "a mainnet stake1… address"),
  holder0: z.boolean().default(false),
  rBps: z.int().min(0).max(9_000).default(5_000),
  maxShortMicroUsd: z
    .string()
    .regex(/^(0|[1-9]\d{0,17})$/)
    .nullable()
    .default(null),
  /** 0 until the builder code is approved (D0) and attribution verified (D2). */
  approvedBuilderBps: z.int().min(0).max(10).default(0),
  strikeKeyFile: z.string().min(1),
  label: z.string().max(64).optional(),
});

const FileSchema = z.array(Entry).superRefine((rows, ctx) => {
  const ids = new Set<string>();
  const stakes = new Set<string>();
  for (const [i, r] of rows.entries()) {
    if (ids.has(r.accountId))
      ctx.addIssue({ code: "custom", path: [i], message: "duplicate accountId" });
    // One stake credential ↔ one account (invariant 16); the evidence DB enforces it too.
    if (stakes.has(r.stakeAddress))
      ctx.addIssue({ code: "custom", path: [i], message: "stake credential bound twice" });
    ids.add(r.accountId);
    stakes.add(r.stakeAddress);
  }
  if (rows.filter((r) => r.holder0).length > 1) {
    ctx.addIssue({ code: "custom", message: "at most one holder #0" });
  }
});

export interface AccountEntry extends AccountConfig {
  strikeKeyFile: string;
  label?: string;
}

export function parseAccounts(json: unknown): AccountEntry[] {
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`bad accounts file: ${issues}`);
  }
  return parsed.data.map((r) => ({
    accountId: r.accountId,
    stakeAddress: r.stakeAddress,
    holder0: r.holder0,
    rBps: BigInt(r.rBps),
    maxShortMicroUsd:
      r.maxShortMicroUsd === null ? null : (microUsd(BigInt(r.maxShortMicroUsd)) as MicroUsd),
    approvedBuilderBps: r.approvedBuilderBps,
    strikeKeyFile: r.strikeKeyFile,
    ...(r.label !== undefined ? { label: r.label } : {}),
  }));
}

export function loadAccountsFile(path: string): AccountEntry[] {
  return parseAccounts(JSON.parse(readFileSync(path, "utf8")));
}
