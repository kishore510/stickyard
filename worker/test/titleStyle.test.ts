import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { NOTE_DEFAULTS, type Note } from "@stickyard/shared";
import { NoteStore, SCHEMA_VERSION } from "../src/noteStore";
import type { Room } from "../src/room";
import { V3_INSERT, V3_NOTES, V3_UPDATE, loadSchemaV3 } from "./fixtures/schemaV3";
import { TestClient, nextOfType, specRoomCode } from "./helpers";

/* Protocol v6 (slice 2.7.2): the title's own size, bold, italic and ink, and the schema 3 -> 4 migration. Generic fixtures. */

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

type StyleRow = {
  font_size: string;
  bold: number;
  italic: number;
  text_color: string;
  title_font_size: string;
  title_bold: number;
  title_italic: number;
  title_text_color: string;
  rev: number;
};

const rowsWritten = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (room: Room) => room.rowsWritten);
const stored = (stub: DurableObjectStub<Room>) =>
  runInDurableObject(stub, (_room, state) =>
    state.storage.sql
      .exec<StyleRow>("SELECT font_size, bold, italic, text_color, title_font_size, title_bold, title_italic, title_text_color, rev FROM notes ORDER BY rowid")
      .toArray(),
  );
const version = (sql: SqlStorage) => sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value;
const columns = (sql: SqlStorage) => sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('notes')").toArray().map((c) => c.name);

describe("title style", () => {
  it("new notes start with the default title style, like the body", async () => {
    const { a, b, note, stub } = await pair();
    expect(note).toMatchObject({ titleFontSize: "m", titleBold: false, titleItalic: false, titleTextColor: "auto" });
    expect(await stored(stub)).toEqual([
      { font_size: "m", bold: 0, italic: 0, text_color: "auto", title_font_size: "m", title_bold: 0, title_italic: 0, title_text_color: "auto", rev: 1 },
    ]);
    a.close();
    b.close();
  });

  it("an edit styles the title apart from the body, persists it and broadcasts the whole note", async () => {
    const { a, b, note, stub } = await pair();
    a.send({ type: "noteEdit", id: note.id, titleFontSize: "xl", titleBold: true, titleItalic: true, titleTextColor: "purple" });
    const expected: Note = { ...note, titleFontSize: "xl", titleBold: true, titleItalic: true, titleTextColor: "purple", rev: 2 };
    expect((await nextOfType(b, "noteUpdated")).note).toEqual(expected);
    expect((await nextOfType(a, "noteUpdated")).note).toEqual(expected);
    a.send({ type: "noteEdit", id: note.id, fontSize: "s", textColor: "green" });
    expect((await nextOfType(b, "noteUpdated")).note).toEqual({ ...expected, fontSize: "s", textColor: "green", rev: 3 });
    expect(await stored(stub)).toEqual([
      { font_size: "s", bold: 0, italic: 0, text_color: "green", title_font_size: "xl", title_bold: 1, title_italic: 1, title_text_color: "purple", rev: 3 },
    ]);
    a.close();
    b.close();
  });

  it("an unchanged title style writes and sends nothing", async () => {
    const { a, b, note, stub } = await pair();
    const before = await rowsWritten(stub);
    a.send({ type: "noteEdit", id: note.id, titleFontSize: "m", titleBold: false, titleTextColor: "auto" });
    expect(await b.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(before);
    a.close();
    b.close();
  });

  it("an edit with a bad title key is refused (bad_message) and changes nothing", async () => {
    const { a, b, note, stub } = await pair();
    const before = await rowsWritten(stub);
    a.send({ type: "noteEdit", id: note.id, titleFontSize: "huge" });
    expect(await nextOfType(a, "error")).toMatchObject({ code: "bad_message" });
    expect(await b.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(before);
    a.close();
    b.close();
  });
});

describe(`schema migration 3 -> ${SCHEMA_VERSION}`, () => {
  it("adds the four title columns and copies each note's body style into them, so nothing looks different", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV3(sql);
      const notes = new NoteStore(sql).all();
      expect(version(sql)).toBe(4);
      expect(columns(sql)).toEqual(expect.arrayContaining(["title_font_size", "title_bold", "title_italic", "title_text_color"]));
      expect(notes.map((n) => [n.id, n.titleFontSize, n.titleBold, n.titleItalic, n.titleTextColor])).toEqual(
        V3_NOTES.map((n) => [n.id, n.font_size, n.bold === 1, n.italic === 1, n.text_color]),
      );
      // Everything else is as it was, including both alignments.
      expect(notes[1]).toMatchObject({ w: 300, h: 200, fontSize: "xl", bold: true, textColor: "blue", align: "center", titleAlign: "right", rev: 4 });
    });
  });

  it("runs once: a second load writes nothing and keeps a title styled after migrating", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV3(sql);
      const notes = new NoteStore(sql).all();
      sql.exec("UPDATE notes SET title_font_size = 'l', title_bold = 1 WHERE id = ?", V3_NOTES[0].id);
      const again = new NoteStore(sql);
      expect(again.rowsWritten).toBe(0);
      expect(again.all()[0]).toEqual({ ...notes[0], titleFontSize: "l", titleBold: true });
      expect(version(sql)).toBe(SCHEMA_VERSION);
    });
  });

  it("is idempotent if interrupted after adding some of the columns", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV3(sql);
      sql.exec("ALTER TABLE notes ADD COLUMN title_font_size TEXT NOT NULL DEFAULT 'm'");
      sql.exec("ALTER TABLE notes ADD COLUMN title_bold INTEGER NOT NULL DEFAULT 0");
      const notes = new NoteStore(sql).all();
      expect(version(sql)).toBe(SCHEMA_VERSION);
      expect(notes.map((n) => [n.titleFontSize, n.titleBold, n.titleItalic, n.titleTextColor])).toEqual(
        V3_NOTES.map((n) => [n.font_size, n.bold === 1, n.italic === 1, n.text_color]),
      );
    });
  });

  it("notes survive a restart after migration", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => loadSchemaV3(state.storage.sql));
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Kai");
    expect(c.snapshot?.notes.map((n) => [n.id, n.titleFontSize, n.titleTextColor])).toEqual(V3_NOTES.map((n) => [n.id, n.font_size, n.text_color]));
    c.close();
  });

  it("v5 code's insert and update statements still work on schema 4 (rollback safety): its new notes get the default title style", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV3(sql);
      new NoteStore(sql);
      expect(version(sql)).toBe(SCHEMA_VERSION);
      // Exactly what the v5 NoteStore runs: an insert without the title columns...
      sql.exec(V3_INSERT, "fromV5code000001", 0, 0, 160, 160, "x", "yellow", "xl", 1, 1, "red", "center", "right", 1, "AAAAAAAAAAAAAAAA");
      // ...and an update that leaves them alone.
      const n = V3_NOTES[1];
      sql.exec(V3_UPDATE, 10, 20, n.w, n.h, "Edited by v5", n.color, "s", 0, 0, "green", n.align, n.title_align, n.rev + 1, n.id);
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Kai");
    const notes = c.snapshot?.notes ?? [];
    expect(notes.find((n) => n.id === "fromV5code000001")).toMatchObject({
      fontSize: "xl",
      bold: true,
      textColor: "red",
      titleFontSize: NOTE_DEFAULTS.titleFontSize,
      titleBold: NOTE_DEFAULTS.titleBold,
      titleItalic: NOTE_DEFAULTS.titleItalic,
      titleTextColor: NOTE_DEFAULTS.titleTextColor,
    });
    // The update kept the title style the migration copied.
    expect(notes.find((n) => n.id === V3_NOTES[1].id)).toMatchObject({ x: 10, y: 20, text: "Edited by v5", fontSize: "s", titleFontSize: "xl", titleBold: true, titleTextColor: "blue" });
    c.close();
  });
});
