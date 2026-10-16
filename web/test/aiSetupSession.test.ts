// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_NOTES_PER_ROOM } from "@stickyard/shared";
import { parseSetupReply } from "../src/ai/setupParse";
import { SETUP_TEXT, setupFree, setupFullReason, setupReason } from "../src/ai/setupRules";
import { LOCK_TEXT } from "../src/facilitation/lock";
import { SILENT_TEXT } from "../src/silent/silent";
import { NOTE_TOOL_REASONS } from "../src/canvas/tools";
import { UNDO_TEXT } from "../src/rooms/session";
import type { ImportContent } from "../src/importer/parse";
import { nid, note, room } from "./helpers/fakeRelay";
import { RETRO_REPLY } from "./helpers/aiSetupFake";

/*
 * Board setup from a prompt (10b, v0.43.0): Add to board goes through the stencil and Import path
 * (frames first, then notes, paced itemsAdd), placed with its top-left at the chosen spot, as ONE
 * undo step. Generated frames carry their notes (frame membership, v0.41.0); a generated frame
 * dropped onto loose notes elsewhere doesn't take them. Refused up front with nothing sent.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type Room = ReturnType<typeof room>;
const ROOMY = { notes: 200, frames: 30 };
const generated = (reply: unknown = RETRO_REPLY): ImportContent => {
  const r = parseSetupReply(JSON.stringify(reply), ROOMY);
  if (!r.ok) throw new Error("unreadable");
  return r.result.content;
};
const adds = (t: Room) => t.relay.received.filter((m) => m.type === "itemsAdd");
const frameByTitle = (t: Room, title: string) => [...t.relay.frames.values()].find((f) => f.title === title)!;
const noteByText = (t: Room, text: string) => [...t.relay.notes.values()].find((n) => n.text === text)!;
const lastCarry = (t: Room) => t.sent("frameMove").filter((m) => m.final).at(-1);
function dragFrame(t: Room, id: string, x: number, y: number) {
  expect(t.session.startFrameDrag(id, true)).toBe(true);
  t.session.moveFrame(id, x, y, true);
}

describe("Add to board", () => {
  it("adds the frames and notes with the top-left at the chosen spot, frames first", () => {
    const t = room();
    t.relay.received.length = 0;
    const placed = t.session.placeSetup(generated(), { x: 1000, y: 600 });
    expect(placed).not.toBeNull();
    expect(placed!.frames).toHaveLength(3);
    expect(placed!.notes).toHaveLength(6);
    vi.advanceTimersByTime(4000);
    expect(t.relay.frames.size).toBe(3);
    expect(t.relay.notes.size).toBe(6);
    expect(frameByTitle(t, "Went well")).toMatchObject({ x: 1000, y: 600, color: "green" });
    expect(noteByText(t, "Shipped on time")).toMatchObject({ x: 1024, y: 672, color: "green" });
    const first = adds(t)[0]!;
    expect((first.frames as unknown[]).length).toBe(3);
  });

  it("is one undo step that removes everything it added (and only that)", () => {
    const t = room([note(1, { x: 5000, y: 3000 })]);
    t.session.placeSetup(generated(), { x: 1000, y: 600 });
    vi.advanceTimersByTime(4000);
    expect(t.relay.notes.size).toBe(7);
    t.session.undo();
    vi.advanceTimersByTime(4000);
    expect([...t.relay.notes.keys()]).toEqual([nid(1)]);
    expect(t.relay.frames.size).toBe(0);
  });

  it("a generated frame carries its notes when dragged", () => {
    const t = room();
    t.session.placeSetup(generated(), { x: 1000, y: 600 });
    vi.advanceTimersByTime(4000);
    const f = frameByTitle(t, "To improve");
    dragFrame(t, f.id, f.x + 500, f.y + 1500);
    const ids = [noteByText(t, "Fewer meetings").id, noteByText(t, "Clearer tickets").id].sort();
    expect([...(lastCarry(t)?.noteIds ?? [])].sort()).toEqual(ids);
    expect(noteByText(t, "Fewer meetings")).toMatchObject({ x: 1744 + 500, y: 672 + 1500 });
  });

  it("with 60 items over more than one itemsAdd, frames still carry the notes sent later", () => {
    const notes = Array.from({ length: 52 }, (_, i) => ({ text: `Idea ${i} ${"word ".repeat(20)}`.slice(0, 140), color: "yellow", frame: i < 26 ? "a" : "b", x: null, y: null }));
    const t = room();
    t.session.placeSetup(generated({ frames: [{ ref: "a", title: "A", color: "neutral", x: null, y: null, w: 640, h: 400 }, { ref: "b", title: "B", color: "neutral", x: null, y: null, w: 640, h: 400 }], notes }), { x: 100, y: 100 });
    vi.advanceTimersByTime(20_000);
    expect(adds(t).length).toBeGreaterThan(1);
    expect(t.relay.notes.size).toBe(52);
    const b = frameByTitle(t, "B");
    dragFrame(t, b.id, b.x, b.y + 1700);
    expect(lastCarry(t)?.noteIds).toHaveLength(26);
  });

  it("a generated frame dropped onto loose notes elsewhere doesn't take them", () => {
    const t = room([note(1, { x: 4000, y: 2600, placed: 1 }), note(2, { x: 4200, y: 2600, placed: 1 })]);
    t.session.placeSetup(generated(), { x: 1000, y: 600 });
    vi.advanceTimersByTime(4000);
    const f = frameByTitle(t, "Went well");
    // Over the loose notes, then away again.
    dragFrame(t, f.id, 3900, 2500);
    expect([...(lastCarry(t)?.noteIds ?? [])]).not.toContain(nid(1));
    dragFrame(t, f.id, 200, 200);
    const carried = lastCarry(t)?.noteIds ?? [];
    expect(carried).not.toContain(nid(1));
    expect(carried).not.toContain(nid(2));
    expect(carried).toHaveLength(2);
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 4000, y: 2600 });
    expect(t.relay.notes.get(nid(2))).toMatchObject({ x: 4200, y: 2600 });
  });
});

describe("refused up front, nothing sent", () => {
  it("when the room can't fit it", () => {
    const t = room(Array.from({ length: MAX_NOTES_PER_ROOM - 2 }, (_, i) => note(i + 1, { x: (i % 20) * 300, y: Math.floor(i / 20) * 300 })));
    t.relay.received.length = 0;
    expect(t.session.placeSetup(generated(), { x: 100, y: 100 })).toBeNull();
    expect(t.view().noteNotice).toBe(SETUP_TEXT.noRoom([["notes", 6, 2]]));
    expect(adds(t)).toEqual([]);
  });

  it("for a guest on a locked board, and for everyone in a silent round", () => {
    const t = room([], [], {}, (r) => (r.locked = true));
    t.relay.received.length = 0;
    expect(t.session.placeSetup(generated(), { x: 100, y: 100 })).toBeNull();
    expect(t.view().noteNotice).toBe(LOCK_TEXT.reason);
    const s = room();
    s.relay.emit({ type: "silentChanged", active: true, count: 0 });
    s.relay.received.length = 0;
    expect(s.session.placeSetup(generated(), { x: 100, y: 100 })).toBeNull();
    expect(s.view().noteNotice).toBe(SILENT_TEXT.on);
    for (const r of [t, s]) expect(adds(r)).toEqual([]);
  });

  it("a lock that arrives while waiting is checked again at Add to board", () => {
    const t = room();
    t.relay.emit({ type: "lockChanged", locked: true });
    t.relay.received.length = 0;
    expect(t.session.placeSetup(generated(), { x: 100, y: 100 })).toBeNull();
    expect(adds(t)).toEqual([]);
  });
});

describe("who can use it, and when", () => {
  it("the reasons: not connected, a guest on a locked board, a silent round, busy", () => {
    expect(setupReason({ live: false, lockedOut: false, silent: false, busy: false })).toBe(NOTE_TOOL_REASONS.disconnected);
    expect(setupReason({ live: true, lockedOut: true, silent: false, busy: false })).toBe(LOCK_TEXT.reason);
    expect(setupReason({ live: true, lockedOut: false, silent: true, busy: false })).toBe(SILENT_TEXT.on);
    expect(setupReason({ live: true, lockedOut: false, silent: false, busy: true })).toBe(UNDO_TEXT.busy);
    expect(setupReason({ live: true, lockedOut: false, silent: false, busy: false })).toBeNull();
  });

  it("the room's free capacity, and a full board said up front", () => {
    expect(setupFree({ notes: 150, frames: 28, shapes: 0, arrows: 0, groups: 0 })).toEqual({ notes: 50, frames: 2 });
    expect(setupFullReason({ notes: 0, frames: 4 })).toBe(SETUP_TEXT.full);
    expect(setupFullReason({ notes: 3, frames: 0 })).toBeNull();
    expect(SETUP_TEXT.room({ notes: 3, frames: 0 })).toBe("This board has room for 3 more notes and no more frames. Anything beyond that is left out.");
    expect(SETUP_TEXT.room({ notes: 200, frames: 30 })).toBeNull();
  });
});
