import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  clientMessageSchema,
  parseMessage,
  serverMessageSchema,
} from "../src/index";

describe("PROTOCOL_VERSION", () => {
  it("is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe("clientMessageSchema", () => {
  it("accepts a valid hello", () => {
    const result = clientMessageSchema.safeParse({ type: "hello", protocolVersion: 1 });
    expect(result.success).toBe(true);
  });

  it("accepts hello with another version (so the server can report a mismatch)", () => {
    const result = clientMessageSchema.safeParse({ type: "hello", protocolVersion: 99 });
    expect(result.success).toBe(true);
  });

  it.each([
    ["missing version", { type: "hello" }],
    ["string version", { type: "hello", protocolVersion: "1" }],
    ["fractional version", { type: "hello", protocolVersion: 1.5 }],
    ["negative version", { type: "hello", protocolVersion: -1 }],
    ["unknown type", { type: "nope", protocolVersion: 1 }],
    ["server message type", { type: "welcome", protocolVersion: 1 }],
    ["null", null],
    ["array", [1, 2]],
  ])("rejects %s", (_label, value) => {
    expect(clientMessageSchema.safeParse(value).success).toBe(false);
  });
});

describe("serverMessageSchema", () => {
  it("accepts welcome", () => {
    expect(serverMessageSchema.safeParse({ type: "welcome", protocolVersion: 1 }).success).toBe(true);
  });

  it.each(["version_mismatch", "bad_message", "too_large", "rate_limited"] as const)(
    "accepts error with code %s",
    (code) => {
      const result = serverMessageSchema.safeParse({ type: "error", code, message: "x" });
      expect(result.success).toBe(true);
    },
  );

  it.each([
    ["welcome without version", { type: "welcome" }],
    ["error with unknown code", { type: "error", code: "boom", message: "x" }],
    ["error without message", { type: "error", code: "bad_message" }],
    ["client message type", { type: "hello", protocolVersion: 1 }],
  ])("rejects %s", (_label, value) => {
    expect(serverMessageSchema.safeParse(value).success).toBe(false);
  });
});

describe("parseMessage", () => {
  it("parses a valid hello string", () => {
    const result = parseMessage(JSON.stringify({ type: "hello", protocolVersion: 1 }), clientMessageSchema);
    expect(result).toEqual({ ok: true, value: { type: "hello", protocolVersion: 1 } });
  });

  it.each(["", "not json", "{", "{\"type\":", "undefined"])("rejects non-JSON %j as bad_message", (raw) => {
    expect(parseMessage(raw, clientMessageSchema)).toEqual({ ok: false, error: "bad_message" });
  });

  it("rejects valid JSON that fails the schema as bad_message", () => {
    expect(parseMessage("{\"type\":\"hello\"}", clientMessageSchema)).toEqual({
      ok: false,
      error: "bad_message",
    });
  });

  it("rejects input over the size cap as too_large", () => {
    const raw = JSON.stringify({ type: "hello", protocolVersion: 1, pad: "x".repeat(MAX_MESSAGE_BYTES) });
    expect(parseMessage(raw, clientMessageSchema)).toEqual({ ok: false, error: "too_large" });
  });

  it("measures the cap in UTF-8 bytes, not characters", () => {
    // Each "é" is 2 bytes in UTF-8, so this is under the cap in chars but over it in bytes.
    const raw = "é".repeat(Math.floor(MAX_MESSAGE_BYTES / 2) + 1);
    expect(raw.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(parseMessage(raw, clientMessageSchema)).toEqual({ ok: false, error: "too_large" });
  });

  it("rejects binary input", () => {
    expect(parseMessage(new ArrayBuffer(8), clientMessageSchema)).toEqual({ ok: false, error: "bad_message" });
  });

  it("rejects oversized binary input as too_large", () => {
    expect(parseMessage(new ArrayBuffer(MAX_MESSAGE_BYTES + 1), clientMessageSchema)).toEqual({
      ok: false,
      error: "too_large",
    });
  });

  it("does not let __proto__ keys pollute objects", () => {
    const result = parseMessage("{\"type\":\"hello\",\"protocolVersion\":1,\"__proto__\":{\"polluted\":true}}", clientMessageSchema);
    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("parseMessage byte counting", () => {
  it("counts 4-byte characters (emoji) correctly", () => {
    const emoji = "😀"; // 2 UTF-16 units, 4 UTF-8 bytes
    const raw = emoji.repeat(Math.floor(MAX_MESSAGE_BYTES / 4) + 1);
    expect(parseMessage(raw, clientMessageSchema)).toEqual({ ok: false, error: "too_large" });
  });

  it("accepts a message exactly at the cap", () => {
    const base = JSON.stringify({ type: "hello", protocolVersion: 1, pad: "" });
    const raw = JSON.stringify({ type: "hello", protocolVersion: 1, pad: "x".repeat(MAX_MESSAGE_BYTES - base.length) });
    expect(raw.length).toBe(MAX_MESSAGE_BYTES);
    expect(parseMessage(raw, clientMessageSchema).ok).toBe(true);
  });
});
