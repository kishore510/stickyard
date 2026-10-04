// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BATCH_ENTRIES, MAX_NOTES_PER_ROOM, NOTE_DEFAULTS, PROTOCOL_VERSION, type Note, type Participant } from "@stickyard/shared";
import type { SocketFactory, SocketHandlers } from "../src/connection/socket";
import { deleteKeyTarget, type DeleteKeyEvent, type DeleteKeyState } from "../src/canvas/deleteKey";
import { localId } from "../src/notes/board";
import { confirmDeleteNotes } from "../src/notes/label";
import { RoomSession, type RoomView } from "../src/rooms/session";

/*
 * Selection and delete polish (web only, no protocol change): every way a multi-select delete
 * could do nothing, or only part of it, without saying so.
 */

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

const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0 };
const sam: Participant = { id: "BBBBBBBBBBBBBBBB", name: "Sam", colourIndex: 1 };
const id = (i: number) => `note${String(i).padStart(12, "0")}`;
const note = (i: number): Note => ({ id: id(i), x: 10, y: 5, ...NOTE_DEFAULTS, text: "", color: "yellow", z: i, rev: 1, authorId: sam.id });
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function withBoard(count: number) {
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
  sock().receive({ type: "snapshot", notes: range(count).map(note) });
  const view = () => views.at(-1)!;
  const batches = () => sock().sent.filter((m) => m.type === "noteBatch") as { ops: { op: string; id: string }[]; final: boolean }[];
  /** The relay applying one of our batches of deletes. */
  const applied = (ids: readonly string[]) =>
    sock().receive({ type: "notesBatchApplied", final: true, results: ids.map((i) => ({ type: "noteDeleted", id: i })) });
  return { session, sock, view, batches, applied };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("reporting a delete of several notes", () => {
  it("says how many were deleted once the relay has applied them", () => {
    const t = withBoard(3);
    t.session.deleteNotes([id(0), id(1), id(2)]);
    expect(t.view().board.notes).toHaveLength(0);
    t.applied([id(0), id(1), id(2)]);
    expect(t.view().deleteReport).toEqual({ text: "Deleted 3 notes.", partial: false });
  });

  it("unconfirmed notes in the selection are deleted once confirmed, and counted", () => {
    const t = withBoard(2);
    const temp = t.session.addNote({ x: 0, y: 0, color: "pink" })!;
    t.session.deleteNotes([id(0), id(1), temp]);
    expect(t.batches()[0]!.ops.map((o) => o.id)).toEqual([id(0), id(1)]);
    t.applied([id(0), id(1)]);
    // Still waiting for the third: no report claiming all three yet.
    expect(t.view().deleteReport?.text).not.toBe("Deleted 3 notes.");
    t.sock().receive({ type: "noteAdded", note: { ...note(9), authorId: alex.id }, clientRef: temp.replace(/^local:/, "") });
    expect(t.sock().sent.at(-1)).toEqual({ type: "noteDelete", id: id(9) });
    t.sock().receive({ type: "noteDeleted", id: id(9) });
    expect(t.view().deleteReport).toEqual({ text: "Deleted 3 notes.", partial: false });
  });

  it("an unconfirmed note whose add is refused counts as gone (it never existed)", () => {
    const t = withBoard(1);
    const temp = t.session.addNote({ x: 0, y: 0, color: "pink" })!;
    t.session.deleteNotes([id(0), temp]);
    t.applied([id(0)]);
    t.sock().receive({ type: "error", code: "notes_full", message: "x", clientRef: temp.replace(/^local:/, "") });
    expect(t.view().deleteReport).toEqual({ text: "Deleted 2 notes.", partial: false });
    expect(t.view().board.notes).toHaveLength(0);
  });

  it("51+ notes go in chunks of 50, in order, every note once", () => {
    const t = withBoard(120);
    const ids = range(120).map(id);
    t.session.deleteNotes(ids);
    const sent = t.batches();
    expect(sent.map((b) => b.ops.length)).toEqual([50, 50, 20]);
    expect(sent.every((b) => b.final && b.ops.every((o) => o.op === "delete"))).toBe(true);
    expect(sent.flatMap((b) => b.ops.map((o) => o.id))).toEqual(ids);
    for (const b of sent) t.applied(b.ops.map((o) => o.id));
    expect(t.view().deleteReport).toEqual({ text: "Deleted 120 notes.", partial: false });
  });

  it("a full board (200) fits the relay's entry budget in one go", () => {
    const t = withBoard(MAX_NOTES_PER_ROOM);
    t.session.deleteNotes(range(MAX_NOTES_PER_ROOM).map(id));
    const sent = t.batches();
    expect(sent).toHaveLength(Math.ceil(MAX_NOTES_PER_ROOM / MAX_BATCH_ENTRIES));
    // BATCH_LIMITS.entriesBurst is 1000 (worker/src/limits.ts; worker/test/batch.test.ts checks it).
    expect(sent.reduce((n, b) => n + b.ops.length, 0)).toBeLessThanOrEqual(1000);
  });

  it("a rate-limited chunk rolls back only its notes and the report says how many and why", () => {
    const t = withBoard(120);
    t.session.deleteNotes(range(120).map(id));
    const [first, second, third] = t.batches().map((b) => b.ops.map((o) => o.id));
    t.applied(first!);
    t.sock().receive({ type: "error", code: "rate_limited", message: "x", noteIds: second });
    t.applied(third!);
    expect(t.view().board.notes.map((n) => n.note.id)).toEqual(second);
    expect(t.view().deleteReport).toEqual({
      text: "Deleted 70 of 120 notes. 50 weren’t deleted because that was too quick; they’re back on the board. Try again.",
      partial: true,
    });
  });

  it("a refused chunk (not rate limited) says so too", () => {
    const t = withBoard(3);
    t.session.deleteNotes([id(0), id(1), id(2)]);
    t.sock().receive({ type: "error", code: "bad_message", message: "x", entries: [1], noteIds: [id(1)] });
    t.applied([id(0), id(2)]);
    expect(t.view().deleteReport).toEqual({
      text: "Deleted 2 of 3 notes. 1 wasn’t deleted because the relay refused it; it’s back on the board. Try again.",
      partial: true,
    });
  });

  it("notes someone else deleted meanwhile count as deleted", () => {
    const t = withBoard(2);
    t.session.deleteNotes([id(0), id(1)]);
    t.sock().receive({ type: "noteDeleted", id: id(1) });
    t.applied([id(0)]);
    expect(t.view().deleteReport).toEqual({ text: "Deleted 2 notes.", partial: false });
  });

  it("disconnected: nothing is deleted and it says why", () => {
    const t = withBoard(2);
    t.sock().handlers.onClose();
    t.session.deleteNotes([id(0), id(1)]);
    expect(t.view().board.notes).toHaveLength(2);
    expect(t.batches()).toEqual([]);
    expect(t.view().deleteReport).toEqual({ text: "You’re not connected, so nothing was deleted.", partial: true });
  });

  it("the connection lost mid-delete: says how many may not have been deleted", () => {
    const t = withBoard(60);
    t.session.deleteNotes(range(60).map(id));
    t.applied(t.batches()[0]!.ops.map((o) => o.id));
    t.sock().handlers.onClose();
    expect(t.view().deleteReport).toEqual({
      text: "Deleted 50 of 60 notes. The connection was lost before 10 were confirmed, so they may still be on the board.",
      partial: true,
    });
  });

  it("the next note action clears the report", () => {
    const t = withBoard(3);
    t.session.deleteNotes([id(0), id(1)]);
    t.applied([id(0), id(1)]);
    expect(t.view().deleteReport).not.toBeNull();
    t.session.startDrag(id(2));
    expect(t.view().deleteReport).toBeNull();
  });

  it("a local id that the session no longer knows is skipped without a false count", () => {
    const t = withBoard(1);
    t.session.deleteNotes([id(0), localId("gone")]);
    t.applied([id(0)]);
    expect(t.view().deleteReport).toEqual({ text: "Deleted 1 note.", partial: false });
  });
});

describe("the Delete key outside a note card", () => {
  const board = (): Element => {
    const el = document.createElement("section");
    el.innerHTML = '<div class="pane"></div><input data-field /><textarea data-inline="body"></textarea>';
    document.body.append(el);
    return el;
  };
  const key = (target: EventTarget | null, extra: Partial<DeleteKeyEvent> = {}): DeleteKeyEvent => ({
    key: "Delete",
    target,
    defaultPrevented: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...extra,
  });
  const state = (el: Element, extra: Partial<DeleteKeyState> = {}): DeleteKeyState => ({
    multi: true,
    selection: 5,
    frameSelected: false,
    modal: false,
    board: el,
    ...extra,
  });

  it("deletes the selection when focus is on nothing (after Ctrl+A) or on the board (after a marquee)", () => {
    const el = board();
    expect(deleteKeyTarget(key(document.body), state(el))).toBe("notes");
    expect(deleteKeyTarget(key(el.querySelector(".pane")), state(el))).toBe("notes");
    expect(deleteKeyTarget(key(el, { key: "Backspace" }), state(el))).toBe("notes");
  });

  it("focus on an element round the board (a click on the canvas focuses the app's <main>) is the board's", () => {
    const main = document.createElement("main");
    main.tabIndex = -1;
    const el = document.createElement("section");
    main.append(el);
    document.body.append(main);
    expect(deleteKeyTarget(key(main), state(el))).toBe("notes");
    expect(deleteKeyTarget(key(main), state(el, { selection: 0, frameSelected: true }))).toBe("frame");
  });

  it("never inside a text field (a note edited in place, a Properties field), a modal, or with nothing selected", () => {
    const el = board();
    expect(deleteKeyTarget(key(el.querySelector("textarea")), state(el))).toBeNull();
    expect(deleteKeyTarget(key(el.querySelector("input")), state(el))).toBeNull();
    expect(deleteKeyTarget(key(document.body), state(el, { modal: true }))).toBeNull();
    expect(deleteKeyTarget(key(document.body), state(el, { selection: 0 }))).toBeNull();
    expect(deleteKeyTarget(key(document.body, { defaultPrevented: true }), state(el))).toBeNull();
  });

  it("not from a control elsewhere on the page (a menu or chat button), nor with Ctrl, Cmd or Alt", () => {
    const el = board();
    const outside = document.createElement("button");
    document.body.append(outside);
    expect(deleteKeyTarget(key(outside), state(el))).toBeNull();
    expect(deleteKeyTarget(key(document.body, { ctrlKey: true }), state(el))).toBeNull();
    expect(deleteKeyTarget(key(document.body, { altKey: true }), state(el))).toBeNull();
  });

  it("phones keep single-note delete (on the note itself)", () => {
    expect(deleteKeyTarget(key(document.body), state(board(), { multi: false }))).toBeNull();
  });

  it("a selected frame still takes Delete", () => {
    expect(deleteKeyTarget(key(document.body), state(board(), { selection: 0, frameSelected: true }))).toBe("frame");
  });
});

describe("confirming a delete of several notes", () => {
  it("states the count and asks once, even when the notes are empty", () => {
    const asked: string[] = [];
    expect(confirmDeleteNotes(200, (m) => (asked.push(m), true))).toBe(true);
    expect(asked).toEqual(["Delete 200 notes? They’re removed for everyone in the session."]);
  });

  it("no means nothing is deleted", () => {
    expect(confirmDeleteNotes(3, () => false)).toBe(false);
  });
});
