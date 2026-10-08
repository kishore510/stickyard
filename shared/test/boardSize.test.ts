import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  FRAME_COLORS,
  FRAME_MAX_H,
  FRAME_MAX_W,
  FRAME_MIN_H,
  FRAME_MIN_W,
  MAX_BATCH_ENTRIES,
  MAX_FRAMES_PER_ROOM,
  MAX_FRAME_TITLE,
  MAX_MESSAGE_BYTES,
  MAX_NOTES_PER_ROOM,
  MAX_NOTE_TEXT,
  MAX_SERVER_MESSAGE_BYTES,
  MAX_SHAPES_PER_ROOM,
  MAX_SHAPE_TEXT,
  NOTE_ALIGNS,
  NOTE_COLORS,
  NOTE_FONT_SIZES,
  NOTE_MAX_H,
  NOTE_MAX_W,
  NOTE_MIN_H,
  NOTE_MIN_W,
  NOTE_TEXT_COLORS,
  NOTE_Z_LIMIT,
  PROTOCOL_VERSION,
  SHAPE_FILLS,
  SHAPE_FONT_SIZES,
  SHAPE_KINDS,
  SHAPE_MAX_H,
  SHAPE_MAX_W,
  SHAPE_MIN_H,
  SHAPE_MIN_W,
  SHAPE_STROKES,
  SHAPE_STROKE_STYLES,
  SHAPE_STROKE_WIDTHS,
  SHAPE_VALIGNS,
  clampFrameRect,
  clampNoteRect,
  clampShapeRect,
  clientMessageSchema,
  encodeMessage,
  groupOffset,
  parseMessage,
  serverMessageSchema,
  type Frame,
  type Note,
  type Shape,
} from "../src/index";

/*
 * Board size, protocol v16 (decided 7 October 2026): the board doubles each way, 3200 x 2000 ->
 * 6400 x 4000 (four times the area). Item size limits are unchanged. Worst-case message sizes
 * are recorded in docs/LIMITS.md; update both together. Coordinates stay 4 digits until a
 * dimension passes 9,999: the digit test below makes that a conscious decision.
 */

const longest = <T extends string>(keys: readonly T[]) => [...keys].sort((a, b) => b.length - a.length)[0]!;
const AUTHOR = "AAAAAAAAAAAAAAAA";
const pad = (prefix: string, i: number) => `${prefix}${String(i).padStart(16 - prefix.length, "0")}`;

/** The worst note, frame and shape as each snapshot test builds them (largest size at the far corner, longest keys). */
const worstNote = (i: number): Note => ({
  id: pad("note", i),
  x: BOARD_WIDTH - NOTE_MAX_W,
  y: BOARD_HEIGHT - NOTE_MAX_H,
  w: NOTE_MAX_W,
  h: NOTE_MAX_H,
  text: "\ud800".repeat(MAX_NOTE_TEXT),
  color: longest(NOTE_COLORS),
  fontSize: longest(NOTE_FONT_SIZES),
  bold: false,
  italic: false,
  textColor: longest(NOTE_TEXT_COLORS),
  align: longest(NOTE_ALIGNS),
  titleAlign: longest(NOTE_ALIGNS),
  titleFontSize: longest(NOTE_FONT_SIZES),
  titleBold: false,
  titleItalic: false,
  titleTextColor: longest(NOTE_TEXT_COLORS),
  z: -NOTE_Z_LIMIT,
  rev: Number.MAX_SAFE_INTEGER,
  authorId: AUTHOR,
});
const worstFrame = (i: number): Frame => ({
  id: pad("frame", i),
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
  authorId: AUTHOR,
});
const worstShape = (i: number): Shape => ({
  id: pad("shape", i),
  kind: longest(SHAPE_KINDS),
  x: BOARD_WIDTH - SHAPE_MAX_W,
  y: BOARD_HEIGHT - SHAPE_MAX_H,
  w: SHAPE_MAX_W,
  h: SHAPE_MAX_H,
  text: "\ud800".repeat(MAX_SHAPE_TEXT),
  fill: longest(SHAPE_FILLS),
  stroke: longest(SHAPE_STROKES),
  strokeWidth: longest(SHAPE_STROKE_WIDTHS),
  strokeStyle: longest(SHAPE_STROKE_STYLES),
  fontSize: longest(SHAPE_FONT_SIZES),
  bold: false,
  italic: false,
  underline: false,
  textColor: longest(NOTE_TEXT_COLORS),
  align: longest(NOTE_ALIGNS),
  valign: longest(SHAPE_VALIGNS),
  z: -NOTE_Z_LIMIT,
  rev: Number.MAX_SAFE_INTEGER,
  authorId: AUTHOR,
});

const notesSnapshot = encodeMessage({ type: "snapshot", notes: Array.from({ length: MAX_NOTES_PER_ROOM }, (_, i) => worstNote(i)) });
const framesSnapshot = encodeMessage({ type: "framesSnapshot", frames: Array.from({ length: MAX_FRAMES_PER_ROOM }, (_, i) => worstFrame(i)) });
const shapesSnapshot = encodeMessage({ type: "shapesSnapshot", shapes: Array.from({ length: MAX_SHAPES_PER_ROOM }, (_, i) => worstShape(i)) });

/** The other worst-case messages with coordinates: a final resize batch, a frameMove, a full frameMoved, an itemsAdd. */
const farRect = { x: BOARD_WIDTH - NOTE_MIN_W, y: BOARD_HEIGHT - NOTE_MIN_H, w: NOTE_MIN_W, h: NOTE_MIN_H };
const noteBatch = encodeMessage({
  type: "noteBatch",
  ops: Array.from({ length: MAX_BATCH_ENTRIES }, (_, i) => ({ op: "resize", id: pad("note", i), ...farRect })),
  final: true,
});
const frameMove = encodeMessage({
  type: "frameMove",
  id: pad("frame", 0),
  x: BOARD_WIDTH - FRAME_MIN_W,
  y: BOARD_HEIGHT - FRAME_MIN_H,
  final: true,
  noteIds: Array.from({ length: MAX_BATCH_ENTRIES }, (_, i) => pad("note", i)),
});
const frameMoved = encodeMessage({
  type: "frameMoved",
  id: pad("frame", 0),
  x: BOARD_WIDTH - FRAME_MIN_W,
  y: BOARD_HEIGHT - FRAME_MIN_H,
  rev: Number.MAX_SAFE_INTEGER,
  final: true,
  notes: Array.from({ length: 25 }, (_, i) => ({ id: pad("note", i), x: BOARD_WIDTH - NOTE_MIN_W, y: BOARD_HEIGHT - NOTE_MIN_H, rev: Number.MAX_SAFE_INTEGER })),
  shapes: Array.from({ length: 25 }, (_, i) => ({ id: pad("shape", i), x: BOARD_WIDTH - SHAPE_MIN_W, y: BOARD_HEIGHT - SHAPE_MIN_H, rev: Number.MAX_SAFE_INTEGER })),
});
const { id: _id, rev: _rev, authorId: _a, z: _z, ...noteContent } = worstNote(0);
const itemsAdd = encodeMessage({ type: "itemsAdd", clientRef: "c".repeat(32), notes: [{ ...noteContent, text: "x", ref: "r".repeat(32) }] });

const WORST = { notesSnapshot, framesSnapshot, shapesSnapshot, noteBatch, frameMove, frameMoved, itemsAdd };

describe("protocol v16: the board size", () => {
  it("is 6400 x 4000, four times the area of v15's 3200 x 2000", () => {
    expect(PROTOCOL_VERSION).toBe(16);
    expect([BOARD_WIDTH, BOARD_HEIGHT]).toEqual([6400, 4000]);
    expect(BOARD_WIDTH * BOARD_HEIGHT).toBe(4 * 3200 * 2000);
  });

  it("leaves every item size limit alone", () => {
    expect([NOTE_MIN_W, NOTE_MIN_H, NOTE_MAX_W, NOTE_MAX_H]).toEqual([96, 96, 480, 480]);
    expect([FRAME_MAX_W, FRAME_MAX_H]).toEqual([2400, 1600]);
    expect([SHAPE_MAX_W, SHAPE_MAX_H]).toEqual([2400, 1600]);
  });

  it("clamps read the constants: the far corner stays, past it comes back on the board", () => {
    expect(clampNoteRect({ x: BOARD_WIDTH - 160, y: BOARD_HEIGHT - 160, w: 160, h: 160 })).toEqual({ x: BOARD_WIDTH - 160, y: BOARD_HEIGHT - 160, w: 160, h: 160 });
    expect(clampNoteRect({ x: BOARD_WIDTH, y: BOARD_HEIGHT, w: 160, h: 160 })).toEqual({ x: BOARD_WIDTH - 160, y: BOARD_HEIGHT - 160, w: 160, h: 160 });
    expect(clampFrameRect({ x: BOARD_WIDTH, y: BOARD_HEIGHT, w: FRAME_MAX_W, h: FRAME_MAX_H })).toEqual({ x: BOARD_WIDTH - FRAME_MAX_W, y: BOARD_HEIGHT - FRAME_MAX_H, w: FRAME_MAX_W, h: FRAME_MAX_H });
    expect(clampShapeRect({ x: BOARD_WIDTH, y: BOARD_HEIGHT, w: 200, h: 120 })).toEqual({ x: BOARD_WIDTH - 200, y: BOARD_HEIGHT - 120, w: 200, h: 120 });
    // The old board's far corner is now the middle: nothing about it is clamped.
    expect(clampNoteRect({ x: 3200 - 160, y: 2000 - 160, w: 160, h: 160 })).toEqual({ x: 3040, y: 1840, w: 160, h: 160 });
    // A group can move all the way to the new edge.
    expect(groupOffset([{ x: 0, y: 0, w: 160, h: 160 }], BOARD_WIDTH, BOARD_HEIGHT)).toEqual({ dx: BOARD_WIDTH - 160, dy: BOARD_HEIGHT - 160 });
  });

  it("schemas take positions at the new far corner and refuse past the board", () => {
    const add = (x: number, y: number) => clientMessageSchema.safeParse({ type: "noteAdd", clientRef: "r1", x, y, color: "yellow", text: "" }).success;
    expect(add(BOARD_WIDTH - NOTE_MIN_W, BOARD_HEIGHT - NOTE_MIN_H)).toBe(true);
    const move = (x: number, y: number) => clientMessageSchema.safeParse({ type: "noteMove", id: pad("note", 0), x, y, final: true }).success;
    expect(move(BOARD_WIDTH, BOARD_HEIGHT)).toBe(true);
    expect(move(BOARD_WIDTH + 1, 0)).toBe(false);
    expect(move(0, BOARD_HEIGHT + 1)).toBe(false);
    expect(serverMessageSchema.safeParse({ type: "noteUpdated", note: worstNote(0) }).success).toBe(true);
  });
});

describe("worst-case message sizes on the bigger board (recorded in docs/LIMITS.md)", () => {
  it("the notes snapshot is unchanged: 404,229 bytes (its positions were already 4 digits)", () => {
    expect(notesSnapshot.length).toBe(404_229);
    expect(notesSnapshot.length).toBeLessThanOrEqual(400 * 1024);
  });

  it("frames 18,366 and shapes 167,786 bytes (each 1 more byte per coordinate that went from 3 to 4 digits)", () => {
    expect(framesSnapshot.length).toBe(18_366);
    expect(shapesSnapshot.length).toBe(167_786);
  });

  it("the combined reconnect payload is 590,381 bytes, in three messages each under the server cap", () => {
    expect(notesSnapshot.length + framesSnapshot.length + shapesSnapshot.length).toBe(590_381);
    for (const raw of [notesSnapshot, framesSnapshot, shapesSnapshot]) {
      expect(raw.length).toBeLessThan(MAX_SERVER_MESSAGE_BYTES);
      expect(parseMessage(raw, serverMessageSchema, MAX_SERVER_MESSAGE_BYTES).ok).toBe(true);
    }
  });

  it("client messages with far-corner coordinates still fit the 4 KiB cap", () => {
    for (const raw of [noteBatch, frameMove, itemsAdd]) {
      expect(raw.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
      expect(parseMessage(raw, clientMessageSchema).ok).toBe(true);
    }
    expect(frameMoved.length).toBeLessThan(4 * 1024);
  });

  it("no coordinate in a worst-case message reaches 5 digits (a board past 9,999 is a decision, not an accident)", () => {
    expect(Math.max(BOARD_WIDTH, BOARD_HEIGHT)).toBeLessThanOrEqual(9_999);
    for (const [name, raw] of Object.entries(WORST)) {
      const fiveDigits = raw.match(/"(x|y|w|h)":-?\d{5,}/g) ?? [];
      expect(fiveDigits, name).toEqual([]);
    }
  });
});
