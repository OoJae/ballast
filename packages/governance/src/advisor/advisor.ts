import { canonicalize, sha256Hex } from "@ballast/core";
import { ADVISOR_TIMEOUT_MS } from "./llm.js";
import {
  AdvisorDraftSchema,
  type AdvisorNote,
  completeWithSchema,
  type LlmClient,
  redactIdentifiers,
} from "./schemas.js";

/**
 * The Advisor explains; it never decides (§6, invariant 19). It runs off the tick path, its
 * output is a note for humans, and nothing in the engine, Guard, signer or registry reads it.
 * A hung, slow, throwing or refusing model therefore changes nothing but the absence of a note.
 */
export interface AdvisorSubject {
  kind: "policy" | "policy-diff" | "critic-report" | "guard-trip" | "book-health";
  /** Hash of the thing explained (set by code; the model never sees or writes it). */
  subjectHash: string;
  /** The deterministic explanation, which always comes first and stands on its own. */
  deterministicText: string;
  facts?: unknown;
}

export type AdvisorResult =
  | { ok: true; note: AdvisorNote; noteHash: string; attempts: number }
  | { ok: false; reason: string };

const SYSTEM = [
  "You write short, neutral notes for Ballast's public policy page.",
  "Ballast is a covered market maker: holders keep NIGHT in their Cardano wallets as cover, and a",
  "deterministic keeper posts post-only asks under an operator-signed policy and a Guard.",
  "You explain what changed and what a careful reviewer might check. You do not decide anything.",
  'Reply with one JSON object only: {"summary": string <= 600 chars, "risks": up to 5 strings,',
  '"recommendation": "no_change" | "tighten" | "review", "confidence": number 0..1}.',
  "Never write addresses, hashes, keys, policy ids, order ids or UUIDs, even if you see them.",
].join(" ");

export function advisorNoteHash(note: AdvisorNote): string {
  return sha256Hex(canonicalize(note));
}

/**
 * One bounded attempt at a note. Never throws and never outlives `timeoutMs`: the race against
 * the abort resolves even if the client ignores the signal.
 */
export async function draftAdvisorNote(
  llm: LlmClient,
  subject: AdvisorSubject,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<AdvisorResult> {
  const timeoutMs = Math.min(opts.timeoutMs ?? ADVISOR_TIMEOUT_MS, ADVISOR_TIMEOUT_MS);
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort(new Error("advisor cancelled"));
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => ac.abort(new Error("advisor timeout")), timeoutMs);
  const aborted = new Promise<never>((_, reject) => {
    ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true });
  });
  aborted.catch(() => {});
  try {
    const user = [
      `Subject: ${subject.kind}`,
      `Deterministic explanation:\n${redactIdentifiers(subject.deterministicText)}`,
      subject.facts === undefined
        ? ""
        : `Facts (JSON):\n${redactIdentifiers(JSON.stringify(subject.facts))}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const { value, attempts } = await Promise.race([
      completeWithSchema(llm, { system: SYSTEM, user }, AdvisorDraftSchema, { signal: ac.signal }),
      aborted,
    ]);
    const note: AdvisorNote = { v: 1, subjectHash: subject.subjectHash, ...value };
    return { ok: true, note, noteHash: advisorNoteHash(note), attempts };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
    if (!ac.signal.aborted) ac.abort(new Error("advisor finished"));
  }
}

export interface AdvisorServiceOptions {
  llm: LlmClient | null;
  onNote?: (note: AdvisorNote, noteHash: string, subject: AdvisorSubject) => void;
  onError?: (reason: string, subject: AdvisorSubject) => void;
  timeoutMs?: number;
  /** Drops new subjects beyond this many in flight; notes are optional, so no backlog. */
  maxInFlight?: number;
  /** Defers work to a later macrotask so it can never run inside the caller's tick. */
  schedule?: (fn: () => void) => void;
}

/** Fire-and-forget front end. `submit` returns immediately and never throws. */
export class AdvisorService {
  private inFlight = 0;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly opts: AdvisorServiceOptions) {}

  submit(subject: AdvisorSubject): void {
    const llm = this.opts.llm;
    if (!llm || this.inFlight >= (this.opts.maxInFlight ?? 2)) return;
    const schedule = this.opts.schedule ?? ((fn: () => void) => void setTimeout(fn, 0));
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const run = () => {
      draftAdvisorNote(llm, subject, { timeoutMs: this.opts.timeoutMs ?? ADVISOR_TIMEOUT_MS })
        .then((r) => {
          if (r.ok) this.opts.onNote?.(r.note, r.noteHash, subject);
          else this.opts.onError?.(r.reason, subject);
        })
        .catch(() => {})
        .finally(() => {
          this.inFlight -= 1;
          this.pending.delete(done);
          resolveDone();
        });
    };
    this.inFlight += 1;
    this.pending.add(done);
    try {
      schedule(run);
    } catch {
      // A broken scheduler must not reach the caller; the note is simply skipped.
      this.inFlight -= 1;
      this.pending.delete(done);
      resolveDone();
    }
  }

  /** Resolves when every submitted note has finished or been dropped (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
