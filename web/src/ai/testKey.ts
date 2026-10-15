import { countTokens, type FetchLike } from "./client";
import type { AiError } from "./messages";
import { AI_MODELS, type AiModel } from "./models";

/*
 * Test key (v0.42.0): the word "Hi" to POST /v1/messages/count_tokens for both models. Token counting
 * is free (it has its own rate limit), so a test costs nothing. It passes only if each reply has a
 * numeric input_tokens. A cancelled test is not a failure.
 */

export const TEST_TEXT = "Hi";
/** Per call, without data. */
export const TEST_TIMEOUT_MS = 20_000;

export type TestOutcome = { kind: "passed" } | { kind: "failed"; failed: AiModel[]; error: AiError } | { kind: "cancelled" };

export async function testKey(options: { apiKey: string; fetch?: FetchLike; signal?: AbortSignal }): Promise<TestOutcome> {
  const results = await Promise.all(
    AI_MODELS.map(async (model) => ({
      model,
      result: await countTokens({ model: model.id, messages: [{ role: "user", content: TEST_TEXT }] }, { ...options, idleTimeoutMs: TEST_TIMEOUT_MS }),
    })),
  );
  if (options.signal?.aborted || results.some((r) => !r.result.ok && r.result.error.kind === "cancelled")) return { kind: "cancelled" };
  const failed = results.flatMap((r) => (r.result.ok ? [] : [{ model: r.model, error: r.result.error }]));
  const first = failed[0];
  if (!first) return { kind: "passed" };
  return { kind: "failed", failed: failed.map((f) => f.model), error: first.error };
}
