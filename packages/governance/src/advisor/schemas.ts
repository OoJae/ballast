/**
 * Strict Advisor output schemas and the reject-and-retry loop (ported from Ripcord's
 * agents/schemas.ts). Schemas are strict: an unexpected key is evidence of a bad generation,
 * not noise to strip. On top of the schema, assertNoIdentifiers() rejects any Cardano address,
 * stake address, policy id, key or hash, UUID, EVM address or client order id anywhere in the
 * output, keys included: identifiers come only from config (invariant 10, test 15).
 */
import { z } from "zod";

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<string>;
}

/** What the model may write. `v` and `subjectHash` are added by code, never by the model. */
export const AdvisorDraftSchema = z.strictObject({
  summary: z.string().min(1).max(600),
  risks: z.array(z.string().min(1).max(200)).max(5),
  recommendation: z.enum(["no_change", "tighten", "review"]),
  confidence: z.number().finite().min(0).max(1),
});
export type AdvisorDraft = z.infer<typeof AdvisorDraftSchema>;

/** §6 AdvisorNote: non-blocking commentary, published on /policies, never consumed by code. */
export interface AdvisorNote extends AdvisorDraft {
  v: 1;
  subjectHash: string;
}

const B32 = "[qpzry9x8gf2tvdw0s3jn54khce6mua7l]";
const IDENTIFIER_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "Cardano address", re: new RegExp(`addr(?:_test)?1${B32}{8,}`, "i") },
  { name: "stake address", re: new RegExp(`stake(?:_test)?1${B32}{8,}`, "i") },
  {
    name: "other bech32 identifier",
    re: new RegExp(`(?:pool|drep|asset|script|vkey|addr_vkh)1${B32}{8,}`, "i"),
  },
  { name: "Byron address", re: /\b(?:Ae2td|DdzFF)[1-9A-HJ-NP-Za-km-z]{20,}/ },
  { name: "EVM address", re: /0x[0-9a-f]{40}/i },
  { name: "UUID", re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  // 56 hex = a policy id or key hash; 64 = a key, tx hash or digest; longer = raw bytes.
  { name: "hex identifier (56+ hex)", re: /[0-9a-f]{56,}/i },
  { name: "client order id", re: /\bbal_[A-Za-z0-9_-]{4,}/ },
];

// Zero-width and other invisible format characters a model could use to split an identifier.
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤﻿]/g;

/** NFKC folds full-width and compatibility forms; invisible separators are removed. */
function normalize(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "");
}

export class IdentifierInOutputError extends Error {
  constructor(
    readonly path: string,
    readonly kind: string,
  ) {
    super(`${kind} found in ${path}: identifiers come only from config`);
    this.name = "IdentifierInOutputError";
  }
}

function scanString(text: string, path: string): void {
  const n = normalize(text);
  for (const { name, re } of IDENTIFIER_PATTERNS) {
    if (re.test(n)) throw new IdentifierInOutputError(path, name);
  }
}

/** Throws if any string (or object key) anywhere in `value` carries an identifier. */
export function assertNoIdentifiers(value: unknown, path = "output"): void {
  if (typeof value === "string") {
    scanString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      assertNoIdentifiers(v, `${path}[${i}]`);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      scanString(k, `${path} key "${k.slice(0, 16)}"`);
      assertNoIdentifiers(v, `${path}.${k}`);
    }
  }
}

/** Replaces identifiers in text sent to the model, so it has nothing to echo back. */
export function redactIdentifiers(text: string): string {
  let out = normalize(text);
  for (const { re } of IDENTIFIER_PATTERNS)
    out = out.replace(new RegExp(re.source, `${re.flags}g`), "[id]");
  return out;
}

export class SchemaValidationError extends Error {
  constructor(
    readonly attempts: number,
    readonly rawOutputs: string[],
    readonly lastIssue: string,
  ) {
    super(`LLM output failed validation after ${attempts} attempt(s): ${lastIssue}`);
    this.name = "SchemaValidationError";
  }
}

/** Strips a ```json … ``` fence if present. This is the only leniency in the pipeline. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

export interface CompleteWithSchemaResult<T> {
  value: T;
  raw: string;
  attempts: number;
}

/**
 * Asks for JSON, validates strictly, scans for identifiers, and retries with the failure fed
 * back. Throws SchemaValidationError once attempts run out, and stops at once on abort.
 */
export async function completeWithSchema<T>(
  llm: LlmClient,
  prompt: { system: string; user: string },
  schema: z.ZodType<T>,
  opts: { maxAttempts?: number; signal?: AbortSignal; maxTokens?: number } = {},
): Promise<CompleteWithSchemaResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 2;
  const rawOutputs: string[] = [];
  let user = prompt.user;
  let lastIssue = "no attempts made";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    opts.signal?.throwIfAborted();
    const raw = await llm.complete({
      system: prompt.system,
      user,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    });
    rawOutputs.push(raw);
    try {
      const parsed = schema.parse(JSON.parse(stripCodeFences(raw)));
      assertNoIdentifiers(parsed);
      return { value: parsed, raw, attempts: attempt };
    } catch (err) {
      lastIssue =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
          : String(err instanceof Error ? err.message : err);
      user =
        `${prompt.user}\n\nYour previous output failed validation: ${lastIssue}. ` +
        "Respond with only a corrected JSON object: no prose, no markdown, no identifiers.";
    }
  }
  throw new SchemaValidationError(maxAttempts, rawOutputs, lastIssue);
}
