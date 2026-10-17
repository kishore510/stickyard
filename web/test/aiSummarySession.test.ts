// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_NOTES_PER_ROOM } from "@stickyard/shared";
import { parseSummaryReply } from "../src/ai/summaryParse";
import { SUMMARY_TEXT, summaryContent } from "../src/ai/summaryRules";
import { summaryScope } from "../src/ai/summaryScope";
import { LOCK_TEXT } from "../src/facilitation/lock";
import { SILENT_TEXT } from "../src/silent/silent";
import type { ImportContent } from "../src/importer/parse";
import { frame, nid, note, room } from "./helpers/fakeRelay";
import { RETRO_SUMMARY } from "./helpers/aiSummaryFake";

/*
 * Summary and sentiment (10c, v0.44.0): Add to board goes through the same paced add path as Import
 * and board setup: the frame first, then its notes, as ONE undo step. Refused up front with
 * nothing sent: a guest on a locked board, a silent round, no room.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type Room = ReturnType<typeof room>;
const RETRO_NOTES = [
  note(1, { text: "Shipped on time", x: 80, y: 480, placed: 2 }),
  note(2, { text: "Good pairing", x: 260, y: 480, placed: 2 }),
  note(3, { text: "Too many meetings", x: 780, y: 480, placed: 2 }),
  note(4, { text: "Unclear tickets", x: 960, y: 480, placed: 2 }),
  note(5, { text: "Parking lot: tooling", x: 40, y: 60, placed: 2 }),
];
const RETRO_FRAMES = [frame(1, { title: "Went well", x: 40, y: 400, placed: 1 }), frame(2, { title: "To improve", x: 740, y: 400, placed: 1 })];

function contentFor(t: Room): ImportContent {
  const scope = summaryScope(t.view().board, {});
  const parsed = parseSummaryReply(JSON.stringify(RETRO_SUMMARY), scope);
  if (!parsed.ok) throw new Error("unreadable");
  return summaryContent(parsed.result, scope, "purple");
}
const adds = (t: Room) => t.relay.received.filter((m) => m.type === "itemsAdd");
const summaryFrame = (t: Room) => [...t.relay.frames.values()].find((f) => f.title === "AI summary (draft)");
const summaryNotes = (t: Room) => [...t.relay.notes.values()].filter((n) => n.color === "purple");

describe("Add to board", () => {
  it("adds the frame first, then its notes, at the chosen spot", () => {
    const t = room(RETRO_NOTES, RETRO_FRAMES);
    t.relay.received.length = 0;
    const placed = t.session.placeSummary(contentFor(t), { x: 2000, y: 1200 });
    expect(placed).not.toBeNull();
    expect(placed!.frames).toHaveLength(1);
    expect(placed!.notes).toHaveLength(6);
    vi.advanceTimersByTime(4000);
    const first = adds(t)[0]!;
    expect((first.frames as unknown[]).length).toBe(1);
    expect(summaryFrame(t)).toMatchObject({ x: 2000, y: 1200 });
    expect(summaryNotes(t)).toHaveLength(6);
  });

  it("is one undo step that removes all of it (and nothing else)", () => {
    const t = room(RETRO_NOTES, RETRO_FRAMES);
    t.session.placeSummary(contentFor(t), { x: 2000, y: 1200 });
    vi.advanceTimersByTime(4000);
    expect(t.relay.notes.size).toBe(11);
    t.session.undo();
    vi.advanceTimersByTime(4000);
    expect([...t.relay.notes.keys()].sort()).toEqual(RETRO_NOTES.map((n) => n.id).sort());
    expect(summaryFrame(t)).toBeUndefined();
    expect(t.relay.frames.size).toBe(2);
  });

  it("the frame carries its notes when dragged", () => {
    const t = room(RETRO_NOTES, RETRO_FRAMES);
    t.session.placeSummary(contentFor(t), { x: 2000, y: 1200 });
    vi.advanceTimersByTime(4000);
    const f = summaryFrame(t)!;
    expect(t.session.startFrameDrag(f.id, true)).toBe(true);
    t.session.moveFrame(f.id, f.x + 300, f.y + 300, true);
    const carry = t.sent("frameMove").filter((m) => m.final).at(-1);
    expect([...((carry?.noteIds ?? []) as string[])].sort()).toEqual(summaryNotes(t).map((n) => n.id).sort());
    expect((carry?.noteIds as string[]).some((id) => RETRO_NOTES.some((n) => n.id === id))).toBe(false);
  });

  it("refused up front with nothing sent when the board has no room", () => {
    const full = Array.from({ length: MAX_NOTES_PER_ROOM - 6 }, (_, i) => note(i + 1, { x: (i % 20) * 200, y: 3000 + Math.floor(i / 20) * 200 }));
    const t = room([...full, ...RETRO_NOTES.map((n, i) => ({ ...n, id: nid(500 + i) })).slice(0, 3)], RETRO_FRAMES);
    t.relay.received.length = 0;
    const content = contentFor(t);
    expect(t.session.placeSummary(content, { x: 2000, y: 1200 })).toBeNull();
    expect(adds(t)).toEqual([]);
    expect(t.view().noteNotice).toBe(SUMMARY_TEXT.noRoom([["notes", content.notes.length, 3]]));
  });

  it("refused for a guest on a locked board and during a silent round", () => {
    const locked = room(RETRO_NOTES, RETRO_FRAMES, {}, (r) => (r.locked = true));
    locked.relay.received.length = 0;
    expect(locked.session.placeSummary(contentFor(locked), { x: 2000, y: 1200 })).toBeNull();
    expect(locked.view().noteNotice).toBe(LOCK_TEXT.reason);
    const silent = room(RETRO_NOTES, RETRO_FRAMES);
    const content = contentFor(silent);
    silent.relay.emit({ type: "silentChanged", active: true, count: 0 });
    silent.relay.received.length = 0;
    expect(silent.session.placeSummary(content, { x: 2000, y: 1200 })).toBeNull();
    expect(silent.view().noteNotice).toBe(SILENT_TEXT.on);
    expect(adds(silent)).toEqual([]);
  });
});
