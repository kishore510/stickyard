import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_BYTES,
  MAX_NAME_LENGTH,
  MAX_PARTICIPANTS,
  MAX_TEXT_LENGTH,
  PALETTE_SIZE,
  PROTOCOL_VERSION,
  clientMessageSchema,
  encodeMessage,
  parseMessage,
  serverMessageSchema,
  type ServerMessage,
} from "../src/index";

const ID_A = "AAAAAAAAAAAAAAAA";
const ID_B = "BBBBBBBBBBBBBBBB";
const alex = { id: ID_A, name: "Alex", colourIndex: 0 };
const sam = { id: ID_B, name: "Sam", colourIndex: 1 };

describe("constants", () => {
  it("PROTOCOL_VERSION is 9", () => {
    expect(PROTOCOL_VERSION).toBe(9);
  });

  it("limits are the slice 1 defaults", () => {
    expect(MAX_NAME_LENGTH).toBe(24);
    expect(MAX_TEXT_LENGTH).toBe(280);
    expect(MAX_PARTICIPANTS).toBe(20);
    expect(PALETTE_SIZE).toBe(8);
  });
});

describe("clientMessageSchema", () => {
  it.each([
    ["hello v3", { type: "hello", protocolVersion: 3 }],
    ["hello v2 (so the server can report a mismatch)", { type: "hello", protocolVersion: 2 }],
    ["hello v1 (so the server can report a mismatch)", { type: "hello", protocolVersion: 1 }],
    ["hello from the future", { type: "hello", protocolVersion: 99 }],
    ["join", { type: "join", name: "Alex" }],
    ["join with an unclean name (the server cleans it)", { type: "join", name: "  A​lex  " }],
    ["say", { type: "say", text: "Hello there" }],
  ])("accepts %s", (_label, value) => {
    expect(clientMessageSchema.safeParse(value).success).toBe(true);
  });

  it("strips client-claimed id, colour and sender fields", () => {
    const join = clientMessageSchema.parse({ type: "join", name: "Alex", id: ID_B, colourIndex: 7, colour: "red" });
    expect(join).toEqual({ type: "join", name: "Alex" });
    const say = clientMessageSchema.parse({ type: "say", text: "hi", from: ID_B, id: ID_B });
    expect(say).toEqual({ type: "say", text: "hi" });
  });

  it.each([
    ["hello without version", { type: "hello" }],
    ["string version", { type: "hello", protocolVersion: "2" }],
    ["fractional version", { type: "hello", protocolVersion: 1.5 }],
    ["negative version", { type: "hello", protocolVersion: -1 }],
    ["join without name", { type: "join" }],
    ["join with a number name", { type: "join", name: 42 }],
    ["join with a huge name", { type: "join", name: "x".repeat(1000) }],
    ["say without text", { type: "say" }],
    ["say with an object", { type: "say", text: { html: "<b>" } }],
    ["say with huge text", { type: "say", text: "x".repeat(5000) }],
    ["unknown type", { type: "nope" }],
    ["server message type", { type: "echo", from: ID_A, text: "hi" }],
    ["null", null],
    ["array", [1, 2]],
  ])("rejects %s", (_label, value) => {
    expect(clientMessageSchema.safeParse(value).success).toBe(false);
  });
});

describe("serverMessageSchema", () => {
  const valid: [string, ServerMessage][] = [
    ["welcome", { type: "welcome", protocolVersion: 2 }],
    ["joined", { type: "joined", you: alex, participants: [alex, sam] }],
    ["participant_joined", { type: "participant_joined", participant: sam }],
    ["participant_left", { type: "participant_left", id: ID_B }],
    ["echo", { type: "echo", from: ID_A, text: "Hello <b>there</b>" }],
  ];
  it.each(valid)("accepts %s", (_label, value) => {
    expect(serverMessageSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    "version_mismatch",
    "bad_message",
    "too_large",
    "rate_limited",
    "room_full",
    "not_joined",
    "already_joined",
    "invalid_name",
    "notes_full",
  ] as const)("accepts error with code %s", (code) => {
    expect(serverMessageSchema.safeParse({ type: "error", code, message: "x" }).success).toBe(true);
  });

  it.each([
    ["welcome without version", { type: "welcome" }],
    ["error with unknown code", { type: "error", code: "boom", message: "x" }],
    ["error without message", { type: "error", code: "bad_message" }],
    ["client message type", { type: "hello", protocolVersion: 2 }],
    ["joined without you", { type: "joined", participants: [] }],
    ["participant with a bad id", { type: "participant_joined", participant: { ...sam, id: "x" } }],
    ["participant with a negative colour", { type: "participant_joined", participant: { ...sam, colourIndex: -1 } }],
    [
      "participant with a colour past the cap",
      { type: "participant_joined", participant: { ...sam, colourIndex: MAX_PARTICIPANTS } },
    ],
    ["participant with an empty name", { type: "participant_joined", participant: { ...sam, name: "" } }],
    ["participant with an unclean name", { type: "participant_joined", participant: { ...sam, name: " Sam‮" } }],
    ["participant with a long name", { type: "participant_joined", participant: { ...sam, name: "x".repeat(25) } }],
    [
      "joined with too many participants",
      { type: "joined", you: alex, participants: Array.from({ length: MAX_PARTICIPANTS + 1 }, () => alex) },
    ],
    ["echo without from", { type: "echo", text: "hi" }],
    ["echo with empty text", { type: "echo", from: ID_A, text: "" }],
    ["echo with long text", { type: "echo", from: ID_A, text: "x".repeat(MAX_TEXT_LENGTH + 1) }],
  ])("rejects %s", (_label, value) => {
    expect(serverMessageSchema.safeParse(value).success).toBe(false);
  });

  it("the largest possible joined message fits under the size cap", () => {
    // Every name at the limit, in 4-byte characters that JSON doesn't escape.
    const name = "😀".repeat(MAX_NAME_LENGTH);
    const people = Array.from({ length: MAX_PARTICIPANTS }, (_, i) => ({
      id: ID_A,
      name,
      colourIndex: i,
    }));
    const raw = encodeMessage({ type: "joined", you: people[0]!, participants: people });
    expect(parseMessage(raw, serverMessageSchema).ok).toBe(true);
  });

  it("the largest possible echo fits under the size cap", () => {
    const raw = encodeMessage({ type: "echo", from: ID_A, text: "😀".repeat(MAX_TEXT_LENGTH) });
    expect(parseMessage(raw, serverMessageSchema).ok).toBe(true);
  });
});

describe("parseMessage", () => {
  it("parses a valid hello string", () => {
    const result = parseMessage(JSON.stringify({ type: "hello", protocolVersion: 2 }), clientMessageSchema);
    expect(result).toEqual({ ok: true, value: { type: "hello", protocolVersion: 2 } });
  });

  it("parses a join", () => {
    const result = parseMessage(JSON.stringify({ type: "join", name: "Alex" }), clientMessageSchema);
    expect(result).toEqual({ ok: true, value: { type: "join", name: "Alex" } });
  });

  it.each(["", "not json", "{", "{\"type\":", "undefined", "<script>alert(1)</script>"])(
    "rejects non-JSON %j as bad_message",
    (raw) => {
      expect(parseMessage(raw, clientMessageSchema)).toEqual({ ok: false, error: "bad_message" });
    },
  );

  it("rejects valid JSON that fails the schema as bad_message", () => {
    expect(parseMessage("{\"type\":\"say\"}", clientMessageSchema)).toEqual({ ok: false, error: "bad_message" });
  });

  it("rejects input over the size cap as too_large", () => {
    const raw = JSON.stringify({ type: "say", text: "x".repeat(MAX_MESSAGE_BYTES) });
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
    const result = parseMessage(
      "{\"type\":\"hello\",\"protocolVersion\":2,\"__proto__\":{\"polluted\":true}}",
      clientMessageSchema,
    );
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
    const base = JSON.stringify({ type: "hello", protocolVersion: 2, pad: "" });
    const raw = JSON.stringify({ type: "hello", protocolVersion: 2, pad: "x".repeat(MAX_MESSAGE_BYTES - base.length) });
    expect(raw.length).toBe(MAX_MESSAGE_BYTES);
    expect(parseMessage(raw, clientMessageSchema).ok).toBe(true);
  });
});
