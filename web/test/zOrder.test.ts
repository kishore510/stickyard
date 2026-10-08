import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BATCH_ENTRIES, NOTE_DEFAULTS, NOTE_Z_LIMIT, PROTOCOL_VERSION, stackOrder, type Note, type Participant } from "@stickyard/shared";
import type { SocketFactory, SocketHandlers } from "../src/connection/socket";
import { BOARD_NODE, FLOW_STACKING, createNoteNodeMapper, type NoteFlowNode } from "../src/canvas/nodes";
import { EMPTY_SELECTION, selectOnly } from "../src/canvas/selection";
import { applyOrdered, applySnapshot, EMPTY_BOARD, findNote, reorderLocal, setDragging, setResizing, type Board } from "../src/notes/board";
import { RoomSession, type RoomView } from "../src/rooms/session";

/* Slice z-order (protocol v8): stacking on the page. React Flow's zIndex comes from each note's z. */

class FakeSocket {
  sent: Record<string, unknown>[] = [];
  constructor(readonly handlers: SocketHandlers) {}
  send = (data: string) => {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  };
  close = () => {};
  receive(data: unknown) {
    this.handlers.onMessage(JSON.stringify(data));
  }
}

const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0, host: false };
const sam: Participant = { id: "BBBBBBBBBBBBBBBB", name: "Sam", colourIndex: 1, host: false };
const id = (i: number) => `note${String(i).padStart(12, "0")}`;
const note = (i: number, extra: Partial<Note> = {}): Note => ({
  id: id(i),
  x: 10 * i,
  y: 5 * i,
  ...NOTE_DEFAULTS,
  text: "",
  color: "yellow",
  z: i,
  rev: 1,
  authorId: sam.id,
  ...extra,
});
/** Shown ids, bottom to top. */
const stacked = (board: Board) => stackOrder(board.notes.map((n) => n.note)).map((n) => n.id);

function withBoard(...notes: Note[]) {
  let socket: FakeSocket | null = null;
  const views: RoomView[] = [];
  const createSocket: SocketFactory = (_url, handlers) => (socket = new FakeSocket(handlers));
  const session = new RoomSession({
    url: "wss://relay.example.test/ws?room=CODE",
    createSocket,
    checkCode: () => Promise.resolve("valid"),
    onChange: (v) => views.push(v),
  });
  session.join("Alex");
  const sock = () => {
    if (!socket) throw new Error("no socket");
    return socket;
  };
  sock().handlers.onOpen();
  sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
  sock().receive({ type: "joined", you: alex, participants: [alex, sam], locked: false, timer: null, voting: { state: "off", budget: 5, round: 0 }, silent: { active: false, count: 0 } });
  sock().receive({ type: "snapshot", notes });
  const view = () => {
    const v = views.at(-1);
    if (!v) throw new Error("no view");
    return v;
  };
  const sent = (type: string) => sock().sent.filter((m) => m.type === type);
  return { session, sock, view, views, sent };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("board: stacking", () => {
  const board = () => applySnapshot(EMPTY_BOARD, [note(0), note(1), note(2), note(3)]);

  it("reorderLocal brings notes to the front or back at once, keeping their relative order", () => {
    expect(stacked(reorderLocal(board(), [id(2), id(0)], "front"))).toEqual([id(1), id(3), id(0), id(2)]);
    expect(stacked(reorderLocal(board(), [id(3), id(1)], "back"))).toEqual([id(1), id(3), id(0), id(2)]);
  });

  it("reorderLocal returns the same board when nothing changes, and untouched entries stay the same objects", () => {
    const b = board();
    expect(reorderLocal(b, [id(3)], "front")).toBe(b);
    const next = reorderLocal(b, [id(0)], "front");
    expect(next.notes[1]).toBe(b.notes[1]);
    expect(next.notes[0]?.confirmed).toBe(b.notes[0]?.confirmed);
  });

  it("reorderLocal leaves renormalisation to the server (no optimistic change at the bound)", () => {
    const b = applySnapshot(EMPTY_BOARD, [note(0, { z: -1 }), note(1, { z: NOTE_Z_LIMIT })]);
    expect(reorderLocal(b, [id(0)], "front")).toBe(b);
  });

  it("applyOrdered confirms z and rev, and changes only z on what's shown", () => {
    const b = reorderLocal(board(), [id(0)], "front");
    const styled = { ...b, notes: b.notes.map((e) => (e.note.id === id(0) ? { ...e, note: { ...e.note, bold: true } } : e)) };
    const next = applyOrdered(styled, [{ id: id(0), z: 4, rev: 2 }]);
    const entry = findNote(next, id(0));
    expect(entry?.confirmed).toMatchObject({ z: 4, rev: 2, bold: false });
    expect(entry?.note).toMatchObject({ z: 4, rev: 2, bold: true });
    expect(next.notes[1]).toBe(styled.notes[1]);
  });

  it("applyOrdered ignores stale results and unknown notes, and returns the same board when nothing changes", () => {
    const b = applySnapshot(EMPTY_BOARD, [note(0, { rev: 5 })]);
    expect(applyOrdered(b, [{ id: id(0), z: 9, rev: 4 }])).toBe(b);
    expect(applyOrdered(b, [{ id: id(9), z: 9, rev: 1 }])).toBe(b);
    expect(applyOrdered(b, [{ id: id(0), z: 0, rev: 5 }])).toBe(b);
  });

  it("held notes keep their z: a remote reorder still applies to them, and holding never changes z", () => {
    let b = setResizing(setDragging(board(), id(0), true), id(1), true);
    expect(b.notes.map((n) => n.note.z)).toEqual([0, 1, 2, 3]);
    b = applyOrdered(b, [{ id: id(0), z: 7, rev: 2 }]);
    expect(findNote(b, id(0))?.note.z).toBe(7);
  });
});

describe("session: orderNotes", () => {
  it("is optimistic and sends one notesOrder with just ids and action", () => {
    const t = withBoard(note(0), note(1), note(2));
    expect(t.session.orderNotes([id(0)], "front")).toBe(true);
    expect(stacked(t.view().board)).toEqual([id(1), id(2), id(0)]);
    expect(t.sent("notesOrder")).toEqual([{ type: "notesOrder", ids: [id(0)], action: "front" }]);
  });

  it("over 50 notes go in chunks of 50 in stacking order, so relative order survives (front bottom-up, back top-down)", () => {
    const notes = Array.from({ length: 120 }, (_, i) => note(i));
    const t = withBoard(...notes, note(200, { z: 500 }));
    const ids = notes.map((n) => n.id).reverse();
    t.session.orderNotes(ids, "front");
    const fronts = t.sent("notesOrder") as { ids: string[]; action: string }[];
    expect(fronts.map((m) => m.ids.length)).toEqual([MAX_BATCH_ENTRIES, MAX_BATCH_ENTRIES, 20]);
    expect(fronts.flatMap((m) => m.ids)).toEqual(notes.map((n) => n.id));
    t.session.orderNotes(ids, "back");
    const backs = (t.sent("notesOrder") as { ids: string[] }[]).slice(3);
    expect(backs.map((m) => m.ids.length)).toEqual([20, MAX_BATCH_ENTRIES, MAX_BATCH_ENTRIES]);
  });

  it("notes not confirmed yet are left out; with none left nothing is sent", () => {
    const t = withBoard(note(0), note(1));
    const local = t.session.addNote({ x: 5, y: 5, color: "pink" });
    expect(local).not.toBeNull();
    t.session.orderNotes([local ?? ""], "back");
    expect(t.sent("notesOrder")).toEqual([]);
  });

  it("a new local note shows on top", () => {
    const t = withBoard(note(0), note(1, { z: 9 }));
    const local = t.session.addNote({ x: 5, y: 5, color: "pink" }) ?? "";
    expect(stacked(t.view().board).at(-1)).toBe(local);
  });

  it("a refusal naming the notes rolls them back to the server's order", () => {
    const t = withBoard(note(0), note(1), note(2));
    t.session.orderNotes([id(0)], "front");
    t.sock().receive({ type: "error", code: "rate_limited", message: "Slow down a little.", noteIds: [id(0)] });
    expect(stacked(t.view().board)).toEqual([id(0), id(1), id(2)]);
    expect(t.view().noteNotice).not.toBeNull();
  });

  it("remote results are folded in one view update", () => {
    const t = withBoard(note(0), note(1), note(2));
    const before = t.views.length;
    t.sock().receive({
      type: "notesOrdered",
      results: [
        { id: id(0), z: 5, rev: 2 },
        { id: id(1), z: 6, rev: 2 },
      ],
    });
    expect(t.views.length - before).toBe(1);
    expect(stacked(t.view().board)).toEqual([id(2), id(0), id(1)]);
  });

  it("is refused while disconnected", () => {
    const t = withBoard(note(0), note(1));
    t.sock().handlers.onClose();
    expect(t.session.orderNotes([id(0)], "front")).toBe(false);
  });

  it("moving, resizing and styling a note never changes its z", () => {
    const t = withBoard(note(0), note(1), note(2));
    t.session.startDrag(id(0));
    t.session.moveNote(id(0), 300, 300, true);
    t.session.setNoteSize(id(1), 300, 200);
    t.session.styleNote(id(2), { bold: true });
    t.session.editNote(id(2), "Changed");
    expect(t.view().board.notes.map((n) => n.note.z)).toEqual([0, 1, 2]);
  });
});

describe("canvas nodes", () => {
  const board = () => applySnapshot(EMPTY_BOARD, [note(0, { z: 3 }), note(1, { z: -2 }), note(2, { z: 0 })]);
  const notes = (nodes: ReturnType<ReturnType<typeof createNoteNodeMapper>>) => nodes.filter((n): n is NoteFlowNode => n.type === "note");

  it("React Flow's zIndex is each note's z, and the board sits below every possible z", () => {
    const map = createNoteNodeMapper();
    expect(notes(map(board(), true)).map((n) => [n.id, n.zIndex])).toEqual([
      [id(0), 3],
      [id(1), -2],
      [id(2), 0],
    ]);
    expect(BOARD_NODE.zIndex).toBeLessThan(-NOTE_Z_LIMIT);
  });

  it("selected, dragged and resized notes are not elevated: what you see is z order", () => {
    const map = createNoteNodeMapper();
    let b = board();
    b = setDragging(b, id(1), true);
    b = setResizing(b, id(2), true);
    const nodes = notes(map(b, true, true, selectOnly(EMPTY_SELECTION, id(1))));
    expect(nodes.map((n) => n.zIndex)).toEqual([3, -2, 0]);
  });

  it("React Flow's elevate-on-select is off (and z order is manual)", () => {
    expect(FLOW_STACKING).toEqual({ elevateNodesOnSelect: false, zIndexMode: "manual" });
  });

  it("only notes whose z changed get new nodes (the rest are reused, so they don't re-render)", () => {
    const map = createNoteNodeMapper();
    const b = board();
    const first = notes(map(b, true, true, EMPTY_SELECTION));
    const next = notes(map(applyOrdered(b, [{ id: id(1), z: 4, rev: 2 }]), true, true, EMPTY_SELECTION));
    expect(next[0]).toBe(first[0]);
    expect(next[2]).toBe(first[2]);
    expect(next[1]).not.toBe(first[1]);
    expect(next[1]?.zIndex).toBe(4);
  });
});
