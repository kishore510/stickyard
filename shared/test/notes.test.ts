import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  MAX_MESSAGE_BYTES,
  MAX_NOTES_PER_ROOM,
  MAX_NOTE_TEXT,
  MAX_SERVER_MESSAGE_BYTES,
  NOTE_COLORS,
  NOTE_SIZE,
  clampNotePosition,
  cleanNoteText,
  clientMessageSchema,
  encodeMessage,
  parseMessage,
  serverMessageSchema,
  type Note,
  type ServerMessage,
} from "../src/index";

/*
 * Protocol v3: shared sticky notes. Fixtures are generic on purpose.
 */

const ID_A = "AAAAAAAAAAAAAAAA";
const NOTE_ID = "NNNNNNNNNNNNNNNN";
const note: Note = { id: NOTE_ID, x: 100, y: 200, text: "Idea one", color: "yellow", rev: 1, authorId: ID_A };

describe("note constants", () => {
  it("are the slice 2 defaults", () => {
    expect(MAX_NOTES_PER_ROOM).toBe(200);
    expect(MAX_NOTE_TEXT).toBe(280);
    expect(NOTE_COLORS).toContain("yellow");
    expect(NOTE_COLORS).toContain("pink");
    expect(BOARD_WIDTH).toBeGreaterThan(NOTE_SIZE);
    expect(BOARD_HEIGHT).toBeGreaterThan(NOTE_SIZE);
    expect(MAX_SERVER_MESSAGE_BYTES).toBeGreaterThan(MAX_MESSAGE_BYTES);
  });
});

describe("clampNotePosition", () => {
  it.each([
    [{ x: 0, y: 0 }, { x: 0, y: 0 }],
    [{ x: 10, y: 20 }, { x: 10, y: 20 }],
    [{ x: BOARD_WIDTH, y: BOARD_HEIGHT }, { x: BOARD_WIDTH - NOTE_SIZE, y: BOARD_HEIGHT - NOTE_SIZE }],
    [{ x: -50, y: -1 }, { x: 0, y: 0 }],
    [{ x: 10.6, y: 3.2 }, { x: 11, y: 3 }],
  ])("%j -> %j", (input, expected) => {
    expect(clampNotePosition(input.x, input.y)).toEqual(expected);
  });
});

describe("cleanNoteText", () => {
  it.each([
    ["plain", "Idea one", "Idea one"],
    ["empty is allowed", "", ""],
    ["blank becomes empty", "  \n ", ""],
    ["trims", "  Idea one \n", "Idea one"],
    ["keeps newlines", "Idea one\nNeeds follow-up", "Idea one\nNeeds follow-up"],
    ["CRLF and CR become newlines", "a\r\nb\rc", "a\nb\nc"],
    ["tabs become spaces", "a\tb", "a b"],
    ["strips other controls", "a\u0000b\u0007c\u001Bd\u007Fe\u009F", "abcde"],
    ["strips invisible and bidi characters", "‮Idea​ one‬", "Idea one"],
    ["keeps HTML-looking text as text", "<b>bold</b>", "<b>bold</b>"],
    ["exactly the cap, in characters", "😀".repeat(MAX_NOTE_TEXT), "😀".repeat(MAX_NOTE_TEXT)],
  ])("%s", (_label, input, expected) => {
    expect(cleanNoteText(input)).toBe(expected);
  });

  it("refuses text over the cap", () => {
    expect(cleanNoteText("x".repeat(MAX_NOTE_TEXT + 1))).toBeNull();
  });
});

describe("client note messages", () => {
  const add = { type: "noteAdd", clientRef: "ref-1", x: 10, y: 20, color: "pink", text: "Idea one" };
  const edit = { type: "noteEdit", id: NOTE_ID, text: "Needs follow-up" };
  const move = { type: "noteMove", id: NOTE_ID, x: 30, y: 40, final: false };
  const del = { type: "noteDelete", id: NOTE_ID };

  it.each([
    ["noteAdd", add],
    ["noteAdd with empty text", { ...add, text: "" }],
    ["noteAdd at the far corner", { ...add, x: BOARD_WIDTH, y: BOARD_HEIGHT }],
    ["noteAdd with every colour", { ...add, color: NOTE_COLORS.at(-1) }],
    ["noteAdd with text at the cap", { ...add, text: "😀".repeat(MAX_NOTE_TEXT) }],
    ["noteEdit", edit],
    ["noteEdit to empty", { ...edit, text: "" }],
    ["noteMove", move],
    ["noteMove final", { ...move, final: true }],
    ["noteDelete", del],
  ])("accepts %s", (_label, value) => {
    expect(clientMessageSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    // noteAdd
    ["noteAdd with oversize text", { ...add, text: "x".repeat(MAX_NOTE_TEXT + 1) }],
    ["noteAdd with huge text", { ...add, text: "x".repeat(5000) }],
    ["noteAdd with a hex colour", { ...add, color: "#ff0000" }],
    ["noteAdd with an unknown colour", { ...add, color: "red" }],
    ["noteAdd with a fractional x", { ...add, x: 10.5 }],
    ["noteAdd with a string y", { ...add, y: "20" }],
    ["noteAdd with a negative x", { ...add, x: -1 }],
    ["noteAdd past the board", { ...add, x: BOARD_WIDTH + 1 }],
    ["noteAdd below the board", { ...add, y: BOARD_HEIGHT + 1 }],
    ["noteAdd with NaN-ish x", { ...add, x: null }],
    ["noteAdd without clientRef", { type: "noteAdd", x: 1, y: 1, color: "yellow", text: "" }],
    ["noteAdd with an empty clientRef", { ...add, clientRef: "" }],
    ["noteAdd with a long clientRef", { ...add, clientRef: "r".repeat(33) }],
    ["noteAdd with a clientRef with odd characters", { ...add, clientRef: "<ref>" }],
    ["noteAdd with a claimed id", { ...add, id: NOTE_ID }],
    ["noteAdd with a claimed author", { ...add, authorId: ID_A }],
    ["noteAdd with a claimed rev", { ...add, rev: 9 }],
    // noteEdit
    ["noteEdit with oversize text", { ...edit, text: "x".repeat(MAX_NOTE_TEXT + 1) }],
    ["noteEdit with a number text", { ...edit, text: 42 }],
    ["noteEdit with a bad id", { ...edit, id: "short" }],
    ["noteEdit without id", { type: "noteEdit", text: "x" }],
    ["noteEdit with a colour", { ...edit, color: "pink" }],
    ["noteEdit with a claimed author", { ...edit, authorId: ID_A }],
    // noteMove
    ["noteMove without final", { type: "noteMove", id: NOTE_ID, x: 1, y: 1 }],
    ["noteMove with a string final", { ...move, final: "true" }],
    ["noteMove with fractional coords", { ...move, x: 1.25 }],
    ["noteMove out of range", { ...move, y: -5 }],
    ["noteMove far out of range", { ...move, x: 1e12 }],
    ["noteMove with a rev", { ...move, rev: 3 }],
    // noteDelete
    ["noteDelete without id", { type: "noteDelete" }],
    ["noteDelete with an array id", { type: "noteDelete", id: [NOTE_ID] }],
    ["noteDelete with extra fields", { ...del, force: true }],
  ])("rejects %s", (_label, value) => {
    expect(clientMessageSchema.safeParse(value).success).toBe(false);
  });
});

describe("server note messages", () => {
  const valid: [string, ServerMessage][] = [
    ["empty snapshot", { type: "snapshot", notes: [] }],
    ["snapshot", { type: "snapshot", notes: [note, { ...note, id: ID_A, color: "blue", text: "" }] }],
    ["noteAdded", { type: "noteAdded", note }],
    ["noteAdded with clientRef", { type: "noteAdded", note, clientRef: "ref-1" }],
    ["noteUpdated", { type: "noteUpdated", note: { ...note, text: "Needs follow-up", rev: 2 } }],
    ["noteMoved", { type: "noteMoved", id: NOTE_ID, x: 1, y: 2, rev: 3, final: true }],
    ["noteDeleted", { type: "noteDeleted", id: NOTE_ID }],
    ["error with clientRef", { type: "error", code: "notes_full", message: "x", clientRef: "ref-1" }],
    ["error with noteId", { type: "error", code: "rate_limited", message: "x", noteId: NOTE_ID }],
  ];
  it.each(valid)("accepts %s", (_label, value) => {
    expect(serverMessageSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["note with a hex colour", { type: "noteAdded", note: { ...note, color: "#ffff00" } }],
    ["note with unclean text", { type: "noteAdded", note: { ...note, text: " Idea‮ " } }],
    ["note with long text", { type: "noteAdded", note: { ...note, text: "x".repeat(MAX_NOTE_TEXT + 1) } }],
    ["note with rev 0", { type: "noteAdded", note: { ...note, rev: 0 } }],
    ["note off the board", { type: "noteAdded", note: { ...note, x: BOARD_WIDTH } }],
    ["note with a bad author", { type: "noteAdded", note: { ...note, authorId: "x" } }],
    ["snapshot over the cap", { type: "snapshot", notes: Array.from({ length: MAX_NOTES_PER_ROOM + 1 }, () => note) }],
    ["noteMoved without rev", { type: "noteMoved", id: NOTE_ID, x: 1, y: 2, final: false }],
    ["noteDeleted with a bad id", { type: "noteDeleted", id: "<x>" }],
  ])("rejects %s", (_label, value) => {
    expect(serverMessageSchema.safeParse(value).success).toBe(false);
  });

  it("the largest possible snapshot fits under the server message cap", () => {
    const big: Note = { ...note, text: "😀".repeat(MAX_NOTE_TEXT), rev: Number.MAX_SAFE_INTEGER };
    const raw = encodeMessage({ type: "snapshot", notes: Array.from({ length: MAX_NOTES_PER_ROOM }, () => big) });
    expect(raw.length).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(parseMessage(raw, serverMessageSchema, MAX_SERVER_MESSAGE_BYTES).ok).toBe(true);
  });

  it("the largest possible note message fits under the client message cap too", () => {
    // Client-to-server messages stay under MAX_MESSAGE_BYTES even at the text cap.
    const raw = JSON.stringify({ type: "noteAdd", clientRef: "r".repeat(32), x: BOARD_WIDTH, y: BOARD_HEIGHT, color: "yellow", text: "😀".repeat(MAX_NOTE_TEXT) });
    expect(parseMessage(raw, clientMessageSchema).ok).toBe(true);
  });
});
