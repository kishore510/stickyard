import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { carryPlan } from "../src/canvas/frameSelect";
import { findFrame, frameMembers } from "../src/frames/board";
import { findNote } from "../src/notes/board";
import { findShape } from "../src/shapes/board";
import { buildStencil } from "../src/stencils/data";
import { fid, frame, nid, note, room, shape, sid } from "./helpers/fakeRelay";

/*
 * Frame membership (protocol v23, v0.41.0): a frame carries only the notes and shapes inside it
 * that were placed at or after it (`placed`, the relay's placement counter). A frame dropped onto
 * a note, or onto another frame's notes, doesn't pick them up when it moves again.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type Room = ReturnType<typeof room>;

/** Drags a frame by its header (carrying its members) and drops it at x, y. */
function dragFrame(t: Room, id: string, x: number, y: number) {
  expect(t.session.startFrameDrag(id, true)).toBe(true);
  t.session.moveFrame(id, x, y, true);
}
const lastCarry = (t: Room) => t.sent("frameMove").filter((m) => m.final).at(-1);

describe("frameMembers", () => {
  const box = { x: 0, y: 0, w: 640, h: 400 };
  const at = (id: string, x: number, placed?: number) => ({ id, x, y: 100, w: 160, h: 160, ...(placed === undefined ? {} : { placed }) });

  it("inside and placed at or after the frame; a tie counts; outside never", () => {
    const items = [at("before", 100, 4), at("tie", 200, 5), at("after", 300, 6), at("outside", 900, 9)];
    expect(frameMembers({ ...box, placed: 5 }, items).map((i) => i.id)).toEqual(["tie", "after"]);
  });

  it("absent is 0 (placed before v23): an old frame keeps every item inside, an old item stays with an old frame only", () => {
    const items = [at("old", 100), at("new", 300, 3)];
    expect(frameMembers(box, items).map((i) => i.id)).toEqual(["old", "new"]);
    expect(frameMembers({ ...box, placed: 2 }, items).map((i) => i.id)).toEqual(["new"]);
  });

  it("carryPlan (a selection drag) uses the same rule", () => {
    const f = { id: "F1", ...box, placed: 5 };
    const plan = carryPlan([f], [at("N1", 100, 4), at("N2", 300, 6)], [], true, 50, [at("S1", 200, 7)], []);
    expect(plan.frames).toEqual([{ id: "F1", noteIds: ["N2"], shapeIds: ["S1"] }]);
  });
});

describe("dragging frames", () => {
  it("a frame dropped onto a note doesn't take it the next time it moves; its own note still goes", () => {
    const t = room(
      [note(1, { x: 100, y: 100, placed: 2 }), note(2, { x: 1100, y: 1100, placed: 1 })],
      [frame(1, { x: 0, y: 0, placed: 1 })],
    );
    dragFrame(t, fid(1), 1000, 1000);
    expect(lastCarry(t)).toMatchObject({ noteIds: [nid(1)] });
    // The relay placed the frame and its note after note 2.
    expect(findFrame(t.view().board, fid(1))?.frame.placed).toBe(3);
    expect(findNote(t.view().board, nid(1))?.note.placed).toBe(3);
    // Note 2 is now inside the frame, but was there first: the frame leaves it.
    dragFrame(t, fid(1), 2000, 1000);
    expect(lastCarry(t)).toMatchObject({ noteIds: [nid(1)] });
    expect(t.relay.notes.get(nid(2))).toMatchObject({ x: 1100, y: 1100 });
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 2100, y: 1100 });
  });

  it("a frame dropped onto another frame's notes doesn't take them; the other frame still does", () => {
    const t = room(
      [note(1, { x: 100, y: 100, placed: 2 })],
      [frame(1, { x: 0, y: 0, placed: 1 }), frame(2, { x: 2000, y: 0, placed: 1 })],
    );
    // Frame 2 lands right over frame 1 (and its note).
    dragFrame(t, fid(2), 0, 0);
    expect(lastCarry(t)?.noteIds).toBeUndefined();
    dragFrame(t, fid(2), 3000, 0);
    expect(lastCarry(t)?.noteIds).toBeUndefined();
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 100, y: 100 });
    // Back over it again, then frame 1 moves: it takes its note, as before.
    dragFrame(t, fid(2), 0, 0);
    dragFrame(t, fid(1), 1000, 1000);
    expect(lastCarry(t)).toMatchObject({ id: fid(1), noteIds: [nid(1)] });
  });

  it("moving a note within a frame (or into it) makes it the frame's", () => {
    const t = room([note(1, { x: 1100, y: 1100, placed: 1 })], [frame(1, { x: 1000, y: 1000, placed: 2 })]);
    dragFrame(t, fid(1), 1000, 1500);
    expect(lastCarry(t)?.noteIds).toBeUndefined();
    // Moved into the frame: placed after it.
    expect(t.session.startDrag(nid(1))).toBe(true);
    t.session.moveNote(nid(1), 1100, 1600, true);
    expect(findNote(t.view().board, nid(1))?.note.placed).toBeGreaterThan(findFrame(t.view().board, fid(1))?.frame.placed ?? Infinity);
    dragFrame(t, fid(1), 2000, 1500);
    expect(lastCarry(t)).toMatchObject({ noteIds: [nid(1)] });
  });

  it("shapes follow the same rule", () => {
    const t = room([], [frame(1, { x: 0, y: 0, placed: 1 })], {}, undefined, [shape(1, { x: 100, y: 100, placed: 2 }), shape(2, { x: 1100, y: 1100, placed: 1 })]);
    dragFrame(t, fid(1), 1000, 1000);
    expect(lastCarry(t)).toMatchObject({ shapeIds: [sid(1)] });
    dragFrame(t, fid(1), 2000, 1000);
    expect(lastCarry(t)).toMatchObject({ shapeIds: [sid(1)] });
    expect(findShape(t.view().board, sid(2))?.shape).toMatchObject({ x: 1100, y: 1100 });
  });

  it("undo puts a moved frame back before its notes, so it still carries them", () => {
    const t = room([note(1, { x: 100, y: 100, placed: 2 })], [frame(1, { x: 0, y: 0, placed: 1 })]);
    dragFrame(t, fid(1), 1000, 1000);
    t.session.undo();
    vi.advanceTimersByTime(1000);
    expect(t.relay.frames.get(fid(1))).toMatchObject({ x: 0, y: 0 });
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 100, y: 100 });
    // The frame went first, so the note was placed after it.
    expect(t.relay.notes.get(nid(1))?.placed).toBeGreaterThanOrEqual(t.relay.frames.get(fid(1))?.placed ?? Infinity);
    dragFrame(t, fid(1), 500, 500);
    expect(lastCarry(t)).toMatchObject({ noteIds: [nid(1)] });
  });
});

describe("placed is the relay's: never sent back", () => {
  it("undoing a delete adds the note back without its placed (the relay assigns a new one)", () => {
    const t = room([], [frame(1, { x: 0, y: 0, placed: 1 })]);
    t.session.addNote({ x: 100, y: 100, color: "yellow" });
    vi.advanceTimersByTime(100);
    const id = t.view().board.notes[0]!.note.id;
    expect(findNote(t.view().board, id)?.note.placed).toBe(2);
    t.session.deleteNote(id);
    t.session.undo();
    vi.advanceTimersByTime(1000);
    // The fake relay checks every message against the shared schema: an itemsAdd with placed would fail it.
    const added = t.sent("itemsAdd").at(-1) as { notes: Record<string, unknown>[] } | undefined;
    expect(added?.notes[0]).not.toHaveProperty("placed");
    expect(t.relay.notes.size).toBe(1);
  });

  it("Save as stencil (and the board file, the same format) leaves placed out", () => {
    const t = room([note(1, { x: 100, y: 100, placed: 4 })], [frame(1, { x: 0, y: 0, placed: 3 })], {}, undefined, [shape(1, { placed: 5 })]);
    const stencil = buildStencil(t.view().board, { notes: [nid(1)], shapes: [sid(1)], frames: [fid(1)], connectors: [] }, "Kept", "st1");
    for (const item of [...stencil.notes, ...stencil.shapes, ...stencil.frames]) expect(item).not.toHaveProperty("placed");
  });
});
