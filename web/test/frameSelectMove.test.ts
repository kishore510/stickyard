// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_WIDTH, MAX_BATCH_ENTRIES, MAX_FRAMES_PER_ROOM, NOTE_DEFAULTS, type Note } from "@stickyard/shared";
import { carryPlan, confirmDeleteSelection, deleteCounts } from "../src/canvas/frameSelect";
import { createDragHandlers } from "../src/canvas/nodes";
import { findFrame } from "../src/frames/board";
import {
  CLEAR_FRAME_STEP_MS,
  ITEMS_STEP_MS,
  NOTICES,
  SELECTION_LIVE_MESSAGES,
  SELECTION_MOVE_INTERVAL_MS,
  UNDO_TEXT,
  removalReportFor,
} from "../src/rooms/session";
import { TEMPLATES } from "../src/templates/registry";
import { placeTemplate } from "../src/templates/place";
import { fid, frame, nid, note, room } from "./helpers/fakeRelay";

/*
 * Frame multi-select, part 2 (web only): deleting and moving a selection that holds frames.
 * Delete: one paced run (notes in batches, then one frameDelete at a time), one report, one undo.
 * Move: each selected frame carries the notes whose centre is inside it (each note once, to the
 * first frame), plus the loose selected notes; one delta clamped for the whole group; live moves
 * throttled inside the relay's per-socket budget.
 */

/** The relay's per-socket message budget (worker/src/limits.ts SOCKET_LIMITS; worker tests check it). */
const SOCKET_LIMITS = { messagesPerSecond: 30, burst: 40 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const rect = (id: string, x: number, y: number, w = 160, h = 160) => ({ id, x, y, w, h });

describe("carryPlan (pure)", () => {
  const frames = [rect("A", 0, 0, 640, 400), rect("B", 300, 0, 640, 400)];
  it("a note inside two selected frames goes with the first; selected notes a frame carries aren't loose", () => {
    const notes = [rect("n1", 400, 100), rect("n2", 2000, 1000), rect("n3", 10, 10)];
    expect(carryPlan(frames, notes, ["n2", "n3"], true)).toEqual({
      frames: [
        { id: "A", noteIds: ["n1", "n3"] },
        { id: "B", noteIds: [] },
      ],
      loose: ["n2"],
      alone: [],
    });
  });

  it("without carrying (Alt), frames move alone and every selected note is loose", () => {
    const notes = [rect("n1", 400, 100), rect("n3", 10, 10)];
    expect(carryPlan(frames, notes, ["n3"], false)).toEqual({
      frames: [
        { id: "A", noteIds: [] },
        { id: "B", noteIds: [] },
      ],
      loose: ["n3"],
      alone: [],
    });
  });

  it("a frame holding more than the cap moves alone (and says so); its notes stay unless selected", () => {
    const notes = Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, i) => rect(`m${i}`, 10 + i, 10));
    const plan = carryPlan([rect("A", 0, 0, 640, 400)], notes, ["m0"], true);
    expect(plan.frames).toEqual([{ id: "A", noteIds: [] }]);
    expect(plan.alone).toEqual(["A"]);
    expect(plan.loose).toEqual(["m0"]);
  });
});

describe("deleteCounts and confirmDeleteSelection (pure)", () => {
  it("counts selected notes and frames, and unselected notes inside the frames once each", () => {
    const t = room([note(1, { x: 50, y: 50 }), note(2, { x: 400, y: 100 }), note(3, { x: 2000, y: 1000 })], [frame(1), frame(2, { x: 300 })]);
    expect(deleteCounts(t.view().board, [nid(1), nid(3)], [fid(1), fid(2)])).toEqual({ notes: 2, frames: 2, staying: 1 });
  });

  it("asks once, with the counts and what stays", () => {
    const ask = vi.fn(() => true);
    confirmDeleteSelection({ notes: 3, frames: 2, staying: 4 }, ask);
    expect(ask).toHaveBeenLastCalledWith(
      "Delete 3 notes and 2 frames? They’re removed for everyone in the session. 4 notes inside the frames aren’t selected and stay on the board.",
    );
    confirmDeleteSelection({ notes: 0, frames: 2, staying: 1 }, ask);
    expect(ask).toHaveBeenLastCalledWith("Delete 2 frames? They’re removed for everyone in the session. 1 note inside the frames isn’t selected and stays on the board.");
    confirmDeleteSelection({ notes: 1, frames: 1, staying: 0 }, ask);
    expect(ask).toHaveBeenLastCalledWith("Delete 1 note and 1 frame? They’re removed for everyone in the session.");
  });
});

describe("RoomSession.deleteSelection", () => {
  const board = () =>
    room(
      [note(1, { x: 50, y: 50 }), note(2, { x: 2000, y: 1000 }), note(3, { x: 100, y: 100 })],
      [frame(1, { title: "To do" }), frame(2, { x: 800, title: "Doing" }), frame(3, { x: 1600, title: "Done" })],
    );

  it("notes go as one batch of deletes, then one frameDelete each, paced; then one report", async () => {
    const t = board();
    expect(t.session.deleteSelection([nid(1), nid(2)], [fid(1), fid(2)])).toBe(true);
    expect(t.sent("noteBatch")).toEqual([{ type: "noteBatch", ops: [{ op: "delete", id: nid(1) }, { op: "delete", id: nid(2) }], final: true }]);
    expect(t.sent("frameDelete")).toHaveLength(1);
    expect(t.view().deleting).toBe(true);
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * 3);
    expect(t.sent("frameDelete").map((m) => m.id)).toEqual([fid(1), fid(2)]);
    expect([...t.relay.notes.keys()]).toEqual([nid(3)]);
    expect([...t.relay.frames.keys()]).toEqual([fid(3)]);
    expect(t.view().deleting).toBe(false);
    expect(t.view().deleteReport).toEqual({ text: "Deleted 2 notes and 2 frames.", partial: false });
  });

  it("a refused frame delete comes back and the report says so; nothing is retried", async () => {
    const t = board();
    t.relay.refuseFrameDeletes.add(fid(2));
    t.session.deleteSelection([nid(1)], [fid(1), fid(2)]);
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * 3);
    expect(findFrame(t.view().board, fid(2))?.frame.title).toBe("Doing");
    expect(t.sent("frameDelete")).toHaveLength(2);
    expect(t.view().deleteReport?.partial).toBe(true);
    expect(t.view().deleteReport?.text).toBe(
      "Deleted 1 of 1 note and 1 of 2 frames. 1 frame wasn’t deleted because the relay refused it; it’s back on the board. Nothing was retried.",
    );
    expect(t.view().noteNotice).toBeNull();
  });

  it("one undo restores every note and frame it deleted (paced restore)", async () => {
    const t = board();
    t.session.deleteSelection([nid(1), nid(2)], [fid(1), fid(2)]);
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * 3);
    expect(t.view().history.undo).toBeNull();
    t.session.undo();
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 3);
    expect([...t.relay.notes.values()].map((n) => n.text).sort()).toEqual(["Note 1", "Note 2", "Note 3"]);
    expect([...t.relay.frames.values()].map((f) => f.title).sort()).toEqual(["Doing", "Done", "To do"]);
    expect(t.view().historyReport).toEqual({ text: UNDO_TEXT.restored(4), partial: false });
  });

  it("not connected: nothing is deleted, and the report says so", () => {
    const t = board();
    t.relay.drop();
    expect(t.session.deleteSelection([nid(1)], [fid(1)])).toBe(false);
    expect(t.view().deleteReport?.text).toBe("You’re not connected, so nothing was deleted.");
  });

  it("the report text for a delete (as opposed to a clear)", () => {
    expect(removalReportFor("delete", { total: 1, refused: 0, lost: 0, tooQuick: false }, { total: 3, refused: 0, lost: 0, tooQuick: false }).text).toBe("Deleted 1 note and 3 frames.");
    expect(removalReportFor("clear", { total: 1, refused: 0, lost: 0, tooQuick: false }, { total: 0, refused: 0, lost: 0, tooQuick: false }).text).toBe("Cleared the board: deleted 1 note.");
  });
});

describe("RoomSession.startSelectionDrag and moveSelection", () => {
  // F1 (0,0) and F2 (300,0) overlap; note 1's centre (480, 180) is inside both. Note 2 is loose.
  const overlapping = () =>
    room([note(1, { x: 400, y: 100 }), note(2, { x: 2000, y: 1000 }), note(3, { x: 1500, y: 1500 })], [frame(1, { title: "To do" }), frame(2, { x: 300, title: "Doing" })]);

  it("each note moves once: a note in two selected frames goes with the first; loose notes go in a batch", () => {
    const t = overlapping();
    expect(t.session.startSelectionDrag([fid(1), fid(2)], [nid(2)], true)).toBe(true);
    t.session.moveSelection(100, 50, true);
    const moves = t.sent("frameMove").filter((m) => m.final);
    expect(moves).toEqual([
      { type: "frameMove", id: fid(1), x: 100, y: 50, final: true, noteIds: [nid(1)] },
      { type: "frameMove", id: fid(2), x: 400, y: 50, final: true },
    ]);
    expect(t.sent("noteBatch").filter((m) => m.final)).toEqual([{ type: "noteBatch", ops: [{ op: "move", id: nid(2), x: 2100, y: 1050 }], final: true }]);
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 500, y: 150 });
    expect(t.relay.notes.get(nid(3))).toMatchObject({ x: 1500, y: 1500 });
    expect(t.relay.frames.get(fid(2))).toMatchObject({ x: 400, y: 50 });
  });

  it("one delta is clamped for the whole group at the board's edge", () => {
    const t = overlapping();
    t.session.startSelectionDrag([fid(1)], [nid(2)], true);
    // Note 2 (x 2000, w 160) can go at most BOARD_WIDTH - 2160 right; everything moves that much.
    const applied = t.session.moveSelection(5000, 0, true);
    expect(applied).toEqual({ dx: BOARD_WIDTH - 2160, dy: 0 });
    expect(t.relay.frames.get(fid(1))?.x).toBe(BOARD_WIDTH - 2160);
    expect(t.relay.notes.get(nid(2))?.x).toBe(BOARD_WIDTH - 160);
  });

  it("Alt at drag start: the frames move alone; the selected notes still come", () => {
    const t = overlapping();
    t.session.startSelectionDrag([fid(1), fid(2)], [nid(2)], false);
    t.session.moveSelection(10, 10, true);
    expect(t.sent("frameMove").every((m) => m.noteIds === undefined)).toBe(true);
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 400, y: 100 });
    expect(t.relay.notes.get(nid(2))).toMatchObject({ x: 2010, y: 1010 });
  });

  it("a frame holding more than 50 notes moves alone with the existing notice", () => {
    const many: Note[] = Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, i) => note(10 + i, { x: 10 + i * 4, y: 10 }));
    const t = room(many, [frame(1), frame(2, { x: 1000 })]);
    t.session.startSelectionDrag([fid(1), fid(2)], [], true);
    expect(t.view().noteNotice).toBe(NOTICES.frameTooFull);
    t.session.moveSelection(20, 20, true);
    expect(t.sent("frameMove").every((m) => m.noteIds === undefined)).toBe(true);
    expect(t.relay.notes.get(nid(10))?.x).toBe(10);
  });

  it("one undo step puts the whole move back; redo moves it again", () => {
    const t = overlapping();
    t.session.startSelectionDrag([fid(1), fid(2)], [nid(2)], true);
    t.session.moveSelection(100, 50, true);
    expect(t.view().history.undo).toBeNull();
    t.session.undo();
    expect(t.relay.frames.get(fid(1))).toMatchObject({ x: 0, y: 0 });
    expect(t.relay.frames.get(fid(2))).toMatchObject({ x: 300, y: 0 });
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 400, y: 100 });
    expect(t.relay.notes.get(nid(2))).toMatchObject({ x: 2000, y: 1000 });
    t.session.redo();
    expect(t.relay.frames.get(fid(1))).toMatchObject({ x: 100, y: 50 });
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 500, y: 150 });
  });

  it("live moves stay inside the per-socket budget with every frame selected (local preview moves every time)", async () => {
    const frames = Array.from({ length: MAX_FRAMES_PER_ROOM }, (_, i) => frame(i, { x: (i % 6) * 500, y: Math.floor(i / 6) * 380, w: 480, h: 360 }));
    const notes = Array.from({ length: 60 }, (_, i) => note(100 + i, { x: 3000, y: i * 30, w: 96, h: 96 }));
    const t = room(notes, frames, {}, (relay) => {
      // Shrink them so the group can move a little.
      for (const n of relay.notes.values()) relay.notes.set(n.id, { ...n, ...NOTE_DEFAULTS, w: 96, h: 96, x: 3000, y: n.y });
    });
    t.session.startSelectionDrag(
      frames.map((f) => f.id),
      notes.map((n) => n.id),
      true,
    );
    const before = t.relay.received.length;
    // A pointer move every 10 ms for one second.
    for (let i = 1; i <= 100; i++) {
      t.session.moveSelection(-(i % 20), 0, false);
      await vi.advanceTimersByTimeAsync(10);
    }
    const live = t.relay.received.slice(before);
    expect(live.every((m) => m.final === false)).toBe(true);
    // At most SELECTION_LIVE_MESSAGES every SELECTION_MOVE_INTERVAL_MS: 20 a second, under SOCKET_LIMITS' 30.
    expect(SELECTION_LIVE_MESSAGES * (1000 / SELECTION_MOVE_INTERVAL_MS)).toBeLessThan(SOCKET_LIMITS.messagesPerSecond);
    expect(live.length).toBeLessThanOrEqual(SELECTION_LIVE_MESSAGES * (1000 / SELECTION_MOVE_INTERVAL_MS) + SELECTION_LIVE_MESSAGES);
    for (const m of live.filter((x) => x.type === "noteBatch")) expect((m.ops as unknown[]).length).toBeLessThanOrEqual(MAX_BATCH_ENTRIES);
    // Frames take turns, so every frame is relayed live within the second.
    expect(new Set(live.filter((m) => m.type === "frameMove").map((m) => m.id)).size).toBeGreaterThan(1);
    // The drop: one frameMove per frame and the loose notes in chunks, within the burst.
    t.session.moveSelection(-5, 0, true);
    const final = t.relay.received.filter((m) => m.final === true);
    expect(final.filter((m) => m.type === "frameMove")).toHaveLength(MAX_FRAMES_PER_ROOM);
    expect(final.length).toBeLessThanOrEqual(SOCKET_LIMITS.burst);
  });

  it("a guest on a locked board can't start one (nothing sent)", () => {
    const t = room([note(1)], [frame(1)], {}, (relay) => {
      relay.locked = true;
    });
    expect(t.session.startSelectionDrag([fid(1)], [nid(1)], true)).toBe(false);
    expect(t.session.deleteSelection([nid(1)], [fid(1)])).toBe(false);
    expect(t.sent("frameMove")).toEqual([]);
    expect(t.sent("frameDelete")).toEqual([]);
    expect(t.sent("noteBatch")).toEqual([]);
  });
});

describe("a template's four frames plus notes: moved and deleted in one action each", () => {
  it("everything moves with one drag and goes with one delete; one undo brings it back", async () => {
    const template = TEMPLATES.find((tp) => tp.frames.length === 4);
    if (!template) throw new Error("no four-frame template");
    const plans = placeTemplate(template, { x: 100, y: 100 });
    const t = room(
      plans.map((p, i) => note(i + 1, { x: p.x + 40, y: p.y + 80, text: ["To do", "Doing", "Done", "Later"][i]! })),
      plans.map((p, i) => frame(i + 1, { x: p.x, y: p.y, w: p.w, h: p.h, title: p.title })),
    );
    const frameIds = plans.map((_, i) => fid(i + 1));
    const noteIds = plans.map((_, i) => nid(i + 1));
    t.session.startSelectionDrag(frameIds, noteIds, true);
    t.session.moveSelection(200, 100, true);
    expect(t.sent("noteBatch")).toEqual([]);
    expect(t.sent("frameMove").map((m) => (m.noteIds as string[]).length)).toEqual([1, 1, 1, 1]);
    for (const [i, p] of plans.entries()) {
      expect(t.relay.frames.get(fid(i + 1))).toMatchObject({ x: p.x + 200, y: p.y + 100 });
      expect(t.relay.notes.get(nid(i + 1))).toMatchObject({ x: p.x + 240, y: p.y + 180 });
    }
    t.session.deleteSelection(noteIds, frameIds);
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * 5);
    expect(t.relay.notes.size + t.relay.frames.size).toBe(0);
    expect(t.view().deleteReport?.text).toBe("Deleted 4 notes and 4 frames.");
    t.session.undo();
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 3);
    expect(t.relay.notes.size).toBe(4);
    expect(t.relay.frames.size).toBe(4);
  });
});

describe("drag handlers: grabbing any item of a selection with frames drags the selection", () => {
  it("offsets from the grabbed item's start go to moveSelection; Alt at the start means frames alone", () => {
    const calls: string[] = [];
    const drag = createDragHandlers({
      startDrag: () => true,
      moveNote: () => calls.push("note"),
      startFrameDrag: () => {
        calls.push("frame");
        return true;
      },
      selectionDragFor: (id) => (id === "F" || id === "N" ? { x: 100, y: 200, w: 640, h: 400 } : null),
      startSelectionDrag: (carry) => {
        calls.push(`start ${carry}`);
        return true;
      },
      moveSelection: (dx, dy, final) => calls.push(`move ${dx} ${dy} ${final}`),
    });
    drag.onNodeDragStart({ id: "F", type: "frame" }, { altKey: false });
    drag.onNodesChange([{ type: "position", id: "F", dragging: true, position: { x: 130, y: 190 } }]);
    drag.onNodeDragStop({ id: "F", position: { x: 150, y: 250 } });
    drag.onNodeDragStart({ id: "N", type: "note" }, { altKey: true });
    drag.onNodeDragStop({ id: "N", position: { x: 100, y: 200 } });
    // Not part of such a selection: the ordinary frame drag.
    drag.onNodeDragStart({ id: "G", type: "frame" }, { altKey: false });
    expect(calls).toEqual(["start true", "move 30 -10 false", "move 50 50 true", "start false", "move 0 0 true", "frame"]);
  });
});

