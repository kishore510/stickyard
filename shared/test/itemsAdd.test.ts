import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  FRAME_COLORS,
  FRAME_DEFAULTS,
  FRAME_MAX_H,
  FRAME_MAX_W,
  FRAME_STYLE_FIELDS,
  MAX_BATCH_ENTRIES,
  MAX_FRAME_TITLE,
  MAX_MESSAGE_BYTES,
  MAX_NOTE_TEXT,
  MAX_SERVER_MESSAGE_BYTES,
  NOTE_ALIGNS,
  NOTE_COLORS,
  NOTE_DEFAULTS,
  NOTE_FONT_SIZES,
  NOTE_MAX_H,
  NOTE_MAX_W,
  NOTE_STYLE_FIELDS,
  NOTE_TEXT_COLORS,
  NOTE_Z_LIMIT,
  PROTOCOL_VERSION,
  checkItems,
  clientMessageSchema,
  encodeMessage,
  frameItemSchema,
  noteItemSchema,
  parseMessage,
  serverMessageSchema,
  utf8Length,
  type Frame,
  type FrameItem,
  type Note,
  type NoteItem,
} from "../src/index";

/*
 * Protocol v11 (slice create with content): itemsAdd carries notes and frames with their full
 * content; itemsAdded answers. Generic fixtures.
 */

const parses = (message: unknown) => clientMessageSchema.safeParse(message).success;
const serverParses = (message: unknown) => serverMessageSchema.safeParse(message).success;
const longest = <T extends string>(keys: readonly T[]) => [...keys].sort((a, b) => b.length - a.length)[0]!;
const AUTHOR = "AAAAAAAAAAAAAAAA";
const sid = (i: number) => `item${String(i).padStart(12, "0")}`;

const noteItem = (ref: string, extra: Partial<NoteItem> = {}): NoteItem => ({
  ref,
  x: 10,
  y: 20,
  w: 200,
  h: 120,
  text: "Idea one\nmore",
  color: "blue",
  fontSize: "l",
  bold: true,
  italic: false,
  textColor: "red",
  align: "center",
  titleAlign: "right",
  titleFontSize: "xl",
  titleBold: false,
  titleItalic: true,
  titleTextColor: "grey",
  ...extra,
});
const frameItem = (ref: string, extra: Partial<FrameItem> = {}): FrameItem => ({
  ref,
  x: 0,
  y: 0,
  w: 800,
  h: 500,
  title: "Start",
  color: "green",
  ...FRAME_DEFAULTS,
  ...extra,
});

/** The largest valid entries: every value at its longest, 32-character refs (the schema's maximum). */
const REF_MAX = "r".repeat(32);
const worstNote = (ref = REF_MAX): NoteItem => ({
  ref,
  x: BOARD_WIDTH,
  y: BOARD_HEIGHT,
  w: NOTE_MAX_W,
  h: NOTE_MAX_H,
  // Lone surrogates: JSON escapes each as 6 bytes.
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
});
const worstFrame = (ref = REF_MAX): FrameItem => ({
  ref,
  x: BOARD_WIDTH,
  y: BOARD_HEIGHT,
  w: FRAME_MAX_W,
  h: FRAME_MAX_H,
  title: "\ud800".repeat(MAX_FRAME_TITLE),
  color: longest(FRAME_COLORS),
  titleFontSize: longest(NOTE_FONT_SIZES),
  titleBold: false,
  titleItalic: false,
  titleTextColor: longest(NOTE_TEXT_COLORS),
  titleAlign: longest(NOTE_ALIGNS),
});

/** How many of `entry(i)` fit in one itemsAdd under MAX_MESSAGE_BYTES. */
function perMessage(kind: "notes" | "frames", entry: (i: number) => unknown): number {
  let n = 0;
  for (;;) {
    const raw = encodeMessage({ type: "itemsAdd", clientRef: REF_MAX, [kind]: Array.from({ length: n + 1 }, (_, i) => entry(i)) } as never);
    if (utf8Length(raw) > MAX_MESSAGE_BYTES || n + 1 > MAX_BATCH_ENTRIES) return n;
    n++;
  }
}

describe("protocol v11", () => {
  it("is protocol 11", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(11);
  });
});

describe("itemsAdd", () => {
  it("accepts notes, frames, or both, with every content field", () => {
    expect(parses({ type: "itemsAdd", clientRef: "c1", notes: [noteItem("a")] })).toBe(true);
    expect(parses({ type: "itemsAdd", clientRef: "c1", frames: [frameItem("a")] })).toBe(true);
    expect(parses({ type: "itemsAdd", clientRef: "c1", notes: [noteItem("a"), noteItem("b")], frames: [frameItem("c")] })).toBe(true);
  });

  it("needs 1 to MAX_BATCH_ENTRIES items in total", () => {
    expect(parses({ type: "itemsAdd", clientRef: "c1" })).toBe(false);
    expect(parses({ type: "itemsAdd", clientRef: "c1", notes: [], frames: [] })).toBe(false);
    const notes = Array.from({ length: 30 }, (_, i) => ({ ref: `n${i}` }));
    const frames = Array.from({ length: 20 }, (_, i) => ({ ref: `f${i}` }));
    expect(parses({ type: "itemsAdd", clientRef: "c1", notes, frames })).toBe(true);
    expect(parses({ type: "itemsAdd", clientRef: "c1", notes, frames: [...frames, { ref: "f20" }] })).toBe(false);
    expect(parses({ type: "itemsAdd", clientRef: "c1", notes: Array.from({ length: MAX_BATCH_ENTRIES + 1 }, () => ({})) })).toBe(false);
  });

  it("the envelope is strict and needs a clientRef", () => {
    expect(parses({ type: "itemsAdd", notes: [noteItem("a")] })).toBe(false);
    expect(parses({ type: "itemsAdd", clientRef: "c1", notes: [noteItem("a")], authorId: AUTHOR })).toBe(false);
    expect(parses({ type: "itemsAdd", clientRef: "bad ref!", notes: [noteItem("a")] })).toBe(false);
  });

  it("note entries need every content field and refuse a claimed id, rev, z or author", () => {
    expect(noteItemSchema.safeParse(noteItem("a")).success).toBe(true);
    for (const field of ["ref", "x", "y", "w", "h", "text", ...NOTE_STYLE_FIELDS] as const) {
      const { [field]: _, ...without } = noteItem("a");
      expect(noteItemSchema.safeParse(without).success, field).toBe(false);
    }
    for (const extra of [{ id: sid(0) }, { rev: 1 }, { z: 3 }, { authorId: AUTHOR }]) {
      expect(noteItemSchema.safeParse({ ...noteItem("a"), ...extra }).success).toBe(false);
    }
  });

  it("frame entries need every content field and refuse a claimed id, rev or author, and note-only fields", () => {
    expect(frameItemSchema.safeParse(frameItem("a")).success).toBe(true);
    for (const field of ["ref", "x", "y", "w", "h", "title", "color", ...FRAME_STYLE_FIELDS] as const) {
      const { [field]: _, ...without } = frameItem("a");
      expect(frameItemSchema.safeParse(without).success, field).toBe(false);
    }
    for (const extra of [{ id: sid(0) }, { rev: 1 }, { authorId: AUTHOR }, { fontSize: "l" }, { text: "x" }]) {
      expect(frameItemSchema.safeParse({ ...frameItem("a"), ...extra }).success).toBe(false);
    }
  });

  it("style values are the shared key sets: unknown keys and CSS values are refused", () => {
    for (const k of NOTE_FONT_SIZES) expect(noteItemSchema.safeParse(noteItem("a", { fontSize: k, titleFontSize: k })).success).toBe(true);
    for (const k of NOTE_TEXT_COLORS) expect(frameItemSchema.safeParse(frameItem("a", { titleTextColor: k })).success).toBe(true);
    const bad = [{ fontSize: "xxl" }, { textColor: "#ff0000" }, { align: "justify" }, { titleBold: "true" }, { color: "teal" }];
    for (const b of bad) expect(noteItemSchema.safeParse({ ...noteItem("a"), ...b }).success, JSON.stringify(b)).toBe(false);
    expect(frameItemSchema.safeParse({ ...frameItem("a"), titleFontSize: "14px" }).success).toBe(false);
    expect(frameItemSchema.safeParse({ ...frameItem("a"), color: "red" }).success).toBe(false);
  });

  it("sizes and text are bounded like the single messages (the server still clamps and cleans)", () => {
    expect(noteItemSchema.safeParse(noteItem("a", { w: NOTE_MAX_W + 1 })).success).toBe(false);
    expect(noteItemSchema.safeParse(noteItem("a", { x: -1 })).success).toBe(false);
    expect(noteItemSchema.safeParse(noteItem("a", { text: "x".repeat(MAX_NOTE_TEXT + 1) })).success).toBe(false);
    expect(frameItemSchema.safeParse(frameItem("a", { h: FRAME_MAX_H + 1 })).success).toBe(false);
    expect(frameItemSchema.safeParse(frameItem("a", { title: "x".repeat(MAX_FRAME_TITLE + 1) })).success).toBe(false);
  });
});

describe("checkItems", () => {
  it("checks each entry on its own: valid ones kept with their index, invalid ones named by kind, index and ref", () => {
    const check = checkItems([noteItem("a"), { ...noteItem("b"), fontSize: "huge" }, noteItem("c")], [{ ref: "d" }, frameItem("e"), 42]);
    expect(check.duplicate).toBe(false);
    expect(check.notes.map((n) => [n.index, n.entry.ref])).toEqual([
      [0, "a"],
      [2, "c"],
    ]);
    expect(check.frames.map((f) => [f.index, f.entry.ref])).toEqual([[1, "e"]]);
    expect(check.invalid).toEqual([
      { kind: "note", index: 1, ref: "b", reason: "invalid" },
      { kind: "frame", index: 0, ref: "d", reason: "invalid" },
      { kind: "frame", index: 2, reason: "invalid" },
    ]);
  });

  it("a ref used twice, in either list or across both, refuses the whole message", () => {
    expect(checkItems([noteItem("a"), noteItem("a")]).duplicate).toBe(true);
    const across = checkItems([noteItem("a")], [frameItem("a")]);
    expect(across).toMatchObject({ duplicate: true, notes: [], frames: [], invalid: [] });
    // Unreadable refs can't clash.
    expect(checkItems([{ ref: 1 }, { ref: 1 }]).duplicate).toBe(false);
  });
});

describe("itemsAdded", () => {
  const note: Note = { id: sid(1), ...NOTE_DEFAULTS, x: 10, y: 20, w: 200, h: 120, text: "Idea", color: "pink", z: 0, rev: 1, authorId: AUTHOR };
  const frame: Frame = { id: sid(2), x: 0, y: 0, w: 640, h: 400, title: "Start", color: "neutral", ...FRAME_DEFAULTS, rev: 1, authorId: AUTHOR };

  it("the sender's copy has clientRef, refs and refusals; the others' have none of them", () => {
    expect(serverParses({ type: "itemsAdded", clientRef: "c1", notes: [{ ref: "a", note }], frames: [{ ref: "b", frame }], refused: [{ kind: "note", index: 1, ref: "x", reason: "notes_full" }] })).toBe(true);
    expect(serverParses({ type: "itemsAdded", notes: [{ note }], frames: [], refused: [] })).toBe(true);
  });

  it("is never empty and checks every note and frame", () => {
    expect(serverParses({ type: "itemsAdded", notes: [], frames: [], refused: [] })).toBe(false);
    expect(serverParses({ type: "itemsAdded", notes: [{ note: { ...note, text: "\u0007" } }], frames: [], refused: [] })).toBe(false);
    expect(serverParses({ type: "itemsAdded", notes: [], frames: [{ frame: { ...frame, w: 10 } }], refused: [] })).toBe(false);
    expect(serverParses({ type: "itemsAdded", notes: [{ note }], frames: [], refused: [{ kind: "shape", index: 0, reason: "invalid" }] })).toBe(false);
    expect(serverParses({ type: "itemsAdded", notes: [{ note }], frames: [], refused: [{ kind: "note", index: 0, reason: "board_full" }] })).toBe(false);
  });

  it("an error may name the refused items", () => {
    expect(serverParses({ type: "error", code: "notes_full", message: "Full.", clientRef: "c1", refused: [{ kind: "note", index: 0, ref: "a", reason: "notes_full" }] })).toBe(true);
  });
});

describe("sizes (docs/LIMITS.md)", () => {
  it("every single item fits in a message on its own, at its largest", () => {
    expect(utf8Length(encodeMessage({ type: "itemsAdd", clientRef: REF_MAX, notes: [worstNote()] }))).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(utf8Length(encodeMessage({ type: "itemsAdd", clientRef: REF_MAX, frames: [worstFrame()] }))).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  it("items per 4 KiB message: worst case and the web's usual case", () => {
    // Maximum-size notes: only 2 fit; frames with the longest titles: 6.
    expect(perMessage("notes", () => worstNote())).toBe(2);
    expect(perMessage("frames", () => worstFrame())).toBe(6);
    // Short content (empty text, default style, 12-character refs as the web sends): 15 notes or 21 frames.
    const ref = (i: number) => `ref${String(i).padStart(9, "0")}`;
    expect(perMessage("notes", (i) => ({ ...worstNote(ref(i)), text: "", ...NOTE_DEFAULTS, x: 0, y: 0 }))).toBe(15);
    expect(perMessage("frames", (i) => ({ ...worstFrame(ref(i)), title: "", ...FRAME_DEFAULTS, x: 0, y: 0 }))).toBe(21);
  });

  it("the largest itemsAdded the schema allows is far under the server message cap", () => {
    const note: Note = {
      id: sid(0),
      ...worstNote(),
      x: BOARD_WIDTH - NOTE_MAX_W,
      y: BOARD_HEIGHT - NOTE_MAX_H,
      z: -NOTE_Z_LIMIT,
      rev: Number.MAX_SAFE_INTEGER,
      authorId: AUTHOR,
    };
    const { ref: _, ...plain } = note as Note & { ref?: string };
    const message = {
      type: "itemsAdded" as const,
      clientRef: REF_MAX,
      notes: Array.from({ length: MAX_BATCH_ENTRIES }, () => ({ ref: REF_MAX, note: plain })),
      frames: [],
      refused: [],
    };
    expect(serverParses(message)).toBe(true);
    const bytes = utf8Length(encodeMessage(message));
    // An upper bound: an itemsAdd that fits 4 KiB carries far less text than this.
    expect(bytes).toBe(103_653);
    expect(bytes).toBeLessThan(MAX_SERVER_MESSAGE_BYTES / 4);
    expect(parseMessage(encodeMessage(message), serverMessageSchema, MAX_SERVER_MESSAGE_BYTES).ok).toBe(true);
  });
});
