// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_WIDTH, MAX_BATCH_ENTRIES, MAX_FRAMES_PER_ROOM, MAX_NOTES_PER_ROOM, clampFrameRect, type Note } from "@stickyard/shared";
import { GRID_GAP, align, distribute, grid, matchSize } from "../src/canvas/arrange";
import { DUPLICATE_HINTS, DUPLICATE_OFFSET, duplicateDisabledReason, duplicateSelectionInputs } from "../src/canvas/duplicate";
import { ARRANGE_HINTS, arrangeReason } from "../src/canvas/frameSelect";
import { findFrame } from "../src/frames/board";
import { CLEAR_FRAME_STEP_MS, NOTICES } from "../src/rooms/session";
import { fid, frame, nid, note, room } from "./helpers/fakeRelay";

/*
 * Frame multi-select, part 3 (web only): Align, Distribute, Grid and Match size on frames (frames
 * carry their notes when they move; Match size resizes alone), colour and title style for several
 * frames at once, and Duplicate for frames and mixed selections.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const placed = (id: string, x: number, y: number, w = 640, h = 400) => ({ id, x, y, w, h });

describe("arrange on frames (pure): frame limits, not note limits", () => {
  const frames = [placed("A", 100, 100), placed("B", 900, 300, 800, 500), placed("C", 1900, 50)];

  it("align keeps frame sizes (note clamping would cut them to the note maximum)", () => {
    expect([...align(frames, "top", clampFrameRect)]).toEqual([
      ["A", { x: 100, y: 50, w: 640, h: 400 }],
      ["B", { x: 900, y: 50, w: 800, h: 500 }],
    ]);
  });

  it("distribute spaces three frames evenly", () => {
    const out = distribute(frames, "horizontal", clampFrameRect);
    // Span 100..2540, widths 2080: two gaps of 180.
    expect(out.get("B")).toEqual({ x: 920, y: 300, w: 800, h: 500 });
    expect(out.has("A") || out.has("C")).toBe(false);
  });

  it("match size gives every frame the first one's size, within frame limits", () => {
    expect(matchSize([placed("A", 0, 0, 1200, 900), placed("B", 1500, 0)], "both", clampFrameRect).get("B")).toEqual({ x: 1500, y: 0, w: 1200, h: 900 });
  });

  it("grid lays frames out with the gap, and says why when it can't fit", () => {
    const out = grid(frames, 3, GRID_GAP, clampFrameRect);
    expect(out.reason).toBeNull();
    expect(out.changes.get("B")).toEqual({ x: 100 + 640 + GRID_GAP, y: 50, w: 800, h: 500 });
    const big = [placed("A", 0, 0, 2400, 1600), placed("B", 0, 0, 2400, 1600)];
    expect(grid(big, 2, GRID_GAP, clampFrameRect).reason).toBe("wide");
  });
});

describe("arrangeReason (pure)", () => {
  const base = { live: true, locked: null, held: false, unsaved: false };
  it("a mix of notes and frames turns arrange off, and says why", () => {
    expect(arrangeReason({ ...base, notes: 2, frames: 1 })).toBe(ARRANGE_HINTS.mixed);
    expect(arrangeReason({ ...base, notes: 0, frames: 1 })).toBe(ARRANGE_HINTS.fewFrames);
    expect(arrangeReason({ ...base, notes: 0, frames: 2 })).toBeNull();
    expect(arrangeReason({ ...base, notes: 0, frames: 2, live: false })).toBe(ARRANGE_HINTS.offline);
    expect(arrangeReason({ ...base, notes: 0, frames: 2, unsaved: true })).toBe(ARRANGE_HINTS.unsaved);
    expect(arrangeReason({ ...base, notes: 0, frames: 2, locked: "The host has locked the board." })).toBe("The host has locked the board.");
  });
});

describe("duplicate a selection with frames (pure)", () => {
  it("frames are copied alone and notes with everything, offset once and clamped as a group", () => {
    const f = frame(1, { x: BOARD_WIDTH - 650, y: 100, title: "Doing" });
    const n = note(1, { x: 100, y: 100, text: "Idea" });
    const inputs = duplicateSelectionInputs([n], [f]);
    // The frame is 10 from the right edge, so the whole group moves 10 right (and the full offset down).
    expect(inputs.map((i) => [i.kind, i.x, i.y])).toEqual([
      ["frame", BOARD_WIDTH - 640, 100 + DUPLICATE_OFFSET],
      ["note", 110, 100 + DUPLICATE_OFFSET],
    ]);
    expect(inputs[0]).toMatchObject({ kind: "frame", title: "Doing", w: 640, h: 400 });
    expect(inputs[1]).toMatchObject({ kind: "note", text: "Idea" });
  });

  it("refused up front when there isn't room for every frame or note", () => {
    const s = { notes: 0, frame: false, frames: 2, live: true, held: false, unsaved: false, busy: false, freeNotes: 10, freeFrames: 1 };
    expect(duplicateDisabledReason(s)).toBe(DUPLICATE_HINTS.framesFullMany(2, 1));
    expect(duplicateDisabledReason({ ...s, frames: 1, notes: 11 })).toBe(DUPLICATE_HINTS.notesFull(11, 10));
    expect(duplicateDisabledReason({ ...s, frames: 1, notes: 3 })).toBeNull();
  });
});

describe("RoomSession.applyFrameRects (arrange on frames)", () => {
  const board = () =>
    room(
      [note(1, { x: 150, y: 200 }), note(2, { x: 950, y: 400 }), note(3, { x: 2800, y: 1800 })],
      [frame(1, { x: 100, y: 100, title: "To do" }), frame(2, { x: 900, y: 300, title: "Doing" })],
    );

  it("moves carry each frame's notes (frameMove with noteIds); one undo puts frames and notes back", () => {
    const t = board();
    expect(t.session.applyFrameRects([{ id: fid(2), x: 900, y: 100, w: 640, h: 400 }])).toBe(true);
    expect(t.sent("frameMove")).toEqual([{ type: "frameMove", id: fid(2), x: 900, y: 100, final: true, noteIds: [nid(2)] }]);
    expect(t.relay.notes.get(nid(2))).toMatchObject({ x: 950, y: 200 });
    t.session.undo();
    expect(t.relay.frames.get(fid(2))).toMatchObject({ x: 900, y: 300 });
    expect(t.relay.notes.get(nid(2))).toMatchObject({ x: 950, y: 400 });
  });

  it("a size change (Match size) is a frameResize and leaves the notes where they are", () => {
    const t = board();
    t.session.applyFrameRects([{ id: fid(1), x: 100, y: 100, w: 900, h: 600 }]);
    expect(t.sent("frameResize")).toEqual([{ type: "frameResize", id: fid(1), x: 100, y: 100, w: 900, h: 600, final: true }]);
    expect(t.sent("frameMove")).toEqual([]);
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 150, y: 200 });
  });

  it("a frame holding more than 50 notes moves alone, with the notice", () => {
    const many: Note[] = Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, i) => note(10 + i, { x: 110 + i * 4, y: 110 }));
    const t = room(many, [frame(1, { x: 100, y: 100 })]);
    t.session.applyFrameRects([{ id: fid(1), x: 300, y: 100, w: 640, h: 400 }]);
    expect(t.sent("frameMove")[0]?.noteIds).toBeUndefined();
    expect(t.view().noteNotice).toBe(NOTICES.frameTooFull);
  });
});

describe("RoomSession.editFrames (colour and title style for several)", () => {
  it("one frameEdit per frame, paced; one undo step puts every colour back", async () => {
    const t = room([], [frame(1, { title: "To do" }), frame(2, { x: 700, title: "Doing" }), frame(3, { x: 1400, title: "Done", color: "blue" })]);
    expect(t.session.editFrames([fid(1), fid(2), fid(3)], { color: "green", titleBold: false })).toBe(true);
    expect(t.view().board.frames.every((f) => f.frame.color === "green")).toBe(true);
    expect(t.sent("frameEdit")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * 3);
    expect(t.sent("frameEdit")).toEqual([
      { type: "frameEdit", id: fid(1), color: "green", titleBold: false },
      { type: "frameEdit", id: fid(2), color: "green", titleBold: false },
      { type: "frameEdit", id: fid(3), color: "green", titleBold: false },
    ]);
    t.session.undo();
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * 3);
    expect([...t.relay.frames.values()].map((f) => [f.color, f.titleBold])).toEqual([
      ["neutral", true],
      ["neutral", true],
      ["blue", true],
    ]);
  });

  it("only what changes is sent (a frame already that colour gets nothing)", async () => {
    const t = room([], [frame(1), frame(2, { x: 700, color: "green" })]);
    t.session.editFrames([fid(1), fid(2)], { color: "green" });
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * 3);
    expect(t.sent("frameEdit")).toEqual([{ type: "frameEdit", id: fid(1), color: "green" }]);
  });
});

describe("RoomSession.duplicateSelection", () => {
  it("copies frames (alone) and notes in one itemsAdd; the copies' ids come back by kind", () => {
    const t = room([note(1, { x: 150, y: 200 }), note(2, { x: 2000, y: 1000 })], [frame(1, { x: 100, y: 100, title: "To do" })]);
    const ids = t.session.duplicateSelection([nid(2)], [fid(1)]);
    expect(ids?.frames).toHaveLength(1);
    expect(ids?.notes).toHaveLength(1);
    const add = t.sent("itemsAdd")[0]!;
    expect((add.frames as unknown[]).length).toBe(1);
    expect((add.notes as { x: number; text: string }[]).map((n) => [n.x, n.text])).toEqual([[2000 + DUPLICATE_OFFSET, "Note 2"]]);
    expect(t.relay.frames.size).toBe(2);
    expect(t.relay.notes.size).toBe(3);
    expect(findFrame(t.view().board, ids!.frames[0]!)).toBeUndefined();
  });

  it("over the caps: refused with a notice, nothing sent", () => {
    const frames = Array.from({ length: MAX_FRAMES_PER_ROOM - 1 }, (_, i) => frame(i, { x: (i % 6) * 500, y: Math.floor(i / 6) * 380, w: 480, h: 360 }));
    const t = room([note(1)], frames);
    expect(t.session.duplicateSelection([], [fid(0), fid(1)])).toBeNull();
    expect(t.view().noteNotice).toBe(DUPLICATE_HINTS.framesFullMany(2, 1));
    const notes = Array.from({ length: MAX_NOTES_PER_ROOM - 1 }, (_, i) => note(i, { x: (i % 16) * 190, y: Math.floor(i / 16) * 150 }));
    const u = room(notes, [frame(1)]);
    expect(u.session.duplicateSelection([nid(0), nid(1)], [fid(1)])).toBeNull();
    expect(u.view().noteNotice).toBe(DUPLICATE_HINTS.notesFull(2, 1));
    expect([...t.sent("itemsAdd"), ...u.sent("itemsAdd")]).toEqual([]);
  });

  it("a guest on a locked board: arrange, edits and duplicate send nothing", () => {
    const t = room([note(1)], [frame(1), frame(2, { x: 700 })], {}, (relay) => {
      relay.locked = true;
    });
    expect(t.session.applyFrameRects([{ id: fid(1), x: 10, y: 10, w: 640, h: 400 }])).toBe(false);
    expect(t.session.editFrames([fid(1), fid(2)], { color: "green" })).toBe(false);
    expect(t.session.duplicateSelection([nid(1)], [fid(1)])).toBeNull();
    expect([...t.sent("frameMove"), ...t.sent("frameEdit"), ...t.sent("itemsAdd")]).toEqual([]);
  });
});
