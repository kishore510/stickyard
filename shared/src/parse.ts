import type { z } from "zod";
import { MAX_MESSAGE_BYTES, type ClientMessage, type ServerMessage } from "./protocol";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: "bad_message" | "too_large" };

/** UTF-8 byte length, stopping early once past the cap. Runtime-agnostic (no TextEncoder). */
function byteLength(raw: string, cap: number): number {
  // Every UTF-16 code unit encodes to at least one UTF-8 byte.
  if (raw.length > cap) return raw.length;
  let bytes = 0;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // surrogate pair
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Size-cap, JSON-parse and validate one inbound message. Never throws.
 * Binary frames are not part of the protocol and are rejected.
 * `maxBytes` defaults to the client-to-server cap; the web passes MAX_SERVER_MESSAGE_BYTES.
 */
export function parseMessage<S extends z.ZodType>(
  raw: string | ArrayBuffer,
  schema: S,
  maxBytes: number = MAX_MESSAGE_BYTES,
): ParseResult<z.infer<S>> {
  if (typeof raw !== "string") {
    return { ok: false, error: raw.byteLength > maxBytes ? "too_large" : "bad_message" };
  }
  if (byteLength(raw, maxBytes) > maxBytes) return { ok: false, error: "too_large" };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "bad_message" };
  }

  const result = schema.safeParse(json);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: "bad_message" };
}

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}
