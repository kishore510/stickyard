import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_BATCH_ENTRIES, NOTE_Z_LIMIT, PROTOCOL_VERSION, stackOrder, type ServerMessage } from "@stickyard/shared";
import { BATCH_LIMITS, SOCKET_LIMITS } from "../src/limits";
import { NoteStore, SCHEMA_VERSION } from "../src/noteStore";
import type { Room } from "../src/room";
import { V4_INSERT, V4_NOTES, V4_UPDATE, loadSchemaV4 } from "./fixtures/schemaV4";
import { TestClient, nextOfType, specRoomCode } from "./helpers";

/*
 * Protocol v8 (slice z-order): notes carry a server-assigned z; notesOrder brings notes to the
 * front or sends them to the back, in one transaction and one broadcast; stored schema 5 adds
 * the z column, backfilled from creation order. Generic fixtures.
 */

const id = (i: number) => `seed${String(i).padStart(12, "0")}`;

async function newRoom() {
  const { code, id: roomId } = await specRoomCode();
  return { code, stub: env.ROOM.get(env.ROOM.idFromName(roomId)) };
}

/** A room seeded with notes at the given z values (id(i) has zs[i]), and two joined clients. */
async function room(zs: readonly number[] = [0, 1, 2, 3, 4]) {
  const { code, stub } = await newRoom();
  await runInDurableObject(stub, (_room, state) => {
    zs.forEach((z, i) => {
      state.storage.sql.exec(
        "INSERT INTO notes (id, x, y, text, color, rev, author_id, z) VALUES (?, ?, ?, 'Idea one', 'yellow', 1, 'AAAAAAAAAAAAAAAA', ?)",
        id(i),
        i * 10,
        i * 5,
        z,
      );
    });
  });
  const a = await TestClient.open(code);
  const b = await TestClient.open(code);
  await a.enter("Alex");
  await b.enter("Sam");
  await nextOfType(a, "participant_joined");
  return { code, stub, a, b };
}

const rowsWritten = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (r: Room) => r.rowsWritten);
const transactions = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (r: Room) => r.transactions);
const stored = (stub: DurableObjectStub<Room>) =>
  runInDurableObject(stub, (_r, state) => state.storage.sql.exec<{ id: string; z: number; rev: number }>("SELECT id, z, rev FROM notes ORDER BY rowid").toArray());
/** Stored ids, bottom to top. */
const stacked = async (stub: DurableObjectStub<Room>) => stackOrder(await stored(stub)).map((n) => n.id);
const close = (...cs: TestClient[]) => cs.forEach((c) => c.close());
const version = (sql: SqlStorage) => sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value;

describe("version", () => {
  it("a protocol v7 page is refused with version_mismatch (please reload)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(PROTOCOL_VERSION).toBe(8);
    expect(await c.request({ type: "hello", protocolVersion: 7 })).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Alex" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });
});

describe("new notes", () => {
  it("go on top (max z + 1) and the snapshot carries z", async () => {
    const { code, stub, a, b } = await room([3, -2]);
    expect(a.snapshot?.notes.map((n) => n.z)).toEqual([3, -2]);
    a.send({ type: "noteAdd", clientRef: "r1", x: 10, y: 10, color: "yellow", text: "" });
    const added = await nextOfType(a, "noteAdded");
    expect(added.note.z).toBe(4);
    expect((await nextOfType(b, "noteAdded")).note.z).toBe(4);
    expect((await stacked(stub)).at(-1)).toBe(added.note.id);
    const c = await TestClient.open(code);
    await c.enter("Kai");
    expect(c.snapshot?.notes.find((n) => n.id === added.note.id)?.z).toBe(4);
    close(a, b, c);
  });

  it("at the bound, the room is renormalised (reported first) and the new note still goes on top", async () => {
    const { stub, a, b } = await room([NOTE_Z_LIMIT, -3]);
    a.send({ type: "noteAdd", clientRef: "r1", x: 10, y: 10, color: "yellow", text: "" });
    const ordered = await nextOfType(b, "notesOrdered");
    const added = await nextOfType(b, "noteAdded");
    expect(ordered.results.map((r) => r.id).sort()).toEqual([id(0), id(1)]);
    const rows = await stored(stub);
    expect(rows.every((r) => Math.abs(r.z) <= NOTE_Z_LIMIT)).toBe(true);
    expect(await stacked(stub)).toEqual([id(1), id(0), added.note.id]);
    expect(added.note.z).toBe(Math.max(...rows.map((r) => r.z)));
    close(a, b);
  });
});

describe("notesOrder", () => {
  it("front: named notes go above all others, keeping their relative order, in one transaction and one broadcast", async () => {
    const { stub, a, b } = await room();
    const writes = await rowsWritten(stub);
    const txs = await transactions(stub);
    a.send({ type: "notesOrder", ids: [id(3), id(0)], action: "front" });
    const mine = await nextOfType(a, "notesOrdered");
    const theirs = await nextOfType(b, "notesOrdered");
    expect(theirs).toEqual(mine);
    expect(mine.results.map((r) => r.id).sort()).toEqual([id(0), id(3)]);
    expect(mine.results.every((r) => r.rev === 2)).toBe(true);
    expect(await stacked(stub)).toEqual([id(1), id(2), id(4), id(0), id(3)]);
    expect((await rowsWritten(stub)) - writes).toBe(2);
    expect((await transactions(stub)) - txs).toBe(1);
    expect(await a.quiet()).toBe(true);
    close(a, b);
  });

  it("back: named notes go below all others, keeping their relative order", async () => {
    const { stub, a, b } = await room();
    a.send({ type: "notesOrder", ids: [id(4), id(2)], action: "back" });
    await nextOfType(b, "notesOrdered");
    expect(await stacked(stub)).toEqual([id(2), id(4), id(0), id(1), id(3)]);
    close(a, b);
  });

  it("a note already on top is untouched: no write, no rev bump, still reported at its current rev", async () => {
    const { stub, a, b } = await room();
    const writes = await rowsWritten(stub);
    const txs = await transactions(stub);
    a.send({ type: "notesOrder", ids: [id(4)], action: "front" });
    expect(await nextOfType(b, "notesOrdered")).toEqual({ type: "notesOrdered", results: [{ id: id(4), z: 4, rev: 1 }] });
    a.send({ type: "notesOrder", ids: [id(0)], action: "back" });
    expect(await nextOfType(b, "notesOrdered")).toEqual({ type: "notesOrdered", results: [{ id: id(0), z: 0, rev: 1 }] });
    expect((await rowsWritten(stub)) - writes).toBe(0);
    expect((await transactions(stub)) - txs).toBe(0);
    close(a, b);
  });

  it("only notes whose z changes are written", async () => {
    const { stub, a, b } = await room([0, 10, 20, 30, 40]);
    const writes = await rowsWritten(stub);
    a.send({ type: "notesOrder", ids: [id(1), id(4)], action: "front" });
    const { results } = await nextOfType(b, "notesOrdered");
    expect(results).toEqual(expect.arrayContaining([{ id: id(1), z: 41, rev: 2 }, { id: id(4), z: 40, rev: 1 }]));
    expect((await rowsWritten(stub)) - writes).toBe(1);
    close(a, b);
  });

  it("unknown and deleted ids are ignored silently; only unknown ids sends nothing", async () => {
    const { stub, a, b } = await room();
    a.send({ type: "noteDelete", id: id(2) });
    await nextOfType(b, "noteDeleted");
    a.send({ type: "notesOrder", ids: ["unknown000000000", id(2)], action: "front" });
    expect(await b.quiet()).toBe(true);
    expect(await a.quiet()).toBe(true);
    a.send({ type: "notesOrder", ids: ["unknown000000000", id(0)], action: "front" });
    expect((await nextOfType(b, "notesOrdered")).results.map((r) => r.id)).toEqual([id(0)]);
    expect((await stacked(stub)).at(-1)).toBe(id(0));
    close(a, b);
  });

  it("invalid ids are reported to the sender by index; the valid ones apply", async () => {
    const { stub, a, b } = await room();
    a.send({ type: "notesOrder", ids: [id(0), "bad id!", 42], action: "front" });
    const error = await nextOfType(a, "error");
    expect(error).toMatchObject({ code: "bad_message", entries: [1, 2] });
    expect(error.noteIds).toBeUndefined();
    await nextOfType(b, "notesOrdered");
    expect((await stacked(stub)).at(-1)).toBe(id(0));
    close(a, b);
  });

  it("an id named twice refuses the whole message, naming its notes, and writes nothing", async () => {
    const { stub, a, b } = await room();
    const writes = await rowsWritten(stub);
    a.send({ type: "notesOrder", ids: [id(0), id(1), id(0)], action: "front" });
    const error = await nextOfType(a, "error");
    expect(error).toMatchObject({ code: "bad_message", entries: [0, 1, 2], noteIds: [id(0), id(1)] });
    expect(await b.quiet()).toBe(true);
    expect((await rowsWritten(stub)) - writes).toBe(0);
    close(a, b);
  });

  it("malformed messages get bad_message and never throw (extra field, empty, over 50, bad action)", async () => {
    const { a, b } = await room();
    for (const message of [
      { type: "notesOrder", ids: [id(0)], action: "front", z: 9 },
      { type: "notesOrder", ids: [], action: "front" },
      { type: "notesOrder", ids: Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, i) => id(i)), action: "front" },
      { type: "notesOrder", ids: [id(0)], action: "forward" },
    ]) {
      expect(await a.request(message)).toMatchObject({ type: "error", code: "bad_message" });
    }
    expect(await b.quiet()).toBe(true);
    close(a, b);
  });

  it("before join gets not_joined naming the notes", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    await c.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    expect(await c.request({ type: "notesOrder", ids: [id(0)], action: "front" })).toMatchObject({ code: "not_joined", noteIds: [id(0)] });
    c.close();
  });

  it("last write wins in arrival order: the later Front ends on top", async () => {
    const { stub, a, b } = await room();
    a.send({ type: "notesOrder", ids: [id(0)], action: "front" });
    await nextOfType(b, "notesOrdered");
    b.send({ type: "notesOrder", ids: [id(1)], action: "front" });
    await nextOfType(a, "notesOrdered");
    expect((await stacked(stub)).slice(-2)).toEqual([id(0), id(1)]);
    close(a, b);
  });

  it("renormalises the whole room in the same transaction when an action would pass the bound, reporting every changed note", async () => {
    const { stub, a, b } = await room([-5, 10, NOTE_Z_LIMIT]);
    const txs = await transactions(stub);
    a.send({ type: "notesOrder", ids: [id(0)], action: "front" });
    const { results } = await nextOfType(b, "notesOrdered");
    const rows = await stored(stub);
    expect(results.map((r) => r.id).sort()).toEqual([id(0), id(1), id(2)]);
    expect(results).toEqual(expect.arrayContaining(rows.map((r) => ({ id: r.id, z: r.z, rev: r.rev }))));
    expect(rows.every((r) => Math.abs(r.z) <= NOTE_Z_LIMIT)).toBe(true);
    expect(await stacked(stub)).toEqual([id(1), id(2), id(0)]);
    expect((await transactions(stub)) - txs).toBe(1);
    close(a, b);
  });
});

describe("z never changes otherwise", () => {
  it("moves, resizes, edits, batches and drags keep z", async () => {
    const { stub, a, b } = await room();
    const before = await stored(stub);
    a.send({ type: "noteMove", id: id(0), x: 500, y: 500, final: false });
    a.send({ type: "noteMove", id: id(0), x: 600, y: 600, final: true });
    a.send({ type: "noteResize", id: id(1), x: 100, y: 100, w: 300, h: 300, final: true });
    a.send({ type: "noteEdit", id: id(2), text: "Changed", bold: true });
    a.send({ type: "noteBatch", final: true, ops: [{ op: "move", id: id(3), x: 900, y: 900 }] });
    await nextOfType(b, "notesBatchApplied");
    const after = await stored(stub);
    expect(after.map((r) => [r.id, r.z])).toEqual(before.map((r) => [r.id, r.z]));
    const updated = await runInDurableObject(stub, (r: Room) => r.rowsWritten);
    expect(updated).toBeGreaterThan(0);
    close(a, b);
  });
});

describe("rate budget", () => {
  it("a notesOrder is one message and its ids spend the batch entries budget: too many are dropped with rate_limited naming the notes", async () => {
    expect(30).toBeLessThan(SOCKET_LIMITS.burst);
    expect(30 * MAX_BATCH_ENTRIES).toBeGreaterThan(BATCH_LIMITS.entriesBurst);
    const { a, b } = await room(Array.from({ length: MAX_BATCH_ENTRIES }, (_, i) => i));
    const ids = Array.from({ length: MAX_BATCH_ENTRIES }, (_, i) => id(i));
    for (let n = 0; n < 30; n++) a.send({ type: "notesOrder", ids: n % 2 === 0 ? ids : [...ids].reverse(), action: n % 2 === 0 ? "back" : "front" });
    let error: Extract<ServerMessage, { type: "error" }> | null = null;
    for (;;) {
      const m = await a.next();
      if (m.type === "error") {
        error = m;
        break;
      }
    }
    expect(error).toMatchObject({ code: "rate_limited" });
    expect(error?.noteIds).toHaveLength(MAX_BATCH_ENTRIES);
    expect(a.closeCode).toBeNull();
    close(a, b);
  });
});

describe(`schema migration 4 -> ${SCHEMA_VERSION}`, () => {
  it("adds z, backfilled from creation (rowid) order, so the stacking looks the same", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV4(sql);
      const notes = new NoteStore(sql).all();
      expect(SCHEMA_VERSION).toBe(5);
      expect(version(sql)).toBe(5);
      expect(notes.map((n) => [n.id, n.z])).toEqual(V4_NOTES.map((n, i) => [n.id, i]));
      expect(stackOrder(notes).map((n) => n.id)).toEqual(V4_NOTES.map((n) => n.id));
      // Nothing else changed, revs included.
      expect(notes[1]).toMatchObject({ x: 40, y: 40, w: 300, h: 200, text: "Second", color: "blue", rev: 4 });
    });
  });

  it("runs once: a second load writes nothing", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV4(sql);
      const notes = new NoteStore(sql).all();
      sql.exec("UPDATE notes SET z = 9 WHERE id = ?", V4_NOTES[0].id);
      const again = new NoteStore(sql);
      expect(again.rowsWritten).toBe(0);
      expect(again.all()[0]).toEqual({ ...notes[0], z: 9 });
    });
  });

  it("is idempotent if interrupted after adding the column", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV4(sql);
      sql.exec("ALTER TABLE notes ADD COLUMN z INTEGER NOT NULL DEFAULT 0");
      const notes = new NoteStore(sql).all();
      expect(version(sql)).toBe(SCHEMA_VERSION);
      expect(notes.map((n) => n.z)).toEqual([0, 1, 2]);
    });
  });

  it("notes survive a restart after migration, in the same stacking order", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => loadSchemaV4(state.storage.sql));
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Kai");
    expect(stackOrder(c.snapshot?.notes ?? []).map((n) => n.id)).toEqual(V4_NOTES.map((n) => n.id));
    c.close();
  });

  it("a z outside the bound (written by hand) is clamped on load, not dropped", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV4(sql);
      new NoteStore(sql);
      sql.exec("UPDATE notes SET z = ? WHERE id = ?", NOTE_Z_LIMIT * 5, V4_NOTES[0].id);
      const notes = new NoteStore(sql).all();
      expect(notes).toHaveLength(3);
      expect(notes[0]?.z).toBe(NOTE_Z_LIMIT);
    });
  });

  it("v7 code's insert and update statements still work on schema 5 (rollback safety): its new notes get z 0", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV4(sql);
      new NoteStore(sql);
      expect(version(sql)).toBe(SCHEMA_VERSION);
      // Exactly what the v7 NoteStore runs: an insert without z...
      sql.exec(V4_INSERT, "fromV7code000001", 0, 0, 160, 160, "x", "yellow", "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", 1, "AAAAAAAAAAAAAAAA");
      // ...and an update that leaves z alone.
      const n = V4_NOTES[2];
      sql.exec(V4_UPDATE, 10, 20, n.w, n.h, "Edited by v7", n.color, "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", n.rev + 1, n.id);
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Kai");
    const notes = c.snapshot?.notes ?? [];
    expect(notes.find((n) => n.id === "fromV7code000001")?.z).toBe(0);
    // The update kept the z the migration gave it.
    expect(notes.find((n) => n.id === V4_NOTES[2].id)).toMatchObject({ x: 10, y: 20, text: "Edited by v7", z: 2 });
    c.close();
  });
});
