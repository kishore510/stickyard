import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../src/ai/client";
import { AI_ERRORS, AI_ERROR_KINDS, describeError, errorDetails } from "../src/ai/messages";
import { LARGE_MODEL, SMALL_MODEL } from "../src/ai/models";
import { TEST_TEXT, TEST_TIMEOUT_MS, testKey } from "../src/ai/testKey";

/*
 * Test key (AI part 1, v0.42.0): POST /v1/messages/count_tokens with "Hi" for both models (free),
 * 20 s without data. It passes only if each reply has a numeric input_tokens.
 */

const KEY = "sk-ant-api03-FAKE-testkey-test-key-0000abcd";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const byModel =
  (replies: Record<string, () => Response>): FetchLike =>
  async (_url, init) => {
    const model = (JSON.parse(String(init.body)) as { model: string }).model;
    const reply = replies[model];
    if (!reply) throw new Error(`unexpected model ${model}`);
    return reply();
  };

describe("the models", () => {
  it("are the current small and large models, not the retiring Haiku 4.5", () => {
    expect(SMALL_MODEL.id).toBe("claude-haiku-5-5");
    expect(LARGE_MODEL.id).toBe("claude-sonnet-5-5");
    expect(SMALL_MODEL.name).toBe("Claude Haiku 5.5");
    expect(LARGE_MODEL.name).toBe("Claude Sonnet 5.5");
    // Each has a comment giving its documented retirement date.
    const source = readFileSync(new URL("../src/ai/models.ts", import.meta.url), "utf8");
    expect(source.match(/Retirement: not sooner than \d{1,2} [A-Z][a-z]+ \d{4}/g)).toHaveLength(2);
    expect(source).not.toContain("claude-haiku-4-5");
  });
});

describe("Test key", () => {
  it("sends Hi to count_tokens for both models with a 20 s timeout", async () => {
    expect(TEST_TEXT).toBe("Hi");
    expect(TEST_TIMEOUT_MS).toBe(20_000);
    const fetch = vi.fn<FetchLike>(async () => json(200, { input_tokens: 8 }));
    const outcome = await testKey({ apiKey: KEY, fetch });
    expect(outcome).toEqual({ kind: "passed" });
    expect(fetch).toHaveBeenCalledTimes(2);
    const bodies = fetch.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(String(init.body)) as unknown }));
    expect(bodies).toEqual([
      { url: "https://api.anthropic.com/v1/messages/count_tokens", body: { model: SMALL_MODEL.id, messages: [{ role: "user", content: "Hi" }] } },
      { url: "https://api.anthropic.com/v1/messages/count_tokens", body: { model: LARGE_MODEL.id, messages: [{ role: "user", content: "Hi" }] } },
    ]);
  });

  it("fails without a numeric input_tokens", async () => {
    const outcome = await testKey({ apiKey: KEY, fetch: async () => json(200, { input_tokens: "eight" }) });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.failed).toEqual([SMALL_MODEL, LARGE_MODEL]);
      expect(outcome.error.kind).toBe("malformed");
    }
  });

  it("names the one model that failed", async () => {
    const outcome = await testKey({
      apiKey: KEY,
      fetch: byModel({
        [SMALL_MODEL.id]: () => json(200, { input_tokens: 8 }),
        [LARGE_MODEL.id]: () => json(404, { type: "error", error: { type: "not_found_error", message: `model: ${LARGE_MODEL.id}` } }),
      }),
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.failed).toEqual([LARGE_MODEL]);
      expect(outcome.error.kind).toBe("model_unavailable");
    }
  });

  it("a cancelled test is not a failure", async () => {
    const controller = new AbortController();
    const fetch: FetchLike = (_url, init) => new Promise((_res, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const pending = testKey({ apiKey: KEY, fetch, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ kind: "cancelled" });
  });

  it("an invalid key fails for both", async () => {
    const outcome = await testKey({ apiKey: KEY, fetch: async () => json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
    expect(outcome.kind === "failed" && outcome.error.kind).toBe("invalid_key");
  });
});

describe("the error table", () => {
  it("has a title, message, next step and a Retry flag for every kind", () => {
    for (const kind of AI_ERROR_KINDS) {
      const entry = AI_ERRORS[kind];
      expect(entry.title, kind).not.toBe("");
      expect(entry.message, kind).not.toBe("");
      expect(entry.next, kind).not.toBe("");
      expect(typeof entry.retry).toBe("boolean");
    }
    expect(AI_ERROR_KINDS).toEqual([
      "no_key",
      "invalid_key",
      "permission",
      "billing",
      "rate_limited",
      "spend_limit",
      "overloaded",
      "server",
      "timeout",
      "too_large",
      "model_unavailable",
      "bad_request",
      "offline",
      "blocked",
      "cancelled",
      "malformed",
      "refused",
      "truncated",
    ]);
  });

  it("uses the changed wording", () => {
    expect(AI_ERRORS.blocked.message).toBe("Could not reach the API. Your network or browser may be blocking it.");
    for (const kind of ["cancelled", "timeout"] as const) expect(AI_ERRORS[kind].message).toMatch(/already sent can still be billed/);
    const all = JSON.stringify(AI_ERRORS);
    expect(all).not.toMatch(/diagram/i);
    expect(all).toContain("Nothing was changed on the board.");
  });

  it("says when to retry after a rate limit", () => {
    expect(describeError({ kind: "rate_limited", status: 429, retryAfterSeconds: 30 }).next).toContain("30 seconds");
    expect(describeError({ kind: "rate_limited", status: 429, retryAfterSeconds: 1 }).next).toContain("1 second");
  });

  it("Details are redacted: status, type, API message and request id only", () => {
    const details = errorDetails({ kind: "bad_request", status: 400, type: "invalid_request_error", apiMessage: `bad ${KEY} x-api-key: ${KEY}`, requestId: "req_9" });
    expect(details).toBe("HTTP 400 · invalid_request_error · bad [redacted] x-api-key: [redacted] · request req_9");
    expect(errorDetails({ kind: "offline" })).toBe("No response (offline)");
  });
});
