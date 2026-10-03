import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  NOTE_DEFAULTS,
  NOTE_MAX_H,
  NOTE_MAX_W,
  NOTE_MIN_H,
  NOTE_MIN_W,
  type Note,
} from "@stickyard/shared";
import {
  EMPTY_BOARD,
  addLocal,
  applyAdded,
  applyDeleted,
  applyMoved,
  applyResized,
  applySnapshot,
  applyUpdated,
  findNote,
  localId,
  moveLocal,
  resizeLocal,
  rollback,
  setDraft,
  setDragging,
  setResizing,
  styleLocal,
  type Board,
} from "../src/notes/board";
import { RESIZE_STEP, RESIZE_STEP_BIG, keyResize, noteSize, sizeFieldValue } from "../src/notes/size";

/* Protocol v4 on the web: optimistic resize, colour and style, with rollback. Fixtures are generic. */

const ME = "AAAAAAAAAAAAAAAA";
const N1 = "NNNNNNNNNNNNNNN1";
const one: Note = { id: N1, x: 100, y: 100, ...NOTE_DEFAULTS, text: "Idea one", color: "yellow", rev: 3, authorId: ME };
const withNotes = (...notes: Note[]): Board => applySnapshot(EMPTY_BOARD, notes);
const shown = (board: Board, id = N1) => findNote(board, id)?.note;

describe("local resize", () => {
  it("shows the new rect at once, clamped to min/max and the board", () => {
    let board = resizeLocal(withNotes(one), N1, { x: 90, y: 80, w: 250, h: 200 });
    expect(shown(board)).toMatchObject({ x: 90, y: 80, w: 250, h: 200 });
    board = resizeLocal(board, N1, { x: 90, y: 80, w: 10, h: 9999 });
    expect(shown(board)).toMatchObject({ w: NOTE_MIN_W, h: NOTE_MAX_H });
    board = resizeLocal(board, N1, { x: BOARD_WIDTH, y: BOARD_HEIGHT, w: 300, h: 300 });
    expect(shown(board)).toMatchObject({ x: BOARD_WIDTH - 300, y: BOARD_HEIGHT - 300 });
    // Confirmed is untouched until the server says so.
    expect(findNote(board, N1)?.confirmed).toEqual(one);
  });

  it("is the same board when nothing changes", () => {
    const board = withNotes(one);
    expect(resizeLocal(board, N1, { x: one.x, y: one.y, w: one.w, h: one.h })).toBe(board);
  });

  it("a local move clamps with the note's own size", () => {
    const board = resizeLocal(withNotes(one), N1, { x: 100, y: 100, w: NOTE_MAX_W, h: NOTE_MIN_H });
    expect(shown(moveLocal(board, N1, BOARD_WIDTH, BOARD_HEIGHT))).toMatchObject({ x: BOARD_WIDTH - NOTE_MAX_W, y: BOARD_HEIGHT - NOTE_MIN_H });
  });

  it("rolls back to the confirmed size when refused, and stops resizing", () => {
    let board = setResizing(withNotes(one), N1, true);
    board = resizeLocal(board, N1, { x: 50, y: 50, w: 300, h: 300 });
    board = rollback(board, N1);
    expect(shown(board)).toEqual(one);
    expect(findNote(board, N1)?.resizing).toBe(false);
  });
});

describe("remote resize", () => {
  it("non-final and final resizes show; only final ones are confirmed", () => {
    let board = applyResized(withNotes(one), { id: N1, x: 90, y: 90, w: 200, h: 220, rev: 3, final: false });
    expect(shown(board)).toMatchObject({ x: 90, y: 90, w: 200, h: 220 });
    expect(findNote(board, N1)?.confirmed).toEqual(one);
    board = applyResized(board, { id: N1, x: 80, y: 80, w: 210, h: 230, rev: 4, final: true });
    expect(findNote(board, N1)?.confirmed).toMatchObject({ x: 80, y: 80, w: 210, h: 230, rev: 4 });
    expect(shown(board)).toMatchObject({ x: 80, y: 80, w: 210, h: 230, rev: 4 });
  });

  it("stale revs are ignored", () => {
    const board = withNotes(one);
    expect(applyResized(board, { id: N1, x: 0, y: 0, w: 300, h: 300, rev: 2, final: true })).toBe(board);
  });

  it("unknown ids are ignored", () => {
    const board = withNotes(one);
    expect(applyResized(board, { id: "ZZZZZZZZZZZZZZZZ", x: 0, y: 0, w: 300, h: 300, rev: 9, final: true })).toBe(board);
  });

  it("while resizing here, remote resizes and moves are confirmed but not shown", () => {
    let board = setResizing(withNotes(one), N1, true);
    board = resizeLocal(board, N1, { x: 100, y: 100, w: 260, h: 260 });
    board = applyResized(board, { id: N1, x: 0, y: 0, w: 400, h: 400, rev: 4, final: true });
    board = applyMoved(board, { id: N1, x: 700, y: 700, rev: 5, final: true });
    expect(shown(board)).toMatchObject({ x: 100, y: 100, w: 260, h: 260 });
    expect(findNote(board, N1)?.confirmed).toMatchObject({ x: 700, y: 700, w: 400, h: 400, rev: 5 });
  });

  it("while dragging here, remote resizes don't move or resize the note", () => {
    let board = setDragging(withNotes(one), N1, true);
    board = moveLocal(board, N1, 500, 500);
    board = applyResized(board, { id: N1, x: 0, y: 0, w: 400, h: 400, rev: 4, final: false });
    expect(shown(board)).toMatchObject({ x: 500, y: 500, w: one.w, h: one.h });
  });

  it("a remote text/style update while resizing keeps the local rect", () => {
    let board = setResizing(withNotes(one), N1, true);
    board = resizeLocal(board, N1, { x: 100, y: 100, w: 260, h: 200 });
    board = applyUpdated(board, { ...one, color: "blue", bold: true, rev: 4 });
    expect(shown(board)).toMatchObject({ w: 260, h: 200, color: "blue", bold: true });
  });

  it("a remote delete mid-resize removes the note", () => {
    let board = setResizing(withNotes(one), N1, true);
    board = resizeLocal(board, N1, { x: 100, y: 100, w: 260, h: 200 });
    board = applyDeleted(board, N1);
    expect(findNote(board, N1)).toBeUndefined();
  });
});

describe("local colour and style", () => {
  it("shows at once, keeps the draft, and rolls back when refused", () => {
    let board = setDraft(withNotes(one), N1, "Typing");
    board = styleLocal(board, N1, { color: "green", fontSize: "xl", bold: true, italic: true, textColor: "red", align: "right", titleAlign: "center" });
    expect(shown(board)).toMatchObject({ color: "green", fontSize: "xl", bold: true, italic: true, textColor: "red", align: "right", titleAlign: "center" });
    expect(findNote(board, N1)?.draft).toBe("Typing");
    board = rollback(board, N1);
    expect(shown(board)).toEqual(one);
    // A draft in the editor is never clobbered, even by a rollback.
    expect(findNote(board, N1)?.draft).toBe("Typing");
  });

  it("is the same board when nothing changes", () => {
    const board = withNotes(one);
    expect(styleLocal(board, N1, { color: "yellow", bold: false })).toBe(board);
  });

  it("a confirmed update replaces the optimistic one; a stale one is ignored", () => {
    let board = styleLocal(withNotes(one), N1, { bold: true });
    board = applyUpdated(board, { ...one, bold: true, rev: 4 });
    expect(findNote(board, N1)?.confirmed).toMatchObject({ bold: true, rev: 4 });
    const stale = applyUpdated(board, { ...one, bold: false, rev: 3 });
    expect(stale).toBe(board);
  });

  it("styles set on a note before the server confirmed it are kept when it does", () => {
    let board = addLocal(EMPTY_BOARD, { clientRef: "r1", x: 10, y: 10, color: "yellow", text: "", authorId: ME });
    const temp = localId("r1");
    expect(shown(board, temp)).toMatchObject(NOTE_DEFAULTS);
    board = styleLocal(board, temp, { color: "pink", bold: true });
    board = applyAdded(board, { ...one, id: N1, x: 10, y: 10, rev: 1 }, "r1");
    expect(shown(board)).toMatchObject({ color: "pink", bold: true });
    expect(findNote(board, N1)?.confirmed).toMatchObject({ color: "yellow", bold: false });
  });
});

describe("size lookup and keyboard resize", () => {
  it("noteSize reads the note's own size", () => {
    expect(noteSize({ ...one, w: 321, h: 123 })).toEqual({ width: 321, height: 123 });
  });

  it.each([
    ["ArrowRight", false, { w: one.w + RESIZE_STEP, h: one.h }],
    ["ArrowLeft", false, { w: one.w - RESIZE_STEP, h: one.h }],
    ["ArrowDown", false, { w: one.w, h: one.h + RESIZE_STEP }],
    ["ArrowUp", false, { w: one.w, h: one.h - RESIZE_STEP }],
    ["ArrowRight", true, { w: one.w + RESIZE_STEP_BIG, h: one.h }],
    ["ArrowUp", true, { w: one.w, h: one.h - RESIZE_STEP_BIG }],
  ] as const)("Alt+%s (Shift: %s) changes the size by a step, top-left fixed", (key, big, size) => {
    expect(keyResize(one, key, big)).toEqual({ x: one.x, y: one.y, ...size });
  });

  it("keyboard resize stops at min, max and the board edge", () => {
    const small = { ...one, w: NOTE_MIN_W, h: NOTE_MIN_H };
    expect(keyResize(small, "ArrowLeft", true)).toMatchObject({ w: NOTE_MIN_W });
    const large = { ...one, w: NOTE_MAX_W, h: NOTE_MAX_H };
    expect(keyResize(large, "ArrowDown", true)).toMatchObject({ h: NOTE_MAX_H });
    const edge = { ...one, x: BOARD_WIDTH - 200, w: 190 };
    expect(keyResize(edge, "ArrowRight", true)).toEqual({ x: BOARD_WIDTH - 200, y: one.y, w: 200, h: one.h });
  });

  it("Width/Height field values: whole numbers, clamped to min/max and the board", () => {
    expect(sizeFieldValue("250", "w", one)).toBe(250);
    expect(sizeFieldValue(" 250.6 ", "w", one)).toBe(251);
    expect(sizeFieldValue("1", "w", one)).toBe(NOTE_MIN_W);
    expect(sizeFieldValue("99999", "h", one)).toBe(NOTE_MAX_H);
    expect(sizeFieldValue("400", "w", { ...one, x: BOARD_WIDTH - 300 })).toBe(300);
    expect(sizeFieldValue("", "w", one)).toBeNull();
    expect(sizeFieldValue("abc", "h", one)).toBeNull();
  });
});
