import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  NOTE_DEFAULTS,
  NOTE_MAX_H,
  NOTE_MAX_W,
  NOTE_MIN_H,
  NOTE_MIN_W,
  type Note,
  type ServerMessage,
} from "@stickyard/shared";
import { NoteStore, SCHEMA_VERSION } from "../src/noteStore";
import type { Room } from "../src/room";
import { V1_NOTES, loadSchemaV1 } from "./fixtures/schemaV1";
import { TestClient, nextOfType, specRoomCode } from "./helpers";

/*
 * Protocol v4 (slice 2.7): note size, colour change and text style, and the schema 1 -> 2
 * migration. Fixture text is generic on purpose.
 */

async function newRoom() {
  const { code, id } = await specRoomCode();
  const stub = env.ROOM.get(env.ROOM.idFromName(id));
  return { code, stub };
}

async function pair() {
  const room = await newRoom();
  const a = await TestClient.open(room.code);
  const b = await TestClient.open(room.code);
  const ja = await a.enter("Alex");
  const jb = await b.enter("Sam");
  await nextOfType(a, "participant_joined");
  return { ...room, a, b, ja, jb };
}

async function addNote(c: TestClient, x = 100, y = 120): Promise<Note> {
  c.send({ type: "noteAdd", clientRef: "ref-1", x, y, color: "yellow", text: "Idea one" });
  return (await nextOfType(c, "noteAdded")).note;
}

/** Adds a note on `a` and waits until `b` has it too. */
async function shared(a: TestClient, b: TestClient, x?: number, y?: number): Promise<Note> {
  const note = await addNote(a, x, y);
  await nextOfType(b, "noteAdded");
  return note;
}

const rowsWritten = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (room: Room) => room.rowsWritten);

interface StoredRow {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  color: string;
  font_size: string;
  bold: number;
  italic: number;
  text_color: string;
  align: string;
  rev: number;
}
const storedNotes = (stub: DurableObjectStub<Room>) =>
  runInDurableObject(stub, (_room, state) =>
    state.storage.sql
      .exec<StoredRow>("SELECT id, x, y, w, h, text, color, font_size, bold, italic, text_color, align, rev FROM notes ORDER BY rowid")
      .toArray(),
  );

const closeAll = (...clients: TestClient[]) => {
  for (const c of clients) c.close();
};

const resize = (id: string, x: number, y: number, w: number, h: number, final: boolean) => ({ type: "noteResize", id, x, y, w, h, final });

describe("new notes", () => {
  it("get the default size and style", async () => {
    const { a, b, stub } = await pair();
    const note = await addNote(a);
    expect(note).toMatchObject(NOTE_DEFAULTS);
    expect(await storedNotes(stub)).toMatchObject([{ w: NOTE_DEFAULTS.w, h: NOTE_DEFAULTS.h, font_size: "m", bold: 0, italic: 0, text_color: "auto", align: "left" }]);
    closeAll(a, b);
  });
});

describe("noteResize", () => {
  it("non-final resizes go to the others only, keep rev, are coalesced, and write nothing", async () => {
    const { a, b, stub } = await pair();
    const note = await shared(a, b);
    const before = await rowsWritten(stub);
    for (let i = 1; i <= 5; i++) a.send(resize(note.id, 100, 120, 160 + i * 10, 160, false));
    let last: Extract<ServerMessage, { type: "noteResized" }> | null = null;
    while (last?.w !== 210) last = await nextOfType(b, "noteResized");
    expect(last).toEqual({ type: "noteResized", id: note.id, x: 100, y: 120, w: 210, h: 160, rev: 1, final: false });
    expect(await a.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(before);
    expect(await storedNotes(stub)).toMatchObject([{ w: 160, h: 160, rev: 1 }]);
    closeAll(a, b);
  });

  it("a final resize applies position and size together, bumps rev, writes once, and goes to everyone", async () => {
    const { a, b, stub } = await pair();
    const note = await shared(a, b);
    const before = await rowsWritten(stub);
    // Dragged by the top-left corner: x/y and w/h change together.
    a.send(resize(note.id, 60, 80, 200, 200, false));
    a.send(resize(note.id, 50, 70, 210, 210, true));
    const expected = { type: "noteResized", id: note.id, x: 50, y: 70, w: 210, h: 210, rev: 2, final: true };
    expect(await nextOfType(a, "noteResized")).toEqual(expected);
    let seen = await nextOfType(b, "noteResized");
    while (!seen.final) seen = await nextOfType(b, "noteResized");
    expect(seen).toEqual(expected);
    expect(await rowsWritten(stub)).toBe(before + 1);
    expect(await storedNotes(stub)).toMatchObject([{ x: 50, y: 70, w: 210, h: 210, rev: 2 }]);
    closeAll(a, b);
  });

  it("an unchanged final resize writes nothing and keeps rev, but still tells everyone where it ended", async () => {
    const { a, b, stub } = await pair();
    const note = await shared(a, b);
    const before = await rowsWritten(stub);
    a.send(resize(note.id, note.x, note.y, note.w, note.h, true));
    expect(await nextOfType(b, "noteResized")).toMatchObject({ rev: 1, final: true });
    expect(await rowsWritten(stub)).toBe(before);
    closeAll(a, b);
  });

  it.each([
    ["bottom-right", { x: BOARD_WIDTH - 200, y: BOARD_HEIGHT - 200, w: 400, h: 400 }],
    ["top-left (x/y already at 0)", { x: 0, y: 0, w: NOTE_MAX_W, h: NOTE_MAX_H }],
    ["top-right", { x: BOARD_WIDTH - 100, y: 0, w: 300, h: 300 }],
    ["bottom-left", { x: 0, y: BOARD_HEIGHT - 50, w: 250, h: 250 }],
    ["the far corner", { x: BOARD_WIDTH, y: BOARD_HEIGHT, w: NOTE_MAX_W, h: NOTE_MAX_H }],
  ])("clamping keeps the note inside the board (%s)", async (_label, rect) => {
    const { a, b, stub } = await pair();
    const note = await shared(a, b);
    a.send(resize(note.id, rect.x, rect.y, rect.w, rect.h, true));
    const got = await nextOfType(a, "noteResized");
    expect(got.w).toBe(rect.w);
    expect(got.h).toBe(rect.h);
    expect(got.x).toBeGreaterThanOrEqual(0);
    expect(got.y).toBeGreaterThanOrEqual(0);
    expect(got.x + got.w).toBeLessThanOrEqual(BOARD_WIDTH);
    expect(got.y + got.h).toBeLessThanOrEqual(BOARD_HEIGHT);
    const [stored] = await storedNotes(stub);
    expect(stored).toMatchObject({ x: got.x, y: got.y, w: got.w, h: got.h });
    closeAll(a, b);
  });

  it("a move after a resize is clamped at the note's own size", async () => {
    const { a, b } = await pair();
    const note = await shared(a, b);
    a.send(resize(note.id, 0, 0, NOTE_MAX_W, NOTE_MIN_H, true));
    await nextOfType(a, "noteResized");
    a.send({ type: "noteMove", id: note.id, x: BOARD_WIDTH, y: BOARD_HEIGHT, final: true });
    expect(await nextOfType(a, "noteMoved")).toMatchObject({ x: BOARD_WIDTH - NOTE_MAX_W, y: BOARD_HEIGHT - NOTE_MIN_H });
    closeAll(a, b);
  });

  it.each([
    ["below min", resize("NNNNNNNNNNNNNNNN", 1, 1, NOTE_MIN_W - 1, 200, true)],
    ["above max", resize("NNNNNNNNNNNNNNNN", 1, 1, 200, NOTE_MAX_H + 1, true)],
    ["fractional", resize("NNNNNNNNNNNNNNNN", 1, 1, 200.5, 200, true)],
    ["with a claimed rev", { ...resize("NNNNNNNNNNNNNNNN", 1, 1, 200, 200, true), rev: 9 }],
  ])("rejects a resize %s with bad_message", async (_label, message) => {
    const { a, b } = await pair();
    expect(await a.request(message)).toMatchObject({ type: "error", code: "bad_message" });
    expect(await b.quiet()).toBe(true);
    closeAll(a, b);
  });

  it("is ignored silently for an unknown id", async () => {
    const { a, b, stub } = await pair();
    const before = await rowsWritten(stub);
    a.send(resize("ZZZZZZZZZZZZZZZZ", 1, 1, 200, 200, true));
    a.send(resize("ZZZZZZZZZZZZZZZZ", 1, 1, 200, 200, false));
    expect(await a.quiet()).toBe(true);
    expect(await b.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(before);
    closeAll(a, b);
  });

  it("is ignored silently after the note is deleted", async () => {
    const { a, b } = await pair();
    const note = await shared(a, b);
    b.send({ type: "noteDelete", id: note.id });
    await nextOfType(a, "noteDeleted");
    await nextOfType(b, "noteDeleted");
    a.send(resize(note.id, 1, 1, 200, 200, true));
    expect(await a.quiet()).toBe(true);
    expect(await b.quiet()).toBe(true);
    closeAll(a, b);
  });

  it("before join gets not_joined with the note id", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    await c.request({ type: "hello", protocolVersion: 4 });
    expect(await c.request(resize("NNNNNNNNNNNNNNNN", 1, 1, 200, 200, true))).toMatchObject({ type: "error", code: "not_joined", noteId: "NNNNNNNNNNNNNNNN" });
    c.close();
  });

  it("counts against the per-socket rate budget, naming the note when dropped", async () => {
    const { a, b, stub } = await pair();
    const note = await shared(a, b);
    const limited: ServerMessage[] = [];
    let resized = 0;
    for (let sent = 0; limited.length === 0 && sent < 1000; ) {
      for (let i = 0; i < 10; i++, sent++) a.send(resize(note.id, 1, 1, NOTE_MIN_W + (sent % 300), 200, true));
      for (let i = 0; i < 10; i++) {
        const m = await a.next();
        if (m.type === "error") limited.push(m);
        else if (m.type === "noteResized") resized++;
      }
    }
    expect(limited[0]).toMatchObject({ code: "rate_limited", noteId: note.id });
    const [stored] = await storedNotes(stub);
    expect(stored?.rev).toBeLessThanOrEqual(1 + resized);
    closeAll(a, b);
  });
});

describe("noteEdit with colour and style", () => {
  it("a colour change persists, bumps rev and broadcasts the full note", async () => {
    const { a, b, stub } = await pair();
    const note = await shared(a, b);
    b.send({ type: "noteEdit", id: note.id, color: "blue" });
    const expected = { type: "noteUpdated", note: { ...note, color: "blue", rev: 2 } };
    expect(await nextOfType(a, "noteUpdated")).toEqual(expected);
    expect(await nextOfType(b, "noteUpdated")).toEqual(expected);
    expect(await storedNotes(stub)).toMatchObject([{ color: "blue", rev: 2 }]);
    closeAll(a, b);
  });

  it("style fields persist together, one rev for one message", async () => {
    const { a, b, stub } = await pair();
    const note = await shared(a, b);
    a.send({ type: "noteEdit", id: note.id, fontSize: "xl", bold: true, italic: true, textColor: "red", align: "center" });
    const got = await nextOfType(b, "noteUpdated");
    expect(got.note).toEqual({ ...note, fontSize: "xl", bold: true, italic: true, textColor: "red", align: "center", rev: 2 });
    expect(await storedNotes(stub)).toMatchObject([{ font_size: "xl", bold: 1, italic: 1, text_color: "red", align: "center", rev: 2 }]);
    closeAll(a, b);
  });

  it("text and style in one edit", async () => {
    const { a, b } = await pair();
    const note = await shared(a, b);
    a.send({ type: "noteEdit", id: note.id, text: "  Needs follow-up ", bold: true });
    expect((await nextOfType(b, "noteUpdated")).note).toMatchObject({ text: "Needs follow-up", bold: true, rev: 2 });
    closeAll(a, b);
  });

  it("an edit that changes nothing writes nothing and sends nothing", async () => {
    const { a, b, stub } = await pair();
    const note = await shared(a, b);
    const before = await rowsWritten(stub);
    a.send({ type: "noteEdit", id: note.id, color: "yellow", fontSize: "m", bold: false, italic: false, textColor: "auto", align: "left", text: "Idea one" });
    expect(await a.quiet()).toBe(true);
    expect(await b.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(before);
    closeAll(a, b);
  });

  it("keeps the author and position, whoever edits", async () => {
    const { a, b, ja } = await pair();
    const note = await shared(a, b);
    b.send({ type: "noteEdit", id: note.id, italic: true });
    expect((await nextOfType(a, "noteUpdated")).note).toMatchObject({ authorId: ja.you.id, x: note.x, y: note.y, w: note.w, h: note.h });
    closeAll(a, b);
  });

  it("authorId can't be spoofed through an edit", async () => {
    const { a, b, jb } = await pair();
    const note = await shared(a, b);
    expect(await b.request({ type: "noteEdit", id: note.id, bold: true, authorId: jb.you.id })).toMatchObject({ type: "error", code: "bad_message" });
    closeAll(a, b);
  });

  it.each([
    ["a hex colour", { color: "#ffcc00" }],
    ["a bad font size", { fontSize: "huge" }],
    ["no editable field", {}],
  ])("refuses %s with bad_message", async (_label, fields) => {
    const { a, b, stub } = await pair();
    const note = await shared(a, b);
    expect(await a.request({ type: "noteEdit", id: note.id, ...fields })).toMatchObject({ type: "error", code: "bad_message" });
    expect(await storedNotes(stub)).toMatchObject([{ color: "yellow", font_size: "m", rev: 1 }]);
    closeAll(a, b);
  });

  it("is ignored silently for an unknown id", async () => {
    const { a, b, stub } = await pair();
    const before = await rowsWritten(stub);
    a.send({ type: "noteEdit", id: "ZZZZZZZZZZZZZZZZ", color: "blue" });
    expect(await a.quiet()).toBe(true);
    expect(await b.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(before);
    closeAll(a, b);
  });
});

describe("persistence of sizes and styles", () => {
  it("a resized, styled note survives hibernation and a restart", async () => {
    const { code, a, b, stub } = await pair();
    const note = await shared(a, b);
    a.send(resize(note.id, 40, 40, 300, 220, true));
    await nextOfType(a, "noteResized");
    a.send({ type: "noteEdit", id: note.id, color: "green", bold: true, textColor: "blue" });
    const { note: styled } = await nextOfType(a, "noteUpdated");
    expect(styled).toMatchObject({ x: 40, y: 40, w: 300, h: 220, color: "green", bold: true, textColor: "blue", rev: 3 });

    await evictDurableObject(stub, { webSockets: "hibernate" });
    const c = await TestClient.open(code);
    await c.enter("Kai");
    expect(c.snapshot?.notes).toEqual([styled]);
    closeAll(a, b, c);

    await evictDurableObject(stub, { webSockets: "close" });
    const d = await TestClient.open(code);
    await d.enter("Kai");
    expect(d.snapshot?.notes).toEqual([styled]);
    d.close();
  });
});

describe(`schema migration 1 -> ${SCHEMA_VERSION}`, () => {
  const version = (sql: SqlStorage) => sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value;

  it("gives every old note the default size and style, and records the new version", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV1(sql);
      expect(version(sql)).toBe(1);
      const store = new NoteStore(sql);
      expect(version(sql)).toBe(2);
      const notes = store.all();
      expect(notes).toHaveLength(V1_NOTES.length);
      for (const [i, old] of V1_NOTES.entries()) {
        expect(notes[i]).toEqual({
          id: old.id,
          x: old.x,
          y: old.y,
          text: old.text,
          color: old.color,
          rev: old.rev,
          authorId: old.author_id,
          ...NOTE_DEFAULTS,
        });
      }
    });
  });

  it("runs once: a second load changes nothing", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV1(sql);
      const first = new NoteStore(sql);
      const notes = first.all();
      // A second ALTER TABLE ADD COLUMN would throw: this proves the step is skipped.
      const second = new NoteStore(sql);
      expect(second.rowsWritten).toBe(0);
      expect(second.all()).toEqual(notes);
      expect(version(sql)).toBe(2);
    });
  });

  it("is idempotent if it was interrupted after adding some columns", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV1(sql);
      sql.exec("ALTER TABLE notes ADD COLUMN w INTEGER NOT NULL DEFAULT 160");
      const store = new NoteStore(sql);
      expect(version(sql)).toBe(2);
      expect(store.all()).toHaveLength(V1_NOTES.length);
    });
  });

  it("old notes survive a restart after migration and can then be resized and styled", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => loadSchemaV1(state.storage.sql));
    await evictDurableObject(stub, { webSockets: "close" });

    const a = await TestClient.open(code);
    await a.enter("Alex");
    expect(a.snapshot?.notes.map((n) => [n.id, n.w, n.h, n.fontSize, n.textColor])).toEqual(
      V1_NOTES.map((n) => [n.id, NOTE_DEFAULTS.w, NOTE_DEFAULTS.h, "m", "auto"]),
    );
    const id = V1_NOTES[0].id;
    a.send(resize(id, 0, 0, 240, 240, true));
    expect(await nextOfType(a, "noteResized")).toMatchObject({ w: 240, rev: 2 });
    a.close();

    await evictDurableObject(stub, { webSockets: "close" });
    const b = await TestClient.open(code);
    await b.enter("Sam");
    expect(b.snapshot?.notes[0]).toMatchObject({ id, w: 240, h: 240, rev: 2 });
    b.close();
  });

  it("v3 code writing to a migrated table still works (rollback safety): new columns have defaults", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      // Exactly the statements slice 2's NoteStore runs.
      state.storage.sql.exec(
        "INSERT INTO notes (id, x, y, text, color, rev, author_id) VALUES ('fromV3code000001', 3040, 0, 'Idea one', 'yellow', 1, 'AAAAAAAAAAAAAAAA')",
      );
      state.storage.sql.exec("UPDATE notes SET x = ?, y = ?, text = ?, rev = ? WHERE id = ?", 3040, 10, "Idea one", 2, "fromV3code000001");
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const a = await TestClient.open(code);
    await a.enter("Alex");
    expect(a.snapshot?.notes).toEqual([
      expect.objectContaining({ id: "fromV3code000001", x: 3040, y: 10, rev: 2, ...NOTE_DEFAULTS }),
    ]);
    a.close();
  });

  it("a row left off the board at its size (by older code) is clamped on load, not dropped", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      state.storage.sql.exec(
        "INSERT INTO notes (id, x, y, w, h, text, color, rev, author_id) VALUES ('offBoardNote0001', 3040, 1840, 400, 300, 'x', 'yellow', 1, 'AAAAAAAAAAAAAAAA')",
      );
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const a = await TestClient.open(code);
    await a.enter("Alex");
    expect(a.snapshot?.notes).toEqual([expect.objectContaining({ id: "offBoardNote0001", x: BOARD_WIDTH - 400, y: BOARD_HEIGHT - 300, w: 400, h: 300 })]);
    a.close();
  });
});
