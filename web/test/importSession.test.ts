// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FRAMES_PER_ROOM, MAX_NOTES_PER_ROOM, stackOrder } from "@stickyard/shared";
import { boardFileText, buildBoardFile, type BoardFile } from "../src/export/boardFile";
import { IMPORT_TEXT, parseBoardFile, parseTextImport, type ImportContent } from "../src/importer/parse";
import { importReason } from "../src/importer/rules";
import { LOCK_TEXT } from "../src/facilitation/lock";
import { SILENT_TEXT } from "../src/silent/silent";
import { NOTE_TOOL_REASONS } from "../src/canvas/tools";
import { UNDO_TEXT } from "../src/rooms/session";
import { connector, frame, group, nid, note, room, shape, sid } from "./helpers/fakeRelay";

/*
 * Import (v0.40.0, part 2): add-only, placed at the view centre through the stencil path
 * (itemsAdd packed by size and paced, then arrows and groups by ref), one undoable step. Refused
 * up front with nothing sent when it doesn't all fit, on a locked board (guests), during a silent
 * round, while disconnected or busy. Round trip: export, clear, import gives the same board.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const content = (text: string): ImportContent => {
  const r = parseTextImport(text);
  if (!r.ok) throw new Error(r.reason);
  return r.content;
};
const fromFile = (file: BoardFile): ImportContent => {
  const r = parseBoardFile(boardFileText(file));
  if (!r.ok) throw new Error(r.reason);
  return r.content;
};
const sentAdds = (t: ReturnType<typeof room>) => t.relay.received.filter((m) => m.type === "itemsAdd" || m.type === "connectorAdd" || m.type === "groupCreate");

/** A file's comparable form: group members in a fixed order (their order follows ids, which change). */
const normal = (file: BoardFile | null) => file && { ...file, groups: file.groups.map((g) => ({ ...g, members: [...g.members].sort() })) };

describe("importing", () => {
  it("adds text lines as notes at the given centre, in order, one itemsAdd", () => {
    const t = room();
    t.relay.received.length = 0;
    expect(t.session.importBoard(content("One\nTwo\nThree"), { x: 3200, y: 2000 })).toBe(true);
    vi.advanceTimersByTime(2000);
    const notes = stackOrder([...t.relay.notes.values()]);
    expect(notes.map((n) => n.text)).toEqual(["One", "Two", "Three"]);
    const xs = notes.map((n) => n.x);
    const ys = notes.map((n) => n.y);
    const cx = (Math.min(...xs) + Math.max(...notes.map((n) => n.x + n.w))) / 2;
    const cy = (Math.min(...ys) + Math.max(...notes.map((n) => n.y + n.h))) / 2;
    expect(Math.abs(cx - 3200)).toBeLessThanOrEqual(1);
    expect(Math.abs(cy - 2000)).toBeLessThanOrEqual(1);
    expect(t.sent("itemsAdd")).toHaveLength(1);
  });

  it("is add-only: what is already on the board stays", () => {
    const t = room([note(1), note(2)], [frame(1)]);
    t.session.importBoard(content("New"), { x: 3000, y: 2000 });
    vi.advanceTimersByTime(2000);
    expect(t.relay.notes.size).toBe(3);
    expect(t.relay.frames.size).toBe(1);
    expect(t.relay.received.some((m) => String(m.type).toLowerCase().includes("delete"))).toBe(false);
  });

  it("is one undoable step", () => {
    const t = room([note(1)]);
    const file = buildBoardFile(room([note(1), note(2)], [frame(1)], {}, undefined, [shape(1)], [connector(1, { item: nid(1), anchor: "auto" }, { item: nid(2), anchor: "auto" })], [group(1, [nid(1), nid(2)])]).view().board)!;
    t.session.importBoard(fromFile(file), { x: 3000, y: 2000 });
    vi.advanceTimersByTime(4000);
    expect(t.relay.notes.size).toBe(3);
    expect(t.relay.connectors.size).toBe(1);
    expect(t.relay.groups.size).toBe(1);
    t.session.undo();
    vi.advanceTimersByTime(4000);
    expect([...t.relay.notes.keys()]).toEqual([nid(1)]);
    expect(t.relay.frames.size + t.relay.shapes.size + t.relay.connectors.size + t.relay.groups.size).toBe(0);
  });

  it("paces a large import in itemsAdd messages packed by size", () => {
    const t = room();
    const lines = Array.from({ length: MAX_NOTES_PER_ROOM }, (_, i) => `${i} ${"word ".repeat(40)}`).join("\n");
    t.session.importBoard(content(lines), { x: 3200, y: 2000 });
    expect(t.sent("itemsAdd").length).toBeLessThanOrEqual(1);
    vi.advanceTimersByTime(60_000);
    expect(t.relay.notes.size).toBe(MAX_NOTES_PER_ROOM);
    expect(t.sent("itemsAdd").length).toBeGreaterThan(4);
  });
});

describe("refused up front, nothing sent", () => {
  it("when it doesn't all fit, saying everything that wouldn't", () => {
    const t = room(
      Array.from({ length: MAX_NOTES_PER_ROOM - 2 }, (_, i) => note(i + 1, { x: (i % 20) * 300, y: Math.floor(i / 20) * 300 })),
      Array.from({ length: MAX_FRAMES_PER_ROOM }, (_, i) => frame(i + 1, { x: (i % 9) * 700, y: Math.floor(i / 9) * 450 })),
    );
    t.relay.received.length = 0;
    const file = buildBoardFile(room([note(1), note(2), note(3)], [frame(1)]).view().board)!;
    expect(t.session.importBoard(fromFile(file), { x: 3000, y: 2000 })).toBe(false);
    expect(t.view().noteNotice).toBe(IMPORT_TEXT.noRoom([["frames", 1, 0], ["notes", 3, 2]]));
    expect(sentAdds(t)).toEqual([]);
    expect(t.relay.notes.size).toBe(MAX_NOTES_PER_ROOM - 2);
  });

  it("more lines than fit", () => {
    const t = room(Array.from({ length: MAX_NOTES_PER_ROOM - 1 }, (_, i) => note(i + 1)));
    t.relay.received.length = 0;
    expect(t.session.importBoard(content("a\nb\nc"), { x: 3000, y: 2000 })).toBe(false);
    expect(t.view().noteNotice).toBe(IMPORT_TEXT.noRoom([["notes", 3, 1]]));
    expect(sentAdds(t)).toEqual([]);
  });

  it("a guest on a locked board, everyone during a silent round, and while disconnected", () => {
    const t = room([], [], {}, (r) => (r.locked = true));
    t.relay.received.length = 0;
    expect(t.session.importBoard(content("x"), { x: 500, y: 500 })).toBe(false);
    expect(t.view().noteNotice).toBe(LOCK_TEXT.reason);
    const s = room();
    s.relay.emit({ type: "silentChanged", active: true, count: 0 });
    s.relay.received.length = 0;
    expect(s.session.importBoard(content("x"), { x: 500, y: 500 })).toBe(false);
    expect(s.view().noteNotice).toBe(SILENT_TEXT.on);
    const d = room();
    d.relay.handlers!.onClose(1006);
    d.relay.received.length = 0;
    expect(d.session.importBoard(content("x"), { x: 500, y: 500 })).toBe(false);
    for (const r of [t, s, d]) expect(sentAdds(r)).toEqual([]);
  });

  it("while another add is being sent", () => {
    const t = room();
    // Long lines: several itemsAdd messages, sent one at a time.
    t.session.importBoard(content(Array.from({ length: 60 }, (_, i) => `${i} ${"word ".repeat(40)}`).join("\n")), { x: 3000, y: 2000 });
    t.relay.received.length = 0;
    expect(t.session.importBoard(content("b"), { x: 900, y: 500 })).toBe(false);
    expect(t.view().noteNotice).toBe(UNDO_TEXT.busy);
  });

  it("the reasons, as Duplicate and stencils give them", () => {
    expect(importReason({ live: false, lockedOut: false, silent: false, busy: false })).toBe(NOTE_TOOL_REASONS.disconnected);
    expect(importReason({ live: true, lockedOut: true, silent: false, busy: false })).toBe(LOCK_TEXT.reason);
    expect(importReason({ live: true, lockedOut: false, silent: true, busy: false })).toBe(SILENT_TEXT.on);
    expect(importReason({ live: true, lockedOut: false, silent: false, busy: true })).toBe(UNDO_TEXT.busy);
    expect(importReason({ live: true, lockedOut: false, silent: false, busy: false })).toBeNull();
  });
});

describe("round trip", () => {
  it("export a board file, clear the room, import it: the same content, stacking order and structure", () => {
    // Notes and shapes interleaved in one stacking space, frames, bound and free arrows, two groups.
    const t = room(
      [
        note(1, { x: 1000, y: 1000, z: 5, text: "Bottom note\nwith a body", color: "pink", bold: true }),
        note(2, { x: 1300, y: 1000, z: 30, text: "Top note 🚀" }),
        note(3, { x: 1000, y: 1300, z: 12, text: "Middle", color: "blue", w: 240, h: 200 }),
        note(4, { x: 1600, y: 1300, z: 1, text: "" }),
      ],
      [frame(1, { x: 900, y: 900, w: 1200, h: 800, title: "Area", color: "blue" }), frame(2, { x: 2300, y: 900, title: "Second" })],
      {},
      undefined,
      [shape(1, { x: 1300, y: 1300, z: 20, text: "Between", kind: "diamond" }), shape(2, { x: 2400, y: 1000, z: 2, text: "Low label", kind: "text" })],
      [
        connector(1, { item: nid(1), anchor: "right" }, { item: nid(2), anchor: "left" }),
        connector(2, { item: sid(1), anchor: "auto" }, { x: 2600, y: 1500 }, { route: "elbow", dash: "dotted" }),
      ],
      [group(1, [nid(1), nid(3)], { label: "Pair", color: "green" }), group(2, [sid(1), nid(2)], { label: "Mixed" })],
    );
    const before = buildBoardFile(t.view().board)!;
    const text = boardFileText(before);

    expect(t.session.clearBoard()).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(t.relay.notes.size + t.relay.frames.size + t.relay.shapes.size + t.relay.connectors.size + t.relay.groups.size).toBe(0);

    const parsed = parseBoardFile(text);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(t.session.importBoard(parsed.content, { x: 3200, y: 2000 })).toBe(true);
    vi.advanceTimersByTime(10_000);

    expect(t.relay.notes.size).toBe(4);
    const after = buildBoardFile(t.view().board);
    expect(normal(after)).toEqual(normal(before));
    // The relay's own z agrees: notes and shapes in the same interleaved order.
    const relayOrder = stackOrder([...t.relay.notes.values(), ...t.relay.shapes.values()]).map((i) => i.text);
    expect(relayOrder).toEqual(["", "Low label", "Bottom note\nwith a body", "Middle", "Between", "Top note 🚀"]);
  });
});
