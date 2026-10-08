// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_WIDTH, MAX_BATCH_ENTRIES, MAX_SHAPES_PER_ROOM, shapeDefaults } from "@stickyard/shared";
import { carryPlan, confirmDeleteSelection, deleteCounts, itemsInWords, selectionLabel } from "../src/canvas/frameSelect";
import { deleteKeyTarget } from "../src/canvas/deleteKey";
import { DUPLICATE_HINTS, duplicateDisabledReason, duplicateSelectionInputs } from "../src/canvas/duplicate";
import { clearBoardReason, confirmClearBoard } from "../src/properties/clearBoard";
import { findShape } from "../src/shapes/board";
import { ITEMS_STEP_MS, SELECTION_MOVE_INTERVAL_MS, removalReportFor } from "../src/rooms/session";
import { fid, frame, nid, note, room, shape, sid } from "./helpers/fakeRelay";

/*
 * Text and shapes, part 3: shapes alongside notes and frames in selections, deletes, group moves
 * (frames carry shapes), duplicate, order, undo and redo, and resync. Generic fixtures.
 */

const rect = (id: string, x: number, y: number, w = 160, h = 160) => ({ id, x, y, w, h });

describe("pure rules", () => {
  it("frames carry the shapes whose centre is inside, each once; notes and shapes share the cap; Alt carries none", () => {
    const frames = [rect("A", 0, 0, 640, 400), rect("B", 300, 0, 640, 400)];
    const plan = carryPlan(frames, [rect("n1", 10, 10)], [], true, MAX_BATCH_ENTRIES, [rect("s1", 400, 100, 200, 120), rect("s2", 2000, 1500)], ["s1", "s2"]);
    expect(plan).toEqual({
      frames: [
        { id: "A", noteIds: ["n1"], shapeIds: ["s1"] },
        { id: "B", noteIds: [], shapeIds: [] },
      ],
      loose: [],
      looseShapes: ["s2"],
      alone: [],
    });
    const many = Array.from({ length: 30 }, (_, i) => rect(`n${i}`, 10 + i, 10));
    const shapes = Array.from({ length: 21 }, (_, i) => rect(`s${i}`, 10 + i, 200, 40, 24));
    expect(carryPlan([rect("A", 0, 0, 640, 400)], many, [], true, MAX_BATCH_ENTRIES, shapes, []).alone).toEqual(["A"]);
    expect(carryPlan([rect("A", 0, 0, 640, 400)], many, [], true, MAX_BATCH_ENTRIES, shapes.slice(0, 20), []).alone).toEqual([]);
    expect(carryPlan(frames, [], [], false, MAX_BATCH_ENTRIES, [rect("s1", 400, 100)], ["s1"]).looseShapes).toEqual(["s1"]);
  });

  it("labels and the delete confirmation count shapes, and the shapes left inside frames", () => {
    expect(selectionLabel(1, 2, 3)).toBe("1 note, 2 frames, 3 shapes selected");
    expect(itemsInWords(2, 0, 1)).toBe("2 notes and 1 shape");
    expect(itemsInWords(1, 1, 1)).toBe("1 note, 1 frame and 1 shape");
    const t = room([note(1, { x: 10, y: 10 })], [frame(1)], {}, undefined, [shape(1, { x: 100, y: 100 }), shape(2, { x: 2000, y: 1500 })]);
    const counts = deleteCounts(t.view().board, [], [fid(1)], [sid(2)]);
    expect(counts).toEqual({ notes: 0, frames: 1, shapes: 1, staying: 1, stayingShapes: 1 });
    const ask = vi.fn(() => true);
    confirmDeleteSelection(counts, ask);
    expect(ask).toHaveBeenCalledWith(
      "Delete 1 frame and 1 shape? They’re removed for everyone in the session. 1 note inside the frames isn’t selected and stays on the board. 1 shape inside the frames isn’t selected and stays on the board.",
    );
  });

  it("the Delete key: one shape alone is the shape; shapes with anything else are the selection", () => {
    const e = { key: "Delete", target: null, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false };
    const base = { multi: true, selection: 0, frameSelected: false, frames: 0, modal: false, board: null };
    expect(deleteKeyTarget(e, { ...base, shapes: 1 })).toBe("shape");
    expect(deleteKeyTarget(e, { ...base, shapes: 2 })).toBe("selection");
    expect(deleteKeyTarget(e, { ...base, shapes: 1, selection: 1 })).toBe("selection");
    expect(deleteKeyTarget(e, { ...base, selection: 2 })).toBe("notes");
    expect(deleteKeyTarget(e, { ...base, shapes: 1, multi: false })).toBeNull();
  });

  it("duplicate copies shapes with everything, one offset for the group, notes and shapes in stacking order", () => {
    const inputs = duplicateSelectionInputs([note(1, { x: 3000, z: 5 })], [], undefined, [shape(1, { x: 100, z: 3, fill: "pink", text: "Step 1" }), shape(2, { z: 9, kind: "oval" })]);
    // One offset for the group, clamped by the note at the right edge (x 3000 + 160 = 3160: 40 to spare).
    expect(inputs.map((i) => [i.kind, i.x])).toEqual([
      ["shape", 124],
      ["note", 3024],
      ["shape", 344],
    ]);
    expect(inputs[0]).toMatchObject({ kind: "shape", shapeKind: "rect", fill: "pink", text: "Step 1", w: 200, h: 120 });
    expect(inputs[2]).toMatchObject({ shapeKind: "oval" });
    const state = { notes: 0, frame: false, live: true, held: false, unsaved: false, busy: false, freeNotes: 200, freeFrames: 30 };
    expect(duplicateDisabledReason({ ...state, shapes: 3, freeShapes: 2 })).toBe(DUPLICATE_HINTS.shapesFull(3, 2));
    expect(duplicateDisabledReason({ ...state, shapes: 2, freeShapes: 2 })).toBeNull();
  });

  it("Clear board counts shapes", () => {
    expect(clearBoardReason({ live: true, notes: 0, frames: 0, shapes: 1, busy: false, clearing: false })).toBeNull();
    const ask = vi.fn(() => true);
    confirmClearBoard(2, 1, ask, 3);
    expect(ask).toHaveBeenCalledWith("Delete 2 notes, 1 frame and 3 shapes for everyone in this session? You can undo this until you leave or reconnect.");
    expect(removalReportFor("delete", { total: 1, refused: 0, lost: 0, tooQuick: false }, { total: 0, refused: 0, lost: 0, tooQuick: false }, { total: 2, refused: 0, lost: 0, tooQuick: false }).text).toBe(
      "Deleted 1 note and 2 shapes.",
    );
  });
});

describe("the session", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a frame drag carries the shapes inside it (one frameMove with shapeIds); Alt leaves them; undo puts both back", () => {
    const t = room([], [frame(1)], {}, undefined, [shape(1, { x: 100, y: 100 }), shape(2, { x: 2000, y: 1500 })]);
    expect(t.session.startFrameDrag(fid(1), true)).toBe(true);
    t.session.moveFrame(fid(1), 500, 300, true);
    expect(t.sent("frameMove").at(-1)).toEqual({ type: "frameMove", id: fid(1), x: 500, y: 300, final: true, shapeIds: [sid(1)] });
    expect(t.relay.shapes.get(sid(1))).toMatchObject({ x: 600, y: 400 });
    expect(t.relay.shapes.get(sid(2))).toMatchObject({ x: 2000, y: 1500 });
    vi.advanceTimersByTime(1000);
    t.session.undo();
    expect(t.relay.frames.get(fid(1))).toMatchObject({ x: 0, y: 0 });
    expect(t.relay.shapes.get(sid(1))).toMatchObject({ x: 100, y: 100 });
    t.session.startFrameDrag(fid(1), false);
    t.session.moveFrame(fid(1), 50, 50, true);
    expect(t.sent("frameMove").at(-1)).not.toHaveProperty("shapeIds");
  });

  it("a selection of notes and shapes moves by one clamped delta: live one batch a tick, final a noteBatch and a shapeBatch, one undo step", () => {
    // The shape sits against the right edge (its default width from it).
    const EDGE_X = BOARD_WIDTH - shapeDefaults("rect").w;
    const t = room([note(1, { x: 0, y: 0 })], [], {}, undefined, [shape(1, { x: EDGE_X, y: 100 })]);
    expect(t.session.startSelectionDrag([], [nid(1)], true, [sid(1)])).toBe(true);
    // Asked to move 500 right: the shape at the edge stops the whole group at 0.
    expect(t.session.moveSelection(500, 50, false)).toEqual({ dx: 0, dy: 50 });
    vi.advanceTimersByTime(SELECTION_MOVE_INTERVAL_MS * 3);
    const live = t.relay.received.filter((m) => (m.type === "noteBatch" || m.type === "shapeBatch") && m.final === false);
    expect(live.length).toBeGreaterThan(0);
    // Asked to move 50 left: the note at the left edge stops the group there too.
    t.session.moveSelection(-50, 50, true);
    expect(t.sent("noteBatch").at(-1)).toEqual({ type: "noteBatch", ops: [{ op: "move", id: nid(1), x: 0, y: 50 }], final: true });
    expect(t.sent("shapeBatch").at(-1)).toEqual({ type: "shapeBatch", ops: [{ op: "move", id: sid(1), x: EDGE_X, y: 150 }], final: true });
    t.session.undo();
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 0, y: 0 });
    expect(t.relay.shapes.get(sid(1))).toMatchObject({ x: EDGE_X, y: 100 });
  });

  it("a selected shape inside a selected frame moves once, with the frame", () => {
    const t = room([], [frame(1)], {}, undefined, [shape(1, { x: 100, y: 100 })]);
    t.session.startSelectionDrag([fid(1)], [], true, [sid(1)]);
    t.session.moveSelection(10, 10, true);
    expect(t.sent("frameMove").at(-1)).toMatchObject({ shapeIds: [sid(1)] });
    expect(t.sent("shapeBatch")).toEqual([]);
  });

  it("deleting a mix sends a note batch and a shape batch, reports once, and one undo restores everything (with its stacking)", () => {
    const t = room([note(1, { z: 2 })], [], {}, undefined, [shape(1, { z: 1, text: "Under" }), shape(2, { z: 3, kind: "diamond", text: "Over" })]);
    expect(t.session.deleteSelection([nid(1)], [], [sid(1), sid(2)])).toBe(true);
    expect(t.sent("shapeBatch")).toEqual([{ type: "shapeBatch", ops: [{ op: "delete", id: sid(1) }, { op: "delete", id: sid(2) }], final: true }]);
    expect(t.view().deleteReport?.text).toBe("Deleted 1 note and 2 shapes.");
    expect(t.relay.shapes.size).toBe(0);
    t.session.undo();
    vi.advanceTimersByTime(ITEMS_STEP_MS * 5);
    const [restore] = t.sent("itemsAdd");
    // Notes and shapes in stacking order, ranked: shape (z 1), note (z 2), shape (z 3).
    expect(restore?.shapes).toMatchObject([
      { kind: "rect", text: "Under", rank: 0 },
      { kind: "diamond", text: "Over", rank: 2 },
    ]);
    expect(restore?.notes).toMatchObject([{ rank: 1 }]);
    expect(t.relay.shapes.size).toBe(2);
    expect(t.view().board.shapes.map((s) => s.shape.text).sort()).toEqual(["Over", "Under"]);
  });

  it("Clear board deletes shapes too, and one undo brings them back", () => {
    const t = room([note(1)], [frame(1)], {}, undefined, [shape(1), shape(2)]);
    expect(t.session.clearBoard()).toBe(true);
    vi.advanceTimersByTime(500);
    expect(t.relay.shapes.size).toBe(0);
    expect(t.view().deleteReport?.text).toBe("Cleared the board: deleted 1 note, 1 frame and 2 shapes.");
    t.session.undo();
    vi.advanceTimersByTime(ITEMS_STEP_MS * 10);
    expect(t.relay.shapes.size).toBe(2);
    expect(t.relay.notes.size).toBe(1);
    expect(t.relay.frames.size).toBe(1);
  });

  it("undo and redo for every shape action: add, text, style, move, resize, delete", () => {
    const t = room([], [], {}, undefined, [shape(1)]);
    const id = t.session.addShape({ kind: "oval", x: 0, y: 0 });
    expect(id).not.toBeNull();
    const added = t.view().board.shapes.at(-1)!.shape.id;
    t.session.undo();
    expect(t.relay.shapes.has(added)).toBe(false);
    t.session.redo();
    vi.advanceTimersByTime(ITEMS_STEP_MS * 2);
    expect([...t.relay.shapes.values()].filter((s) => s.kind === "oval")).toHaveLength(1);

    t.session.editShape(sid(1), { text: "Changed" });
    vi.advanceTimersByTime(1000);
    t.session.editShape(sid(1), { fill: "green" });
    vi.advanceTimersByTime(1000);
    t.session.moveShape(sid(1), 900, 900, true);
    vi.advanceTimersByTime(1000);
    t.session.setShapeSize(sid(1), 400, 300);
    vi.advanceTimersByTime(1000);
    t.session.undo();
    expect(t.relay.shapes.get(sid(1))).toMatchObject({ w: 200, h: 120 });
    t.session.undo();
    expect(t.relay.shapes.get(sid(1))).toMatchObject({ x: 310, y: 300 });
    t.session.undo();
    expect(t.relay.shapes.get(sid(1))?.fill).toBe("neutral");
    t.session.undo();
    expect(t.relay.shapes.get(sid(1))?.text).toBe("Step 1");
    t.session.redo();
    expect(t.relay.shapes.get(sid(1))?.text).toBe("Changed");

    t.session.deleteShape(sid(1));
    vi.advanceTimersByTime(1000);
    t.session.undo();
    vi.advanceTimersByTime(ITEMS_STEP_MS * 2);
    expect([...t.relay.shapes.values()].some((s) => s.text === "Changed")).toBe(true);
  });

  it("duplicate copies shapes through itemsAdd and selects them; refused up front when the shapes would pass the cap", () => {
    const t = room([note(1)], [], {}, undefined, [shape(1)]);
    const ids = t.session.duplicateSelection([nid(1)], [], [sid(1)]);
    expect(ids?.shapes).toHaveLength(1);
    expect(ids?.notes).toHaveLength(1);
    expect(t.sent("itemsAdd")[0]?.shapes).toMatchObject([{ kind: "rect", text: "Step 1", x: 334, y: 324 }]);
    vi.advanceTimersByTime(ITEMS_STEP_MS);
    expect(t.relay.shapes.size).toBe(2);
    const full = room([], [], {}, undefined, Array.from({ length: MAX_SHAPES_PER_ROOM }, (_, i) => shape(i)));
    expect(full.session.duplicateSelection([], [], [sid(0)])).toBeNull();
    expect(full.sent("itemsAdd")).toEqual([]);
    expect(full.view().noteNotice).toBe(DUPLICATE_HINTS.shapesFull(1, 0));
  });

  it("Bring to front and Send to back act on notes and shapes together", () => {
    const t = room([note(1, { z: 0 })], [], {}, undefined, [shape(1, { z: 1 }), shape(2, { z: 2 })]);
    t.session.orderNotes([sid(1), nid(1)], "front");
    expect(t.sent("notesOrder")).toEqual([{ type: "notesOrder", ids: [nid(1), sid(1)], action: "front" }]);
    const z = (id: string) => findShape(t.view().board, id)?.shape.z ?? t.view().board.notes.find((n) => n.note.id === id)?.note.z;
    expect(z(sid(1))! > z(sid(2))!).toBe(true);
    expect(z(nid(1))! > z(sid(2))!).toBe(true);
  });

  it("a reconnect replaces the shapes from the relay's snapshot, keeping text being typed on a shape that is still there", () => {
    const t = room([], [], {}, undefined, [shape(1), shape(2)]);
    t.session.setShapeDraft(sid(1), "Half typed");
    t.relay.drop();
    t.relay.shapes.delete(sid(2));
    t.relay.shapes.set(sid(1), { ...shape(1), text: "Edited elsewhere", rev: 4 });
    vi.advanceTimersByTime(2000);
    t.relay.open();
    expect(t.view().status).toBe("joined");
    expect(t.view().board.shapes.map((s) => s.shape.id)).toEqual([sid(1)]);
    expect(findShape(t.view().board, sid(1))).toMatchObject({ draft: "Half typed", shape: { text: "Edited elsewhere", rev: 4 } });
  });

  it("other people's cursors still go straight to their sink, never a view update", () => {
    const moved = vi.fn();
    const t = room([], [], { cursors: { moved, gone: vi.fn(), left: vi.fn(), clear: vi.fn() } }, undefined, [shape(1)]);
    const views = t.views.length;
    t.relay.emit({ type: "cursorMoved", id: "BBBBBBBBBBBBBBBB", x: 10, y: 20 });
    expect(moved).toHaveBeenCalledWith("BBBBBBBBBBBBBBBB", 10, 20);
    expect(t.views.length).toBe(views);
  });

  it("voting and chat are unaffected by shapes on the board", () => {
    const t = room([note(1)], [], { voterKey: () => "k".repeat(22) }, (relay) => (relay.voting = { state: "open", budget: 5, round: 1 }), [shape(1)]);
    expect(t.session.voteSet(nid(1), 1)).toBe(true);
    expect(t.view().myVotes.get(nid(1))).toBe(1);
    expect(t.session.say("Hello")).toBe(true);
    expect(t.view().messages.at(-1)?.text).toBe("Hello");
    expect(shapeDefaults("rect").w).toBe(t.view().board.shapes[0]?.shape.w);
  });
});
