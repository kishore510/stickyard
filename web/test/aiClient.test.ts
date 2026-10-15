import { afterEach, describe, expect, it, vi } from "vitest";
import { COUNT_TOKENS_URL, MESSAGES_URL, countTokens, errorFromResponse, parseRetryAfter, streamMessage, type FetchLike } from "../src/ai/client";
import { AI_ERROR_KINDS } from "../src/ai/messages";

/*
 * The browser's own Anthropic client (AI part 1, v0.42.0): plain fetch, a fake one here. The key goes
 * only in the x-api-key header; streaming accumulates text deltas; the timeout measures time without
 * data; no automatic retries.
 */

const KEY = "sk-ant-api03-FAKE-client-test-key-0000abcd";

const encoder = new TextEncoder();

/** A Response whose body streams the given chunks; `hold` keeps it open after them (until aborted). */
function streamResponse(chunks: string[], { hold = false, status = 200, headers = {} }: { hold?: boolean; status?: number; headers?: Record<string, string> } = {}, signal?: AbortSignal) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!hold) controller.close();
      signal?.addEventListener("abort", () => controller.error(signal.reason ?? new DOMException("Aborted", "AbortError")));
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream", ...headers } });
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const HAPPY = [
  sse("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "m", stop_reason: null, usage: { input_tokens: 25, output_tokens: 1 } } }),
  sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  sse("ping", { type: "ping" }),
  sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
  sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ", board!" } }),
  sse("content_block_stop", { type: "content_block_stop", index: 0 }),
  sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 15 } }),
  sse("message_stop", { type: "message_stop" }),
];

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const apiError = (type: string, message: string) => ({ type: "error", error: { type, message }, request_id: "req_test_1" });

const request = { model: "claude-haiku-5-5", maxTokens: 100, messages: [{ role: "user" as const, content: "Hi" }] };

afterEach(() => {
  vi.useRealTimers();
});

describe("the request", () => {
  it("posts to the exact URL with the exact headers and fetch options, and the key only in the header", async () => {
    const fetch = vi.fn<FetchLike>(async () => streamResponse(HAPPY));
    await streamMessage(request, { apiKey: KEY, fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(MESSAGES_URL).toBe(url);
    expect(url).not.toContain(KEY);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    });
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init).sort()).toEqual(["body", "cache", "credentials", "headers", "method", "referrerPolicy", "signal"]);
    expect(String(init.body)).not.toContain(KEY);
    expect(JSON.parse(String(init.body))).toEqual({ model: "claude-haiku-5-5", max_tokens: 100, stream: true, messages: [{ role: "user", content: "Hi" }] });
  });

  it("count_tokens goes to its own URL with the same headers and no key in the body", async () => {
    const fetch = vi.fn<FetchLike>(async () => jsonResponse(200, { input_tokens: 8 }));
    const result = await countTokens({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "Hi" }] }, { apiKey: KEY, fetch });
    expect(result).toEqual({ ok: true, inputTokens: 8 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages/count_tokens");
    expect(COUNT_TOKENS_URL).toBe(url);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    expect(init.credentials).toBe("omit");
    expect(String(init.body)).not.toContain(KEY);
    expect(JSON.parse(String(init.body))).toEqual({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "Hi" }] });
  });

  it("count_tokens without a numeric input_tokens is malformed", async () => {
    for (const body of [{ input_tokens: "8" }, {}, { input_tokens: null }]) {
      const result = await countTokens(request, { apiKey: KEY, fetch: async () => jsonResponse(200, body) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("malformed");
    }
    const notJson = await countTokens(request, { apiKey: KEY, fetch: async () => new Response("<html>", { status: 200 }) });
    expect(!notJson.ok && notJson.error.kind).toBe("malformed");
  });
});

describe("streaming", () => {
  it("accumulates text deltas, reports progress, and reads stop_reason and usage", async () => {
    const progress: number[] = [];
    const result = await streamMessage(request, { apiKey: KEY, fetch: async () => streamResponse(HAPPY), onProgress: (chars) => progress.push(chars) });
    expect(result).toEqual({ ok: true, text: "Hello, board!", stopReason: "end_turn", usage: { inputTokens: 25, outputTokens: 15 } });
    expect(progress).toEqual([5, 13]);
  });

  it("handles events split across chunks and CRLF line endings", async () => {
    const whole = HAPPY.join("").replace(/\n/g, "\r\n");
    const chunks = whole.match(/[\s\S]{1,7}/g) ?? [];
    const result = await streamMessage(request, { apiKey: KEY, fetch: async () => streamResponse(chunks) });
    expect(result.ok && result.text).toBe("Hello, board!");
  });

  it("a stream that ends before message_stop is malformed, keeping the text so far", async () => {
    const result = await streamMessage(request, { apiKey: KEY, fetch: async () => streamResponse(HAPPY.slice(0, 4)) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("malformed");
      expect(result.text).toBe("Hello");
    }
  });

  it("an error event mid-stream maps by its type", async () => {
    const chunks = [...HAPPY.slice(0, 4), sse("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })];
    const result = await streamMessage(request, { apiKey: KEY, fetch: async () => streamResponse(chunks) });
    expect(!result.ok && result.error.kind).toBe("overloaded");
  });

  it("stop_reason max_tokens is truncated and refusal is refused", async () => {
    const withStop = (reason: string) => HAPPY.map((c) => c.replace('"end_turn"', JSON.stringify(reason)));
    const truncated = await streamMessage(request, { apiKey: KEY, fetch: async () => streamResponse(withStop("max_tokens")) });
    expect(!truncated.ok && truncated.error.kind).toBe("truncated");
    expect(!truncated.ok && truncated.text).toBe("Hello, board!");
    const refused = await streamMessage(request, { apiKey: KEY, fetch: async () => streamResponse(withStop("refusal")) });
    expect(!refused.ok && refused.error.kind).toBe("refused");
  });

  it("Cancel aborts the request and reports cancelled, not an error kind of its own making", async () => {
    const controller = new AbortController();
    const fetch: FetchLike = async (_url, init) => streamResponse(HAPPY.slice(0, 4), { hold: true }, init.signal ?? undefined);
    const pending = streamMessage(request, { apiKey: KEY, fetch, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const result = await pending;
    expect(!result.ok && result.error.kind).toBe("cancelled");
    expect(!result.ok && result.text).toBe("Hello");
  });

  it("an already-aborted signal never calls fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn<FetchLike>();
    const result = await streamMessage(request, { apiKey: KEY, fetch, signal: controller.signal });
    expect(fetch).not.toHaveBeenCalled();
    expect(!result.ok && result.error.kind).toBe("cancelled");
  });
});

describe("the timeout measures time without data", () => {
  it("keeps going while data keeps arriving, past the timeout in total", async () => {
    vi.useFakeTimers();
    let push: ((s: string) => void) | undefined;
    let end: (() => void) | undefined;
    const fetch: FetchLike = async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          push = (s) => c.enqueue(encoder.encode(s));
          end = () => c.close();
          init.signal?.addEventListener("abort", () => c.error(init.signal?.reason));
        },
      });
      return new Response(body, { status: 200 });
    };
    const pending = streamMessage(request, { apiKey: KEY, fetch, idleTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(10);
    for (const chunk of HAPPY.slice(0, 7)) {
      push?.(chunk);
      await vi.advanceTimersByTimeAsync(800);
    }
    push?.(HAPPY[7]!);
    end?.();
    const result = await pending;
    expect(result.ok).toBe(true);
  });

  it("gives up after the timeout with nothing new", async () => {
    vi.useFakeTimers();
    const fetch: FetchLike = async (_url, init) => streamResponse(HAPPY.slice(0, 2), { hold: true }, init.signal ?? undefined);
    const pending = streamMessage(request, { apiKey: KEY, fetch, idleTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    const result = await pending;
    expect(!result.ok && result.error.kind).toBe("timeout");
  });

  it("times out while waiting for the response headers too", async () => {
    vi.useFakeTimers();
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const pending = countTokens(request, { apiKey: KEY, fetch, idleTimeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(600);
    const result = await pending;
    expect(!result.ok && result.error.kind).toBe("timeout");
  });
});

describe("errors", () => {
  const cases: [number, unknown, string][] = [
    [401, apiError("authentication_error", "invalid x-api-key"), "invalid_key"],
    [403, apiError("permission_error", "Your API key does not have permission to use the specified resource."), "permission"],
    [402, apiError("billing_error", "There is an issue with your billing."), "billing"],
    [400, apiError("invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."), "billing"],
    [400, apiError("invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-11-01."), "spend_limit"],
    [400, apiError("invalid_request_error", "Your workspace has reached its spend limit."), "spend_limit"],
    [400, apiError("invalid_request_error", "messages: roles must alternate"), "bad_request"],
    [404, apiError("not_found_error", "model: claude-haiku-5-5"), "model_unavailable"],
    [404, apiError("not_found_error", "The requested resource could not be found."), "bad_request"],
    [404, "<html>Not found</html>", "bad_request"],
    [413, apiError("request_too_large", "Request exceeds the maximum allowed number of bytes."), "too_large"],
    [429, apiError("rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit"), "rate_limited"],
    [529, apiError("overloaded_error", "Overloaded"), "overloaded"],
    [500, apiError("api_error", "Internal server error"), "server"],
    [502, "Bad gateway", "server"],
    [504, apiError("timeout_error", "Request timed out"), "server"],
    [418, "teapot", "bad_request"],
  ];

  for (const [status, body, kind] of cases) {
    it(`HTTP ${status} ${typeof body === "string" ? body : (body as { error: { message: string } }).error.message} is ${kind}`, async () => {
      const response = typeof body === "string" ? new Response(body, { status }) : jsonResponse(status, body, { "request-id": "req_header_1" });
      const result = await streamMessage(request, { apiKey: KEY, fetch: async () => response });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe(kind);
        expect(result.error.status).toBe(status);
        if (typeof body !== "string") {
          expect(result.error.type).toBe((body as { error: { type: string } }).error.type);
          expect(result.error.requestId).toBe("req_header_1");
        }
      }
    });
  }

  it("every kind in the table is a real kind", () => {
    for (const [, , kind] of cases) expect(AI_ERROR_KINDS).toContain(kind);
  });

  it("reads the request id from the body when there's no header", () => {
    expect(errorFromResponse(401, apiError("authentication_error", "x"), new Headers()).requestId).toBe("req_test_1");
  });

  it("429 reads retry-after as seconds or an HTTP date", () => {
    const now = Date.parse("2026-10-15T10:00:00Z");
    expect(errorFromResponse(429, apiError("rate_limit_error", "slow down"), new Headers({ "retry-after": "12" }), now).retryAfterSeconds).toBe(12);
    expect(errorFromResponse(429, apiError("rate_limit_error", "slow down"), new Headers({ "retry-after": "Thu, 15 Oct 2026 10:01:30 GMT" }), now).retryAfterSeconds).toBe(90);
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("-5", now)).toBeUndefined();
    expect(parseRetryAfter("Thu, 15 Oct 2026 09:00:00 GMT", now)).toBe(0);
  });

  it("a 429 for a spend cap (no retry-after, spend in the message) is the spend limit", () => {
    expect(errorFromResponse(429, apiError("rate_limit_error", "You have reached your monthly spend cap."), new Headers()).kind).toBe("spend_limit");
  });

  it("a network failure is offline when the browser says so, else blocked", async () => {
    const fail: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    const offline = await streamMessage(request, { apiKey: KEY, fetch: fail, online: () => false });
    expect(!offline.ok && offline.error.kind).toBe("offline");
    const blocked = await streamMessage(request, { apiKey: KEY, fetch: fail, online: () => true });
    expect(!blocked.ok && blocked.error.kind).toBe("blocked");
  });

  it("never retries by itself", async () => {
    for (const status of [429, 500, 529]) {
      const fetch = vi.fn<FetchLike>(async () => jsonResponse(status, apiError("api_error", "x")));
      await streamMessage(request, { apiKey: KEY, fetch });
      await countTokens(request, { apiKey: KEY, fetch });
      expect(fetch).toHaveBeenCalledTimes(2);
    }
    const throwing = vi.fn<FetchLike>(async () => {
      throw new TypeError("Failed to fetch");
    });
    await streamMessage(request, { apiKey: KEY, fetch: throwing });
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it("an error's API message never carries the key", async () => {
    const echo = apiError("authentication_error", `invalid x-api-key: ${KEY}`);
    const result = await streamMessage(request, { apiKey: KEY, fetch: async () => jsonResponse(401, echo) });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});
