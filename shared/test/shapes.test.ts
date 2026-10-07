import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  BOARD_WRITES,
  FRAME_COLORS,
  HOST_ONLY,
  MAX_BATCH_ENTRIES,
  MAX_MESSAGE_BYTES,
  MAX_NOTES_PER_ROOM,
  MAX_SERVER_MESSAGE_BYTES,
  MAX_SHAPES_PER_ROOM,
  MAX_SHAPE_TEXT,
  NOTE_ALIGNS,
  NOTE_TEXT_COLORS,
  NOTE_Z_LIMIT,
  PROTOCOL_VERSION,
  SHAPE_EDIT_FIELDS,
  SHAPE_FILLS,
  SHAPE_FONT_PX,
  SHAPE_FONT_SIZES,
  SHAPE_KINDS,
  SHAPE_MAX_H,
  SHAPE_MAX_W,
  SHAPE_MIN_H,
  SHAPE_MIN_W,
  SHAPE_STROKES,
  SHAPE_STROKE_STYLES,
  SHAPE_STROKE_WIDTHS,
  SHAPE_STYLE_FIELDS,
  SHAPE_VALIGNS,
  checkItems,
  checkShapeBatch,
  clampShapePosition,
  clampShapeRect,
  cleanNoteText,
  cleanShapeText,
  clientMessageSchema,
  codePointLength,
  encodeMessage,
  parseMessage,
  serverMessageSchema,
  shapeDefaults,
  shapeSchema,
  truncateCodePoints,
  utf8Length,
  type Shape,
  type ShapeItem,
  type ShapeKind,
} from "../src/index";

/*
 * Protocol v15 (slice text and shapes): one new object, the shape (text label, rectangle, oval,
 * diamond). Keys only, never CSS. Shapes share the notes' stacking space. Generic fixtures.
 */

const sid = (i: number) => `shape${String(i).padStart(11, "0")}`;
const nid = (i: number) => `note${String(i).padStart(12, "0")}`;
const AUTHOR = "AAAAAAAAAAAAAAAA";
const parses = (message: unknown) => clientMessageSchema.safeParse(message).success;
const serverParses = (message: unknown) => serverMessageSchema.safeParse(message).success;
const longest = <T extends string>(keys: readonly T[]) => [...keys].sort((a, b) => b.length - a.length)[0]!;

const shape = (kind: ShapeKind = "rect", extra: Partial<Shape> = {}): Shape => ({
  id: sid(0),
  kind,
  x: 100,
  y: 100,
  ...shapeDefaults(kind),
  text: "Step 1",
  z: 0,
  rev: 1,
  authorId: AUTHOR,
  ...extra,
});

const shapeItem = (ref: string, extra: Partial<ShapeItem> = {}): ShapeItem => {
  const { w, h, ...style } = shapeDefaults("oval");
  return { ref, kind: "oval", x: 10, y: 20, w, h, text: "Parking lot", ...style, ...extra };
};

describe("protocol v15 constants", () => {
  it("is protocol 15", () => {
    expect(PROTOCOL_VERSION).toBe(15);
  });

  it("four kinds; a text label is a shape with no fill and no border", () => {
    expect([...SHAPE_KINDS]).toEqual(["text", "rect", "oval", "diamond"]);
    expect(shapeDefaults("text")).toMatchObject({ w: 240, h: 48, fill: "none", strokeWidth: "none" });
    expect(shapeDefaults("rect")).toMatchObject({ w: 200, h: 120, fill: "neutral", stroke: "neutral", strokeWidth: "thin", strokeStyle: "solid" });
    expect(shapeDefaults("oval")).toMatchObject({ w: 200, h: 120, fill: "neutral", strokeWidth: "thin", strokeStyle: "solid" });
    expect(shapeDefaults("diamond")).toMatchObject({ w: 200, h: 160, fill: "neutral", strokeWidth: "thin", strokeStyle: "solid" });
  });

  it("key sets reuse the existing ones where they exist", () => {
    expect([...SHAPE_FILLS]).toEqual(["none", ...FRAME_COLORS]);
    expect([...SHAPE_STROKES]).toEqual([...FRAME_COLORS]);
    expect([...SHAPE_STROKE_WIDTHS]).toEqual(["none", "thin", "medium", "thick"]);
    expect([...SHAPE_STROKE_STYLES]).toEqual(["solid", "dashed"]);
    expect([...SHAPE_VALIGNS]).toEqual(["top", "middle", "bottom"]);
    for (const kind of SHAPE_KINDS) {
      const d = shapeDefaults(kind);
      expect(NOTE_TEXT_COLORS).toContain(d.textColor);
      expect(NOTE_ALIGNS).toContain(d.align);
    }
  });

  it("seven font sizes, wider than notes (heading sizes), increasing", () => {
    expect(SHAPE_FONT_SIZES).toHaveLength(7);
    const px = SHAPE_FONT_SIZES.map((k) => SHAPE_FONT_PX[k]);
    expect([...px].sort((a, b) => a - b)).toEqual(px);
    expect(new Set(px).size).toBe(7);
    expect(px.at(-1)).toBeGreaterThanOrEqual(40);
  });

  it("limits", () => {
    expect(MAX_SHAPES_PER_ROOM).toBe(50);
    expect(MAX_SHAPE_TEXT).toBe(500);
    expect([SHAPE_MIN_W, SHAPE_MIN_H, SHAPE_MAX_W, SHAPE_MAX_H]).toEqual([40, 24, 2400, 1600]);
    for (const kind of SHAPE_KINDS) {
      const { w, h } = shapeDefaults(kind);
      expect(w).toBeGreaterThanOrEqual(SHAPE_MIN_W);
      expect(h).toBeGreaterThanOrEqual(SHAPE_MIN_H);
    }
  });

  it("edit fields are the text and every style field; the kind never changes", () => {
    expect([...SHAPE_EDIT_FIELDS]).toEqual(["text", ...SHAPE_STYLE_FIELDS]);
    expect([...SHAPE_STYLE_FIELDS]).toEqual(["fill", "stroke", "strokeWidth", "strokeStyle", "fontSize", "bold", "italic", "underline", "textColor", "align", "valign"]);
    expect(SHAPE_EDIT_FIELDS).not.toContain("kind");
  });

  it("every new client message type changes the board (the lock refuses them for guests); none is host only", () => {
    for (const t of ["shapeAdd", "shapeEdit", "shapeMove", "shapeResize", "shapeDelete", "shapeBatch"] as const) {
      expect(BOARD_WRITES[t]).toBe(true);
      expect(HOST_ONLY).not.toContain(t);
    }
  });
});

describe("shape text", () => {
  it("is cleaned like note text: newlines kept, controls and invisibles dropped, trimmed, may be empty", () => {
    expect(cleanShapeText("  Step 1\r\nStep 2​\u0007 ")).toBe("Step 1\nStep 2");
    expect(cleanShapeText("")).toBe("");
    expect(cleanShapeText("   ")).toBe("");
    expect(cleanShapeText("Step 1\tdone")).toBe(cleanNoteText("Step 1\tdone"));
  });

  it("counts code points: 500 allowed, 501 refused; emoji and lone surrogates count one each", () => {
    expect(cleanShapeText("a".repeat(MAX_SHAPE_TEXT))).toHaveLength(MAX_SHAPE_TEXT);
    expect(cleanShapeText("a".repeat(MAX_SHAPE_TEXT + 1))).toBeNull();
    const emoji = "\u{1F600}".repeat(MAX_SHAPE_TEXT);
    expect(cleanShapeText(emoji)).toBe(emoji);
    expect(cleanShapeText(emoji + "\u{1F600}")).toBeNull();
    const lone = "\ud800".repeat(MAX_SHAPE_TEXT);
    expect(cleanShapeText(lone)).toBe(lone);
    expect(cleanShapeText(lone + "\udc00x")).toBeNull();
  });

  it("truncateCodePoints cuts by code points and never inside a surrogate pair", () => {
    expect(truncateCodePoints("abc", 5)).toBe("abc");
    expect(truncateCodePoints("abcdef", 3)).toBe("abc");
    const s = "a\u{1F600}b";
    expect(truncateCodePoints(s, 2)).toBe("a\u{1F600}");
    expect(truncateCodePoints(s, 1)).toBe("a");
    const mixed = "\ud800" + "\u{1F600}".repeat(600);
    const cut = truncateCodePoints(mixed, MAX_SHAPE_TEXT);
    expect(codePointLength(cut)).toBe(MAX_SHAPE_TEXT);
    expect(cut.endsWith("\u{1F600}")).toBe(true);
    expect(cleanShapeText(cut)).toBe(cut);
  });
});

describe("clamping", () => {
  it("size first (within the shape limits), then position (the whole shape on the board)", () => {
    expect(clampShapeRect({ x: 5000, y: -10, w: 10, h: 99999 })).toEqual({ x: BOARD_WIDTH - SHAPE_MIN_W, y: 0, w: SHAPE_MIN_W, h: SHAPE_MAX_H });
    expect(clampShapeRect({ x: 10.4, y: 10.6, w: 200.5, h: 120 })).toEqual({ x: 10, y: 11, w: 201, h: 120 });
    expect(clampShapePosition(BOARD_WIDTH, BOARD_HEIGHT, { w: 200, h: 160 })).toEqual({ x: BOARD_WIDTH - 200, y: BOARD_HEIGHT - 160 });
  });
});

describe("client messages", () => {
  it("shapeAdd carries a kind and a position only; strict", () => {
    for (const kind of SHAPE_KINDS) expect(parses({ type: "shapeAdd", clientRef: "r1", kind, x: 0, y: 0 })).toBe(true);
    expect(parses({ type: "shapeAdd", clientRef: "r1", kind: "star", x: 0, y: 0 })).toBe(false);
    expect(parses({ type: "shapeAdd", clientRef: "r1", kind: "rect", x: 0, y: 0, text: "Hi" })).toBe(false);
    expect(parses({ type: "shapeAdd", clientRef: "r1", kind: "rect", x: 0, y: 0, id: sid(1) })).toBe(false);
    expect(parses({ type: "shapeAdd", clientRef: "r1", kind: "rect", x: BOARD_WIDTH + 1, y: 0 })).toBe(false);
  });

  it("shapeEdit: any editable field, at least one, keys only, never the kind", () => {
    expect(parses({ type: "shapeEdit", id: sid(0) })).toBe(false);
    expect(parses({ type: "shapeEdit", id: sid(0), text: "" })).toBe(true);
    for (const k of SHAPE_FILLS) expect(parses({ type: "shapeEdit", id: sid(0), fill: k })).toBe(true);
    for (const k of SHAPE_STROKES) expect(parses({ type: "shapeEdit", id: sid(0), stroke: k })).toBe(true);
    for (const k of SHAPE_STROKE_WIDTHS) expect(parses({ type: "shapeEdit", id: sid(0), strokeWidth: k })).toBe(true);
    for (const k of SHAPE_STROKE_STYLES) expect(parses({ type: "shapeEdit", id: sid(0), strokeStyle: k })).toBe(true);
    for (const k of SHAPE_FONT_SIZES) expect(parses({ type: "shapeEdit", id: sid(0), fontSize: k })).toBe(true);
    for (const k of SHAPE_VALIGNS) expect(parses({ type: "shapeEdit", id: sid(0), valign: k })).toBe(true);
    expect(parses({ type: "shapeEdit", id: sid(0), underline: true })).toBe(true);
    expect(parses({ type: "shapeEdit", id: sid(0), stroke: "none" })).toBe(false);
    expect(parses({ type: "shapeEdit", id: sid(0), fill: "#ffffff" })).toBe(false);
    expect(parses({ type: "shapeEdit", id: sid(0), fontSize: "16px" })).toBe(false);
    expect(parses({ type: "shapeEdit", id: sid(0), kind: "oval" })).toBe(false);
    expect(parses({ type: "shapeEdit", id: sid(0), underline: "yes" })).toBe(false);
    expect(parses({ type: "shapeEdit", id: sid(0), text: "a".repeat(MAX_SHAPE_TEXT + 1) })).toBe(false);
  });

  it("shapeMove, shapeResize (shape limits) and shapeDelete are strict", () => {
    expect(parses({ type: "shapeMove", id: sid(0), x: 1, y: 1, final: true })).toBe(true);
    expect(parses({ type: "shapeMove", id: sid(0), x: 1, y: 1 })).toBe(false);
    expect(parses({ type: "shapeResize", id: sid(0), x: 1, y: 1, w: SHAPE_MIN_W, h: SHAPE_MAX_H, final: false })).toBe(true);
    expect(parses({ type: "shapeResize", id: sid(0), x: 1, y: 1, w: SHAPE_MIN_W - 1, h: 100, final: false })).toBe(false);
    expect(parses({ type: "shapeResize", id: sid(0), x: 1, y: 1, w: SHAPE_MAX_W + 1, h: 100, final: false })).toBe(false);
    expect(parses({ type: "shapeDelete", id: sid(0) })).toBe(true);
    expect(parses({ type: "shapeDelete", id: sid(0), kind: "rect" })).toBe(false);
  });

  it("shapeBatch: 1 to 50 ops, each checked on its own; a shape named twice refuses the whole batch", () => {
    expect(parses({ type: "shapeBatch", ops: [], final: true })).toBe(false);
    expect(parses({ type: "shapeBatch", ops: Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, i) => ({ op: "delete", id: sid(i) })), final: true })).toBe(false);
    const check = checkShapeBatch([
      { op: "move", id: sid(0), x: 1, y: 2 },
      { op: "resize", id: sid(1), x: 1, y: 2, w: SHAPE_MIN_W, h: SHAPE_MIN_H },
      { op: "resize", id: sid(2), x: 1, y: 2, w: 10, h: 10 },
      { op: "delete", id: sid(3) },
      { op: "spin", id: sid(4) },
    ]);
    expect(check.valid.map((v) => v.index)).toEqual([0, 1, 3]);
    expect(check.invalid).toEqual([2, 4]);
    expect(check.invalidIds).toEqual([sid(2), sid(4)]);
    expect(check.duplicate).toBe(false);
    const twice = checkShapeBatch([
      { op: "move", id: sid(0), x: 1, y: 2 },
      { op: "delete", id: sid(0) },
    ]);
    expect(twice).toMatchObject({ valid: [], invalid: [0, 1], invalidIds: [sid(0)], duplicate: true });
  });

  it("frameMove may carry shapes; notes and shapes share the 50-item carry cap; no repeats", () => {
    const move = { type: "frameMove", id: "frame00000000000", x: 0, y: 0, final: true };
    expect(parses({ ...move, shapeIds: [sid(0)] })).toBe(true);
    expect(parses({ ...move, noteIds: [nid(0)], shapeIds: [sid(0)] })).toBe(true);
    expect(parses({ ...move, shapeIds: [sid(0), sid(0)] })).toBe(false);
    const notes = Array.from({ length: 30 }, (_, i) => nid(i));
    expect(parses({ ...move, noteIds: notes, shapeIds: Array.from({ length: 20 }, (_, i) => sid(i)) })).toBe(true);
    expect(parses({ ...move, noteIds: notes, shapeIds: Array.from({ length: 21 }, (_, i) => sid(i)) })).toBe(false);
  });

  it("notesOrder may name shapes too (one stacking space); its envelope is unchanged", () => {
    expect(parses({ type: "notesOrder", ids: [nid(0), sid(0)], action: "front" })).toBe(true);
  });

  it("itemsAdd takes shapes with their full content; 50 items across notes, frames and shapes", () => {
    expect(parses({ type: "itemsAdd", clientRef: "c1", shapes: [shapeItem("a")] })).toBe(true);
    const fifty = Array.from({ length: MAX_BATCH_ENTRIES }, (_, i) => shapeItem(`r${i}`));
    expect(parses({ type: "itemsAdd", clientRef: "c1", shapes: fifty })).toBe(true);
    expect(parses({ type: "itemsAdd", clientRef: "c1", shapes: fifty, notes: [{}] })).toBe(false);
    const check = checkItems([], [], [shapeItem("a"), { ...shapeItem("b"), kind: "star" }, { ...shapeItem("c"), id: sid(1) }, shapeItem("d", { rank: 3 })]);
    expect(check.shapes.map((s) => s.index)).toEqual([0, 3]);
    expect(check.invalid).toEqual([
      { kind: "shape", index: 1, ref: "b", reason: "invalid" },
      { kind: "shape", index: 2, ref: "c", reason: "invalid" },
    ]);
    // A ref used twice across all three lists refuses the whole message.
    expect(checkItems([{ ref: "a" }], [], [shapeItem("a")]).duplicate).toBe(true);
  });
});

describe("server messages", () => {
  it("a shape needs every field, valid keys, clean text, and the whole shape on the board", () => {
    expect(shapeSchema.safeParse(shape()).success).toBe(true);
    for (const kind of SHAPE_KINDS) expect(shapeSchema.safeParse(shape(kind)).success).toBe(true);
    expect(shapeSchema.safeParse(shape("rect", { text: " untrimmed " })).success).toBe(false);
    expect(shapeSchema.safeParse(shape("rect", { x: BOARD_WIDTH - 10 })).success).toBe(false);
    expect(shapeSchema.safeParse({ ...shape(), fill: "teal" }).success).toBe(false);
    expect(shapeSchema.safeParse({ ...shape(), z: NOTE_Z_LIMIT + 1 }).success).toBe(false);
    const { underline: _, ...noUnderline } = shape();
    expect(shapeSchema.safeParse(noUnderline).success).toBe(false);
  });

  it("every new server message parses", () => {
    const s = shape();
    expect(serverParses({ type: "shapesSnapshot", shapes: [s] })).toBe(true);
    expect(serverParses({ type: "shapesSnapshot", shapes: [s], extra: 1 })).toBe(false);
    expect(serverParses({ type: "shapeAdded", shape: s, clientRef: "r1" })).toBe(true);
    expect(serverParses({ type: "shapeUpdated", shape: s })).toBe(true);
    expect(serverParses({ type: "shapeMoved", id: s.id, x: 1, y: 1, rev: 2, final: true })).toBe(true);
    expect(serverParses({ type: "shapeResized", id: s.id, x: 1, y: 1, w: 50, h: 30, rev: 2, final: false })).toBe(true);
    expect(serverParses({ type: "shapeDeleted", id: s.id })).toBe(true);
    expect(serverParses({ type: "shapesBatchApplied", results: [{ type: "shapeDeleted", id: s.id }], final: true })).toBe(true);
    expect(serverParses({ type: "shapesBatchApplied", results: [{ type: "noteDeleted", id: s.id }], final: true })).toBe(false);
    expect(serverParses({ type: "frameMoved", id: "frame00000000000", x: 0, y: 0, rev: 2, final: true, shapes: [{ id: s.id, x: 5, y: 5, rev: 2 }] })).toBe(true);
    expect(serverParses({ type: "itemsAdded", notes: [], frames: [], shapes: [{ shape: s }], refused: [] })).toBe(true);
    expect(serverParses({ type: "error", code: "shapes_full", message: "Full.", clientRef: "r1" })).toBe(true);
    expect(serverParses({ type: "error", code: "board_locked", message: "Locked.", shapeId: s.id })).toBe(true);
    expect(serverParses({ type: "error", code: "bad_message", message: "Bad.", shapeIds: [s.id], entries: [0] })).toBe(true);
    expect(serverParses({ type: "error", code: "bad_message", message: "Bad.", frameId: "frame00000000000", noteIds: [nid(0)], shapeIds: [s.id] })).toBe(true);
  });

  it("notesOrdered may report every note and shape in the room", () => {
    const results = Array.from({ length: MAX_NOTES_PER_ROOM + MAX_SHAPES_PER_ROOM }, (_, i) => ({ id: i < MAX_NOTES_PER_ROOM ? nid(i) : sid(i), z: i, rev: 1 }));
    expect(serverParses({ type: "notesOrdered", results })).toBe(true);
    expect(serverParses({ type: "notesOrdered", results: [...results, { id: sid(999), z: 0, rev: 1 }] })).toBe(false);
  });
});

/** The longest a shape can be on the wire: lone surrogates escape to 6 bytes each. */
function worstShape(i = 0): Shape {
  return {
    id: sid(i),
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
  };
}

describe("message sizes", () => {
  it("the largest shapeEdit and the largest single-shape itemsAdd fit MAX_MESSAGE_BYTES (lone surrogates, and 4-byte emoji)", () => {
    for (const text of ["\ud800".repeat(MAX_SHAPE_TEXT), "\u{1F600}".repeat(MAX_SHAPE_TEXT), "\u0001".repeat(MAX_SHAPE_TEXT)]) {
      const edit = encodeMessage({
        type: "shapeEdit",
        id: sid(0),
        text,
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
      });
      expect(utf8Length(edit)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
      expect(parseMessage(edit, clientMessageSchema).ok).toBe(true);
      const { id: _i, z: _z, rev: _r, authorId: _a, ...content } = worstShape();
      const item: ShapeItem = { ...content, text, ref: "r".repeat(32), rank: MAX_BATCH_ENTRIES - 1 };
      const add = encodeMessage({ type: "itemsAdd", clientRef: "c".repeat(32), shapes: [item] });
      expect(utf8Length(add)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
      expect(parseMessage(add, clientMessageSchema).ok).toBe(true);
    }
  });

  it("items per itemsAdd (recorded in docs/LIMITS.md): 1 shape at its largest, 18 with short content", () => {
    const fits = (items: ShapeItem[]) => utf8Length(encodeMessage({ type: "itemsAdd", clientRef: "c".repeat(12), shapes: items })) <= MAX_MESSAGE_BYTES;
    const count = (make: (i: number) => ShapeItem) => {
      let n = 0;
      while (n < MAX_BATCH_ENTRIES && fits(Array.from({ length: n + 1 }, (_, i) => make(i)))) n++;
      return n;
    };
    const { id: _i, z: _z, rev: _r, authorId: _a, ...content } = worstShape();
    expect(count((i) => ({ ...content, ref: `r${String(i).padStart(11, "0")}` }))).toBe(1);
    expect(count((i) => shapeItem(`r${String(i).padStart(11, "0")}`, { text: "" }))).toBe(18);
  });

  /**
   * Worst case for the shapes message: 50 shapes at the largest size with 500 lone surrogates
   * each, the longest keys, z at its lowest and rev at MAX_SAFE_INTEGER. The test cap is 192 KiB
   * (docs/LIMITS.md says why); the test also fails past 90% of it, so a new per-shape field
   * needs a decision first (the frames rule). It is a separate message from the notes and frames
   * snapshots, whose tripwires are unchanged.
   */
  it("the largest possible shapesSnapshot is 166,451 bytes, under the 192 KiB cap and its 90% tripwire", () => {
    const raw = encodeMessage({ type: "shapesSnapshot", shapes: Array.from({ length: MAX_SHAPES_PER_ROOM }, (_, i) => worstShape(i)) });
    expect(/^[\x20-\x7e]*$/.test(raw)).toBe(true);
    // docs/LIMITS.md records this figure; update both together.
    expect(raw.length).toBe(166_451);
    const CAP = 192 * 1024;
    expect(raw.length).toBeLessThanOrEqual(CAP * 0.9);
    expect(raw.length).toBeLessThan(MAX_SERVER_MESSAGE_BYTES / 2);
    expect(parseMessage(raw, serverMessageSchema, MAX_SERVER_MESSAGE_BYTES).ok).toBe(true);
  });

  it("the largest frameMoved (50 carried items, notes and shapes) stays small", () => {
    const carried = (id: string) => ({ id, x: BOARD_WIDTH - SHAPE_MIN_W, y: BOARD_HEIGHT - SHAPE_MIN_H, rev: Number.MAX_SAFE_INTEGER });
    const raw = encodeMessage({
      type: "frameMoved",
      id: "frame00000000000",
      x: 1000,
      y: 1000,
      rev: Number.MAX_SAFE_INTEGER,
      final: true,
      notes: Array.from({ length: 25 }, (_, i) => carried(nid(i))),
      shapes: Array.from({ length: 25 }, (_, i) => carried(sid(i))),
    });
    expect(raw.length).toBeLessThan(4 * 1024);
    expect(parseMessage(raw, serverMessageSchema, MAX_SERVER_MESSAGE_BYTES).ok).toBe(true);
  });
});
