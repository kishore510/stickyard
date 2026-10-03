import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BATCH_ENTRIES, NOTE_DEFAULTS, PROTOCOL_VERSION, type Note, type Participant } from "@stickyard/shared";
import type { SocketFactory, SocketHandlers } from "../src/connection/socket";
import { findNote, localId } from "../src/notes/board";
import { GROUP_MOVE_INTERVAL_MS, RoomSession, type RoomView } from "../src/rooms/session";

/* Slice 2.8: group moves, arrange, and group delete go out as noteBatch messages (protocol v7). */

class FakeSocket {
  sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(readonly handlers: SocketHandlers) {}
  send = (data: string) => {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  };
  close = () => {
    this.closed = true;
  };
  receive(data: unknown) {
    this.handlers.onMessage(JSON.stringify(data));
  }
}

const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0 };
const sam: Participant = { id: "BBBBBBBBBBBBBBBB", name: "Sam", colourIndex: 1 };
const id = (i: number) => `note${String(i).padStart(12, "0")}`;
const note = (i: number, extra: Partial<Note> = {}): Note => ({
  id: id(i),
  x: 10 * i,
  y: 5 * i,
  ...NOTE_DEFAULTS,
  text: "",
  color: "yellow",
  rev: 1,
  authorId: sam.id,
  ...extra,
});

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
  sock().receive({ type: "joined", you: alex, participants: [sam, alex] });
  sock().receive({ type: "snapshot", notes });
  const view = () => views.at(-1)!;
  const shown = (i: number) => findNote(view().board, id(i))?.note;
  const batches = () => sock().sent.filter((m) => m.type === "noteBatch");
  return { session, sock, view, shown, batches };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("group move", () => {
  it("moves every note here at once and sends one final batch of moves on drop", () => {
    const t = withBoard(note(1), note(2), note(3));
    expect(t.session.startGroupDrag([id(1), id(2), id(3)])).toBe(true);
    t.session.moveGroup(
      [
        { id: id(1), x: 110, y: 105 },
        { id: id(2), x: 120, y: 110 },
      ],
      true,
    );
    expect(t.shown(1)).toMatchObject({ x: 110, y: 105 });
    expect(t.batches()).toEqual([
      {
        type: "noteBatch",
        final: true,
        ops: [
          { op: "move", id: id(1), x: 110, y: 105 },
          { op: "move", id: id(2), x: 120, y: 110 },
        ],
      },
    ]);
    expect(findNote(t.view().board, id(1))?.dragging).toBe(false);
  });

  it("while dragging, sends at most every GROUP_MOVE_INTERVAL_MS (the latest wins), not stored", () => {
    const t = withBoard(note(1), note(2));
    t.session.startGroupDrag([id(1), id(2)]);
    t.session.moveGroup([{ id: id(1), x: 50, y: 50 }, { id: id(2), x: 60, y: 60 }], false);
    t.session.moveGroup([{ id: id(1), x: 51, y: 50 }, { id: id(2), x: 61, y: 60 }], false);
    t.session.moveGroup([{ id: id(1), x: 52, y: 50 }, { id: id(2), x: 62, y: 60 }], false);
    expect(t.batches()).toHaveLength(1);
    expect(t.batches()[0]).toMatchObject({ final: false, ops: [{ id: id(1), x: 50 }, { id: id(2), x: 60 }] });
    vi.advanceTimersByTime(GROUP_MOVE_INTERVAL_MS);
    expect(t.batches()).toHaveLength(2);
    expect(t.batches()[1]).toMatchObject({ final: false, ops: [{ id: id(1), x: 52 }, { id: id(2), x: 62 }] });
    expect(GROUP_MOVE_INTERVAL_MS).toBeGreaterThanOrEqual(100);
  });

  it(`selections over ${MAX_BATCH_ENTRIES}: live drag relays the first ${MAX_BATCH_ENTRIES}; the drop goes out in chunks of ${MAX_BATCH_ENTRIES}`, () => {
    const notes = Array.from({ length: 120 }, (_, i) => note(i));
    const t = withBoard(...notes);
    t.session.startGroupDrag(notes.map((n) => n.id));
    const at = (dx: number) => notes.map((n) => ({ id: n.id, x: n.x + dx, y: n.y }));
    t.session.moveGroup(at(5), false);
    expect(t.batches()).toHaveLength(1);
    expect((t.batches()[0]?.ops as unknown[]).length).toBe(MAX_BATCH_ENTRIES);
    // Every note still moves here.
    expect(t.shown(119)).toMatchObject({ x: 1190 + 5 });
    vi.advanceTimersByTime(GROUP_MOVE_INTERVAL_MS);
    t.session.moveGroup(at(9), true);
    const finals = t.batches().filter((b) => b.final === true);
    expect(finals.map((b) => (b.ops as unknown[]).length)).toEqual([50, 50, 20]);
    expect(finals.flatMap((b) => (b.ops as { id: string }[]).map((o) => o.id))).toEqual(notes.map((n) => n.id));
  });

  it("notes waiting for their server id are left out (they can't move yet)", () => {
    const t = withBoard(note(1));
    const temp = t.session.addNote({ x: 0, y: 0, color: "pink" })!;
    expect(t.session.startGroupDrag([id(1), temp])).toBe(true);
    t.session.moveGroup([{ id: id(1), x: 300, y: 300 }, { id: temp, x: 400, y: 400 }], true);
    expect(t.batches()[0]?.ops).toEqual([{ op: "move", id: id(1), x: 300, y: 300 }]);
  });

  it("held notes ignore others' moves until release", () => {
    const t = withBoard(note(1), note(2));
    t.session.startGroupDrag([id(1), id(2)]);
    t.session.moveGroup([{ id: id(1), x: 50, y: 50 }, { id: id(2), x: 60, y: 60 }], false);
    t.sock().receive({
      type: "notesBatchApplied",
      final: true,
      results: [{ type: "noteMoved", id: id(1), x: 900, y: 900, rev: 2, final: true }],
    });
    expect(t.shown(1)).toMatchObject({ x: 50, y: 50 });
    expect(findNote(t.view().board, id(1))?.confirmed).toMatchObject({ x: 900, y: 900, rev: 2 });
  });
});

describe("refusals roll back per entry", () => {
  it("an error naming some notes rolls back only those", () => {
    const t = withBoard(note(1), note(2), note(3));
    t.session.applyRects([
      { id: id(1), x: 500, y: 500, w: 160, h: 160 },
      { id: id(2), x: 600, y: 500, w: 160, h: 160 },
      { id: id(3), x: 700, y: 500, w: 200, h: 160 },
    ]);
    t.sock().receive({ type: "error", code: "bad_message", message: "x", entries: [1], noteIds: [id(2)] });
    expect(t.shown(1)).toMatchObject({ x: 500 });
    expect(t.shown(2)).toEqual(note(2));
    expect(t.shown(3)).toMatchObject({ x: 700, w: 200 });
    expect(t.view().noteNotice).toBeTruthy();
  });

  it("a batch dropped for the rate limit rolls back every note it named", () => {
    const t = withBoard(note(1), note(2));
    t.session.applyRects([
      { id: id(1), x: 500, y: 500, w: 160, h: 160 },
      { id: id(2), x: 600, y: 500, w: 160, h: 160 },
    ]);
    t.sock().receive({ type: "error", code: "rate_limited", message: "x", noteIds: [id(1), id(2)] });
    expect(t.shown(1)).toEqual(note(1));
    expect(t.shown(2)).toEqual(note(2));
    expect(t.view().rateLimited).toBe(true);
  });
});

describe("arrange and group delete", () => {
  it("applyRects sends moves for position-only changes and resizes when the size changes, in one final batch", () => {
    const t = withBoard(note(1), note(2));
    expect(
      t.session.applyRects([
        { id: id(1), x: 10, y: 300, w: 160, h: 160 },
        { id: id(2), x: 20, y: 10, w: 300, h: 200 },
      ]),
    ).toBe(true);
    expect(t.batches()).toEqual([
      {
        type: "noteBatch",
        final: true,
        ops: [
          { op: "move", id: id(1), x: 10, y: 300 },
          { op: "resize", id: id(2), x: 20, y: 10, w: 300, h: 200 },
        ],
      },
    ]);
    expect(t.shown(2)).toMatchObject({ w: 300, h: 200 });
  });

  it("unchanged notes are left out; nothing changed sends nothing", () => {
    const t = withBoard(note(1), note(2));
    t.session.applyRects([{ id: id(1), x: 10, y: 5, w: 160, h: 160 }]);
    expect(t.batches()).toEqual([]);
  });

  it("deleteNotes removes them here and sends one batch of deletes; an unconfirmed add is deleted once confirmed", () => {
    const t = withBoard(note(1), note(2), note(3));
    const temp = t.session.addNote({ x: 0, y: 0, color: "pink" })!;
    const ref = temp.replace(/^local:/, "");
    t.session.deleteNotes([id(1), id(3), temp]);
    expect(t.view().board.notes.map((n) => n.note.id)).toEqual([id(2)]);
    expect(t.batches()).toEqual([
      {
        type: "noteBatch",
        final: true,
        ops: [
          { op: "delete", id: id(1) },
          { op: "delete", id: id(3) },
        ],
      },
    ]);
    t.sock().receive({ type: "noteAdded", note: note(9, { authorId: alex.id }), clientRef: ref });
    expect(t.sock().sent.at(-1)).toEqual({ type: "noteDelete", id: id(9) });
    expect(findNote(t.view().board, localId(ref))).toBeUndefined();
  });

  it("a refused group delete puts the named notes back", () => {
    const t = withBoard(note(1), note(2));
    t.session.deleteNotes([id(1), id(2)]);
    t.sock().receive({ type: "error", code: "rate_limited", message: "x", noteIds: [id(1), id(2)] });
    expect(t.view().board.notes.map((n) => n.note.id)).toEqual([id(1), id(2)]);
  });

  it("disconnected: group moves, arrange and delete are refused", () => {
    const t = withBoard(note(1), note(2));
    t.sock().handlers.onClose();
    expect(t.session.startGroupDrag([id(1), id(2)])).toBe(false);
    expect(t.session.applyRects([{ id: id(1), x: 500, y: 500, w: 160, h: 160 }])).toBe(false);
    t.session.deleteNotes([id(1)]);
    expect(t.view().board.notes).toHaveLength(2);
    expect(t.batches()).toEqual([]);
  });
});

describe("others' batches", () => {
  it("notesBatchApplied applies each result: moves, resizes and deletes, in one view update", () => {
    const t = withBoard(note(1), note(2), note(3));
    t.sock().receive({
      type: "notesBatchApplied",
      final: true,
      results: [
        { type: "noteMoved", id: id(1), x: 400, y: 400, rev: 2, final: true },
        { type: "noteResized", id: id(2), x: 20, y: 10, w: 300, h: 300, rev: 2, final: true },
        { type: "noteDeleted", id: id(3) },
      ],
    });
    expect(t.shown(1)).toMatchObject({ x: 400, y: 400, rev: 2 });
    expect(t.shown(2)).toMatchObject({ w: 300, h: 300 });
    expect(t.shown(3)).toBeUndefined();
  });

  it("a live (non-final) batch moves notes without confirming them", () => {
    const t = withBoard(note(1));
    t.sock().receive({ type: "notesBatchApplied", final: false, results: [{ type: "noteMoved", id: id(1), x: 77, y: 88, rev: 1, final: false }] });
    expect(t.shown(1)).toMatchObject({ x: 77, y: 88 });
    expect(findNote(t.view().board, id(1))?.confirmed).toMatchObject({ x: 10, y: 5 });
  });
});
