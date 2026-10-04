// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_DEFAULTS, MAX_BATCH_ENTRIES, MAX_FRAMES_PER_ROOM, MAX_NOTES_PER_ROOM } from "@stickyard/shared";
import { CLEAR_HINTS, clearBoardReason, confirmClearBoard } from "../src/properties/clearBoard";
import { CLEAR_FRAME_STEP_MS, ITEMS_STEP_MS, UNDO_TEXT } from "../src/rooms/session";
import { alex, fid, frame, nid, note, room } from "./helpers/fakeRelay";

/*
 * Clear board (part 3, web only): notes as batch deletes, then frames one frameDelete each,
 * paced; one outcome report; one history step that a single undo restores.
 */

const fullBoard = () =>
  room(
    Array.from({ length: MAX_NOTES_PER_ROOM }, (_, i) => note(i, { x: (i % 16) * 190, y: Math.floor(i / 16) * 150, text: `N${i}`, z: i, color: i % 2 ? "pink" : "yellow" })),
    Array.from({ length: MAX_FRAMES_PER_ROOM }, (_, i) => frame(i, { title: `Frame ${i}`, titleAlign: "center" })),
  );

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("confirmClearBoard and clearBoardReason (pure)", () => {
  it("asks once, with the counts and that it can be undone", () => {
    const ask = vi.fn(() => true);
    expect(confirmClearBoard(120, 4, ask)).toBe(true);
    expect(ask).toHaveBeenCalledWith("Delete 120 notes and 4 frames for everyone in this session? You can undo this until you leave or reconnect.");
    confirmClearBoard(1, 0, ask);
    expect(ask).toHaveBeenLastCalledWith("Delete 1 note for everyone in this session? You can undo this until you leave or reconnect.");
    confirmClearBoard(0, 1, ask);
    expect(ask).toHaveBeenLastCalledWith("Delete 1 frame for everyone in this session? You can undo this until you leave or reconnect.");
  });

  it.each([
    [{ live: false, notes: 3, frames: 0, busy: false, clearing: false }, CLEAR_HINTS.offline],
    [{ live: true, notes: 0, frames: 0, busy: false, clearing: false }, CLEAR_HINTS.empty],
    [{ live: true, notes: 3, frames: 0, busy: true, clearing: false }, CLEAR_HINTS.busy],
    [{ live: true, notes: 3, frames: 0, busy: false, clearing: true }, CLEAR_HINTS.clearing],
    [{ live: true, notes: 0, frames: 2, busy: false, clearing: false }, null],
  ])("%o -> %s", (state, reason) => {
    expect(clearBoardReason(state)).toBe(reason);
  });
});

describe("RoomSession.clearBoard", () => {
  it("200 notes + 30 frames: four batches of 50 deletes first, then one frameDelete each, paced; then one report", async () => {
    const t = fullBoard();
    expect(t.session.clearBoard()).toBe(true);
    const batches = t.sent("noteBatch");
    expect(batches.map((b) => (b.ops as unknown[]).length)).toEqual([50, 50, 50, 50]);
    expect(batches.every((b) => b.final === true && (b.ops as { op: string }[]).every((o) => o.op === "delete"))).toBe(true);
    // Frames go after the notes, a few at a time, never more than SOCKET_LIMITS allows.
    const firstFrame = t.relay.received.findIndex((m) => m.type === "frameDelete");
    expect(firstFrame).toBeGreaterThan(t.relay.received.indexOf(batches[3]!));
    expect(t.sent("frameDelete").length).toBeLessThan(MAX_FRAMES_PER_ROOM);
    expect(t.view().clearing).toBe(true);
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * MAX_FRAMES_PER_ROOM);
    expect(t.sent("frameDelete")).toHaveLength(MAX_FRAMES_PER_ROOM);
    // At most 30 messages in any second (SOCKET_LIMITS: 30 a second, burst 40).
    expect(1000 / CLEAR_FRAME_STEP_MS + 4).toBeLessThanOrEqual(30);
    expect(t.relay.notes.size + t.relay.frames.size).toBe(0);
    expect(t.view().board.notes).toEqual([]);
    expect(t.view().board.frames).toEqual([]);
    expect(t.view().clearing).toBe(false);
    expect(t.view().deleteReport).toEqual({ text: "Cleared the board: deleted 200 notes and 30 frames.", partial: false });
  });

  it("one undo restores everything (paced, with a status): counts, content and stacking order; redo clears again", async () => {
    const t = fullBoard();
    const before = [...t.relay.notes.values()].sort((a, b) => a.z - b.z).map((n) => [n.text, n.color, n.x, n.y]);
    const framesBefore = [...t.relay.frames.values()].map((f) => [f.title, f.titleAlign]);
    t.session.clearBoard();
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * MAX_FRAMES_PER_ROOM);
    expect(t.view().history.undo).toBeNull();
    t.session.undo();
    expect(t.view().historyReport?.text).toMatch(/^Restoring \d+ of 230…$/);
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 300);
    expect(t.relay.notes.size).toBe(200);
    expect(t.relay.frames.size).toBe(30);
    expect(t.view().historyReport).toEqual({ text: UNDO_TEXT.restored(230), partial: false });
    expect([...t.relay.notes.values()].sort((a, b) => a.z - b.z).map((n) => [n.text, n.color, n.x, n.y])).toEqual(before);
    expect([...t.relay.frames.values()].map((f) => [f.title, f.titleAlign])).toEqual(framesBefore);
    expect([...t.relay.notes.values()].every((n) => n.authorId === alex.id)).toBe(true);
    t.session.redo();
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * MAX_FRAMES_PER_ROOM);
    expect(t.relay.notes.size + t.relay.frames.size).toBe(0);
  });

  it("an empty board: nothing is sent", () => {
    const t = room();
    expect(t.session.clearBoard()).toBe(false);
    expect(t.relay.received.filter((m) => m.type === "noteBatch" || m.type === "frameDelete")).toEqual([]);
  });

  it("a refused chunk: those notes come back, the report says how many and why, and undo restores only what went", async () => {
    const t = fullBoard();
    t.relay.refuseBatches.add(1);
    t.session.clearBoard();
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * MAX_FRAMES_PER_ROOM);
    expect(t.view().board.notes).toHaveLength(MAX_BATCH_ENTRIES);
    expect(t.view().deleteReport).toEqual({
      text: "Deleted 150 of 200 notes and 30 of 30 frames. 50 notes weren’t deleted because that was too quick; they’re back on the board. Nothing was retried.",
      partial: true,
    });
    t.session.undo();
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 300);
    expect(t.relay.notes.size).toBe(200);
    expect(t.relay.frames.size).toBe(30);
    expect(t.view().historyReport?.text).toBe(UNDO_TEXT.restored(180));
  });

  it("a refused frame delete: that frame stays and the report says so", async () => {
    const t = room([note(1)], [frame(1), frame(2)]);
    t.relay.refuseFrameDeletes.add(fid(2));
    t.session.clearBoard();
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * 5);
    expect(t.view().board.frames.map((f) => f.frame.id)).toEqual([fid(2)]);
    expect(t.view().deleteReport).toEqual({
      text: "Deleted 1 of 1 note and 1 of 2 frames. 1 frame wasn’t deleted because the relay refused it; it’s back on the board. Nothing was retried.",
      partial: true,
    });
    expect(t.view().noteNotice).toBeNull();
  });

  it("a disconnect part-way: frames not sent yet stay, the report says what may not have gone, and the history is cleared", async () => {
    const t = room([note(1), note(2)], Array.from({ length: 10 }, (_, i) => frame(i)));
    t.session.clearBoard();
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * 2);
    const sent = t.sent("frameDelete").length;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(10);
    t.relay.handlers!.onClose();
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * 20);
    expect(t.sent("frameDelete")).toHaveLength(sent);
    expect(t.view().board.frames).toHaveLength(10 - sent);
    expect(t.view().deleteReport).toEqual({
      text: `Deleted 2 of 2 notes and ${sent} of 10 frames. The connection was lost before ${10 - sent} frames were deleted, so they may still be on the board.`,
      partial: true,
    });
    expect(t.view().history.undo).toBe(UNDO_TEXT.offline);
    expect(t.view().clearing).toBe(false);
  });

  it("refused while a template (or any add run) is being sent, and a second clear while one runs", async () => {
    const t = room([note(1)], [frame(1), frame(2)]);
    t.relay.paused = true;
    t.session.applyTemplate([{ x: 0, y: 500, w: 640, h: 400, title: "T", color: "green", style: FRAME_DEFAULTS }]);
    expect(t.session.clearBoard()).toBe(false);
    t.relay.resume();
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS);
    expect(t.session.clearBoard()).toBe(true);
    expect(t.session.clearBoard()).toBe(false);
  });

  it("unconfirmed notes are deleted once confirmed, and counted", () => {
    const t = room([note(1)]);
    t.relay.paused = true;
    t.session.addNote({ x: 0, y: 0, color: "pink" });
    t.session.clearBoard();
    expect(t.view().board.notes).toEqual([]);
    t.relay.resume();
    expect(t.relay.notes.size).toBe(0);
    expect(t.view().deleteReport).toEqual({ text: "Cleared the board: deleted 2 notes.", partial: false });
  });

  it("clear then undo records one step only: a second undo goes to what came before", async () => {
    const t = room([note(1)], [frame(1)]);
    t.session.moveNote(nid(1), 500, 20, true);
    t.session.clearBoard();
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * 3);
    t.session.undo();
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 3);
    expect(t.relay.notes.size).toBe(1);
    expect(t.relay.frames.size).toBe(1);
    t.session.undo();
    expect([...t.relay.notes.values()][0]).toMatchObject({ x: 10 });
  });
});
