import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { NOTE_DEFAULTS, PROTOCOL_VERSION, type NoteItem, type ServerMessage } from "@stickyard/shared";
import { NoteStore, SCHEMA_VERSION } from "../src/noteStore";
import type { Room } from "../src/room";
import { V5_NOTES } from "./fixtures/schemaV5";
import { V6_FRAMES } from "./fixtures/schemaV6";
import { V12_SHAPE_ID } from "./fixtures/schemaV12";
import { V13_FRAME_INSERT, V13_FRAME_UPDATE, V13_GROUP_ID, V13_NOTE_INSERT, V13_NOTE_UPDATE, V13_SHAPE_INSERT, V13_SHAPE_UPDATE, loadSchemaV13 } from "./fixtures/schemaV13";
import { TestClient, migratedRows, nextOfType, specHostToken, specRoomCode } from "./helpers";

/*
 * Protocol v23, stored schema 14 (frame membership): notes, shapes and frames carry `placed`, a
 * per-room counter the relay advances on every add and every final move that changes a place. A
 * frame and what it carries share one value; the web carries only what was placed at or after the
 * frame. Generic fixtures.
 */

type Stub = DurableObjectStub<Room>;
type Row = Record<string, SqlStorageValue>;

async function newRoom() {
  const { code, id } = await specRoomCode();
  return { code, id, stub: env.ROOM.get(env.ROOM.idFromName(id)) as Stub };
}

async function pair() {
  const room = await newRoom();
  const a = await TestClient.open(room.code);
  const b = await TestClient.open(room.code);
  await a.enter("Alex");
  await b.enter("Sam");
  await nextOfType(a, "participant_joined");
  return { ...room, a, b };
}

const close = (...cs: TestClient[]) => cs.forEach((c) => c.close());
const version = (sql: SqlStorage) => sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value;
// Ordered by the first column (group_members is WITHOUT ROWID).
const tableRows = (sql: SqlStorage, table: string) => sql.exec<Row>(`SELECT * FROM ${table} ORDER BY 1`).toArray();
const placedOf = (stub: Stub, table: "notes" | "frames" | "shapes") =>
  runInDurableObject(stub, (_r, state) => state.storage.sql.exec<{ id: string; placed: number }>(`SELECT id, placed FROM ${table} ORDER BY rowid`).toArray());

async function addNote(c: TestClient, x: number, y: number) {
  c.send({ type: "noteAdd", clientRef: `n${x}-${y}`, x, y, color: "yellow", text: "" });
  return (await nextOfType(c, "noteAdded")).note;
}
async function addFrame(c: TestClient, x: number, y: number) {
  c.send({ type: "frameAdd", clientRef: `f${x}-${y}`, x, y, color: "neutral", title: "" });
  return (await nextOfType(c, "frameAdded")).frame;
}
async function finalMoved(c: TestClient, type: "noteMoved" | "frameMoved" | "shapeMoved") {
  for (;;) {
    const m = (await nextOfType(c, type)) as Extract<ServerMessage, { type: typeof type }>;
    if (m.final) return m;
  }
}

describe("versions", () => {
  it("protocol 23 and stored schema 14; a v22 page is asked to reload", async () => {
    expect(PROTOCOL_VERSION).toBe(23);
    expect(SCHEMA_VERSION).toBe(14);
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request({ type: "hello", protocolVersion: 22 })).toMatchObject({ type: "error", code: "version_mismatch" });
    c.close();
  });
});

describe("the placement counter", () => {
  it("every add takes the next value, sent with the item and stored", async () => {
    const { stub, a, b } = await pair();
    const note = await addNote(a, 100, 100);
    const frame = await addFrame(a, 600, 600);
    a.send({ type: "shapeAdd", clientRef: "s1", kind: "rect", x: 2000, y: 2000 });
    const shape = (await nextOfType(a, "shapeAdded")).shape;
    expect([note.placed, frame.placed, shape.placed]).toEqual([1, 2, 3]);
    // Everyone else gets the same values.
    expect((await nextOfType(b, "noteAdded")).note.placed).toBe(1);
    expect((await nextOfType(b, "frameAdded")).frame.placed).toBe(2);
    expect((await nextOfType(b, "shapeAdded")).shape.placed).toBe(3);
    expect(await placedOf(stub, "notes")).toEqual([{ id: note.id, placed: 1 }]);
    expect(await placedOf(stub, "frames")).toEqual([{ id: frame.id, placed: 2 }]);
    expect(await placedOf(stub, "shapes")).toEqual([{ id: shape.id, placed: 3 }]);
    close(a, b);
  });

  it("one itemsAdd is one placement: new notes inside new frames belong to them", async () => {
    const { a, b } = await pair();
    await addNote(a, 10, 10);
    const { w, h, ...style } = NOTE_DEFAULTS;
    const item = (ref: string, x: number): NoteItem => ({ ref, x, y: 100, w, h, text: "", color: "yellow", ...style });
    a.send({
      type: "itemsAdd",
      clientRef: "c1",
      notes: [item("n1", 100), item("n2", 300)],
      frames: [{ ref: "f1", x: 0, y: 0, w: 800, h: 600, title: "Ideas", color: "neutral", titleFontSize: "m", titleBold: true, titleItalic: false, titleTextColor: "auto", titleAlign: "left" }],
    });
    const added = await nextOfType(a, "itemsAdded");
    expect(added.notes.map((n) => n.note.placed)).toEqual([2, 2]);
    expect(added.frames.map((f) => f.frame.placed)).toEqual([2]);
    const theirs = await nextOfType(b, "itemsAdded");
    expect([...theirs.notes.map((n) => n.note.placed), ...theirs.frames.map((f) => f.frame.placed)]).toEqual([2, 2, 2]);
    close(a, b);
  });

  it("a final move that changes a place takes the next value; a live move or a drop in place takes none", async () => {
    const { stub, a, b } = await pair();
    const note = await addNote(a, 100, 100);
    a.send({ type: "noteMove", id: note.id, x: 150, y: 150, final: false });
    a.send({ type: "noteMove", id: note.id, x: 200, y: 200, final: true });
    expect(await finalMoved(a, "noteMoved")).toEqual({ type: "noteMoved", id: note.id, x: 200, y: 200, rev: 2, final: true, placed: 2 });
    // Dropped where it already is: no new place, no new value.
    a.send({ type: "noteMove", id: note.id, x: 200, y: 200, final: true });
    expect(await finalMoved(a, "noteMoved")).toEqual({ type: "noteMoved", id: note.id, x: 200, y: 200, rev: 2, final: true });
    // A resize is not a placement, even one that moves the corner.
    a.send({ type: "noteResize", id: note.id, x: 180, y: 180, w: 200, h: 200, final: true });
    await nextOfType(a, "noteResized");
    expect(await placedOf(stub, "notes")).toEqual([{ id: note.id, placed: 2 }]);
    // So the next placement is 3.
    expect((await addNote(a, 900, 900)).placed).toBe(3);
    close(a, b);
  });

  it("a final noteBatch is one placement for every note it moved (resizes take none)", async () => {
    const { a, b } = await pair();
    const one = await addNote(a, 100, 100);
    const two = await addNote(a, 300, 100);
    const three = await addNote(a, 500, 100);
    a.send({
      type: "noteBatch",
      final: true,
      ops: [
        { op: "move", id: one.id, x: 120, y: 120 },
        { op: "move", id: two.id, x: 320, y: 120 },
        { op: "resize", id: three.id, x: 500, y: 100, w: 300, h: 300 },
      ],
    });
    const applied = await nextOfType(b, "notesBatchApplied");
    expect(applied.results.map((r) => ("placed" in r ? r.placed : undefined))).toEqual([4, 4, undefined]);
    close(a, b);
  });

  it("a frame and everything it carries share one new value; a note it was dropped onto keeps its older one", async () => {
    const { stub, a, b } = await pair();
    const under = await addNote(a, 2000, 2000);
    const frame = await addFrame(a, 0, 0);
    const inside = await addNote(a, 100, 100);
    // The frame moves with its note, onto `under`.
    a.send({ type: "frameMove", id: frame.id, x: 1900, y: 1900, final: true, noteIds: [inside.id] });
    const moved = await finalMoved(b, "frameMoved");
    expect(moved).toMatchObject({ id: frame.id, x: 1900, y: 1900, final: true, placed: 4, notes: [{ id: inside.id, x: 2000, y: 2000 }] });
    const notes = Object.fromEntries((await placedOf(stub, "notes")).map((r) => [r.id, r.placed]));
    expect(notes).toEqual({ [under.id]: 1, [inside.id]: 4 });
    expect(await placedOf(stub, "frames")).toEqual([{ id: frame.id, placed: 4 }]);
    // `under` (1) was placed before the frame (4): a page carries only `inside` next time.
    expect(notes[under.id]).toBeLessThan(4);
    // Dropped where it is: nothing new.
    a.send({ type: "frameMove", id: frame.id, x: 1900, y: 1900, final: true, noteIds: [inside.id] });
    expect((await finalMoved(b, "frameMoved")).placed).toBeUndefined();
    close(a, b);
  });

  it("shapes too: shapeMove and a final shapeBatch move", async () => {
    const { a, b } = await pair();
    a.send({ type: "shapeAdd", clientRef: "s1", kind: "rect", x: 100, y: 100 });
    const shape = (await nextOfType(a, "shapeAdded")).shape;
    a.send({ type: "shapeMove", id: shape.id, x: 200, y: 200, final: true });
    expect((await finalMoved(b, "shapeMoved")).placed).toBe(2);
    a.send({ type: "shapeBatch", final: true, ops: [{ op: "move", id: shape.id, x: 300, y: 300 }] });
    const applied = await nextOfType(b, "shapesBatchApplied");
    expect(applied.results).toEqual([{ type: "shapeMoved", id: shape.id, x: 300, y: 300, rev: 3, final: true, placed: 3 }]);
    close(a, b);
  });

  it("survives a restart: the counter starts above every stored value", async () => {
    const { code, stub, a, b } = await pair();
    await addNote(a, 100, 100);
    await addFrame(a, 600, 600);
    close(a, b);
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Kai");
    expect(c.snapshot?.notes.map((n) => n.placed)).toEqual([1]);
    expect(c.frames?.frames.map((f) => f.placed)).toEqual([2]);
    expect((await addNote(c, 900, 900)).placed).toBe(3);
    c.close();
  });

  it("a sealed note's add and moves don't advance what everyone else sees (no gaps give them away)", async () => {
    const { code, id } = await newRoom();
    const host = await TestClient.open(code);
    const guest = await TestClient.open(code);
    await host.enter("Hana", "k".repeat(22));
    await guest.enter("Ari", "g".repeat(22));
    await nextOfType(host, "participant_joined");
    expect(await host.request({ type: "claimHost", token: await specHostToken(id) })).toEqual({ type: "hostGranted" });
    const before = await addFrame(host, 0, 0);
    expect(before.placed).toBe(1);
    expect(await host.request({ type: "silentStart" })).toMatchObject({ type: "silentChanged", active: true });
    guest.send({ type: "noteAdd", clientRef: "s1", x: 100, y: 100, color: "yellow", text: "Hidden" });
    const sealed = (await nextOfType(guest, "noteAdded")).note;
    // Placed at the current value (a tie counts as after the frame), not a new one.
    expect(sealed.placed).toBe(1);
    guest.send({ type: "noteMove", id: sealed.id, x: 300, y: 300, final: true });
    expect((await finalMoved(guest, "noteMoved")).placed).toBe(1);
    // The next public placement is 2: nothing skipped.
    expect((await addFrame(host, 2000, 2000)).placed).toBe(2);
    close(host, guest);
  });
});

describe(`schema migration 13 -> ${SCHEMA_VERSION}`, () => {
  it("adds placed (NOT NULL DEFAULT 0) to notes, frames and shapes; rows load with 0; everything else untouched", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV13(sql);
      const tables = ["notes", "frames", "votes", "shapes", "reactions", "connectors", "groups", "group_members"];
      const before = Object.fromEntries(tables.map((t) => [t, tableRows(sql, t)]));
      const store = new NoteStore(sql);
      expect(version(sql)).toBe(SCHEMA_VERSION);
      for (const [t, rows] of Object.entries(before)) expect(tableRows(sql, t), t).toEqual(migratedRows(t, rows));
      for (const t of ["notes", "frames", "shapes"]) {
        const column = sql.exec<{ name: string; dflt_value: string | null; notnull: number }>(`SELECT name, dflt_value, "notnull" FROM pragma_table_info('${t}')`).toArray().find((c) => c.name === "placed");
        expect(column, t).toEqual({ name: "placed", dflt_value: "0", notnull: 1 });
      }
      expect(store.all().every((n) => n.placed === 0)).toBe(true);
      expect(store.allFrames().map((f) => [f.id, f.placed])).toEqual(V6_FRAMES.map((f) => [f.id, 0]));
      expect(store.allShapes().map((s) => [s.id, s.placed])).toEqual([[V12_SHAPE_ID, 0]]);
      expect(store.allGroups().map((g) => g.id)).toEqual([V13_GROUP_ID]);
      // The counter starts above them all.
      expect(store.place()).toBe(1);
      // Runs once: a second load writes nothing.
      expect(new NoteStore(sql).rowsWritten).toBe(0);
    });
  });

  it("is idempotent if it was interrupted after adding some of the columns", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV13(sql);
      sql.exec("ALTER TABLE notes ADD COLUMN placed INTEGER NOT NULL DEFAULT 0");
      new NoteStore(sql);
      expect(version(sql)).toBe(SCHEMA_VERSION);
      for (const t of ["notes", "frames", "shapes"]) expect(tableRows(sql, t)[0], t).toHaveProperty("placed", 0);
    });
  });

  it("v13 code's insert and update statements still work on schema 14 (rollback safety): new rows get 0, updates keep the value", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV13(sql);
      new NoteStore(sql);
      sql.exec("UPDATE notes SET placed = 7 WHERE id = ?", V5_NOTES[0].id);
      sql.exec("UPDATE frames SET placed = 8 WHERE id = ?", V6_FRAMES[0].id);
      sql.exec("UPDATE shapes SET placed = 9 WHERE id = ?", V12_SHAPE_ID);
      sql.exec(V13_NOTE_INSERT, "v13note000000001", 10, 10, 160, 160, "New", "yellow", "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", 20, 1, "authorAAAAAAAAAA", 0, null);
      sql.exec(V13_NOTE_UPDATE, 50, 50, 160, 160, "Moved", "yellow", "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", 0, 2, V5_NOTES[0].id);
      sql.exec(V13_FRAME_INSERT, "v13frame00000001", 0, 0, 640, 400, "", "neutral", 1, "authorAAAAAAAAAA", "m", 1, 0, "auto", "left");
      sql.exec(V13_FRAME_UPDATE, 10, 10, 640, 400, "Start", "neutral", 2, "m", 1, 0, "auto", "left", V6_FRAMES[0].id);
      sql.exec(V13_SHAPE_INSERT, "v13shape00000001", "rect", 0, 0, 200, 120, "", "none", "neutral", "medium", "solid", "m", 0, 0, 0, "auto", "center", "middle", 30, 1, "authorAAAAAAAAAA");
      sql.exec(V13_SHAPE_UPDATE, 10, 10, 200, 120, "Moved", "none", "neutral", "medium", "solid", "m", 0, 0, 0, "auto", "center", "middle", 31, 2, V12_SHAPE_ID);
      const placed = (t: string, id: string) => sql.exec<{ placed: number }>(`SELECT placed FROM ${t} WHERE id = ?`, id).one().placed;
      expect([placed("notes", "v13note000000001"), placed("notes", V5_NOTES[0].id)]).toEqual([0, 7]);
      expect([placed("frames", "v13frame00000001"), placed("frames", V6_FRAMES[0].id)]).toEqual([0, 8]);
      expect([placed("shapes", "v13shape00000001"), placed("shapes", V12_SHAPE_ID)]).toEqual([0, 9]);
      // And the new code reads them all.
      const store = new NoteStore(sql);
      expect(store.get(V5_NOTES[0].id)?.placed).toBe(7);
      expect(store.place()).toBe(10);
    });
  });
});
