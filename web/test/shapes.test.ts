// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SHAPES_PER_ROOM,
  MAX_SHAPE_TEXT,
  NOTE_TEXT_COLORS,
  SHAPE_FILLS,
  SHAPE_FONT_PX,
  SHAPE_FONT_SIZES,
  SHAPE_KINDS,
  SHAPE_MAX_H,
  SHAPE_MAX_W,
  SHAPE_MIN_H,
  SHAPE_MIN_W,
  SHAPE_STROKES,
  shapeDefaults,
  type Shape,
} from "@stickyard/shared";
import { EMPTY_BOARD, applyOrdered, localId, reorderLocal, topZ, type Board } from "../src/notes/board";
import {
  addShapeLocal,
  applyShapeAdded,
  applyShapeMoved,
  applyShapeUpdated,
  applyShapesSnapshot,
  deleteShapeLocal,
  discardUnconfirmedShapes,
  editShapeLocal,
  findShape,
  moveShapeLocal,
  rejectShapeAdd,
  resizeShapeLocal,
  resyncShapes,
  rollbackShape,
  setShapeDraft,
  setShapeDragging,
  shapeChanges,
} from "../src/shapes/board";
import { shapeLabel } from "../src/shapes/label";
import { shapeFillToken, shapeInkToken, shapeOutlineStyle, shapeStrokeToken, shapeTextStyle } from "../src/shapes/style";
import { PALETTE_CATEGORIES, SHAPE_TILES, paletteSections, type PaletteActions } from "../src/palette/registry";
import { NOTICES } from "../src/rooms/session";
import { packItems } from "../src/rooms/items";
import { alex, room, sam, shape, sid } from "./helpers/fakeRelay";

/*
 * Text and shapes (protocol v15), the web core: the board model, the session against a fake relay,
 * the tokens (both themes, contrast) and the palette tiles. Generic fixtures.
 */

const tokens = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");
const THEMES = [':root,\n[data-theme="light"]', '[data-theme="dark"]'] as const;
const theme = (selector: string): Record<string, string> => {
  const start = tokens.indexOf(selector);
  const block = tokens.slice(start, tokens.indexOf("}", start));
  return Object.fromEntries([...block.matchAll(/--sy-([\w-]+):\s*(#[0-9a-f]{6,8})\b/g)].map((m) => [m[1], m[2]]));
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
const px = (name: string) => Number(tokens.match(new RegExp(`--sy-${name}:\\s*(\\d+)px;`))?.[1]);
const strip = (token: string) => token.replace(/^--sy-/, "");

const boardWith = (shapes: Shape[]): Board => applyShapesSnapshot(EMPTY_BOARD, shapes);

describe("tokens (both themes)", () => {
  it("font sizes and size limits mirror the shared constants", () => {
    for (const key of SHAPE_FONT_SIZES) expect(px(`shape-font-${key}`), key).toBe(SHAPE_FONT_PX[key]);
    expect([px("shape-min-w"), px("shape-min-h"), px("shape-max-w"), px("shape-max-h")]).toEqual([SHAPE_MIN_W, SHAPE_MIN_H, SHAPE_MAX_W, SHAPE_MAX_H]);
  });

  it.each(THEMES)("every fill, border and ink has a value in %s", (selector) => {
    const c = theme(selector);
    for (const key of SHAPE_FILLS) if (key !== "none") expect(c[strip(shapeFillToken(key)!)], key).toMatch(/^#[0-9a-f]{6}$/);
    for (const key of SHAPE_STROKES) expect(c[strip(shapeStrokeToken(key))], key).toMatch(/^#[0-9a-f]{6}$/);
    for (const ink of NOTE_TEXT_COLORS) expect(c[strip(shapeInkToken(ink))], ink).toMatch(/^#[0-9a-f]{6}$/);
    expect(c["shape-placeholder"]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each(THEMES)("every ink, Auto included, is 4.5:1 on every fill and on the board (no fill) in %s", (selector) => {
    const c = theme(selector);
    const grounds = [...SHAPE_FILLS.filter((k) => k !== "none").map((k) => c[strip(shapeFillToken(k)!)]!), c.board!];
    for (const ink of NOTE_TEXT_COLORS) {
      for (const ground of grounds) expect(contrast(c[strip(shapeInkToken(ink))]!, ground), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(THEMES)("borders are 3:1 on the board, and the empty-text placeholder 3:1, in %s", (selector) => {
    const c = theme(selector);
    for (const key of SHAPE_STROKES) expect(contrast(c[strip(shapeStrokeToken(key))]!, c.board!), key).toBeGreaterThanOrEqual(3);
    expect(contrast(c["shape-placeholder"]!, c.board!)).toBeGreaterThanOrEqual(3);
  });

  it("styles are var() references only, never colour values or sizes", () => {
    for (const kind of SHAPE_KINDS) {
      const s = shape(0, { kind, ...shapeDefaults(kind), strokeStyle: "dashed", underline: true, bold: true });
      const json = JSON.stringify([shapeOutlineStyle(s), shapeTextStyle(s)]);
      expect(json).not.toMatch(/#[0-9a-f]{3,8}|\d+px/i);
    }
    expect(shapeOutlineStyle({ fill: "none", stroke: "blue", strokeWidth: "none", strokeStyle: "solid" })).toEqual({ fill: "none", stroke: "none", strokeWidth: 0 });
    expect(shapeOutlineStyle({ fill: "pink", stroke: "blue", strokeWidth: "thick", strokeStyle: "dashed" })).toEqual({
      fill: "var(--sy-shape-pink-fill)",
      stroke: "var(--sy-shape-blue-stroke)",
      strokeWidth: "var(--sy-shape-stroke-thick)",
      strokeDasharray: "var(--sy-shape-dash)",
    });
  });
});

describe("the board model", () => {
  it("a local add uses the kind's size and style, empty text, and goes on top of notes and shapes", () => {
    const board = boardWith([shape(1, { z: 7 })]);
    const next = addShapeLocal(board, { clientRef: "r1", kind: "diamond", x: 3190, y: 10, authorId: alex.id });
    expect(findShape(next, localId("r1"))?.shape).toMatchObject({ kind: "diamond", ...shapeDefaults("diamond"), x: 3000, y: 10, text: "", z: 8 });
    expect(topZ(next)).toBe(9);
  });

  it("the server's add replaces the temporary shape in place, keeping text and style set meanwhile", () => {
    let board = addShapeLocal(EMPTY_BOARD, { clientRef: "r1", kind: "rect", x: 0, y: 0, authorId: alex.id });
    board = editShapeLocal(board, localId("r1"), { text: "Step 1", fill: "blue" });
    board = applyShapeAdded(board, shape(9, { x: 0, y: 0, text: "", z: 0 }), "r1");
    expect(board.shapes).toHaveLength(1);
    expect(board.shapes[0]).toMatchObject({ clientRef: null, shape: { id: sid(9), text: "Step 1", fill: "blue" }, confirmed: { text: "" } });
  });

  it("stale updates are ignored; a draft survives a remote edit; a held shape keeps its place", () => {
    let board = boardWith([shape(1, { rev: 3 })]);
    expect(applyShapeUpdated(board, shape(1, { rev: 2, text: "Old" }))).toBe(board);
    board = setShapeDraft(board, sid(1), "Typing");
    board = applyShapeUpdated(board, shape(1, { rev: 4, text: "Theirs" }));
    expect(findShape(board, sid(1))).toMatchObject({ draft: "Typing", shape: { text: "Theirs" } });
    board = setShapeDragging(moveShapeLocal(board, sid(1), 500, 500), sid(1), true);
    board = applyShapeMoved(board, { id: sid(1), x: 10, y: 10, rev: 5, final: true });
    expect(findShape(board, sid(1))).toMatchObject({ shape: { x: 500, y: 500 }, confirmed: { x: 10, y: 10, rev: 5 } });
  });

  it("local moves and resizes are clamped to the board and the shape limits", () => {
    let board = boardWith([shape(1)]);
    board = moveShapeLocal(board, sid(1), 99999, -5);
    expect(findShape(board, sid(1))?.shape).toMatchObject({ x: 3000, y: 0 });
    board = resizeShapeLocal(board, sid(1), { x: 0, y: 0, w: 1, h: 99999 });
    expect(findShape(board, sid(1))?.shape).toMatchObject({ w: SHAPE_MIN_W, h: SHAPE_MAX_H });
  });

  it("a delete waits as removed and comes back in place on refusal; a refused add goes; edits roll back", () => {
    let board = boardWith([shape(1), shape(2), shape(3)]);
    board = deleteShapeLocal(board, sid(2));
    expect(board.shapes.map((s) => s.shape.id)).toEqual([sid(1), sid(3)]);
    board = rollbackShape(board, sid(2));
    expect(board.shapes.map((s) => s.shape.id)).toEqual([sid(1), sid(2), sid(3)]);
    board = editShapeLocal(board, sid(1), { fill: "pink" });
    board = rollbackShape(board, sid(1));
    expect(findShape(board, sid(1))?.shape.fill).toBe("neutral");
    board = addShapeLocal(board, { clientRef: "r9", kind: "oval", x: 0, y: 0, authorId: alex.id });
    expect(rejectShapeAdd(board, "r9").shapes).toHaveLength(3);
  });

  it("shapeChanges lists only what changed; an unchanged edit keeps the same board", () => {
    const a = shape(1);
    expect(shapeChanges(a, { ...a, text: "New", underline: true, x: 999 })).toEqual({ text: "New", underline: true });
    const board = boardWith([a]);
    expect(editShapeLocal(board, sid(1), { fill: a.fill })).toBe(board);
  });

  it("notes and shapes share stacking: bring to front over both, and notesOrdered results apply to shapes", () => {
    let board = boardWith([shape(1, { z: 1 }), shape(2, { z: 5 })]);
    board = reorderLocal(board, [sid(1)], "front");
    expect(findShape(board, sid(1))?.shape.z).toBe(6);
    board = applyOrdered(board, [{ id: sid(2), z: -3, rev: 2 }]);
    expect(findShape(board, sid(2))).toMatchObject({ shape: { z: -3, rev: 2 }, confirmed: { z: -3, rev: 2 } });
  });

  it("a snapshot merges by rev and keeps local adds; a resync replaces and keeps drafts; a drop discards unconfirmed", () => {
    let board = boardWith([shape(1, { rev: 5 })]);
    board = addShapeLocal(board, { clientRef: "r1", kind: "rect", x: 0, y: 0, authorId: alex.id });
    board = applyShapesSnapshot(board, [shape(1, { rev: 4, text: "Older" }), shape(2)]);
    expect(board.shapes.map((s) => s.shape.id)).toEqual([localId("r1"), sid(1), sid(2)]);
    expect(findShape(board, sid(1))?.shape.rev).toBe(5);
    board = setShapeDraft(board, sid(2), "Kept");
    board = editShapeLocal(board, sid(1), { fill: "green" });
    const dropped = discardUnconfirmedShapes(board);
    expect(dropped.shapes.map((s) => s.shape.id)).toEqual([sid(1), sid(2)]);
    expect(findShape(dropped, sid(1))?.shape.fill).toBe("neutral");
    const resynced = resyncShapes(dropped, [shape(2, { rev: 9 })]);
    expect(resynced.shapes).toHaveLength(1);
    expect(findShape(resynced, sid(2))).toMatchObject({ draft: "Kept", shape: { rev: 9 } });
  });

  it("an accessible name says the kind and the text", () => {
    expect(shapeLabel({ kind: "rect", text: "Step 1\nnext" })).toBe("Rectangle: Step 1 next");
    expect(shapeLabel({ kind: "text", text: " " })).toBe("Text, empty");
    expect(shapeLabel({ kind: "diamond", text: "Choose" })).toBe("Diamond: Choose");
  });
});

describe("palette", () => {
  const state = { live: true, noteCount: 0, isHost: false };
  const ctx = { noteReason: null, frameReason: null, templateReason: null, timerReason: null, shapeReason: null };
  it("a Shapes category on the panel only: Text, Rectangle, Oval, Diamond", () => {
    const panel = paletteSections(PALETTE_CATEGORIES, "add", state, "", "panel");
    expect(panel.find((s) => s.category.id === "shapes")?.items.map((i) => i.label)).toEqual(["Text", "Rectangle", "Oval", "Diamond"]);
    const drawer = paletteSections(PALETTE_CATEGORIES, "add", state, "", "drawer");
    expect(drawer.some((s) => s.category.id === "shapes")).toBe(false);
  });

  it("a tile adds its kind at the view centre or where it was dropped, drops at its size, and is off with the reason", () => {
    const addShape = vi.fn();
    const actions: PaletteActions = { addNote: vi.fn(), addFrame: vi.fn(), applyTemplate: vi.fn(), openTimer: vi.fn(), addShape };
    SHAPE_TILES[3]!.create(actions);
    SHAPE_TILES[0]!.create(actions, { x: 5, y: 6 });
    expect(addShape.mock.calls).toEqual([["diamond", undefined], ["text", { x: 5, y: 6 }]]);
    expect(SHAPE_TILES.map((t) => t.dropSize)).toEqual(SHAPE_KINDS.map((k) => ({ width: shapeDefaults(k).w, height: shapeDefaults(k).h })));
    expect(SHAPE_TILES[1]!.disabled(ctx)).toBeNull();
    expect(SHAPE_TILES[1]!.disabled({ ...ctx, shapeReason: "Full" })).toBe("Full");
  });
});

describe("itemsAdd packing with shapes", () => {
  it("a message with shapes ranks every note and shape in the order given; one without shapes is as before", () => {
    const { w, h, ...style } = shapeDefaults("oval");
    const noteItem = { ref: "n1", x: 0, y: 0, w: 160, h: 160, text: "", color: "yellow", fontSize: "m", bold: false, italic: false, textColor: "auto", align: "left", titleAlign: "left", titleFontSize: "m", titleBold: false, titleItalic: false, titleTextColor: "auto" } as const;
    const shapeItem = { ref: "s1", kind: "oval" as const, x: 0, y: 0, w, h, text: "", ...style };
    let n = 0;
    const ref = () => `c${n++}`;
    const mixed = packItems([{ kind: "shape", item: shapeItem }, { kind: "note", item: noteItem }, { kind: "shape", item: { ...shapeItem, ref: "s2" } }], ref);
    expect(mixed.messages).toHaveLength(1);
    expect(mixed.messages[0]?.shapes?.map((s) => [s.ref, s.rank])).toEqual([["s1", 0], ["s2", 2]]);
    expect(mixed.messages[0]?.notes?.map((s) => [s.ref, s.rank])).toEqual([["n1", 1]]);
    const plain = packItems([{ kind: "note", item: noteItem }], ref);
    expect(plain.messages[0]?.notes?.[0]).not.toHaveProperty("rank");
  });
});

describe("the session (fake relay)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("joining applies the shapes snapshot after the frames snapshot", () => {
    const t = room([], [], {}, undefined, [shape(1), shape(2, { kind: "text", text: "Parking lot" })]);
    expect(t.view().board.shapes.map((s) => s.shape.id)).toEqual([sid(1), sid(2)]);
  });

  it("addShape shows it at once, sends shapeAdd, and follows it to its server id", () => {
    const confirmed = vi.fn();
    const t = room([], [], { onShapeConfirmed: confirmed });
    const id = t.session.addShape({ kind: "oval", x: 100, y: 200 });
    expect(id).toMatch(/^local:/);
    expect(t.sent("shapeAdd")).toEqual([{ type: "shapeAdd", clientRef: expect.any(String), kind: "oval", x: 100, y: 200 }]);
    const [entry] = t.view().board.shapes;
    expect(entry?.confirmed).not.toBeNull();
    expect(confirmed).toHaveBeenCalledWith(id, entry?.shape.id);
  });

  it("text typed before the add is confirmed goes out once as one shapeEdit", () => {
    const t = room();
    t.relay.paused = true;
    const id = t.session.addShape({ kind: "rect", x: 0, y: 0 })!;
    t.session.setShapeDraft(id, "Step 1");
    t.session.editShape(id, { text: "Step 1" });
    expect(t.sent("shapeEdit")).toEqual([]);
    t.relay.resume();
    expect(t.sent("shapeEdit")).toEqual([{ type: "shapeEdit", id: expect.any(String), text: "Step 1" }]);
    expect(t.view().board.shapes[0]?.shape.text).toBe("Step 1");
  });

  it("an edit sends only the changed fields, cleaned; an unchanged text just ends the draft", () => {
    const t = room([], [], {}, undefined, [shape(1)]);
    t.session.setShapeDraft(sid(1), "  Step 1\r\nStep 2 ");
    expect(t.session.editShape(sid(1), { text: "  Step 1\r\nStep 2 " })).toBe(true);
    t.session.editShape(sid(1), { fill: "pink", valign: "bottom" });
    t.session.editShape(sid(1), { fill: "pink" });
    expect(t.sent("shapeEdit")).toEqual([
      { type: "shapeEdit", id: sid(1), text: "Step 1\nStep 2" },
      { type: "shapeEdit", id: sid(1), fill: "pink", valign: "bottom" },
    ]);
    expect(t.relay.shapes.get(sid(1))).toMatchObject({ text: "Step 1\nStep 2", fill: "pink", valign: "bottom", rev: 3 });
    expect(t.session.editShape(sid(1), { text: "a".repeat(MAX_SHAPE_TEXT + 1) })).toBe(false);
  });

  it("moves are throttled while dragging and the drop is final; resizes too; Width/Height is one final resize", () => {
    const t = room([], [], {}, undefined, [shape(1)]);
    expect(t.session.startShapeDrag(sid(1))).toBe(true);
    t.session.moveShape(sid(1), 400, 300, false);
    t.session.moveShape(sid(1), 410, 300, false);
    t.session.moveShape(sid(1), 420, 300, false);
    expect(t.sent("shapeMove")).toHaveLength(1);
    t.session.moveShape(sid(1), 500, 600, true);
    expect(t.sent("shapeMove").at(-1)).toEqual({ type: "shapeMove", id: sid(1), x: 500, y: 600, final: true });
    expect(t.relay.shapes.get(sid(1))).toMatchObject({ x: 500, y: 600 });
    t.session.startShapeResize(sid(1));
    t.session.resizeShape(sid(1), { x: 500, y: 600, w: 10, h: 99999 }, true);
    expect(t.sent("shapeResize").at(-1)).toEqual({ type: "shapeResize", id: sid(1), x: 500, y: 400, w: SHAPE_MIN_W, h: SHAPE_MAX_H, final: true });
    t.session.setShapeSize(sid(1), 300, 200);
    expect(t.relay.shapes.get(sid(1))).toMatchObject({ w: 300, h: 200 });
  });

  it("delete removes it at once and the relay confirms; Sam's changes arrive; a deleted shape being edited says so", () => {
    const t = room([], [], {}, undefined, [shape(1), shape(2)]);
    t.session.deleteShape(sid(1));
    expect(t.sent("shapeDelete")).toEqual([{ type: "shapeDelete", id: sid(1) }]);
    expect(t.view().board.shapes.map((s) => s.shape.id)).toEqual([sid(2)]);
    t.relay.samEditShape(sid(2), { text: "Theirs" });
    expect(t.view().board.shapes[0]?.shape.text).toBe("Theirs");
    t.session.setShapeDraft(sid(2), "Mine");
    t.relay.emit({ type: "shapeDeleted", id: sid(2) });
    expect(t.view().noteNotice).toBe(NOTICES.shapeDeletedWhileEditing);
  });

  it("the board's shape cap is checked here and by the relay: shapes_full rolls back with a notice", () => {
    const full = Array.from({ length: MAX_SHAPES_PER_ROOM }, (_, i) => shape(i));
    const t = room([], [], {}, undefined, full);
    expect(t.session.addShape({ kind: "rect", x: 0, y: 0 })).toBeNull();
    expect(t.view().noteNotice).toBe(NOTICES.shapesFull);
    const u = room();
    u.relay.refuseShapes = "shapes_full";
    u.session.addShape({ kind: "rect", x: 0, y: 0 });
    expect(u.view().board.shapes).toEqual([]);
    expect(u.view().noteNotice).toBe(NOTICES.shapesFull);
  });

  it("a refused change rolls back (board_locked says the board is locked)", () => {
    const t = room([], [], {}, undefined, [shape(1)]);
    t.relay.refuseShapes = "board_locked";
    t.session.editShape(sid(1), { fill: "green" });
    expect(t.view().board.shapes[0]?.shape.fill).toBe("neutral");
    expect(t.view().noteNotice).toBe(NOTICES.locked);
    t.relay.refuseShapes = "board_locked";
    t.session.deleteShape(sid(1));
    expect(t.view().board.shapes.map((s) => s.shape.id)).toEqual([sid(1)]);
  });

  it("nothing is sent while disconnected; a drop puts shapes back as confirmed and counts unsaved shape work", () => {
    const t = room([], [], {}, undefined, [shape(1)]);
    t.relay.paused = true;
    t.session.editShape(sid(1), { fill: "pink" });
    t.session.addShape({ kind: "text", x: 0, y: 0 });
    t.relay.drop();
    expect(t.view().status).toBe("disconnected");
    expect(t.view().board.shapes.map((s) => s.shape)).toEqual([shape(1)]);
    expect(t.view().dropReport).toMatch(/^2 changes may not/);
    const before = t.relay.received.length;
    expect(t.session.addShape({ kind: "rect", x: 0, y: 0 })).toBeNull();
    expect(t.session.editShape(sid(1), { fill: "blue" })).toBe(false);
    t.session.moveShape(sid(1), 5, 5, true);
    expect(t.relay.received.length).toBe(before);
  });

  it("a frame drag's shapes in frameMoved, and itemsAdded shapes from someone else, are applied", () => {
    const t = room([], [], {}, undefined, [shape(1)]);
    t.relay.emit({ type: "frameMoved", id: "frme000000000001", x: 0, y: 0, rev: 2, final: true, shapes: [{ id: sid(1), x: 700, y: 50, rev: 2 }] });
    expect(t.view().board.shapes[0]?.shape).toMatchObject({ x: 700, y: 50, rev: 2 });
    t.relay.emit({ type: "itemsAdded", notes: [], frames: [], shapes: [{ shape: shape(5, { authorId: sam.id }) }], refused: [] });
    expect(t.view().board.shapes.map((s) => s.shape.id)).toEqual([sid(1), sid(5)]);
  });
});
