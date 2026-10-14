// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CONNECTORS_PER_ROOM, MAX_FRAMES_PER_ROOM, MAX_GROUPS_PER_ROOM, NOTE_DEFAULTS } from "@stickyard/shared";
import { BUILTIN_STENCILS } from "../src/stencils/builtins";
import { stencilCounts, type Stencil } from "../src/stencils/data";
import { STENCIL_TEXT } from "../src/stencils/rules";
import { LOCK_TEXT } from "../src/facilitation/lock";
import { SILENT_TEXT } from "../src/silent/silent";
import { connector, frame, group, nid, note, room } from "./helpers/fakeRelay";

/*
 * Stencils part 3: placing a stencil goes through the normal paced add path (items first, then
 * arrows and groups with the returned ids), is one history step, and is refused up front with the
 * reason when a room cap wouldn't fit, on a locked board (guests) and during a silent round.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const byId = (id: string) => BUILTIN_STENCILS.find((s) => s.id === id)!;
const totals = (t: ReturnType<typeof room>) => ({
  notes: t.relay.notes.size,
  shapes: t.relay.shapes.size,
  frames: t.relay.frames.size,
  arrows: t.relay.connectors.size,
  groups: t.relay.groups.size,
});

describe("placing a stencil", () => {
  it.each(BUILTIN_STENCILS.map((s) => [s.id, s] as const))("built-in %s: the right counts, items first, then arrows and groups on the new ids", (_, stencil) => {
    const t = room();
    t.relay.received.length = 0;
    expect(t.session.placeStencil(stencil, { x: 3000, y: 2000 })).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(totals(t)).toEqual(stencilCounts(stencil));
    const kinds = t.relay.received.map((m) => m.type);
    const firstAfter = Math.min(...["connectorAdd", "groupCreate"].map((k) => kinds.indexOf(k)).filter((i) => i >= 0), Infinity);
    if (firstAfter !== Infinity) expect(kinds.lastIndexOf("itemsAdd")).toBeLessThan(firstAfter);
    const items = new Set([...t.relay.notes.keys(), ...t.relay.shapes.keys()]);
    for (const c of t.relay.connectors.values()) for (const end of [c.start, c.end]) if ("item" in end) expect(items.has(end.item)).toBe(true);
    for (const g of t.relay.groups.values()) expect(g.members.every((m) => items.has(m))).toBe(true);
  });

  it("goes at the given centre, clamped onto the board, keeping its arrangement", () => {
    const t = room();
    const stencil = byId("note-cluster");
    t.session.placeStencil(stencil, { x: 6390, y: 3990 });
    vi.advanceTimersByTime(2000);
    const notes = [...t.relay.notes.values()];
    expect(notes.every((n) => n.x + n.w <= 6400 && n.y + n.h <= 4000)).toBe(true);
    const xs = notes.map((n) => n.x).sort((a, b) => a - b);
    const want = stencil.notes.map((n) => n.x).sort((a, b) => a - b);
    expect(xs.map((x) => x - xs[0]!)).toEqual(want.map((x) => x - want[0]!));
  });

  it("one undo removes everything a stencil added", () => {
    const t = room();
    const mixed = BUILTIN_STENCILS.find((s) => { const c = stencilCounts(s); return c.arrows > 0 && c.groups + c.frames > 0; }) ?? byId("flow");
    t.session.placeStencil(mixed, { x: 2000, y: 1500 });
    vi.advanceTimersByTime(3000);
    expect(Object.values(totals(t)).some((n) => n > 0)).toBe(true);
    t.session.undo();
    vi.advanceTimersByTime(3000);
    expect(totals(t)).toEqual({ notes: 0, shapes: 0, frames: 0, arrows: 0, groups: 0 });
  });

  it("text and names stay text: a hostile saved stencil places plain strings through the normal add messages", () => {
    const HOSTILE = "<img src=x onerror=alert(1)>";
    const s: Stencil = { id: "evil", name: HOSTILE, notes: [{ ref: "n1", x: 0, y: 0, w: 160, h: 160, text: HOSTILE, ...NOTE_DEFAULTS, color: "pink" }], shapes: [], frames: [], arrows: [], groups: [] };
    const t = room();
    t.session.placeStencil(s, { x: 500, y: 500 });
    vi.advanceTimersByTime(1000);
    expect([...t.relay.notes.values()][0]?.text).toBe(HOSTILE);
    expect(t.relay.received.filter((m) => m.type === "itemsAdd")).toHaveLength(1);
  });
});

describe("refused up front, with the reason, nothing sent", () => {
  const sentAdds = (t: ReturnType<typeof room>) => t.relay.received.filter((m) => m.type === "itemsAdd" || m.type === "connectorAdd" || m.type === "groupCreate");

  it("frames past the cap", () => {
    const t = room([], Array.from({ length: MAX_FRAMES_PER_ROOM }, (_, i) => frame(i + 1, { x: (i % 9) * 700, y: Math.floor(i / 9) * 450 })));
    expect(t.session.placeStencil(byId("labelled-area"), { x: 100, y: 100 })).toBe(false);
    expect(t.view().noteNotice).toBe(STENCIL_TEXT.noRoom("frames", 1, 0));
    expect(sentAdds(t)).toEqual([]);
  });

  it("arrows past 100 and groups past 30", () => {
    const ns = Array.from({ length: 62 }, (_, i) => note(i + 1, { x: 100 + (i % 20) * 250, y: 100 + Math.floor(i / 20) * 300 }));
    const arrows = Array.from({ length: MAX_CONNECTORS_PER_ROOM }, (_, i) => connector(i + 1, { x: 10, y: 10 + i }, { x: 90, y: 10 + i }));
    const t = room(ns, [], {}, undefined, [], arrows);
    expect(t.session.placeStencil(byId("flow"), { x: 3000, y: 3000 })).toBe(false);
    expect(t.view().noteNotice).toBe(STENCIL_TEXT.noRoom("arrows", 2, 0));
    const groups = Array.from({ length: MAX_GROUPS_PER_ROOM }, (_, i) => group(i + 1, [nid(2 * i + 1), nid(2 * i + 2)]));
    const g = room(ns, [], {}, undefined, [], [], groups);
    expect(g.session.placeStencil(byId("note-cluster"), { x: 3000, y: 3000 })).toBe(false);
    expect(g.view().noteNotice).toBe(STENCIL_TEXT.noRoom("groups", 1, 0));
    expect(sentAdds(t)).toEqual([]);
    expect(sentAdds(g)).toEqual([]);
  });

  it("a guest on a locked board, and everyone during a silent round", () => {
    const t = room([], [], {}, (r) => (r.locked = true));
    expect(t.session.placeStencil(byId("note-cluster"), { x: 500, y: 500 })).toBe(false);
    expect(t.view().noteNotice).toBe(LOCK_TEXT.reason);
    const s = room();
    s.relay.emit({ type: "silentChanged", active: true, count: 0 });
    expect(s.session.placeStencil(byId("note-cluster"), { x: 500, y: 500 })).toBe(false);
    expect(s.view().noteNotice).toBe(SILENT_TEXT.on);
    expect(sentAdds(t)).toEqual([]);
    expect(sentAdds(s)).toEqual([]);
  });
});
