import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  MAX_MESSAGE_BYTES,
  MAX_NOTES_PER_ROOM,
  MAX_NOTE_TEXT,
  NOTE_DEFAULT_H,
  NOTE_DEFAULT_W,
  PROTOCOL_VERSION,
  type Note,
  type ServerMessage,
} from "@stickyard/shared";
import { SOCKET_LIMITS } from "../src/limits";
import { SCHEMA_VERSION } from "../src/noteStore";
import type { Room } from "../src/room";
import { TestClient, nextOfType, specRoomCode } from "./helpers";

/*
 * Protocol v3: shared sticky notes, last-write-wins, kept in the room's SQLite.
 * Fixture text is generic on purpose.
 */

async function newRoom() {
  const { code, id } = await specRoomCode();
  const stub = env.ROOM.get(env.ROOM.idFromName(id));
  return { code, stub };
}

/** Two joined clients in a fresh room; each has seen the other join. */
async function pair() {
  const room = await newRoom();
  const a = await TestClient.open(room.code);
  const b = await TestClient.open(room.code);
  const ja = await a.enter("Alex");
  const jb = await b.enter("Sam");
  await nextOfType(a, "participant_joined");
  return { ...room, a, b, ja, jb };
}

const addMsg = (clientRef: string, text = "Idea one", x = 100, y = 120) => ({
  type: "noteAdd",
  clientRef,
  x,
  y,
  color: "yellow",
  text,
});

async function addNote(c: TestClient, clientRef = "ref-1", text = "Idea one"): Promise<Note> {
  c.send(addMsg(clientRef, text));
  const added = await nextOfType(c, "noteAdded");
  return added.note;
}

const rowsWritten = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (room: Room) => room.rowsWritten);
const storedNotes = (stub: DurableObjectStub<Room>) =>
  runInDurableObject(stub, (_room, state) =>
    state.storage.sql.exec<{ id: string; x: number; y: number; text: string; rev: number }>(
      "SELECT id, x, y, text, rev FROM notes ORDER BY rowid",
    ).toArray(),
  );

/** Inserts `n` notes straight into a room's table (before anything has loaded them). */
const seed = (sql: SqlStorage, n: number, authorId = "AAAAAAAAAAAAAAAA") => {
  for (let i = 0; i < n; i++) {
    const id = `seed${String(i).padStart(12, "0")}`;
    sql.exec("INSERT INTO notes (id, x, y, text, color, rev, author_id) VALUES (?, 0, 0, 'Idea one', 'yellow', 1, ?)", id, authorId);
  }
};

const closeAll = (...clients: TestClient[]) => {
  for (const c of clients) c.close();
};

describe("snapshot", () => {
  it("follows joined, empty in a new room", async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex");
    expect(a.snapshot).toEqual({ type: "snapshot", notes: [] });
    a.close();
  });

  it("lists every note, in creation order, to someone joining later", async () => {
    const { code, a } = await pair();
    const one = await addNote(a, "r1", "Idea one");
    const two = await addNote(a, "r2", "Needs follow-up");
    const c = await TestClient.open(code);
    await c.enter("Kai");
    expect(c.snapshot?.notes).toEqual([one, two]);
    closeAll(a, c);
  });

  it("is not sent before join", async () => {
    const { code, a } = await pair();
    await addNote(a);
    const lurker = await TestClient.open(code);
    expect(await lurker.request({ type: "hello", protocolVersion: PROTOCOL_VERSION })).toMatchObject({ type: "welcome" });
    expect(await lurker.quiet()).toBe(true);
    closeAll(a, lurker);
  });
});

describe("noteAdd", () => {
  it("assigns id, rev 1 and the author from the socket; clientRef goes to the sender only", async () => {
    const { a, b, ja } = await pair();
    a.send(addMsg("ref-1"));
    const mine = await nextOfType(a, "noteAdded");
    const theirs = await nextOfType(b, "noteAdded");
    expect(mine.clientRef).toBe("ref-1");
    expect(theirs.clientRef).toBeUndefined();
    expect(mine.note).toEqual(theirs.note);
    expect(mine.note).toMatchObject({ x: 100, y: 120, color: "yellow", text: "Idea one", rev: 1, authorId: ja.you.id });
    expect(mine.note.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    closeAll(a, b);
  });

  it("authorId can't be spoofed", async () => {
    const { a, b, ja, jb } = await pair();
    // Extra fields are refused outright...
    expect(await b.request({ ...addMsg("r"), authorId: ja.you.id })).toMatchObject({ type: "error", code: "bad_message" });
    // ...and an honest add is credited to the socket's own participant.
    const note = await addNote(b, "r2");
    expect(note.authorId).toBe(jb.you.id);
    closeAll(a, b);
  });

  it("cleans the text", async () => {
    const { a, b } = await pair();
    const note = await addNote(a, "r", "  Idea‮ one\r\nNeeds​ follow-up \t");
    expect(note.text).toBe("Idea one\nNeeds follow-up");
    closeAll(a, b);
  });

  it("clamps the position so the note stays on the board", async () => {
    const { a, b } = await pair();
    a.send(addMsg("r", "x", BOARD_WIDTH, BOARD_HEIGHT));
    const { note } = await nextOfType(a, "noteAdded");
    expect(note).toMatchObject({ x: BOARD_WIDTH - NOTE_DEFAULT_W, y: BOARD_HEIGHT - NOTE_DEFAULT_H });
    closeAll(a, b);
  });

  it("before join gets not_joined, with the clientRef", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    await c.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    expect(await c.request(addMsg("r9"))).toMatchObject({ type: "error", code: "not_joined", clientRef: "r9" });
    c.close();
  });

  it(`refuses note ${MAX_NOTES_PER_ROOM + 1} with notes_full and the clientRef`, async () => {
    const { code, stub } = await newRoom();
    // Fill the table directly: sending 200 adds would trip the rate limit.
    await runInDurableObject(stub, (_room, state) => seed(state.storage.sql, MAX_NOTES_PER_ROOM - 1));
    const a = await TestClient.open(code);
    await a.enter("Alex");
    expect(a.snapshot?.notes).toHaveLength(MAX_NOTES_PER_ROOM - 1);
    await addNote(a, "last");
    expect(await a.request(addMsg("over"))).toMatchObject({ type: "error", code: "notes_full", clientRef: "over" });
    expect(await storedNotes(stub)).toHaveLength(MAX_NOTES_PER_ROOM);
    a.close();
  });

  it.each([
    ["text over the cap", { ...addMsg("r"), text: "x".repeat(MAX_NOTE_TEXT + 1) }],
    ["a hex colour", { ...addMsg("r"), color: "#ffcc00" }],
    ["fractional coordinates", { ...addMsg("r"), x: 1.5 }],
    ["out-of-range coordinates", { ...addMsg("r"), y: BOARD_HEIGHT + 1 }],
  ])("rejects %s with bad_message and stores nothing", async (_label, message) => {
    const { a, b, stub } = await pair();
    expect(await a.request(message)).toMatchObject({ type: "error", code: "bad_message" });
    expect(await b.quiet()).toBe(true);
    expect(await storedNotes(stub)).toEqual([]);
    closeAll(a, b);
  });
});

describe("noteEdit", () => {
  it("updates text, bumps rev, and broadcasts noteUpdated to everyone", async () => {
    const { a, b, stub } = await pair();
    const note = await addNote(a);
    await nextOfType(b, "noteAdded");
    b.send({ type: "noteEdit", id: note.id, text: "Needs follow-up" });
    const expected = { type: "noteUpdated", note: { ...note, text: "Needs follow-up", rev: 2 } };
    expect(await nextOfType(a, "noteUpdated")).toEqual(expected);
    expect(await nextOfType(b, "noteUpdated")).toEqual(expected);
    expect(await storedNotes(stub)).toMatchObject([{ id: note.id, text: "Needs follow-up", rev: 2 }]);
    closeAll(a, b);
  });

  it("keeps the original author", async () => {
    const { a, b, ja } = await pair();
    const note = await addNote(a);
    b.send({ type: "noteEdit", id: note.id, text: "Edited by someone else" });
    expect((await nextOfType(b, "noteUpdated")).note.authorId).toBe(ja.you.id);
    closeAll(a, b);
  });

  it("last write wins, in arrival order, each bumping rev", async () => {
    const { a, b } = await pair();
    const note = await addNote(a);
    a.send({ type: "noteEdit", id: note.id, text: "First" });
    b.send({ type: "noteEdit", id: note.id, text: "Second" });
    const first = await nextOfType(a, "noteUpdated");
    const second = await nextOfType(a, "noteUpdated");
    expect([first.note, second.note].map(({ text, rev }) => [text, rev])).toEqual([
      ["First", 2],
      ["Second", 3],
    ]);
    closeAll(a, b);
  });

  it("an unchanged text writes nothing and sends nothing", async () => {
    const { a, b, stub } = await pair();
    const note = await addNote(a);
    await nextOfType(b, "noteAdded");
    const before = await rowsWritten(stub);
    a.send({ type: "noteEdit", id: note.id, text: "Idea one" });
    expect(await b.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(before);
    closeAll(a, b);
  });

  it("text over the cap is refused", async () => {
    const { a, b } = await pair();
    const note = await addNote(a);
    expect(await a.request({ type: "noteEdit", id: note.id, text: "x".repeat(MAX_NOTE_TEXT + 1) })).toMatchObject({
      type: "error",
      code: "bad_message",
    });
    closeAll(a, b);
  });
});

describe("noteMove", () => {
  it("non-final moves go to the others only, keep rev, and write nothing", async () => {
    const { a, b, stub } = await pair();
    const note = await addNote(a);
    await nextOfType(b, "noteAdded");
    const before = await rowsWritten(stub);
    for (let i = 1; i <= 5; i++) a.send({ type: "noteMove", id: note.id, x: 100 + i * 10, y: 120, final: false });
    let last: Extract<ServerMessage, { type: "noteMoved" }> | null = null;
    while (last?.x !== 150) last = await nextOfType(b, "noteMoved");
    expect(last).toEqual({ type: "noteMoved", id: note.id, x: 150, y: 120, rev: 1, final: false });
    expect(await a.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(before);
    expect(await storedNotes(stub)).toMatchObject([{ x: 100, y: 120, rev: 1 }]);
    closeAll(a, b);
  });

  it("non-final moves that arrive together are coalesced per note", async () => {
    const { a, b } = await pair();
    const note = await addNote(a);
    await nextOfType(b, "noteAdded");
    for (let i = 1; i <= 10; i++) a.send({ type: "noteMove", id: note.id, x: 100 + i, y: 120, final: false });
    const seen: number[] = [];
    while (seen.at(-1) !== 110) seen.push((await nextOfType(b, "noteMoved")).x);
    // Never out of order, never more than were sent.
    expect(seen).toEqual([...seen].sort((p, q) => p - q));
    expect(seen.length).toBeLessThanOrEqual(10);
    closeAll(a, b);
  });

  it("a final move bumps rev, writes once, and goes to everyone", async () => {
    const { a, b, stub } = await pair();
    const note = await addNote(a);
    await nextOfType(b, "noteAdded");
    const before = await rowsWritten(stub);
    a.send({ type: "noteMove", id: note.id, x: 300, y: 400, final: false });
    a.send({ type: "noteMove", id: note.id, x: 310, y: 410, final: true });
    const expected = { type: "noteMoved", id: note.id, x: 310, y: 410, rev: 2, final: true };
    expect(await nextOfType(a, "noteMoved")).toEqual(expected);
    let seen = await nextOfType(b, "noteMoved");
    while (!seen.final) seen = await nextOfType(b, "noteMoved");
    expect(seen).toEqual(expected);
    expect(await rowsWritten(stub)).toBe(before + 1);
    expect(await storedNotes(stub)).toMatchObject([{ x: 310, y: 410, rev: 2 }]);
    closeAll(a, b);
  });

  it("clamps moves to the board", async () => {
    const { a, b } = await pair();
    const note = await addNote(a);
    a.send({ type: "noteMove", id: note.id, x: BOARD_WIDTH, y: BOARD_HEIGHT, final: true });
    expect(await nextOfType(a, "noteMoved")).toMatchObject({ x: BOARD_WIDTH - NOTE_DEFAULT_W, y: BOARD_HEIGHT - NOTE_DEFAULT_H });
    closeAll(a, b);
  });
});

describe("noteDelete", () => {
  it("removes the note for everyone and from storage", async () => {
    const { code, a, b, stub } = await pair();
    const note = await addNote(a);
    b.send({ type: "noteDelete", id: note.id });
    expect(await nextOfType(a, "noteDeleted")).toEqual({ type: "noteDeleted", id: note.id });
    expect(await nextOfType(b, "noteDeleted")).toEqual({ type: "noteDeleted", id: note.id });
    expect(await storedNotes(stub)).toEqual([]);
    const c = await TestClient.open(code);
    await c.enter("Kai");
    expect(c.snapshot?.notes).toEqual([]);
    closeAll(a, b, c);
  });
});

describe("unknown and deleted ids", () => {
  it.each([
    ["noteEdit", (id: string) => ({ type: "noteEdit", id, text: "Idea one" })],
    ["noteMove", (id: string) => ({ type: "noteMove", id, x: 1, y: 1, final: false })],
    ["noteMove final", (id: string) => ({ type: "noteMove", id, x: 1, y: 1, final: true })],
    ["noteDelete", (id: string) => ({ type: "noteDelete", id })],
  ])("%s on an unknown id is ignored silently", async (_label, make) => {
    const { a, b, stub } = await pair();
    const before = await rowsWritten(stub);
    a.send(make("ZZZZZZZZZZZZZZZZ"));
    expect(await a.quiet()).toBe(true);
    expect(await b.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(before);
    closeAll(a, b);
  });

  it("operations after a delete are ignored silently", async () => {
    const { a, b } = await pair();
    const note = await addNote(a);
    a.send({ type: "noteDelete", id: note.id });
    await nextOfType(b, "noteDeleted");
    await nextOfType(a, "noteDeleted");
    b.send({ type: "noteEdit", id: note.id, text: "Too late" });
    b.send({ type: "noteDelete", id: note.id });
    expect(await a.quiet()).toBe(true);
    expect(await b.quiet()).toBe(true);
    closeAll(a, b);
  });
});

describe("not joined", () => {
  it.each([
    ["noteEdit", { type: "noteEdit", id: "NNNNNNNNNNNNNNNN", text: "x" }],
    ["noteMove", { type: "noteMove", id: "NNNNNNNNNNNNNNNN", x: 1, y: 1, final: true }],
    ["noteDelete", { type: "noteDelete", id: "NNNNNNNNNNNNNNNN" }],
  ])("%s before join gets not_joined, with the note id", async (_label, message) => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    await c.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    expect(await c.request(message)).toMatchObject({ type: "error", code: "not_joined", noteId: "NNNNNNNNNNNNNNNN" });
    c.close();
  });
});

describe("caps on the wire", () => {
  it("an oversized note message gets too_large and the socket stays usable", async () => {
    const { a, b } = await pair();
    const big = JSON.stringify({ ...addMsg("r"), text: "x".repeat(MAX_MESSAGE_BYTES) });
    expect(await a.request(big)).toMatchObject({ type: "error", code: "too_large" });
    expect((await addNote(a)).text).toBe("Idea one");
    closeAll(a, b);
  });

  it("over the rate limit, note messages are dropped with rate_limited naming the note", async () => {
    const { a, b, stub } = await pair();
    const note = await addNote(a);
    await nextOfType(b, "noteAdded");
    // Batches of 10 until one is refused: independent of how fast this machine processes them,
    // and never near the violations that close the socket.
    const limited: ServerMessage[] = [];
    let moved = 0;
    for (let sent = 0; limited.length === 0 && sent < 1000; ) {
      for (let i = 0; i < 10; i++, sent++) a.send({ type: "noteMove", id: note.id, x: 1 + (sent % 1000), y: 1, final: true });
      for (let i = 0; i < 10; i++) {
        const m = await a.next();
        if (m.type === "error") limited.push(m);
        else if (m.type === "noteMoved") moved++;
      }
    }
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0]).toMatchObject({ code: "rate_limited", noteId: note.id });
    // Dropped messages were not applied: rev counts only the accepted moves.
    const [stored] = await storedNotes(stub);
    expect(stored?.rev).toBe(1 + moved);
    closeAll(a, b);
  });

  it(`about ${SOCKET_LIMITS.refillPerSecond} messages a second keeps a 20/s drag well inside the limit`, () => {
    expect(SOCKET_LIMITS.refillPerSecond).toBeGreaterThanOrEqual(30);
    expect(SOCKET_LIMITS.burst).toBeLessThanOrEqual(60);
  });
});

describe("persistence", () => {
  it("notes survive hibernation", async () => {
    const { code, a, b, stub } = await pair();
    const one = await addNote(a, "r1", "Idea one");
    a.send({ type: "noteMove", id: one.id, x: 500, y: 600, final: true });
    await nextOfType(a, "noteMoved");
    await evictDurableObject(stub, { webSockets: "hibernate" });

    const c = await TestClient.open(code);
    await c.enter("Kai");
    expect(c.snapshot?.notes).toEqual([{ ...one, x: 500, y: 600, rev: 2 }]);
    // Sockets from before hibernation can still edit.
    a.send({ type: "noteEdit", id: one.id, text: "Needs follow-up" });
    expect((await nextOfType(c, "noteUpdated")).note).toMatchObject({ text: "Needs follow-up", rev: 3 });
    closeAll(a, b, c);
  });

  it("notes survive a restart with every socket closed", async () => {
    const { code, a, stub } = await pair();
    const one = await addNote(a, "r1", "Idea one");
    const two = await addNote(a, "r2", "Needs follow-up");
    a.send({ type: "noteDelete", id: one.id });
    await nextOfType(a, "noteDeleted");
    await evictDurableObject(stub, { webSockets: "close" });

    const c = await TestClient.open(code);
    await c.enter("Kai");
    expect(c.snapshot?.notes).toEqual([two]);
    c.close();
  });

  it("records the current schema version", async () => {
    const { a, b, stub } = await pair();
    const version = await runInDurableObject(stub, (_room, state) =>
      state.storage.sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value,
    );
    expect(version).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(4);
    closeAll(a, b);
  });

  it("skips stored rows that don't validate rather than failing to load", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      seed(state.storage.sql, 1);
      state.storage.sql.exec("INSERT INTO notes (id, x, y, text, color, rev, author_id) VALUES ('bad', 0, 0, 'x', 'mauve', 1, 'x')");
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Kai");
    expect(c.snapshot?.notes).toHaveLength(1);
    c.close();
  });
});
