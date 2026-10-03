import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { NOTE_DEFAULTS, type Note } from "@stickyard/shared";
import { NoteStore, SCHEMA_VERSION } from "../src/noteStore";
import type { Room } from "../src/room";
import { V2_NOTES, loadSchemaV2 } from "./fixtures/schemaV2";
import { TestClient, nextOfType, specRoomCode } from "./helpers";

/* Protocol v5 (slice 2.7.1): titleAlign, and the schema 2 -> 3 migration. Generic fixtures. */

async function newRoom() {
  const { code, id } = await specRoomCode();
  return { code, stub: env.ROOM.get(env.ROOM.idFromName(id)) };
}

async function pair() {
  const room = await newRoom();
  const a = await TestClient.open(room.code);
  const b = await TestClient.open(room.code);
  await a.enter("Alex");
  await b.enter("Sam");
  await nextOfType(a, "participant_joined");
  a.send({ type: "noteAdd", clientRef: "r1", x: 10, y: 10, color: "yellow", text: "Idea one\nThe details" });
  const { note } = await nextOfType(a, "noteAdded");
  await nextOfType(b, "noteAdded");
  return { ...room, a, b, note };
}

const rowsWritten = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (room: Room) => room.rowsWritten);
const stored = (stub: DurableObjectStub<Room>) =>
  runInDurableObject(stub, (_room, state) =>
    state.storage.sql.exec<{ align: string; title_align: string; rev: number }>("SELECT align, title_align, rev FROM notes ORDER BY rowid").toArray(),
  );
const version = (sql: SqlStorage) => sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value;

describe("titleAlign", () => {
  it("new notes start with the title aligned left", async () => {
    const { a, b, note, stub } = await pair();
    expect(note.titleAlign).toBe("left");
    expect(await stored(stub)).toEqual([{ align: "left", title_align: "left", rev: 1 }]);
    a.close();
    b.close();
  });

  it("an edit sets the title's alignment apart from the body's, persists it and broadcasts the note", async () => {
    const { a, b, note, stub } = await pair();
    a.send({ type: "noteEdit", id: note.id, titleAlign: "center" });
    const expected: Note = { ...note, titleAlign: "center", rev: 2 };
    expect((await nextOfType(b, "noteUpdated")).note).toEqual(expected);
    a.send({ type: "noteEdit", id: note.id, align: "right" });
    expect((await nextOfType(b, "noteUpdated")).note).toEqual({ ...expected, align: "right", rev: 3 });
    expect(await stored(stub)).toEqual([{ align: "right", title_align: "center", rev: 3 }]);
    a.close();
    b.close();
  });

  it("an unchanged title alignment writes and sends nothing", async () => {
    const { a, b, note, stub } = await pair();
    const before = await rowsWritten(stub);
    a.send({ type: "noteEdit", id: note.id, titleAlign: "left" });
    expect(await b.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(before);
    a.close();
    b.close();
  });
});

describe(`schema migration 2 -> ${SCHEMA_VERSION}`, () => {
  it("each existing note's title keeps the alignment it had (title_align = align), so nothing looks different", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV2(sql);
      const notes = new NoteStore(sql).all();
      expect(version(sql)).toBe(SCHEMA_VERSION);
      expect(notes.map((n) => [n.id, n.align, n.titleAlign])).toEqual(V2_NOTES.map((n) => [n.id, n.align, n.align]));
      expect(notes[1]).toMatchObject({ w: 300, h: 200, fontSize: "xl", bold: true, textColor: "blue", rev: 4 });
    });
  });

  it("runs once: a second load writes nothing and changes nothing", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV2(sql);
      const notes = new NoteStore(sql).all();
      // A title edited after migrating must not be reset by a second load.
      sql.exec("UPDATE notes SET title_align = 'right' WHERE id = ?", V2_NOTES[0].id);
      const again = new NoteStore(sql);
      expect(again.rowsWritten).toBe(0);
      expect(again.all()[0]).toEqual({ ...notes[0], titleAlign: "right" });
      expect(version(sql)).toBe(SCHEMA_VERSION);
    });
  });

  it("is idempotent if interrupted after adding the column", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV2(sql);
      sql.exec("ALTER TABLE notes ADD COLUMN title_align TEXT NOT NULL DEFAULT 'left'");
      const notes = new NoteStore(sql).all();
      expect(notes.map((n) => n.titleAlign)).toEqual(V2_NOTES.map((n) => n.align));
    });
  });

  it("notes survive a restart after migration", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => loadSchemaV2(state.storage.sql));
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Kai");
    expect(c.snapshot?.notes.map((n) => [n.id, n.titleAlign])).toEqual(V2_NOTES.map((n) => [n.id, n.align]));
    c.close();
  });

  it("v4 code writing to the migrated table still works (rollback safety): the title is aligned left", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      state.storage.sql.exec(
        "INSERT INTO notes (id, x, y, w, h, text, color, font_size, bold, italic, text_color, align, rev, author_id) VALUES ('fromV4code000001', 0, 0, 160, 160, 'x', 'yellow', 'm', 0, 0, 'auto', 'center', 1, 'AAAAAAAAAAAAAAAA')",
      );
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Kai");
    expect(c.snapshot?.notes).toEqual([expect.objectContaining({ id: "fromV4code000001", align: "center", titleAlign: NOTE_DEFAULTS.titleAlign })]);
    c.close();
  });
});
