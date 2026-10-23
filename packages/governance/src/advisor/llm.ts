/**
 * Anthropic-backed LlmClient for the Advisor (ported from Ripcord's agents/llm.ts).
 *
 * - Model notes (claude-opus-5-5): thinking cannot be disabled, so these short JSON calls run at
 *   low effort instead. Sampling parameters are not sent (the API rejects them).
 * - Refusals: server-side fallback ("default" routing) is enabled, and a final refusal throws,
 *   which the Advisor treats like any other failure: no note.
 * - Every call is bounded by an abort signal and a 20 s timeout, with no SDK retries, so a slow
 *   API can only delay a note, never anything else.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient } from "./schemas.js";

export const ADVISOR_TIMEOUT_MS = 20_000;

export interface AnthropicLlmOptions {
  apiKey?: string;
  model: string;
  baseURL?: string;
  timeoutMs?: number;
}

export function createAnthropicLlm(opts: AnthropicLlmOptions): LlmClient {
  const client = new Anthropic({
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    maxRetries: 0,
    timeout: opts.timeoutMs ?? ADVISOR_TIMEOUT_MS,
  });
  return {
    async complete(req): Promise<string> {
      const response = await client.beta.messages.create(
        {
          model: opts.model,
          max_tokens: req.maxTokens ?? 2048,
          output_config: { effort: "low" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        },
        { signal: req.signal ?? null, timeout: opts.timeoutMs ?? ADVISOR_TIMEOUT_MS },
      );
      if (response.stop_reason === "refusal") throw new Error("advisor model refused");
      return response.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
    },
  };
}
