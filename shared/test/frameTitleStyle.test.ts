import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  FRAME_COLORS,
  FRAME_DEFAULTS,
  FRAME_DEFAULT_H,
  FRAME_DEFAULT_W,
  FRAME_EDIT_FIELDS,
  FRAME_MAX_H,
  FRAME_MAX_W,
  FRAME_STYLE_FIELDS,
  MAX_FRAMES_PER_ROOM,
  MAX_FRAME_TITLE,
  MAX_MESSAGE_BYTES,
  MAX_SERVER_MESSAGE_BYTES,
  NOTE_ALIGNS,
  NOTE_FONT_SIZES,
  NOTE_TEXT_COLORS,
  PROTOCOL_VERSION,
  clientMessageSchema,
  encodeMessage,
  frameSchema,
  parseMessage,
  serverMessageSchema,
  type Frame,
} from "../src/index";

/*
 * Protocol v10 (slice frame title styling): a frame's title has its own size, weight, slant, ink
 * and alignment, reusing the note style key sets. Keys only, never CSS. Generic fixtures.
 */

const id = (i: number) => `frame${String(i).padStart(11, "0")}`;
const parses = (message: unknown) => clientMessageSchema.safeParse(message).success;
const serverParses = (message: unknown) => serverMessageSchema.safeParse(message).success;
const frame: Frame = {
  id: id(0),
  x: 100,
  y: 100,
  w: FRAME_DEFAULT_W,
  h: FRAME_DEFAULT_H,
  title: "Start",
  color: "neutral",
  ...FRAME_DEFAULTS,
  rev: 1,
  authorId: "AAAAAAAAAAAAAAAA",
};
const longest = <T extends string>(keys: readonly T[]) => [...keys].sort((a, b) => b.length - a.length)[0]!;

describe("protocol v10 constants", () => {
  it("is protocol 10", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(10);
  });

  it("defaults reproduce the v9 header: medium, semibold (bold), upright, auto ink, left", () => {
    expect(FRAME_DEFAULTS).toEqual({ titleFontSize: "m", titleBold: true, titleItalic: false, titleTextColor: "auto", titleAlign: "left" });
  });

  it("the style fields are the five title fields; edits may also change title and colour", () => {
    expect([...FRAME_STYLE_FIELDS]).toEqual(["titleFontSize", "titleBold", "titleItalic", "titleTextColor", "titleAlign"]);
    expect([...FRAME_EDIT_FIELDS]).toEqual(["title", "color", ...FRAME_STYLE_FIELDS]);
  });
});

describe("frameEdit with title style", () => {
  it("accepts each style field alone, every key of the shared sets, and all together", () => {
    for (const k of NOTE_FONT_SIZES) expect(parses({ type: "frameEdit", id: id(0), titleFontSize: k })).toBe(true);
    for (const k of NOTE_TEXT_COLORS) expect(parses({ type: "frameEdit", id: id(0), titleTextColor: k })).toBe(true);
    for (const k of NOTE_ALIGNS) expect(parses({ type: "frameEdit", id: id(0), titleAlign: k })).toBe(true);
    expect(parses({ type: "frameEdit", id: id(0), titleBold: false })).toBe(true);
    expect(parses({ type: "frameEdit", id: id(0), titleItalic: true })).toBe(true);
    expect(parses({ type: "frameEdit", id: id(0), title: "Stop", color: "pink", titleFontSize: "xl", titleBold: false, titleItalic: true, titleTextColor: "blue", titleAlign: "center" })).toBe(true);
  });

  it("refuses bad keys, CSS values, wrong types and fields frames don't have", () => {
    expect(parses({ type: "frameEdit", id: id(0), titleFontSize: "xxl" })).toBe(false);
    expect(parses({ type: "frameEdit", id: id(0), titleFontSize: "14px" })).toBe(false);
    expect(parses({ type: "frameEdit", id: id(0), titleTextColor: "#ff0000" })).toBe(false);
    expect(parses({ type: "frameEdit", id: id(0), titleTextColor: "var(--sy-frame-title)" })).toBe(false);
    expect(parses({ type: "frameEdit", id: id(0), titleAlign: "justify" })).toBe(false);
    expect(parses({ type: "frameEdit", id: id(0), titleBold: "true" })).toBe(false);
    expect(parses({ type: "frameEdit", id: id(0), titleItalic: 1 })).toBe(false);
    // Note-only (body) fields aren't frame fields: strict, so refused.
    expect(parses({ type: "frameEdit", id: id(0), fontSize: "l" })).toBe(false);
    expect(parses({ type: "frameEdit", id: id(0), bold: true })).toBe(false);
  });

  it("still needs at least one field", () => {
    expect(parses({ type: "frameEdit", id: id(0) })).toBe(false);
  });

  it("frameAdd carries no style (the server uses the defaults)", () => {
    const add = { type: "frameAdd", clientRef: "r1", x: 0, y: 0, color: "neutral", title: "" };
    expect(parses(add)).toBe(true);
    expect(parses({ ...add, titleFontSize: "l" })).toBe(false);
    expect(parses({ ...add, titleBold: false })).toBe(false);
  });

  it("the largest frameEdit stays well under MAX_MESSAGE_BYTES", () => {
    const raw = JSON.stringify({
      type: "frameEdit",
      id: id(0),
      title: "\ud800".repeat(MAX_FRAME_TITLE),
      color: longest(FRAME_COLORS),
      titleFontSize: longest(NOTE_FONT_SIZES),
      titleBold: false,
      titleItalic: false,
      titleTextColor: longest(NOTE_TEXT_COLORS),
      titleAlign: longest(NOTE_ALIGNS),
    });
    expect(raw.length).toBeLessThan(MAX_MESSAGE_BYTES / 4);
  });
});

describe("frames carry their title style", () => {
  it("frameSchema needs every style field, with valid keys", () => {
    expect(frameSchema.safeParse(frame).success).toBe(true);
    for (const field of FRAME_STYLE_FIELDS) {
      const { [field]: _, ...without } = frame;
      expect(frameSchema.safeParse(without).success, field).toBe(false);
    }
    expect(frameSchema.safeParse({ ...frame, titleFontSize: "huge" }).success).toBe(false);
    expect(frameSchema.safeParse({ ...frame, titleTextColor: "#000000" }).success).toBe(false);
  });

  it("frameSchema stays non-strict: an unknown field is stripped, not refused", () => {
    const parsed = frameSchema.safeParse({ ...frame, extra: "x" });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("extra");
  });

  it("frameAdded, frameUpdated and framesSnapshot carry the style; a v9-shaped frame is refused", () => {
    expect(serverParses({ type: "frameUpdated", frame: { ...frame, titleFontSize: "xl", titleAlign: "right" } })).toBe(true);
    expect(serverParses({ type: "frameAdded", frame, clientRef: "r1" })).toBe(true);
    expect(serverParses({ type: "framesSnapshot", frames: [frame] })).toBe(true);
    const { titleFontSize: _s, titleBold: _b, titleItalic: _i, titleTextColor: _c, titleAlign: _a, ...v9 } = frame;
    expect(serverParses({ type: "frameUpdated", frame: v9 })).toBe(false);
  });

  /**
   * Worst case per frame: the longest id/author, 4-digit positions, the largest size, a title of
   * lone surrogates (JSON escapes each as 6 bytes), the longest colour and style keys (false is
   * longer than true), rev at MAX_SAFE_INTEGER. The cap is 20 KiB (raised from 16 KiB for v10:
   * docs/LIMITS.md says why). Rule: a new per-frame field that takes the worst case within 10% of
   * the cap needs a decision first. The notes snapshot, its 400 KiB tripwire and 100 KiB headroom
   * rule are separate and unchanged (noteSize.test.ts).
   */
  it("the largest possible framesSnapshot is 18,306 bytes, under the 20 KiB cap (recorded in docs/LIMITS.md)", () => {
    const big: Frame = {
      id: id(0),
      x: BOARD_WIDTH - FRAME_MAX_W,
      y: BOARD_HEIGHT - FRAME_MAX_H,
      w: FRAME_MAX_W,
      h: FRAME_MAX_H,
      title: "\ud800".repeat(MAX_FRAME_TITLE),
      color: longest(FRAME_COLORS),
      titleFontSize: longest(NOTE_FONT_SIZES),
      titleBold: false,
      titleItalic: false,
      titleTextColor: longest(NOTE_TEXT_COLORS),
      titleAlign: longest(NOTE_ALIGNS),
      rev: Number.MAX_SAFE_INTEGER,
      authorId: "AAAAAAAAAAAAAAAA",
    };
    const raw = encodeMessage({ type: "framesSnapshot", frames: Array.from({ length: MAX_FRAMES_PER_ROOM }, () => big) });
    expect(/^[\x20-\x7e]*$/.test(raw)).toBe(true);
    // docs/LIMITS.md records this figure; update both together.
    expect(raw.length).toBe(18_306);
    const CAP = 20 * 1024;
    expect(raw.length).toBeLessThanOrEqual(CAP);
    // The 10% rule: past this, a new per-frame field needs a decision (and this test changes with it).
    expect(raw.length).toBeLessThanOrEqual(CAP * 0.9);
    expect(raw.length).toBeLessThan(MAX_SERVER_MESSAGE_BYTES / 16);
    expect(parseMessage(raw, serverMessageSchema, MAX_SERVER_MESSAGE_BYTES).ok).toBe(true);
  });
});
