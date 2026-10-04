import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  FRAME_COLORS,
  FRAME_DEFAULTS,
  FRAME_DEFAULT_H,
  FRAME_DEFAULT_W,
  FRAME_MAX_H,
  FRAME_MAX_W,
  FRAME_MIN_H,
  FRAME_MIN_W,
  MAX_BATCH_ENTRIES,
  MAX_FRAMES_PER_ROOM,
  MAX_FRAME_TITLE,
  MAX_MESSAGE_BYTES,
  NOTE_MAX_H,
  NOTE_MAX_W,
  PROTOCOL_VERSION,
  clampFramePosition,
  clampFrameRect,
  cleanFrameTitle,
  clientMessageSchema,
  encodeMessage,
  groupOffset,
  parseMessage,
  serverMessageSchema,
  type Frame,
} from "../src/index";

/*
 * Protocol v9 (slice frames): frames, a named, resizable, coloured area behind notes. Frames
 * come in their own framesSnapshot right after the notes snapshot (which keeps its shape).
 * Fixtures are generic (Start, Stop, Continue).
 */

const id = (i: number) => `frame${String(i).padStart(11, "0")}`;
const noteId = (i: number) => `note${String(i).padStart(12, "0")}`;
const parses = (message: unknown) => clientMessageSchema.safeParse(message).success;
const serverParses = (message: unknown) => serverMessageSchema.safeParse(message).success;
const frame: Frame = { id: id(0), x: 100, y: 100, w: FRAME_DEFAULT_W, h: FRAME_DEFAULT_H, title: "Start", color: "neutral", ...FRAME_DEFAULTS, rev: 1, authorId: "AAAAAAAAAAAAAAAA" };

describe("protocol v9 constants", () => {
  it("is protocol 9 or later, with frame caps and sizes bigger than notes that fit the board", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(9);
    expect(MAX_FRAMES_PER_ROOM).toBe(30);
    expect(MAX_FRAME_TITLE).toBe(60);
    expect(FRAME_MIN_W).toBeGreaterThanOrEqual(NOTE_MAX_W / 2);
    expect(FRAME_MAX_W).toBeGreaterThan(NOTE_MAX_W);
    expect(FRAME_MAX_H).toBeGreaterThan(NOTE_MAX_H);
    expect(FRAME_MAX_W).toBeLessThanOrEqual(BOARD_WIDTH);
    expect(FRAME_MAX_H).toBeLessThanOrEqual(BOARD_HEIGHT);
    expect(FRAME_DEFAULT_W).toBeGreaterThanOrEqual(FRAME_MIN_W);
    expect(FRAME_DEFAULT_W).toBeLessThanOrEqual(FRAME_MAX_W);
    expect(FRAME_DEFAULT_H).toBeGreaterThanOrEqual(FRAME_MIN_H);
    expect(FRAME_DEFAULT_H).toBeLessThanOrEqual(FRAME_MAX_H);
    expect(FRAME_COLORS).toEqual(["neutral", "yellow", "pink", "blue", "green", "orange", "purple"]);
  });
});

describe("frame titles", () => {
  it("are one line: whitespace and line breaks collapse, controls and invisibles go, may be empty", () => {
    expect(cleanFrameTitle("  Start\nhere\t now ")).toBe("Start here now");
    expect(cleanFrameTitle("Stop​‮")).toBe("Stop");
    expect(cleanFrameTitle("")).toBe("");
    expect(cleanFrameTitle("   ")).toBe("");
  });

  it("are at most MAX_FRAME_TITLE characters after cleaning", () => {
    expect(cleanFrameTitle("x".repeat(MAX_FRAME_TITLE))).toHaveLength(MAX_FRAME_TITLE);
    expect(cleanFrameTitle("x".repeat(MAX_FRAME_TITLE + 1))).toBeNull();
    expect(cleanFrameTitle("😀".repeat(MAX_FRAME_TITLE))).not.toBeNull();
  });
});

describe("frame geometry", () => {
  it("clampFrameRect: size within min/max first, then the whole frame on the board", () => {
    expect(clampFrameRect({ x: 3000, y: 1900, w: 10, h: 99999 })).toEqual({ x: BOARD_WIDTH - FRAME_MIN_W, y: BOARD_HEIGHT - FRAME_MAX_H, w: FRAME_MIN_W, h: FRAME_MAX_H });
    expect(clampFrameRect({ x: -50, y: 10.6, w: 700.4, h: 500 })).toEqual({ x: 0, y: 11, w: 700, h: 500 });
  });

  it("clampFramePosition keeps a frame of its own size on the board", () => {
    expect(clampFramePosition(BOARD_WIDTH, BOARD_HEIGHT, { w: 1000, h: 800 })).toEqual({ x: BOARD_WIDTH - 1000, y: BOARD_HEIGHT - 800 });
  });

  it("groupOffset clamps one delta for a whole group, so the arrangement is kept at the edges", () => {
    const rects = [
      { x: 100, y: 100, w: 600, h: 400 },
      { x: 600, y: 400, w: 160, h: 160 },
    ];
    expect(groupOffset(rects, 5000, -5000)).toEqual({ dx: BOARD_WIDTH - 760, dy: -100 });
    expect(groupOffset(rects, 10.4, -3.6)).toEqual({ dx: 10, dy: -4 });
    expect(groupOffset([], 10, 10)).toEqual({ dx: 0, dy: 0 });
  });
});

describe("client frame messages (strict)", () => {
  const add = { type: "frameAdd", clientRef: "r1", x: 10, y: 20, color: "neutral", title: "" };

  it("frameAdd: position, colour key and title; no size, id or author", () => {
    expect(parses(add)).toBe(true);
    expect(parses({ ...add, title: "Start", color: "purple" })).toBe(true);
    expect(parses({ ...add, w: 600 })).toBe(false);
    expect(parses({ ...add, id: id(1) })).toBe(false);
    expect(parses({ ...add, color: "#ff0000" })).toBe(false);
    expect(parses({ ...add, color: "red" })).toBe(false);
    expect(parses({ ...add, title: "x".repeat(MAX_FRAME_TITLE + 1) })).toBe(false);
    expect(parses({ ...add, x: BOARD_WIDTH + 1 })).toBe(false);
  });

  it("frameEdit: title and/or colour, at least one; nothing else", () => {
    expect(parses({ type: "frameEdit", id: id(0), title: "Stop" })).toBe(true);
    expect(parses({ type: "frameEdit", id: id(0), color: "green" })).toBe(true);
    expect(parses({ type: "frameEdit", id: id(0), title: "", color: "green" })).toBe(true);
    expect(parses({ type: "frameEdit", id: id(0) })).toBe(false);
    expect(parses({ type: "frameEdit", id: id(0), title: "Stop", w: 300 })).toBe(false);
    expect(parses({ type: "frameEdit", id: id(0), color: "teal" })).toBe(false);
    expect(parses({ type: "frameEdit", id: id(0), title: "x".repeat(MAX_FRAME_TITLE + 1) })).toBe(false);
  });

  it("frameMove: optional noteIds, unique, at most MAX_BATCH_ENTRIES", () => {
    const move = { type: "frameMove", id: id(0), x: 10, y: 10, final: true };
    expect(parses(move)).toBe(true);
    expect(parses({ ...move, noteIds: [noteId(1), noteId(2)] })).toBe(true);
    expect(parses({ ...move, noteIds: [] })).toBe(true);
    expect(parses({ ...move, noteIds: [noteId(1), noteId(1)] })).toBe(false);
    expect(parses({ ...move, noteIds: Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, i) => noteId(i)) })).toBe(false);
    expect(parses({ ...move, noteIds: ["bad id"] })).toBe(false);
    expect(parses({ ...move, extra: 1 })).toBe(false);
    expect(parses({ type: "frameMove", id: id(0), x: 10, y: 10 })).toBe(false);
  });

  it("frameResize: size within frame min/max, position on the board", () => {
    const resize = { type: "frameResize", id: id(0), x: 0, y: 0, w: 800, h: 600, final: false };
    expect(parses(resize)).toBe(true);
    expect(parses({ ...resize, w: FRAME_MIN_W - 1 })).toBe(false);
    expect(parses({ ...resize, h: FRAME_MAX_H + 1 })).toBe(false);
    expect(parses({ ...resize, title: "x" })).toBe(false);
  });

  it("frameDelete: just the id", () => {
    expect(parses({ type: "frameDelete", id: id(0) })).toBe(true);
    expect(parses({ type: "frameDelete", id: id(0), noteIds: [] })).toBe(false);
  });

  it("the largest frameMove (50 carried notes) fits the 4 KiB client cap", () => {
    const raw = encodeMessage({
      type: "frameMove",
      id: id(0),
      x: BOARD_WIDTH - FRAME_MIN_W,
      y: BOARD_HEIGHT - FRAME_MIN_H,
      final: true,
      noteIds: Array.from({ length: MAX_BATCH_ENTRIES }, (_, i) => noteId(i)),
    });
    expect(MAX_MESSAGE_BYTES).toBe(4096);
    expect(raw.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(parseMessage(raw, clientMessageSchema).ok).toBe(true);
  });
});

describe("server frame messages", () => {
  it("a frame must be on the board at its size, with a clean single-line title", () => {
    expect(serverParses({ type: "frameUpdated", frame })).toBe(true);
    expect(serverParses({ type: "frameUpdated", frame: { ...frame, x: BOARD_WIDTH - 100 } })).toBe(false);
    expect(serverParses({ type: "frameUpdated", frame: { ...frame, title: "Two\nlines" } })).toBe(false);
    expect(serverParses({ type: "frameUpdated", frame: { ...frame, color: "teal" } })).toBe(false);
  });

  it("frameAdded, frameMoved (with carried notes), frameResized, frameDeleted", () => {
    expect(serverParses({ type: "frameAdded", frame, clientRef: "r1" })).toBe(true);
    expect(serverParses({ type: "frameMoved", id: id(0), x: 10, y: 10, rev: 2, final: true })).toBe(true);
    expect(serverParses({ type: "frameMoved", id: id(0), x: 10, y: 10, rev: 2, final: true, notes: [{ id: noteId(1), x: 5, y: 5, rev: 3 }] })).toBe(true);
    expect(serverParses({ type: "frameResized", id: id(0), x: 0, y: 0, w: 800, h: 600, rev: 2, final: false })).toBe(true);
    expect(serverParses({ type: "frameDeleted", id: id(0) })).toBe(true);
  });

  it("framesSnapshot is strict and carries at most MAX_FRAMES_PER_ROOM frames; the notes snapshot keeps its shape", () => {
    expect(serverParses({ type: "framesSnapshot", frames: [frame] })).toBe(true);
    expect(serverParses({ type: "framesSnapshot", frames: [] })).toBe(true);
    expect(serverParses({ type: "framesSnapshot", frames: [frame], notes: [] })).toBe(false);
    expect(serverParses({ type: "framesSnapshot", frames: Array.from({ length: MAX_FRAMES_PER_ROOM + 1 }, (_, i) => ({ ...frame, id: id(i) })) })).toBe(false);
    expect(serverParses({ type: "snapshot", notes: [] })).toBe(true);
  });

  it("errors may name a frame (frameId) for rollback, and frames_full is a code", () => {
    expect(serverParses({ type: "error", code: "frames_full", message: "Full.", clientRef: "r1" })).toBe(true);
    expect(serverParses({ type: "error", code: "rate_limited", message: "Slow.", frameId: id(0), noteIds: [noteId(1)] })).toBe(true);
  });

  // The framesSnapshot worst case (with v10's title style) is in frameTitleStyle.test.ts.
});
