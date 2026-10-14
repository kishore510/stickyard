import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findNote } from "../src/notes/board";
import { findShape } from "../src/shapes/board";
import { fid, frame, nid, note, room, shape, sid } from "./helpers/fakeRelay";

/*
 * Hardening (v0.39.1), found by the load harness: when someone else deleted a frame I was dragging,
 * the notes it carried stayed "held" here and no final move was ever sent, so every other page
 * kept showing my last live preview of them, which the relay never stored. Now the carried items
 * are released and their final positions sent, so every page and the relay agree.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const deleteFrame = (t: ReturnType<typeof room>, id: string) => {
  t.relay.frames.delete(id);
  t.relay.emit({ type: "frameDeleted", id });
};

describe("a frame deleted by someone else while I drag it", () => {
  it("releases the notes and shapes it carried and sends their final positions", () => {
    const t = room([note(1, { x: 150, y: 150 })], [frame(1, { x: 100, y: 100 })], {}, undefined, [shape(1, { x: 200, y: 200 })]);
    expect(t.session.startFrameDrag(fid(1), true)).toBe(true);
    t.session.moveFrame(fid(1), 300, 200, false);
    expect(t.shown(nid(1))).toMatchObject({ x: 350, y: 250 });
    deleteFrame(t, fid(1));
    expect(findNote(t.view().board, nid(1))?.dragging).toBe(false);
    expect(findShape(t.view().board, sid(1))?.dragging).toBe(false);
    expect(t.sent("noteBatch").filter((m) => m.final)).toEqual([{ type: "noteBatch", ops: [{ op: "move", id: nid(1), x: 350, y: 250 }], final: true }]);
    expect(t.sent("shapeBatch").filter((m) => m.final)).toEqual([{ type: "shapeBatch", ops: [{ op: "move", id: sid(1), x: 400, y: 300 }], final: true }]);
    // The relay stored them, and the page shows what it confirmed.
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 350, y: 250 });
    expect(findNote(t.view().board, nid(1))?.note).toEqual(findNote(t.view().board, nid(1))?.confirmed);
    // The canvas's own drop for the gone frame sends nothing more.
    const before = t.relay.received.length;
    t.session.moveFrame(fid(1), 320, 220, true);
    vi.advanceTimersByTime(500);
    expect(t.relay.received.length).toBe(before);
  });

  it("in a selection drag, the gone frame's notes are sent with the loose ones on the drop", () => {
    const t = room([note(1, { x: 150, y: 150 }), note(2, { x: 2000, y: 1000 })], [frame(1, { x: 100, y: 100 })]);
    expect(t.session.startSelectionDrag([fid(1)], [nid(2)], true)).toBe(true);
    t.session.moveSelection(100, 50, false);
    deleteFrame(t, fid(1));
    t.session.moveSelection(100, 50, true);
    const ops = t.sent("noteBatch").filter((m) => m.final).flatMap((m) => m.ops as { id: string }[]);
    expect(ops.map((o) => o.id).sort()).toEqual([nid(1), nid(2)].sort());
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 250, y: 200 });
    expect(findNote(t.view().board, nid(1))?.note).toEqual(findNote(t.view().board, nid(1))?.confirmed);
  });
});
