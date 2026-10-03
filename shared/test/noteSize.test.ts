import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  MAX_MESSAGE_BYTES,
  MAX_NOTES_PER_ROOM,
  MAX_NOTE_TEXT,
  MAX_SERVER_MESSAGE_BYTES,
  NOTE_ALIGNS,
  NOTE_COLORS,
  NOTE_DEFAULTS,
  NOTE_DEFAULT_H,
  NOTE_DEFAULT_W,
  NOTE_FONT_SIZES,
  NOTE_MAX_H,
  NOTE_MAX_W,
  NOTE_MIN_H,
  NOTE_MIN_W,
  NOTE_TEXT_COLORS,
  NOTE_Z_LIMIT,
  PROTOCOL_VERSION,
  clampNotePosition,
  clampNoteRect,
  clientMessageSchema,
  encodeMessage,
  noteAddSchema,
  parseMessage,
  serverMessageSchema,
  type Note,
} from "../src/index";

/*
 * Protocol v4 (slice 2.7): note size, colour change and text style. Fixtures are generic.
 */

const ID_A = "AAAAAAAAAAAAAAAA";
const NOTE_ID = "NNNNNNNNNNNNNNNN";
const note: Note = { id: NOTE_ID, x: 100, y: 200, ...NOTE_DEFAULTS, text: "Idea one", color: "yellow", rev: 1, authorId: ID_A };

describe("protocol v4 constants", () => {
  it("is protocol 4 or later (v5 adds titleAlign)", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(4);
  });

  it("sizes are integers, default between min and max, and the largest note fits the board", () => {
    for (const n of [NOTE_DEFAULT_W, NOTE_DEFAULT_H, NOTE_MIN_W, NOTE_MIN_H, NOTE_MAX_W, NOTE_MAX_H]) expect(Number.isInteger(n)).toBe(true);
    expect(NOTE_DEFAULT_W).toBe(160);
    expect(NOTE_DEFAULT_H).toBe(160);
    expect(NOTE_MIN_W).toBeLessThan(NOTE_DEFAULT_W);
    expect(NOTE_MAX_W).toBeGreaterThan(NOTE_DEFAULT_W);
    expect(NOTE_MIN_H).toBeLessThan(NOTE_DEFAULT_H);
    expect(NOTE_MAX_H).toBeGreaterThan(NOTE_DEFAULT_H);
    expect(NOTE_MAX_W).toBeLessThan(BOARD_WIDTH);
    expect(NOTE_MAX_H).toBeLessThan(BOARD_HEIGHT);
  });

  it("style keys are fixed sets with today's look as the default", () => {
    expect(NOTE_FONT_SIZES).toEqual(["s", "m", "l", "xl"]);
    expect(NOTE_ALIGNS).toEqual(["left", "center", "right"]);
    expect(NOTE_TEXT_COLORS[0]).toBe("auto");
    expect(NOTE_TEXT_COLORS.length).toBeGreaterThanOrEqual(6);
    expect(NOTE_TEXT_COLORS.length).toBeLessThanOrEqual(8);
    expect(NOTE_DEFAULTS).toEqual({
      w: NOTE_DEFAULT_W,
      h: NOTE_DEFAULT_H,
      fontSize: "m",
      bold: false,
      italic: false,
      textColor: "auto",
      align: "left",
      titleAlign: "left",
      titleFontSize: "m",
      titleBold: false,
      titleItalic: false,
      titleTextColor: "auto",
    });
  });
});

describe("clampNotePosition with a size", () => {
  it("keeps the whole note on the board", () => {
    expect(clampNotePosition(BOARD_WIDTH, BOARD_HEIGHT, { w: NOTE_MAX_W, h: NOTE_MIN_H })).toEqual({
      x: BOARD_WIDTH - NOTE_MAX_W,
      y: BOARD_HEIGHT - NOTE_MIN_H,
    });
    expect(clampNotePosition(-5, 7.4, { w: NOTE_MIN_W, h: NOTE_MIN_H })).toEqual({ x: 0, y: 7 });
  });
});

describe("clampNoteRect", () => {
  it.each([
    ["unchanged when valid", { x: 10, y: 20, w: 200, h: 120 }, { x: 10, y: 20, w: 200, h: 120 }],
    ["rounds", { x: 10.4, y: 20.6, w: 200.5, h: 119.2 }, { x: 10, y: 21, w: 201, h: 119 }],
    ["below min grows to min", { x: 0, y: 0, w: 10, h: 1 }, { x: 0, y: 0, w: NOTE_MIN_W, h: NOTE_MIN_H }],
    ["above max shrinks to max", { x: 0, y: 0, w: 9999, h: 9999 }, { x: 0, y: 0, w: NOTE_MAX_W, h: NOTE_MAX_H }],
    ["size first, then position: off the right/bottom", { x: BOARD_WIDTH, y: BOARD_HEIGHT, w: 300, h: 200 }, { x: BOARD_WIDTH - 300, y: BOARD_HEIGHT - 200, w: 300, h: 200 }],
    ["off the left/top", { x: -40, y: -1, w: 300, h: 200 }, { x: 0, y: 0, w: 300, h: 200 }],
    ["non-finite values fall back", { x: Number.NaN, y: Number.POSITIVE_INFINITY, w: Number.NaN, h: Number.NaN }, { x: 0, y: 0, w: NOTE_DEFAULT_W, h: NOTE_DEFAULT_H }],
  ])("%s", (_label, input, expected) => {
    const out = clampNoteRect(input);
    expect(out).toEqual(expected);
    expect(out.x + out.w).toBeLessThanOrEqual(BOARD_WIDTH);
    expect(out.y + out.h).toBeLessThanOrEqual(BOARD_HEIGHT);
  });
});

describe("noteAdd defaults", () => {
  it("noteAdd needs no size or style, and refuses them (the server applies the defaults)", () => {
    const add = { type: "noteAdd", clientRef: "ref-1", x: 10, y: 20, color: "pink", text: "Idea one" };
    expect(noteAddSchema.safeParse(add).success).toBe(true);
    expect(clientMessageSchema.safeParse({ ...add, w: 200 }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...add, bold: true }).success).toBe(false);
  });
});

describe("noteResize", () => {
  const resize = { type: "noteResize", id: NOTE_ID, x: 30, y: 40, w: 200, h: 180, final: false };

  it.each([
    ["noteResize", resize],
    ["noteResize final", { ...resize, final: true }],
    ["noteResize at min", { ...resize, w: NOTE_MIN_W, h: NOTE_MIN_H }],
    ["noteResize at max", { ...resize, w: NOTE_MAX_W, h: NOTE_MAX_H }],
    ["noteResize at the far corner (the server clamps)", { ...resize, x: BOARD_WIDTH, y: BOARD_HEIGHT }],
  ])("accepts %s", (_label, value) => {
    expect(clientMessageSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["non-integer width", { ...resize, w: 200.5 }],
    ["non-integer x", { ...resize, x: 1.5 }],
    ["below min width", { ...resize, w: NOTE_MIN_W - 1 }],
    ["below min height", { ...resize, h: NOTE_MIN_H - 1 }],
    ["above max width", { ...resize, w: NOTE_MAX_W + 1 }],
    ["above max height", { ...resize, h: NOTE_MAX_H + 1 }],
    ["out of the board (x)", { ...resize, x: BOARD_WIDTH + 1 }],
    ["out of the board (negative y)", { ...resize, y: -1 }],
    ["a string width", { ...resize, w: "200" }],
    ["a string final", { ...resize, final: "true" }],
    ["no final", { type: "noteResize", id: NOTE_ID, x: 1, y: 1, w: 200, h: 200 }],
    ["no width", { type: "noteResize", id: NOTE_ID, x: 1, y: 1, h: 200, final: true }],
    ["a bad id", { ...resize, id: "short" }],
    ["a claimed rev", { ...resize, rev: 4 }],
    ["a claimed author", { ...resize, authorId: ID_A }],
  ])("rejects %s", (_label, value) => {
    expect(clientMessageSchema.safeParse(value).success).toBe(false);
  });

  it("the server's noteResized carries the rect, rev and final", () => {
    const ok = { type: "noteResized", id: NOTE_ID, x: 1, y: 2, w: 200, h: 300, rev: 3, final: true };
    expect(serverMessageSchema.safeParse(ok).success).toBe(true);
    expect(serverMessageSchema.safeParse({ ...ok, rev: undefined }).success).toBe(false);
    expect(serverMessageSchema.safeParse({ ...ok, w: NOTE_MAX_W + 1 }).success).toBe(false);
    // Off the board at that size.
    expect(serverMessageSchema.safeParse({ ...ok, x: BOARD_WIDTH - 100 }).success).toBe(false);
  });
});

describe("noteEdit (v4: text and/or style)", () => {
  const edit = { type: "noteEdit", id: NOTE_ID };

  it.each([
    ["text only (as in v3)", { ...edit, text: "Needs follow-up" }],
    ["empty text", { ...edit, text: "" }],
    ["colour only", { ...edit, color: "blue" }],
    ["font size only", { ...edit, fontSize: "xl" }],
    ["bold only", { ...edit, bold: true }],
    ["italic false", { ...edit, italic: false }],
    ["text colour", { ...edit, textColor: "red" }],
    ["text colour auto", { ...edit, textColor: "auto" }],
    ["align", { ...edit, align: "center" }],
    ["align right", { ...edit, align: "right" }],
    ["several fields", { ...edit, text: "x", color: "green", fontSize: "s", bold: true, italic: true, textColor: "blue", align: "left" }],
  ])("accepts %s", (_label, value) => {
    expect(clientMessageSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["missing every editable field", edit],
    ["a hex colour", { ...edit, color: "#ff0000" }],
    ["an unknown colour", { ...edit, color: "red" }],
    ["a bad font size", { ...edit, fontSize: "xxl" }],
    ["a CSS font size", { ...edit, fontSize: "14px" }],
    ["a bad text colour", { ...edit, textColor: "#000000" }],
    ["a bad align", { ...edit, align: "middle" }],
    ["an align with odd case", { ...edit, align: "Right" }],
    ["a CSS align", { ...edit, align: "justify" }],
    ["a string bold", { ...edit, bold: "true" }],
    ["a number italic", { ...edit, italic: 1 }],
    ["a null field", { ...edit, color: null }],
    ["a size (use noteResize)", { ...edit, w: 200 }],
    ["a position", { ...edit, x: 1 }],
    ["a claimed rev", { ...edit, bold: true, rev: 3 }],
    ["a claimed author", { ...edit, bold: true, authorId: ID_A }],
    ["oversize text", { ...edit, text: "x".repeat(MAX_NOTE_TEXT + 1) }],
  ])("rejects %s", (_label, value) => {
    expect(clientMessageSchema.safeParse(value).success).toBe(false);
  });
});

describe("notes on the wire (v4)", () => {
  it.each([
    ["a v3 note without size and style", { id: NOTE_ID, x: 1, y: 2, text: "Idea one", color: "yellow", rev: 1, authorId: ID_A }],
    ["a note off the board at its size", { ...note, x: BOARD_WIDTH - NOTE_MAX_W + 1, w: NOTE_MAX_W }],
    ["a note below min size", { ...note, h: NOTE_MIN_H - 1 }],
    ["a note with a CSS font size", { ...note, fontSize: "12px" }],
    ["a note with a hex text colour", { ...note, textColor: "#123456" }],
    ["a note with a string bold", { ...note, bold: "false" }],
  ])("rejects %s", (_label, value) => {
    expect(serverMessageSchema.safeParse({ type: "noteAdded", note: value }).success).toBe(false);
  });

  it("accepts a styled note at max size in the far corner", () => {
    const big: Note = { ...note, x: BOARD_WIDTH - NOTE_MAX_W, y: BOARD_HEIGHT - NOTE_MAX_H, w: NOTE_MAX_W, h: NOTE_MAX_H, fontSize: "xl", bold: true, italic: true, textColor: "purple", align: "center" };
    expect(serverMessageSchema.safeParse({ type: "snapshot", notes: [big] }).success).toBe(true);
    expect(serverMessageSchema.safeParse({ type: "noteUpdated", note: big }).success).toBe(true);
  });

  it("every colour, font size, text colour and align key is accepted on a note", () => {
    for (const color of NOTE_COLORS)
      for (const fontSize of NOTE_FONT_SIZES)
        for (const textColor of NOTE_TEXT_COLORS)
          for (const align of NOTE_ALIGNS) expect(serverMessageSchema.safeParse({ type: "noteUpdated", note: { ...note, color, fontSize, textColor, align } }).success).toBe(true);
  });

  /**
   * Worst case per note: the longest id/author, 4-digit positions, max sizes, the longest style
   * keys, z at its lower bound, rev at MAX_SAFE_INTEGER, and text that encodes as large as possible. JSON.stringify
   * writes a lone surrogate as a 6-byte \\uXXXX escape, which beats 4-byte emoji.
   */
  it("the largest possible snapshot fits under the server message cap (recorded in docs/LIMITS.md)", () => {
    const worstText = "\ud800".repeat(MAX_NOTE_TEXT);
    const longest = <T extends string>(keys: readonly T[]) => [...keys].sort((a, b) => b.length - a.length)[0]!;
    const big: Note = {
      ...note,
      x: BOARD_WIDTH - NOTE_MAX_W,
      y: BOARD_HEIGHT - NOTE_MAX_H,
      w: NOTE_MAX_W,
      h: NOTE_MAX_H,
      text: worstText,
      color: longest(NOTE_COLORS),
      fontSize: longest(NOTE_FONT_SIZES),
      textColor: longest(NOTE_TEXT_COLORS),
      align: longest(NOTE_ALIGNS),
      titleAlign: longest(NOTE_ALIGNS),
      titleFontSize: longest(NOTE_FONT_SIZES),
      titleTextColor: longest(NOTE_TEXT_COLORS),
      bold: false,
      italic: false,
      titleBold: false,
      titleItalic: false,
      // z at its widest (the minus sign makes the lower bound one character longer).
      z: -NOTE_Z_LIMIT,
      rev: Number.MAX_SAFE_INTEGER,
    };
    const raw = encodeMessage({ type: "snapshot", notes: Array.from({ length: MAX_NOTES_PER_ROOM }, () => big) });
    // Every character is ASCII here (the surrogates are escaped), so length is bytes.
    expect(/^[\x20-\x7e]*$/.test(raw)).toBe(true);
    const bytes = raw.length;
    // docs/LIMITS.md records this figure; update both together.
    expect(bytes).toBeLessThanOrEqual(400 * 1024);
    // docs/LIMITS.md flags it if the headroom under the cap ever drops below 100 KiB.
    expect(MAX_SERVER_MESSAGE_BYTES - bytes).toBeGreaterThanOrEqual(100 * 1024);
    expect(bytes).toBeLessThan(MAX_SERVER_MESSAGE_BYTES);
    expect(parseMessage(raw, serverMessageSchema, MAX_SERVER_MESSAGE_BYTES).ok).toBe(true);
  });

  it("the largest possible noteEdit fits under the client message cap", () => {
    const raw = JSON.stringify({
      type: "noteEdit",
      id: NOTE_ID,
      text: "😀".repeat(MAX_NOTE_TEXT),
      color: "purple",
      fontSize: "xl",
      bold: false,
      italic: false,
      textColor: "purple",
      align: "center",
      titleAlign: "center",
      titleFontSize: "xl",
      titleBold: false,
      titleItalic: false,
      titleTextColor: "purple",
    });
    expect(raw.length).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(parseMessage(raw, clientMessageSchema).ok).toBe(true);
  });
});
