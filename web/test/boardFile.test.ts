import { describe, expect, it } from "vitest";
import { FRAME_DEFAULTS, NOTE_DEFAULTS, shapeDefaults, type Connector, type Frame, type Group, type Note, type Shape } from "@stickyard/shared";
import { EMPTY_BOARD, applySnapshot } from "../src/notes/board";
import { applyFramesSnapshot } from "../src/frames/board";
import { applyShapesSnapshot } from "../src/shapes/board";
import { applyConnectorsSnapshot } from "../src/connectors/board";
import { applyGroupsSnapshot } from "../src/groups/board";
import { BOARD_FILE_FORMAT, BOARD_FILE_VERSION, boardFileText, buildBoardFile } from "../src/export/boardFile";
import { exportFileName } from "../src/export/markdown";
import { parseStencil } from "../src/stencils/data";

/*
 * Export board file (v0.40.0, web only): the board as a JSON file of the stencil item schemas
 * (notes, shapes, frames with refs; arrows and groups by ref) wrapped in a format name and version,
 * plus `stack` (the notes' and shapes' stacking order, by ref). Only content and style: no room
 * code, names, authors, ids, revs, z, votes, reactions or cursors, and never a hidden note.
 */

const HOSTILE = "<img src=x onerror=alert(1)>";
const AUTHOR = "AuthorIdAAAAAAAA";

const note = (id: string, x: number, y: number, z: number, extra: Partial<Note> = {}): Note => ({ id, x, y, ...NOTE_DEFAULTS, text: `note ${id}`, color: "yellow", z, rev: 7, authorId: AUTHOR, ...extra });
const shape = (id: string, x: number, y: number, z: number): Shape => ({ id, kind: "oval", x, y, ...shapeDefaults("oval"), text: `shape ${id}`, z, rev: 3, authorId: AUTHOR });
const frame = (id: string, x: number, y: number, title: string): Frame => ({ id, x, y, w: 640, h: 400, color: "neutral", ...FRAME_DEFAULTS, title, rev: 2, authorId: AUTHOR });
const arrow = (id: string, start: Connector["start"], end: Connector["end"]): Connector => ({ id, start, end, route: "elbow", dash: "dashed", width: "thick", ink: "pink", startHead: "none", endHead: "arrow", rev: 1, authorId: AUTHOR });
const group = (id: string, label: string, members: string[]): Group => ({ id, label, color: "green", members: [...members].sort(), rev: 1 });

function sample() {
  let board = applySnapshot(EMPTY_BOARD, [
    note("NoteIdTop0000001", 1200, 1000, 30, { text: `Top\n${HOSTILE}` }),
    note("NoteIdBottom0001", 1000, 1000, 10),
    note("NoteIdHidden0001", 2000, 2000, 50, { text: "my hidden note" }),
  ]);
  board = applyFramesSnapshot(board, [frame("FrameId000000001", 900, 900, "Ideas")]);
  board = applyShapesSnapshot(board, [shape("ShapeId000000001", 1000, 1300, 20)]);
  board = applyConnectorsSnapshot(board, [
    arrow("ArrowId000000001", { item: "NoteIdBottom0001", anchor: "right" }, { item: "NoteIdTop0000001", anchor: "left" }),
    arrow("ArrowId000000002", { item: "ShapeId000000001", anchor: "auto" }, { item: "NoteIdHidden0001", anchor: "auto" }),
  ]);
  board = applyGroupsSnapshot(board, [group("GroupId000000001", "Pair", ["NoteIdBottom0001", "ShapeId000000001"])]);
  return board;
}

describe("the board file", () => {
  it("is the stencil schemas with a format name, a version and the stacking order", () => {
    const file = buildBoardFile(sample(), new Set(["NoteIdHidden0001"]))!;
    expect(file.format).toBe(BOARD_FILE_FORMAT);
    expect(BOARD_FILE_FORMAT).toBe("stickyard-board");
    expect(file.formatVersion).toBe(BOARD_FILE_VERSION);
    expect(BOARD_FILE_VERSION).toBe(1);
    expect(Object.keys(file).sort()).toEqual(["arrows", "format", "formatVersion", "frames", "groups", "notes", "shapes", "stack"]);
    // The items are exactly what a stencil carries (the stencil parser accepts them unchanged).
    const { format: _, formatVersion: __, stack: ___, ...items } = file;
    expect(parseStencil({ id: "check", name: "check", ...items })).toEqual({ id: "check", name: "check", ...items });
  });

  it("keeps content, style and layout from the top-left, notes and shapes in stacking order", () => {
    const file = buildBoardFile(sample(), new Set(["NoteIdHidden0001"]))!;
    expect(file.notes.map((n) => n.text)).toEqual(["note NoteIdBottom0001", `Top\n${HOSTILE}`]);
    expect(file.notes[0]).toMatchObject({ x: 100, y: 100, color: "yellow" });
    expect(file.frames).toEqual([expect.objectContaining({ x: 0, y: 0, title: "Ideas" })]);
    expect(file.shapes).toEqual([expect.objectContaining({ kind: "oval", x: 100, y: 400, text: "shape ShapeId000000001" })]);
    // Bottom note (z 10), the shape (z 20), the top note (z 30): one stacking space.
    const refOf = (text: string) => [...file.notes, ...file.shapes].find((i) => i.text === text)!.ref;
    expect(file.stack).toEqual([refOf("note NoteIdBottom0001"), refOf("shape ShapeId000000001"), refOf(`Top\n${HOSTILE}`)]);
  });

  it("keeps arrows and groups by ref; an arrow to a hidden note keeps a free end", () => {
    const file = buildBoardFile(sample(), new Set(["NoteIdHidden0001"]))!;
    expect(file.arrows).toHaveLength(2);
    expect(file.arrows[0]).toMatchObject({ start: { ref: file.notes[0]!.ref, anchor: "right" }, end: { ref: file.notes[1]!.ref, anchor: "left" }, route: "elbow", dash: "dashed" });
    expect(file.arrows[1]!.start).toEqual({ ref: file.shapes[0]!.ref, anchor: "auto" });
    expect(file.arrows[1]!.end).toEqual({ x: expect.any(Number), y: expect.any(Number) });
    expect(file.groups).toEqual([{ label: "Pair", color: "green", members: expect.arrayContaining([file.notes[0]!.ref, file.shapes[0]!.ref]) }]);
  });

  it("never holds a hidden note", () => {
    const text = boardFileText(buildBoardFile(sample(), new Set(["NoteIdHidden0001"]))!);
    expect(text).not.toContain("my hidden note");
    expect(buildBoardFile(sample())!.notes).toHaveLength(3);
  });

  it("never holds an id, rev, z, author, vote, reaction, room code or name", () => {
    const text = boardFileText(buildBoardFile(sample(), new Set(["NoteIdHidden0001"]))!);
    for (const id of ["NoteIdTop0000001", "NoteIdBottom0001", "FrameId000000001", "ShapeId000000001", "ArrowId000000001", "GroupId000000001", AUTHOR]) expect(text).not.toContain(id);
    for (const key of ['"id"', '"rev"', '"z"', '"authorId"', '"votes"', '"dots"', '"reactions"', '"code"', '"room"', '"name"', '"cursor"', '"rank"']) expect(text).not.toContain(key);
    expect(JSON.parse(text)).toEqual(buildBoardFile(sample(), new Set(["NoteIdHidden0001"])));
    expect(text.endsWith("\n")).toBe(true);
  });

  it("is null for an empty board, or when every note is hidden", () => {
    expect(buildBoardFile(EMPTY_BOARD)).toBeNull();
    expect(buildBoardFile(applySnapshot(EMPTY_BOARD, [note("NoteIdHidden0001", 0, 0, 0)]), new Set(["NoteIdHidden0001"]))).toBeNull();
  });

  it("is named by the date only", () => {
    expect(exportFileName("json", new Date(2026, 9, 15, 23, 59))).toBe("stickyard-board-2026-10-15.json");
  });
});
