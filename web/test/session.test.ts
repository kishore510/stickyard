import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_NOTES_PER_ROOM, PROTOCOL_VERSION, type Note, type Participant } from "@stickyard/shared";
import type { SocketFactory, SocketHandlers } from "../src/connection/socket";
import type { CodeCheck } from "../src/rooms/api";
import { findNote, localId } from "../src/notes/board";
import { JOIN_TIMEOUT_MS, MAX_MESSAGES, MOVE_INTERVAL_MS, RoomSession, type RoomView } from "../src/rooms/session";

class FakeSocket {
  sent: unknown[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly handlers: SocketHandlers,
  ) {}
  send = (data: string) => {
    this.sent.push(JSON.parse(data));
  };
  close = () => {
    this.closed = true;
  };
  open() {
    this.handlers.onOpen();
  }
  receive(data: unknown) {
    this.handlers.onMessage(typeof data === "string" ? data : JSON.stringify(data));
  }
  serverClose() {
    this.handlers.onClose();
  }
}

const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0 };
const sam: Participant = { id: "BBBBBBBBBBBBBBBB", name: "Sam", colourIndex: 1 };

function setup(check: CodeCheck = "valid") {
  const sockets: FakeSocket[] = [];
  const views: RoomView[] = [];
  const createSocket: SocketFactory = (url, handlers) => {
    const s = new FakeSocket(url, handlers);
    sockets.push(s);
    return s;
  };
  const checkCode = vi.fn(() => Promise.resolve(check));
  const session = new RoomSession({
    url: "wss://relay.example.test/ws?room=CODE",
    createSocket,
    checkCode,
    onChange: (v) => views.push(v),
  });
  const sock = () => {
    const s = sockets.at(-1);
    if (!s) throw new Error("no socket");
    return s;
  };
  const view = () => {
    const v = views.at(-1);
    if (!v) throw new Error("no view");
    return v;
  };
  return { session, sockets, sock, view, checkCode };
}

/** Join as Alex, with Sam already in the room. */
function joined() {
  const t = setup();
  t.session.join("Alex");
  t.sock().open();
  t.sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
  t.sock().receive({ type: "joined", you: alex, participants: [sam, alex] });
  return t;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("joining", () => {
  it("connects, says hello, then joins with the name", () => {
    const t = setup();
    t.session.join("Alex");
    expect(t.view().status).toBe("connecting");
    expect(t.sock().url).toBe("wss://relay.example.test/ws?room=CODE");
    t.sock().open();
    expect(t.sock().sent).toEqual([{ type: "hello", protocolVersion: PROTOCOL_VERSION }]);
    t.sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    expect(t.sock().sent.at(-1)).toEqual({ type: "join", name: "Alex" });
  });

  it("is joined, with the server's participant list", () => {
    const t = joined();
    expect(t.view()).toMatchObject({ status: "joined", you: alex, participants: [sam, alex] });
  });

  it("an invalid name keeps the socket and lets the person try again", () => {
    const t = setup();
    t.session.join("x");
    t.sock().open();
    t.sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    t.sock().receive({ type: "error", code: "invalid_name", message: "x" });
    expect(t.view()).toMatchObject({ status: "idle", nameError: true });
    t.session.join("Alex");
    expect(t.sockets).toHaveLength(1);
    expect(t.sock().sent.at(-1)).toEqual({ type: "join", name: "Alex" });
    expect(t.view().nameError).toBe(false);
  });

  it("room_full shows the full state and closes", () => {
    const t = setup();
    t.session.join("Alex");
    t.sock().open();
    t.sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    t.sock().receive({ type: "error", code: "room_full", message: "x" });
    expect(t.view().status).toBe("full");
    expect(t.sock().closed).toBe(true);
  });

  it.each([
    ["version_mismatch", { type: "error", code: "version_mismatch", message: "x" }],
    ["a welcome for another protocol", { type: "welcome", protocolVersion: PROTOCOL_VERSION + 1 }],
    ["a message this page can't understand", { type: "something_new" }],
  ])("%s means please reload", (_label, message) => {
    const t = setup();
    t.session.join("Alex");
    t.sock().open();
    t.sock().receive(message);
    expect(t.view().status).toBe("reload");
    expect(t.sock().closed).toBe(true);
  });

  it("a socket that fails before opening checks the code: invalid", async () => {
    const t = setup("invalid");
    t.session.join("Alex");
    t.sock().serverClose();
    await flush();
    expect(t.checkCode).toHaveBeenCalled();
    expect(t.view().status).toBe("invalid");
  });

  it("a socket that fails before opening checks the code: valid means unreachable", async () => {
    const t = setup("valid");
    t.session.join("Alex");
    t.sock().serverClose();
    await flush();
    expect(t.view().status).toBe("unreachable");
  });

  it("times out to unreachable", () => {
    const t = setup();
    t.session.join("Alex");
    t.sock().open();
    vi.advanceTimersByTime(JOIN_TIMEOUT_MS);
    expect(t.view().status).toBe("unreachable");
    expect(t.sock().closed).toBe(true);
  });

  it("does not time out once joined", () => {
    const t = joined();
    vi.advanceTimersByTime(JOIN_TIMEOUT_MS * 2);
    expect(t.view().status).toBe("joined");
  });
});

describe("in the room", () => {
  it("adds and removes participants, and announces them", () => {
    const t = joined();
    const kai: Participant = { id: "CCCCCCCCCCCCCCCC", name: "Kai", colourIndex: 2 };
    t.sock().receive({ type: "participant_joined", participant: kai });
    expect(t.view().participants).toEqual([sam, alex, kai]);
    expect(t.view().announcement).toBe("Kai joined");
    t.sock().receive({ type: "participant_left", id: sam.id });
    expect(t.view().participants).toEqual([alex, kai]);
    expect(t.view().announcement).toBe("Sam left");
  });

  it("echoes carry the sender's name and colour, kept after they leave", () => {
    const t = joined();
    t.sock().receive({ type: "echo", from: sam.id, text: "hi" });
    t.sock().receive({ type: "participant_left", id: sam.id });
    expect(t.view().messages).toEqual([{ key: expect.any(Number), from: sam.id, name: "Sam", colourIndex: 1, text: "hi" }]);
  });

  it("ignores echoes from unknown senders", () => {
    const t = joined();
    t.sock().receive({ type: "echo", from: "ZZZZZZZZZZZZZZZZ", text: "who?" });
    expect(t.view().messages).toEqual([]);
  });

  it(`keeps the last ${MAX_MESSAGES} messages`, () => {
    const t = joined();
    for (let i = 0; i < MAX_MESSAGES + 5; i++) t.sock().receive({ type: "echo", from: sam.id, text: `m${i}` });
    expect(t.view().messages).toHaveLength(MAX_MESSAGES);
    expect(t.view().messages.at(-1)?.text).toBe(`m${MAX_MESSAGES + 4}`);
  });

  it("say sends cleaned text, and refuses blank text", () => {
    const t = joined();
    expect(t.session.say("  hello ​ world ")).toBe(true);
    expect(t.sock().sent.at(-1)).toEqual({ type: "say", text: "hello world" });
    const count = t.sock().sent.length;
    expect(t.session.say("   ")).toBe(false);
    expect(t.sock().sent).toHaveLength(count);
  });

  it("say does nothing before joining", () => {
    const t = setup();
    t.session.join("Alex");
    t.sock().open();
    expect(t.session.say("hi")).toBe(false);
  });

  it("rate_limited shows a notice until the next accepted message", () => {
    const t = joined();
    t.sock().receive({ type: "error", code: "rate_limited", message: "x" });
    expect(t.view().rateLimited).toBe(true);
    t.sock().receive({ type: "echo", from: alex.id, text: "ok" });
    expect(t.view().rateLimited).toBe(false);
  });

  it("losing the connection after joining is disconnected", () => {
    const t = joined();
    t.sock().serverClose();
    expect(t.view().status).toBe("disconnected");
  });

  it("close() closes the socket and reports nothing further", () => {
    const t = joined();
    const before = t.view();
    t.session.close();
    expect(t.sock().closed).toBe(true);
    t.sock().serverClose();
    expect(t.view()).toBe(before);
  });
});

describe("notes", () => {
  const N1 = "NNNNNNNNNNNNNNN1";
  const one: Note = { id: N1, x: 100, y: 100, text: "Idea one", color: "yellow", rev: 1, authorId: sam.id };
  type Sent = Record<string, unknown>;
  const lastSent = (t: ReturnType<typeof setup>) => t.sock().sent.at(-1) as Sent;
  const sentOfType = (t: ReturnType<typeof setup>, type: string) => (t.sock().sent as Sent[]).filter((m) => m.type === type);

  function withBoard(...notes: Note[]) {
    const t = joined();
    t.sock().receive({ type: "snapshot", notes });
    return t;
  }

  it("the snapshot after join fills the board", () => {
    const t = withBoard(one);
    expect(t.view().board.notes.map((n) => n.note)).toEqual([one]);
  });

  it("add: optimistic note, noteAdd sent, swapped for the server note on noteAdded", () => {
    const t = withBoard();
    expect(t.session.addNote({ x: 10, y: 20, color: "pink" })).toMatch(/^local:/);
    const sent = lastSent(t);
    expect(sent).toMatchObject({ type: "noteAdd", x: 10, y: 20, color: "pink", text: "" });
    const ref = String(sent.clientRef);
    expect(findNote(t.view().board, localId(ref))).toBeDefined();
    const server: Note = { id: N1, x: 10, y: 20, text: "", color: "pink", rev: 1, authorId: alex.id };
    t.sock().receive({ type: "noteAdded", note: server, clientRef: ref });
    expect(t.view().board.notes.map((n) => n.note)).toEqual([server]);
  });

  it("text committed on a note that isn't confirmed yet is sent as an edit after the swap", () => {
    const t = withBoard();
    t.session.addNote({ x: 10, y: 20, color: "pink" });
    const ref = String(lastSent(t).clientRef);
    t.session.editNote(localId(ref), "Idea one");
    expect(sentOfType(t, "noteEdit")).toEqual([]);
    t.sock().receive({ type: "noteAdded", note: { ...one, id: N1, text: "", color: "pink", authorId: alex.id }, clientRef: ref });
    expect(lastSent(t)).toEqual({ type: "noteEdit", id: N1, text: "Idea one" });
    expect(t.view().board.notes[0]?.note.text).toBe("Idea one");
  });

  it("a rejected add is removed, with a friendly notice", () => {
    const t = withBoard();
    t.session.addNote({ x: 10, y: 20, color: "pink" });
    const ref = String(lastSent(t).clientRef);
    t.sock().receive({ type: "error", code: "notes_full", message: "x", clientRef: ref });
    expect(t.view().board.notes).toEqual([]);
    expect(t.view().noteNotice).toMatch(/full/i);
  });

  it(`at ${MAX_NOTES_PER_ROOM} notes, add is refused locally`, () => {
    const notes = Array.from({ length: MAX_NOTES_PER_ROOM }, (_, i) => ({ ...one, id: `N${String(i).padStart(15, "0")}` }));
    const t = withBoard(...notes);
    const count = t.sock().sent.length;
    expect(t.session.addNote({ x: 0, y: 0, color: "yellow" })).toBeNull();
    expect(t.sock().sent).toHaveLength(count);
    expect(t.view().noteNotice).toMatch(/full/i);
  });

  it("edit sends cleaned text and shows it at once; a rejection rolls it back", () => {
    const t = withBoard(one);
    t.session.editNote(N1, "  Needs follow-up\r\n ");
    expect(lastSent(t)).toEqual({ type: "noteEdit", id: N1, text: "Needs follow-up" });
    expect(t.view().board.notes[0]?.note.text).toBe("Needs follow-up");
    t.sock().receive({ type: "error", code: "rate_limited", message: "x", noteId: N1 });
    expect(t.view().board.notes[0]?.note.text).toBe("Idea one");
  });

  it("an unchanged edit sends nothing", () => {
    const t = withBoard(one);
    const count = t.sock().sent.length;
    t.session.editNote(N1, "Idea one");
    expect(t.sock().sent).toHaveLength(count);
  });

  it(`drag moves are throttled to one per ${MOVE_INTERVAL_MS}ms, then one final move`, () => {
    const t = withBoard(one);
    t.session.startDrag(N1);
    for (let i = 1; i <= 10; i++) {
      t.session.moveNote(N1, 100 + i, 100, false);
      vi.advanceTimersByTime(10);
    }
    const moves = sentOfType(t, "noteMove");
    expect(moves.length).toBeGreaterThanOrEqual(2);
    expect(moves.length).toBeLessThanOrEqual(3);
    expect(moves.every((m) => m.final === false)).toBe(true);
    t.session.moveNote(N1, 150, 160, true);
    expect(lastSent(t)).toEqual({ type: "noteMove", id: N1, x: 150, y: 160, final: true });
    // No trailing non-final move after the final one.
    const total = t.sock().sent.length;
    vi.advanceTimersByTime(MOVE_INTERVAL_MS * 4);
    expect(t.sock().sent).toHaveLength(total);
    expect(t.view().board.notes[0]).toMatchObject({ dragging: false, note: { x: 150, y: 160 } });
  });

  it("the last non-final position is sent after the throttle interval", () => {
    const t = withBoard(one);
    t.session.startDrag(N1);
    t.session.moveNote(N1, 110, 100, false);
    t.session.moveNote(N1, 120, 100, false);
    vi.advanceTimersByTime(MOVE_INTERVAL_MS);
    expect(lastSent(t)).toEqual({ type: "noteMove", id: N1, x: 120, y: 100, final: false });
  });

  it("a remote delete during a drag drops the note and stops sending moves", () => {
    const t = withBoard(one);
    t.session.startDrag(N1);
    t.session.moveNote(N1, 110, 100, false);
    t.sock().receive({ type: "noteDeleted", id: N1 });
    const count = t.sock().sent.length;
    t.session.moveNote(N1, 130, 100, false);
    t.session.moveNote(N1, 140, 100, true);
    vi.advanceTimersByTime(MOVE_INTERVAL_MS * 2);
    expect(t.sock().sent).toHaveLength(count);
    expect(t.view().board.notes).toEqual([]);
  });

  it("a remote delete of the note being edited says so", () => {
    const t = withBoard(one);
    t.session.setDraft(N1, "My draft");
    t.sock().receive({ type: "noteDeleted", id: N1 });
    expect(t.view().board.notes).toEqual([]);
    expect(t.view().noteNotice).toMatch(/deleted/i);
  });

  it("deleting a note before the server confirms it deletes it once confirmed", () => {
    const t = withBoard();
    const id = t.session.addNote({ x: 10, y: 20, color: "pink" }) ?? "";
    const ref = String(lastSent(t).clientRef);
    t.session.deleteNote(id);
    expect(t.view().board.notes).toEqual([]);
    t.sock().receive({ type: "noteAdded", note: { ...one, authorId: alex.id }, clientRef: ref });
    expect(lastSent(t)).toEqual({ type: "noteDelete", id: N1 });
    expect(t.view().board.notes).toEqual([]);
  });

  it("delete is optimistic and sends noteDelete", () => {
    const t = withBoard(one);
    t.session.deleteNote(N1);
    expect(lastSent(t)).toEqual({ type: "noteDelete", id: N1 });
    expect(t.view().board.notes).toEqual([]);
  });

  it("stale server updates are ignored", () => {
    const t = withBoard({ ...one, rev: 5 });
    t.sock().receive({ type: "noteUpdated", note: { ...one, text: "Old", rev: 4 } });
    expect(t.view().board.notes[0]?.note.text).toBe("Idea one");
  });

  it("disconnected: editing is blocked and nothing is sent", () => {
    const t = withBoard(one);
    t.sock().serverClose();
    expect(t.session.addNote({ x: 0, y: 0, color: "yellow" })).toBeNull();
    t.session.editNote(N1, "Needs follow-up");
    t.session.deleteNote(N1);
    t.session.moveNote(N1, 1, 1, true);
    expect(t.view().board.notes[0]?.note).toEqual(one);
  });
});
