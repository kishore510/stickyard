import { describe, expect, it } from "vitest";
import { FRAME_DEFAULTS, NOTE_DEFAULTS, shapeDefaults, type Frame, type Note, type Shape } from "@stickyard/shared";
import { applyFrameResized, applyFrameUpdated, applyFramesSnapshot, findFrame, setFrameDragging, setFrameResizing } from "../src/frames/board";
import { EMPTY_BOARD, applyMoved, applyResized, applySnapshot, applyUpdated, findNote, moveLocal, setDragging, setResizing } from "../src/notes/board";
import { applyShapeMoved, applyShapeResized, applyShapeUpdated, applyShapesSnapshot, findShape, setShapeDragging, setShapeResizing } from "../src/shapes/board";

/*
 * Hardening (v0.39.1), found by the load harness: a note dragged here while someone else resized
 * it kept the old size for good. Dragging holds only the position; resizing holds the whole rect.
 * Generic fixtures.
 */

const ME = "AAAAAAAAAAAAAAAA";
const N1 = "NNNNNNNNNNNNNNN1";
const S1 = "SSSSSSSSSSSSSSS1";
const F1 = "FFFFFFFFFFFFFFF1";
const one: Note = { id: N1, x: 100, y: 100, ...NOTE_DEFAULTS, text: "Idea", color: "yellow", z: 0, rev: 1, authorId: ME };
const shape: Shape = { id: S1, kind: "rect", x: 100, y: 100, ...shapeDefaults("rect"), text: "", z: 1, rev: 1, authorId: ME };
const frame: Frame = { id: F1, x: 100, y: 100, w: 640, h: 400, title: "Start", color: "neutral", ...FRAME_DEFAULTS, rev: 1, authorId: ME };

describe("notes: dragging holds the position, not the size", () => {
  it("a remote final resize during my drag shows the new size, keeps my position, and survives the drop", () => {
    let board = moveLocal(setDragging(applySnapshot(EMPTY_BOARD, [one]), N1, true), N1, 300, 300);
    board = applyResized(board, { id: N1, x: 120, y: 120, w: 240, h: 200, rev: 2, final: true });
    expect(findNote(board, N1)?.note).toMatchObject({ x: 300, y: 300, w: 240, h: 200 });
    // My drop: released here, then the relay's final move.
    board = applyMoved(setDragging(board, N1, false), { id: N1, x: 300, y: 300, rev: 3, final: true });
    expect(findNote(board, N1)?.note).toEqual(findNote(board, N1)?.confirmed);
  });

  it("a remote noteUpdated during my drag shows its size too", () => {
    let board = moveLocal(setDragging(applySnapshot(EMPTY_BOARD, [one]), N1, true), N1, 300, 300);
    board = applyUpdated(board, { ...one, w: 300, h: 260, text: "Changed", rev: 2 });
    expect(findNote(board, N1)?.note).toMatchObject({ x: 300, y: 300, w: 300, h: 260, text: "Changed" });
  });

  it("while resizing here, the whole rect is still mine", () => {
    let board = setResizing(applySnapshot(EMPTY_BOARD, [one]), N1, true);
    board = applyResized(board, { id: N1, x: 120, y: 120, w: 240, h: 200, rev: 2, final: true });
    expect(findNote(board, N1)?.note).toMatchObject({ x: 100, y: 100, w: NOTE_DEFAULTS.w, h: NOTE_DEFAULTS.h });
  });
});

describe("shapes: dragging holds the position, not the size", () => {
  it("a remote final resize during my drag shows the new size and survives the drop", () => {
    let board = setShapeDragging(applyShapesSnapshot(EMPTY_BOARD, [shape]), S1, true);
    board = applyShapeResized(board, { id: S1, x: 100, y: 100, w: 300, h: 200, rev: 2, final: true });
    expect(findShape(board, S1)?.shape).toMatchObject({ x: 100, y: 100, w: 300, h: 200 });
    board = applyShapeMoved(setShapeDragging(board, S1, false), { id: S1, x: 100, y: 100, rev: 2, final: true });
    expect(findShape(board, S1)?.shape).toEqual(findShape(board, S1)?.confirmed);
  });

  it("an update during my drag shows its size; resizing here keeps my rect", () => {
    let board = setShapeDragging(applyShapesSnapshot(EMPTY_BOARD, [shape]), S1, true);
    board = applyShapeUpdated(board, { ...shape, w: 320, h: 180, rev: 2 });
    expect(findShape(board, S1)?.shape).toMatchObject({ w: 320, h: 180 });
    board = applyShapeResized(setShapeResizing(setShapeDragging(board, S1, false), S1, true), { id: S1, x: 0, y: 0, w: 400, h: 400, rev: 3, final: true });
    expect(findShape(board, S1)?.shape).toMatchObject({ w: 320, h: 180 });
  });
});

describe("frames: dragging holds the position, not the size", () => {
  it("a remote final resize during my drag shows the new size", () => {
    let board = setFrameDragging(applyFramesSnapshot(EMPTY_BOARD, [frame]), F1, true);
    board = applyFrameResized(board, { id: F1, x: 100, y: 100, w: 800, h: 500, rev: 2, final: true });
    expect(findFrame(board, F1)?.frame).toMatchObject({ x: 100, y: 100, w: 800, h: 500 });
    board = applyFrameUpdated(board, { ...frame, w: 900, h: 600, rev: 3 });
    expect(findFrame(board, F1)?.frame).toMatchObject({ w: 900, h: 600 });
  });

  it("while resizing here, the whole rect is still mine", () => {
    let board = setFrameResizing(applyFramesSnapshot(EMPTY_BOARD, [frame]), F1, true);
    board = applyFrameResized(board, { id: F1, x: 300, y: 300, w: 800, h: 500, rev: 2, final: true });
    expect(findFrame(board, F1)?.frame).toMatchObject({ x: 100, y: 100, w: 640, h: 400 });
  });
});
