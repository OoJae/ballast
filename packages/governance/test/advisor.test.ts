import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  AdvisorDraftSchema,
  assertNoIdentifiers,
  completeWithSchema,
  draftAdvisorNote,
  IdentifierInOutputError,
  type LlmClient,
  redactIdentifiers,
  SchemaValidationError,
  stripCodeFences,
} from "../src/advisor/index.js";

const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const b32 = (n: number) => fc.string({ unit: fc.constantFrom(...B32), minLength: n, maxLength: n });
const hex = (n: number) =>
  fc.string({ unit: fc.constantFrom(..."0123456789abcdef"), minLength: n, maxLength: n });

// Synthetic identifiers in every family the Advisor must never emit.
const identifiers = fc.oneof(
  b32(98).map((s) => `addr1${s}`),
  b32(53).map((s) => `addr_test1${s}`),
  b32(53).map((s) => `stake1${s}`),
  b32(50).map((s) => `stake_test1${s}`),
  b32(52).map((s) => `pool1${s}`),
  hex(56),
  hex(64),
  hex(64).map((s) => s.toUpperCase()),
  hex(40).map((s) => `0x${s}`),
  hex(32).map(
    (h) =>
      `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
  ),
  b32(12).map((s) => `bal_${s}`),
);

const note = (summary: string) => ({
  summary,
  risks: [],
  recommendation: "no_change",
  confidence: 0.5,
});

describe("invariant 15: assertNoIdentifiers", () => {
  it("rejects every identifier family, wherever it hides", () => {
    fc.assert(
      fc.property(
        identifiers,
        fc.string({ maxLength: 40 }),
        fc.integer({ min: 0, max: 3 }),
        (id, prose, where) => {
          const text = `${prose} ${id} ${prose}`;
          const shapes = [
            note(text),
            { ...note("ok"), risks: ["fine", text] },
            { nested: { deeper: [text] } },
            { [id]: "an identifier used as a key" },
          ];
          try {
            assertNoIdentifiers(shapes[where]);
            return false;
          } catch (err) {
            return err instanceof IdentifierInOutputError;
          }
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it("sees through zero-width separators and full-width digits", () => {
    const zw = "addr1​q​xs7j5k6z2yd5wlczanm69humvehck9q6yzpvje663lrtfx3nqcq7jf585dszhf52g9";
    expect(() => assertNoIdentifiers(note(zw))).toThrow(/Cardano address/);
    const fullwidth = "０x".concat("ab".repeat(20));
    expect(() => assertNoIdentifiers(note(fullwidth))).toThrow(/EVM/);
  });

  it("lets ordinary prose, numbers and short hex through", () => {
    for (const ok of [
      "The ask side is empty within 0.5%; L1 moves from +38 to +45 bps.",
      "Replica p99 error rose to 0.77 bps; consider review.",
      "A deadbeef cafe 1234 short hex run is not an identifier.",
      "every bal_ order names its policy",
      "policy renewed 3 of 7 times",
    ]) {
      expect(() => assertNoIdentifiers(note(ok))).not.toThrow();
    }
  });

  it("redactIdentifiers strips what assertNoIdentifiers would reject", () => {
    fc.assert(
      fc.property(identifiers, (id) => {
        assertNoIdentifiers(redactIdentifiers(`before ${id} after`));
        return true;
      }),
      { numRuns: 500 },
    );
  });
});

function fakeLlm(outputs: (string | Error)[]): LlmClient & { calls: number } {
  const llm = {
    calls: 0,
    async complete() {
      const out = outputs[Math.min(llm.calls, outputs.length - 1)];
      llm.calls += 1;
      if (out instanceof Error) throw out;
      return out ?? "";
    },
  };
  return llm;
}

describe("completeWithSchema (ported)", () => {
  const prompt = { system: "s", user: "u" };

  it("strips one code fence and nothing else", () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFences('  {"a":1} ')).toBe('{"a":1}');
  });

  it("retries a bad generation, then accepts a valid one", async () => {
    const llm = fakeLlm(["not json", JSON.stringify(note("All checks passed."))]);
    const r = await completeWithSchema(llm, prompt, AdvisorDraftSchema);
    expect(r.attempts).toBe(2);
    expect(r.value.summary).toBe("All checks passed.");
  });

  it("rejects extra keys, oversize fields and identifiers, then gives up", async () => {
    const bad = [
      JSON.stringify({ ...note("x"), activate: true }),
      JSON.stringify(note("y".repeat(601))),
      JSON.stringify({ ...note("x"), risks: ["a", "b", "c", "d", "e", "f"] }),
      JSON.stringify(note(`send to stake1${"q".repeat(53)}`)),
    ];
    for (const out of bad) {
      await expect(
        completeWithSchema(fakeLlm([out]), prompt, AdvisorDraftSchema),
      ).rejects.toBeInstanceOf(SchemaValidationError);
    }
  });
});

describe("draftAdvisorNote: bounded, never throws", () => {
  const subject = {
    kind: "guard-trip" as const,
    subjectHash: "c".repeat(64),
    deterministicText: `cover-invariant tripped for stake1${"q".repeat(53)}`,
    facts: { rule: "cover-invariant", policy: "d".repeat(64) },
  };

  it("returns a note with code-set v and subjectHash; the model never sees identifiers", async () => {
    const seen: string[] = [];
    const llm: LlmClient = {
      complete: async (req) => {
        seen.push(req.user);
        return JSON.stringify(note("Cover dropped below the committed share; quoting paused."));
      },
    };
    const r = await draftAdvisorNote(llm, subject);
    expect(r.ok && r.note).toMatchObject({
      v: 1,
      subjectHash: "c".repeat(64),
      recommendation: "no_change",
    });
    expect(seen.join("\n")).not.toMatch(/stake1|d{64}/);
  });

  it("a hung model resolves to no note at the timeout, even if it ignores the abort", async () => {
    const llm: LlmClient = { complete: () => new Promise(() => {}) };
    const started = Date.now();
    const r = await draftAdvisorNote(llm, subject, { timeoutMs: 30 });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/timeout/) });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("caps any configured timeout at 20 s", async () => {
    vi.useFakeTimers();
    try {
      const llm: LlmClient = { complete: () => new Promise(() => {}) };
      const p = draftAdvisorNote(llm, subject, { timeoutMs: 600_000 });
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(p).resolves.toMatchObject({ ok: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throwing or refusing model yields no note", async () => {
    expect((await draftAdvisorNote(fakeLlm([new Error("529 overloaded")]), subject)).ok).toBe(
      false,
    );
    expect(
      (await draftAdvisorNote(fakeLlm([new Error("advisor model refused")]), subject)).ok,
    ).toBe(false);
  });
});
