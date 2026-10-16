import { redact } from "./redact";
import type { AiError, AiErrorKind } from "./messages";

/*
 * The page's own Anthropic client (v0.42.0): plain fetch from this browser straight to
 * api.anthropic.com, with the person's key (bring your own key). No SDK, no proxy, no Worker: Stickyard
 * has no AI server and nothing AI-related goes over the WebSocket.
 *
 * - The key goes only in the x-api-key header, never in the URL or the body.
 * - Streaming (SSE) for messages: text deltas are accumulated and the characters received so far are
 *   reported through onProgress; stop_reason and usage are read at the end.
 * - Cancel through an AbortSignal. The timeout measures time without data (no headers yet, or no new
 *   bytes), not total time, so a long reply that keeps arriving is never cut off.
 * - No automatic retries: the person presses Retry.
 * - fetch is injected through the options, so tests use a fake.
 * Everything that comes back from the API is untrusted data; API messages are redacted before they
 * leave this module.
 */

export const API_ORIGIN = "https://api.anthropic.com";
export const MESSAGES_URL = `${API_ORIGIN}/v1/messages`;
export const COUNT_TOKENS_URL = `${API_ORIGIN}/v1/messages/count_tokens`;
export const ANTHROPIC_VERSION = "2023-06-01";
/** How long to wait with nothing arriving before giving up. */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CallOptions {
  apiKey: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  /** navigator.onLine by default; tells offline from blocked when fetch itself fails. */
  online?: () => boolean;
  now?: () => number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type Effort = "low" | "medium" | "high";

export interface MessageRequest {
  model: string;
  maxTokens: number;
  system?: string;
  messages: ChatMessage[];
  /** Structured output (v0.43.0): the reply must be JSON in this schema (output_config.format). */
  schema?: Record<string, unknown>;
  /** How much the model thinks before answering (output_config.effort); the model's default when absent. */
  effort?: Effort;
}

/** output_config for a request, or nothing when it sets neither. */
function outputConfig(request: MessageRequest): { output_config?: Record<string, unknown> } {
  if (request.schema === undefined && request.effort === undefined) return {};
  return {
    output_config: {
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(request.schema === undefined ? {} : { format: { type: "json_schema", schema: request.schema } }),
    },
  };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type MessageResult = { ok: true; text: string; stopReason: string; usage: Usage } | { ok: false; error: AiError; text: string };

export type CountResult = { ok: true; inputTokens: number } | { ok: false; error: AiError };

/** retry-after as seconds or an HTTP date, in whole seconds from now; undefined when unreadable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (!/[a-z]/i.test(text)) return undefined;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The API's error body: { type: "error", error: { type, message }, request_id }. */
function apiErrorParts(body: unknown): { type?: string | undefined; message?: string | undefined; requestId?: string | undefined } {
  const outer = record(body);
  const inner = record(outer?.error);
  return { type: text(inner?.type), message: text(inner?.message), requestId: text(outer?.request_id) };
}

const SPEND = /spend|usage limit/i;

function kindFor(status: number, type: string | undefined, message: string): AiErrorKind {
  if (type === "overloaded_error" || status === 529) return "overloaded";
  switch (status) {
    case 400:
      // An empty credit balance comes back as a 400 invalid_request_error ("Your credit balance is too low...").
      if (/credit balance/i.test(message)) return "billing";
      // So does reaching a spend limit the organisation set.
      if (SPEND.test(message)) return "spend_limit";
      return "bad_request";
    case 401:
      return "invalid_key";
    case 402:
      return "billing";
    case 403:
      return "permission";
    case 404:
      // Only a 404 about the model ("model: <id>"), not any 404.
      return type === "not_found_error" && /^model\b|\bmodel:/i.test(message) ? "model_unavailable" : "bad_request";
    case 413:
      return "too_large";
    case 429:
      return SPEND.test(message) || /spend cap/i.test(message) ? "spend_limit" : "rate_limited";
  }
  return status >= 500 ? "server" : "bad_request";
}

/** An HTTP error response as an AiError (the body already parsed, or a string when it wasn't JSON). */
export function errorFromResponse(status: number, body: unknown, headers: Headers, now: number = Date.now()): AiError {
  const parts = apiErrorParts(body);
  const message = parts.message ?? "";
  const kind = kindFor(status, parts.type, message);
  const retryAfterSeconds = status === 429 ? parseRetryAfter(headers.get("retry-after"), now) : undefined;
  const error: AiError = {
    kind,
    status,
    type: parts.type,
    apiMessage: parts.message === undefined ? undefined : redact(parts.message),
    requestId: headers.get("request-id") ?? parts.requestId,
  };
  if (kind === "spend_limit" && status === 429 && retryAfterSeconds !== undefined) return { ...error, kind: "rate_limited", retryAfterSeconds };
  return retryAfterSeconds === undefined ? error : { ...error, retryAfterSeconds };
}

/** A mid-stream error event, by its type. */
function streamErrorKind(type: string | undefined): AiErrorKind {
  switch (type) {
    case "overloaded_error":
      return "overloaded";
    case "rate_limit_error":
      return "rate_limited";
    case "authentication_error":
      return "invalid_key";
    case "permission_error":
      return "permission";
    case "billing_error":
      return "billing";
    case "invalid_request_error":
      return "bad_request";
    default:
      return "server";
  }
}

/**
 * One call's abort and no-data timer. `touch()` restarts the timer (headers or bytes arrived);
 * `reason()` says why it ended: the person's cancel, or the timeout.
 */
function watch(signal: AbortSignal | undefined, idleMs: number) {
  const controller = new AbortController();
  let why: "cancelled" | "timeout" | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: "cancelled" | "timeout") => {
    if (why) return;
    why = reason;
    controller.abort(new DOMException(reason === "timeout" ? "Timed out" : "Cancelled", "AbortError"));
  };
  const onAbort = () => stop("cancelled");
  signal?.addEventListener("abort", onAbort);
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stop("timeout"), idleMs);
  };
  touch();
  return {
    signal: controller.signal,
    touch,
    reason: () => why,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

type Watch = ReturnType<typeof watch>;

function headersFor(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    // Needed for any call made from a browser page; the page uses the person's own key (bring your own key).
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

/** Why a call failed without an HTTP response: cancelled, timed out, offline or blocked. */
function failure(w: Watch, options: CallOptions): AiError {
  const why = w.reason();
  if (why) return { kind: why };
  const online = options.online ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  return { kind: online() ? "blocked" : "offline" };
}

/** Sends one POST and waits for the response headers, or says why there are none. */
async function post(url: string, body: unknown, w: Watch, options: CallOptions): Promise<Response | AiError> {
  if (options.signal?.aborted) return { kind: "cancelled" };
  const doFetch: FetchLike = options.fetch ?? ((u, init) => globalThis.fetch(u, init));
  try {
    const response = await doFetch(url, {
      method: "POST",
      headers: headersFor(options.apiKey),
      body: JSON.stringify(body),
      signal: w.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    w.touch();
    return response;
  } catch {
    return failure(w, options);
  }
}

/** Reads a response body to the end (restarting the no-data timer on each chunk). */
async function readAll(response: Response, w: Watch): Promise<string | null> {
  if (!response.body) return response.text().catch(() => null);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      w.touch();
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  } catch {
    return null;
  }
}

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

async function httpError(response: Response, w: Watch, options: CallOptions): Promise<AiError> {
  const raw = await readAll(response, w);
  if (raw === null && w.reason()) return { kind: w.reason() ?? "cancelled", status: response.status };
  return errorFromResponse(response.status, parseJson(raw ?? ""), response.headers, (options.now ?? Date.now)());
}

/** POST /v1/messages/count_tokens (free). Passes only with a numeric input_tokens. */
export async function countTokens(request: { model: string; messages: ChatMessage[] }, options: CallOptions): Promise<CountResult> {
  const w = watch(options.signal, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  try {
    const response = await post(COUNT_TOKENS_URL, { model: request.model, messages: request.messages }, w, options);
    if (!(response instanceof Response)) return { ok: false, error: response };
    if (!response.ok) return { ok: false, error: await httpError(response, w, options) };
    const raw = await readAll(response, w);
    if (raw === null) return { ok: false, error: failure(w, options) };
    const tokens = record(parseJson(raw))?.input_tokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens))
      return { ok: false, error: { kind: "malformed", status: response.status, requestId: response.headers.get("request-id") ?? undefined } };
    return { ok: true, inputTokens: tokens };
  } finally {
    w.done();
  }
}

/** The SSE events of one stream, as they're parsed. */
interface StreamState {
  text: string;
  stopReason: string | null;
  usage: Usage;
  stopped: boolean;
  error: AiError | null;
}

function applyEvent(state: StreamState, data: unknown, onProgress: ((chars: number) => void) | undefined): void {
  const event = record(data);
  switch (event?.type) {
    case "message_start": {
      const usage = record(record(event.message)?.usage);
      if (typeof usage?.input_tokens === "number") state.usage.inputTokens = usage.input_tokens;
      if (typeof usage?.output_tokens === "number") state.usage.outputTokens = usage.output_tokens;
      return;
    }
    case "content_block_delta": {
      const delta = record(event.delta);
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        state.text += delta.text;
        onProgress?.(state.text.length);
      }
      return;
    }
    case "message_delta": {
      const reason = text(record(event.delta)?.stop_reason);
      if (reason) state.stopReason = reason;
      // Cumulative, per the API.
      const usage = record(event.usage);
      if (typeof usage?.output_tokens === "number") state.usage.outputTokens = usage.output_tokens;
      if (typeof usage?.input_tokens === "number") state.usage.inputTokens = usage.input_tokens;
      return;
    }
    case "message_stop":
      state.stopped = true;
      return;
    case "error": {
      const parts = apiErrorParts(event);
      state.error = { kind: streamErrorKind(parts.type), type: parts.type, apiMessage: parts.message === undefined ? undefined : redact(parts.message) };
      return;
    }
    // ping, content_block_start/stop and any new event types are ignored.
  }
}

/** Splits SSE text into complete events; returns the leftover partial event. */
function drainEvents(buffer: string, onData: (data: string) => void): string {
  // A chunk can end between the \r and \n of one line ending: keep that \r for the next chunk.
  const hold = buffer.endsWith("\r") ? "\r" : "";
  const normalised = (hold ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, "\n");
  const blocks = normalised.split("\n\n");
  const rest = (blocks.pop() ?? "") + hold;
  for (const block of blocks) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) onData(data);
  }
  return rest;
}

/** POST /v1/messages with stream: true. Text accumulates; onProgress gets the characters so far. */
export async function streamMessage(request: MessageRequest, options: CallOptions & { onProgress?: (chars: number) => void }): Promise<MessageResult> {
  const w = watch(options.signal, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  const state: StreamState = { text: "", stopReason: null, usage: { inputTokens: 0, outputTokens: 0 }, stopped: false, error: null };
  const fail = (error: AiError): MessageResult => ({ ok: false, error, text: state.text });
  try {
    const body = {
      model: request.model,
      max_tokens: request.maxTokens,
      stream: true,
      ...(request.system === undefined ? {} : { system: request.system }),
      messages: request.messages,
      ...outputConfig(request),
    };
    const response = await post(MESSAGES_URL, body, w, options);
    if (!(response instanceof Response)) return fail(response);
    if (!response.ok) return fail(await httpError(response, w, options));
    const requestId = response.headers.get("request-id") ?? undefined;
    if (!response.body) return fail({ kind: "malformed", status: response.status, requestId });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const onData = (data: string) => {
      const parsed = parseJson(data);
      if (typeof parsed === "string") state.error ??= { kind: "malformed", requestId };
      else applyEvent(state, parsed, options.onProgress);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        w.touch();
        buffer = drainEvents(buffer + decoder.decode(value, { stream: true }), onData);
        if (state.error) break;
      }
      drainEvents(`${buffer}${decoder.decode()}\n\n`, onData);
    } catch {
      return fail(failure(w, options));
    }
    if (state.error) {
      void reader.cancel().catch(() => {});
      return fail({ ...state.error, requestId: state.error.requestId ?? requestId });
    }
    if (!state.stopped || !state.stopReason)
      return fail({ kind: "malformed", status: response.status, apiMessage: "The reply stopped before it finished.", requestId });
    if (state.stopReason === "refusal") return fail({ kind: "refused", status: response.status, requestId });
    if (state.stopReason === "max_tokens") return fail({ kind: "truncated", status: response.status, requestId });
    return { ok: true, text: state.text, stopReason: state.stopReason, usage: state.usage };
  } finally {
    w.done();
  }
}
