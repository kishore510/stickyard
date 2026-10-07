import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  MAX_BATCH_ENTRIES,
  MAX_SHAPES_PER_ROOM,
  MAX_SHAPE_TEXT,
  NOTE_Z_LIMIT,
  PROTOCOL_VERSION,
  SHAPE_MAX_H,
  SHAPE_MIN_W,
  shapeDefaults,
  stackOrder,
  type ServerMessage,
  type ShapeItem,
} from "@stickyard/shared";
import { BATCH_LIMITS, SOCKET_LIMITS } from "../src/limits";
import { NoteStore, SCHEMA_VERSION } from "../src/noteStore";
import { entriesOf, type Room } from "../src/room";
import { V5_NOTES } from "./fixtures/schemaV5";
import { V6_FRAMES } from "./fixtures/schemaV6";
import { V8_FRAME_DELETE, V8_FRAME_INSERT, V8_FRAME_UPDATE, V8_NOTE_DELETE, V8_NOTE_INSERT, V8_NOTE_UPDATE, loadSchemaV8 } from "./fixtures/schemaV8";
import { TestClient, nextOfType, specHostToken, specRoomCode } from "./helpers";

/*
 * Protocol v15 (slice text and shapes): shapes in their own table (schema 9), shape messages,
 * one stacking space for notes and shapes, frames carrying shapes, itemsAdd with shapes, the
 * lock, and burial. Generic fixtures.
 */

const noteId = (i: number) => `note${String(i).padStart(12, "0")}`;
const frameId = (i: number) => `frame${String(i).padStart(11, "0")}`;
const shapeId = (i: number) => `shape${String(i).padStart(11, "0")}`;
const AUTHOR = "AAAAAAAAAAAAAAAA";

async function newRoom() {
  const { code, id } = await specRoomCode();
  return { code, id, stub: env.ROOM.get(env.ROOM.idFromName(id)) };
}

interface Seed {
  notes?: readonly { x: number; y: number; z?: number }[];
  frames?: readonly { x: number; y: number; w?: number; h?: number }[];
  shapes?: readonly { x: number; y: number; w?: number; h?: number; z?: number; kind?: string; text?: string }[];
}

/** A room seeded with notes, frames and shapes, and two joined clients. */
async function room(seed: Seed = {}) {
  const { code, id, stub } = await newRoom();
  await runInDurableObject(stub, (_room, state) => {
    const sql = state.storage.sql;
    (seed.notes ?? []).forEach((n, i) =>
      sql.exec("INSERT INTO notes (id, x, y, text, color, rev, author_id, z) VALUES (?, ?, ?, 'Idea one', 'yellow', 1, ?, ?)", noteId(i), n.x, n.y, AUTHOR, n.z ?? i),
    );
    (seed.frames ?? []).forEach((f, i) =>
      sql.exec("INSERT INTO frames (id, x, y, w, h, title, color, rev, author_id) VALUES (?, ?, ?, ?, ?, 'Step 1', 'neutral', 1, ?)", frameId(i), f.x, f.y, f.w ?? 640, f.h ?? 400, AUTHOR),
    );
    (seed.shapes ?? []).forEach((s, i) =>
      sql.exec(
        "INSERT INTO shapes (id, kind, x, y, w, h, text, z, rev, author_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
        shapeId(i),
        s.kind ?? "rect",
        s.x,
        s.y,
        s.w ?? 200,
        s.h ?? 120,
        s.text ?? "",
        s.z ?? 100 + i,
        AUTHOR,
      ),
    );
  });
  const a = await TestClient.open(code);
  const b = await TestClient.open(code);
  await a.enter("Alex");
  await b.enter("Sam");
  await nextOfType(a, "participant_joined");
  return { code, id, stub, a, b };
}

const rowsWritten = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (r: Room) => r.rowsWritten);
const transactions = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (r: Room) => r.transactions);
type ShapeRow = { id: string; kind: string; x: number; y: number; w: number; h: number; text: string; fill: string; z: number; rev: number };
const storedShapes = (stub: DurableObjectStub<Room>) =>
  runInDurableObject(stub, (_r, state) => state.storage.sql.exec<ShapeRow>("SELECT id, kind, x, y, w, h, text, fill, z, rev FROM shapes ORDER BY rowid").toArray());
const storedNotes = (stub: DurableObjectStub<Room>) =>
  runInDurableObject(stub, (_r, state) => state.storage.sql.exec<{ id: string; x: number; y: number; z: number; rev: number }>("SELECT id, x, y, z, rev FROM notes ORDER BY rowid").toArray());
const tables = (stub: DurableObjectStub<Room>) =>
  runInDurableObject(stub, (_r, state) =>
    state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
      .toArray()
      .map((t) => t.name),
  );
const close = (...cs: TestClient[]) => cs.forEach((c) => c.close());
const version = (sql: SqlStorage) => sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value;

const item = (ref: string, extra: Partial<ShapeItem> = {}): ShapeItem => {
  const { w, h, ...style } = shapeDefaults("diamond");
  return { ref, kind: "diamond", x: 100, y: 100, w, h, text: "Parking lot", ...style, ...extra };
};

describe("version and join", () => {
  it("a protocol v14 page is refused with version_mismatch (please reload)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(PROTOCOL_VERSION).toBe(15);
    expect(await c.request({ type: "hello", protocolVersion: 14 })).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Priya" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });

  it("joining sends snapshot, framesSnapshot, then shapesSnapshot, with nothing between them", async () => {
    const { code, a, b } = await room({ notes: [{ x: 10, y: 10 }], frames: [{ x: 100, y: 100 }], shapes: [{ x: 500, y: 500, text: "Step 1" }] });
    expect(a.shapes?.shapes.map((s) => [s.id, s.kind, s.text])).toEqual([[shapeId(0), "rect", "Step 1"]]);
    for (let i = 0; i < 20; i++) a.send({ type: "shapeMove", id: shapeId(0), x: 20 + i, y: 20, final: true });
    const c = await TestClient.open(code);
    c.send({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    c.send({ type: "join", name: "Priya" });
    const seen: ServerMessage["type"][] = [];
    for (;;) {
      const m = await c.next();
      seen.push(m.type);
      if (m.type === "shapesSnapshot") break;
    }
    const at = seen.indexOf("snapshot");
    expect(seen.slice(at, at + 3)).toEqual(["snapshot", "framesSnapshot", "shapesSnapshot"]);
    close(a, b, c);
  });
});

describe("shapeAdd", () => {
  it("adds each kind at its default size and style, clamped, on top of every note and shape; 2 rows", async () => {
    const { stub, a, b } = await room({ notes: [{ x: 0, y: 0, z: 7 }], shapes: [{ x: 0, y: 0, z: 9 }] });
    const writes = await rowsWritten(stub);
    a.send({ type: "shapeAdd", clientRef: "r1", kind: "diamond", x: BOARD_WIDTH, y: 10 });
    const mine = await nextOfType(a, "shapeAdded");
    const theirs = await nextOfType(b, "shapeAdded");
    expect(mine.clientRef).toBe("r1");
    expect(theirs.clientRef).toBeUndefined();
    expect(mine.shape).toEqual({ id: mine.shape.id, kind: "diamond", ...shapeDefaults("diamond"), x: BOARD_WIDTH - 200, y: 10, text: "", z: 10, rev: 1, authorId: mine.shape.authorId });
    expect(theirs.shape).toEqual(mine.shape);
    expect((await rowsWritten(stub)) - writes).toBe(2);
    for (const kind of ["text", "rect", "oval"] as const) {
      a.send({ type: "shapeAdd", clientRef: `k${kind}`, kind, x: 0, y: 0 });
      expect((await nextOfType(b, "shapeAdded")).shape).toMatchObject({ kind, ...shapeDefaults(kind) });
    }
    close(a, b);
  });

  it(`refuses the ${MAX_SHAPES_PER_ROOM + 1}th shape with shapes_full, naming the clientRef`, async () => {
    const { a, b } = await room({ shapes: Array.from({ length: MAX_SHAPES_PER_ROOM }, () => ({ x: 0, y: 0 })) });
    a.send({ type: "shapeAdd", clientRef: "r9", kind: "rect", x: 0, y: 0 });
    expect(await nextOfType(a, "error")).toMatchObject({ code: "shapes_full", clientRef: "r9" });
    expect(await b.quiet()).toBe(true);
    close(a, b);
  });

  it("a new note goes on top of shapes too", async () => {
    const { a, b } = await room({ notes: [{ x: 0, y: 0, z: 1 }], shapes: [{ x: 0, y: 0, z: 40 }] });
    a.send({ type: "noteAdd", clientRef: "n1", x: 0, y: 0, color: "yellow", text: "" });
    expect((await nextOfType(b, "noteAdded")).note.z).toBe(41);
    close(a, b);
  });

  it("before join gets not_joined naming the clientRef", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    await c.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    expect(await c.request({ type: "shapeAdd", clientRef: "r1", kind: "rect", x: 0, y: 0 })).toMatchObject({ code: "not_joined", clientRef: "r1" });
    c.close();
  });
});

describe("shapeEdit", () => {
  it("changes text and style, bumps rev, stores and sends the whole shape; an unchanged edit writes and sends nothing", async () => {
    const { stub, a, b } = await room({ shapes: [{ x: 0, y: 0 }] });
    a.send({ type: "shapeEdit", id: shapeId(0), text: "  Step 1\r\nStep 2 ", fill: "pink", underline: true, valign: "bottom", fontSize: "4xl" });
    const updated = await nextOfType(b, "shapeUpdated");
    expect(updated.shape).toMatchObject({ id: shapeId(0), text: "Step 1\nStep 2", fill: "pink", underline: true, valign: "bottom", fontSize: "4xl", rev: 2, kind: "rect" });
    expect(await nextOfType(a, "shapeUpdated")).toEqual(updated);
    const writes = await rowsWritten(stub);
    a.send({ type: "shapeEdit", id: shapeId(0), text: "Step 1\nStep 2", fill: "pink" });
    expect(await b.quiet()).toBe(true);
    expect(await a.quiet()).toBe(true);
    expect((await rowsWritten(stub)) - writes).toBe(0);
    expect((await storedShapes(stub))[0]).toMatchObject({ text: "Step 1\nStep 2", fill: "pink", rev: 2 });
    close(a, b);
  });

  it("last write wins in arrival order", async () => {
    const { stub, a, b } = await room({ shapes: [{ x: 0, y: 0 }] });
    a.send({ type: "shapeEdit", id: shapeId(0), text: "First" });
    b.send({ type: "shapeEdit", id: shapeId(0), text: "Second" });
    await nextOfType(a, "shapeUpdated");
    expect((await nextOfType(a, "shapeUpdated")).shape).toMatchObject({ text: "Second", rev: 3 });
    expect((await storedShapes(stub))[0]).toMatchObject({ text: "Second", rev: 3 });
    close(a, b);
  });

  it("text at the cap is kept; over it, or a malformed edit, is bad_message naming the shape and changes nothing", async () => {
    const { stub, a, b } = await room({ shapes: [{ x: 0, y: 0, text: "Keep" }] });
    const full = "\u{1F600}".repeat(MAX_SHAPE_TEXT);
    a.send({ type: "shapeEdit", id: shapeId(0), text: full });
    expect((await nextOfType(b, "shapeUpdated")).shape.text).toBe(full);
    expect(await a.request({ type: "shapeEdit", id: shapeId(0), text: "a".repeat(MAX_SHAPE_TEXT + 1) })).toMatchObject({ code: "bad_message" });
    expect(await a.request({ type: "shapeEdit", id: shapeId(0), kind: "oval" })).toMatchObject({ code: "bad_message" });
    // Fits the raw cap but is too long once the line breaks are made "\n": refused by the cleaner.
    expect(await a.request({ type: "shapeEdit", id: shapeId(0), text: `${"a".repeat(MAX_SHAPE_TEXT - 1)} ` })).toMatchObject({ code: "bad_message" });
    expect((await storedShapes(stub))[0]).toMatchObject({ text: full, rev: 2, kind: "rect" });
    close(a, b);
  });
});

describe("shapeMove and shapeResize", () => {
  it("live moves go to the others only, coalesced, at the current rev, and write nothing; the final one is clamped and stored (1 row)", async () => {
    const { stub, a, b } = await room({ shapes: [{ x: 100, y: 100 }] });
    const writes = await rowsWritten(stub);
    for (let i = 1; i <= 5; i++) a.send({ type: "shapeMove", id: shapeId(0), x: 100 + i * 10, y: 100, final: false });
    let last: Extract<ServerMessage, { type: "shapeMoved" }>;
    do last = await nextOfType(b, "shapeMoved");
    while (last.x !== 150);
    expect(last).toMatchObject({ final: false, rev: 1 });
    expect(await a.quiet()).toBe(true);
    expect((await rowsWritten(stub)) - writes).toBe(0);
    a.send({ type: "shapeMove", id: shapeId(0), x: BOARD_WIDTH, y: 100, final: true });
    expect(await nextOfType(b, "shapeMoved")).toEqual({ type: "shapeMoved", id: shapeId(0), x: BOARD_WIDTH - 200, y: 100, rev: 2, final: true });
    expect(await nextOfType(a, "shapeMoved")).toMatchObject({ final: true });
    expect((await rowsWritten(stub)) - writes).toBe(1);
    close(a, b);
  });

  it("resizes clamp to the shape limits (not note or frame limits); live ones write nothing", async () => {
    const { stub, a, b } = await room({ shapes: [{ x: 3000, y: 100 }] });
    const writes = await rowsWritten(stub);
    a.send({ type: "shapeResize", id: shapeId(0), x: 3000, y: 100, w: 400, h: 50, final: false });
    expect(await nextOfType(b, "shapeResized")).toMatchObject({ x: BOARD_WIDTH - 400, w: 400, h: 50, final: false, rev: 1 });
    expect((await rowsWritten(stub)) - writes).toBe(0);
    a.send({ type: "shapeResize", id: shapeId(0), x: 0, y: 100, w: SHAPE_MIN_W, h: SHAPE_MAX_H, final: true });
    expect(await nextOfType(b, "shapeResized")).toMatchObject({ x: 0, y: 100, w: SHAPE_MIN_W, h: SHAPE_MAX_H, rev: 2, final: true });
    expect((await rowsWritten(stub)) - writes).toBe(1);
    // Unchanged: reported, not written.
    a.send({ type: "shapeResize", id: shapeId(0), x: 0, y: 100, w: SHAPE_MIN_W, h: SHAPE_MAX_H, final: true });
    expect(await nextOfType(b, "shapeResized")).toMatchObject({ rev: 2 });
    expect((await rowsWritten(stub)) - writes).toBe(1);
    close(a, b);
  });

  it("deleting removes the shape only; unknown and deleted ids are ignored silently", async () => {
    const { stub, a, b } = await room({ notes: [{ x: 0, y: 0 }], shapes: [{ x: 0, y: 0 }] });
    a.send({ type: "shapeDelete", id: shapeId(0) });
    expect(await nextOfType(b, "shapeDeleted")).toEqual({ type: "shapeDeleted", id: shapeId(0) });
    expect(await storedShapes(stub)).toEqual([]);
    expect(await storedNotes(stub)).toHaveLength(1);
    a.send({ type: "shapeEdit", id: shapeId(0), text: "Gone" });
    a.send({ type: "shapeMove", id: shapeId(0), x: 1, y: 1, final: true });
    a.send({ type: "shapeResize", id: shapeId(0), x: 1, y: 1, w: 100, h: 100, final: true });
    a.send({ type: "shapeDelete", id: shapeId(0) });
    a.send({ type: "shapeBatch", ops: [{ op: "move", id: shapeId(0), x: 1, y: 1 }], final: true });
    await nextOfType(a, "shapeDeleted");
    expect(await b.quiet()).toBe(true);
    expect(await a.quiet()).toBe(true);
    close(a, b);
  });
});

describe("shapeBatch", () => {
  it("final: one transaction, one rev bump per changed shape, one broadcast; invalid entries are named by index and id", async () => {
    const { stub, a, b } = await room({ shapes: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 600, y: 0 }, { x: 900, y: 0 }] });
    const writes = await rowsWritten(stub);
    const txs = await transactions(stub);
    a.send({
      type: "shapeBatch",
      ops: [
        { op: "move", id: shapeId(0), x: 50, y: 50 },
        { op: "resize", id: shapeId(1), x: 300, y: 0, w: 10, h: 10 },
        { op: "resize", id: shapeId(2), x: 600, y: 0, w: 400, h: 300 },
        { op: "delete", id: shapeId(3) },
        { op: "move", id: shapeId(9), x: 1, y: 1 },
      ],
      final: true,
    });
    expect(await nextOfType(a, "error")).toMatchObject({ code: "bad_message", entries: [1], shapeIds: [shapeId(1)] });
    const applied = await nextOfType(b, "shapesBatchApplied");
    expect(applied).toEqual({
      type: "shapesBatchApplied",
      final: true,
      results: [
        { type: "shapeMoved", id: shapeId(0), x: 50, y: 50, rev: 2, final: true },
        { type: "shapeResized", id: shapeId(2), x: 600, y: 0, w: 400, h: 300, rev: 2, final: true },
        { type: "shapeDeleted", id: shapeId(3) },
      ],
    });
    expect((await transactions(stub)) - txs).toBe(1);
    // Two updates (1 row each) and a delete (the row and its index entry).
    expect((await rowsWritten(stub)) - writes).toBe(4);
    expect((await storedShapes(stub)).map((s) => s.id)).toEqual([shapeId(0), shapeId(1), shapeId(2)]);
    close(a, b);
  });

  it("a shape named twice refuses the whole batch and writes nothing", async () => {
    const { stub, a, b } = await room({ shapes: [{ x: 0, y: 0 }] });
    const writes = await rowsWritten(stub);
    a.send({ type: "shapeBatch", ops: [{ op: "move", id: shapeId(0), x: 5, y: 5 }, { op: "delete", id: shapeId(0) }], final: true });
    expect(await nextOfType(a, "error")).toMatchObject({ code: "bad_message", shapeIds: [shapeId(0)] });
    expect(await b.quiet()).toBe(true);
    expect((await rowsWritten(stub)) - writes).toBe(0);
    close(a, b);
  });

  it("live: relayed to the others only as shapesBatchApplied, coalesced, never stored; deletes ignored", async () => {
    const { stub, a, b } = await room({ shapes: [{ x: 0, y: 0 }, { x: 300, y: 0 }] });
    const writes = await rowsWritten(stub);
    for (let i = 1; i <= 3; i++) {
      a.send({ type: "shapeBatch", ops: [{ op: "move", id: shapeId(0), x: i * 10, y: 0 }, { op: "delete", id: shapeId(1) }], final: false });
    }
    let last: Extract<ServerMessage, { type: "shapesBatchApplied" }>;
    do last = await nextOfType(b, "shapesBatchApplied");
    while (last.results[0]?.type === "shapeMoved" && last.results[0].x !== 30);
    expect(last).toEqual({ type: "shapesBatchApplied", final: false, results: [{ type: "shapeMoved", id: shapeId(0), x: 30, y: 0, rev: 1, final: false }] });
    expect(await a.quiet()).toBe(true);
    expect((await rowsWritten(stub)) - writes).toBe(0);
    expect(await storedShapes(stub)).toHaveLength(2);
    close(a, b);
  });

  it("entries spend BATCH_LIMITS: over budget is rate_limited naming the shapes", async () => {
    expect(25 * MAX_BATCH_ENTRIES).toBeGreaterThan(BATCH_LIMITS.entriesBurst);
    expect(25).toBeLessThan(SOCKET_LIMITS.burst);
    const shapes = Array.from({ length: MAX_BATCH_ENTRIES }, (_, i) => ({ x: i, y: 0 }));
    const { a, b } = await room({ shapes });
    const ops = shapes.map((_, i) => ({ op: "move", id: shapeId(i), x: i + 1, y: 1 }));
    for (let n = 0; n < 25; n++) a.send({ type: "shapeBatch", ops, final: true });
    const error = await nextOfType(a, "error");
    expect(error).toMatchObject({ code: "rate_limited" });
    expect(error.shapeIds).toHaveLength(MAX_BATCH_ENTRIES);
    close(a, b);
  });
});

describe("frames carry shapes", () => {
  it("a final move carries notes and shapes by one clamped delta: 1 + N + M rows, one transaction, one frameMoved", async () => {
    const { stub, a, b } = await room({
      notes: [{ x: 150, y: 150 }],
      frames: [{ x: 100, y: 100, w: 1000, h: 600 }],
      shapes: [{ x: 300, y: 300 }, { x: 900, y: 500, w: 400 }, { x: 2000, y: 1500 }],
    });
    const writes = await rowsWritten(stub);
    const txs = await transactions(stub);
    // The second shape sticks out past the frame's right edge (900 + 400 = 1300 > 1100): the group stops when it reaches the board edge.
    a.send({ type: "frameMove", id: frameId(0), x: 3000, y: 200, final: true, noteIds: [noteId(0)], shapeIds: [shapeId(0), shapeId(1), "unknown000000000"] });
    const moved = await nextOfType(b, "frameMoved");
    expect(await nextOfType(a, "frameMoved")).toEqual(moved);
    const dx = BOARD_WIDTH - 1300;
    expect(moved).toMatchObject({ id: frameId(0), x: 100 + dx, y: 200, rev: 2, final: true });
    expect(moved.notes).toEqual([{ id: noteId(0), x: 150 + dx, y: 250, rev: 2 }]);
    expect(moved.shapes).toEqual([
      { id: shapeId(0), x: 300 + dx, y: 400, rev: 2 },
      { id: shapeId(1), x: 900 + dx, y: 600, rev: 2 },
    ]);
    expect((await rowsWritten(stub)) - writes).toBe(4);
    expect((await transactions(stub)) - txs).toBe(1);
    expect((await storedShapes(stub)).map((s) => [s.x, s.y])).toEqual([
      [300 + dx, 400],
      [900 + dx, 600],
      [2000, 1500],
    ]);
    close(a, b);
  });

  it("live moves carry shapes too, to the others only, and write nothing", async () => {
    const { stub, a, b } = await room({ frames: [{ x: 100, y: 100 }], shapes: [{ x: 200, y: 200 }] });
    const writes = await rowsWritten(stub);
    a.send({ type: "frameMove", id: frameId(0), x: 150, y: 100, final: false, shapeIds: [shapeId(0)] });
    expect(await nextOfType(b, "frameMoved")).toMatchObject({ final: false, x: 150, shapes: [{ id: shapeId(0), x: 250, y: 200, rev: 1 }] });
    expect(await a.quiet()).toBe(true);
    expect((await rowsWritten(stub)) - writes).toBe(0);
    close(a, b);
  });

  it("notes and shapes share the carry cap; carried ids on final moves spend batch entries", () => {
    const move = { type: "frameMove", id: frameId(0), x: 0, y: 0 } as const;
    expect(entriesOf({ ...move, final: true, noteIds: [noteId(0), noteId(1)], shapeIds: [shapeId(0)] })).toBe(3);
    expect(entriesOf({ ...move, final: false, noteIds: [noteId(0)], shapeIds: [shapeId(0)] })).toBe(0);
    expect(entriesOf({ type: "shapeBatch", ops: [{}, {}], final: true })).toBe(2);
    expect(entriesOf({ type: "itemsAdd", clientRef: "c", notes: [{}], frames: [{}], shapes: [{}, {}] })).toBe(4);
  });

  it("a carry naming 51 items in total is refused whole (bad_message naming the frame, its notes and shapes)", async () => {
    const { stub, a, b } = await room({ frames: [{ x: 100, y: 100 }], shapes: [{ x: 200, y: 200 }] });
    const reply = await a.request({
      type: "frameMove",
      id: frameId(0),
      x: 500,
      y: 500,
      final: true,
      noteIds: Array.from({ length: 30 }, (_, i) => noteId(i)),
      shapeIds: Array.from({ length: 21 }, (_, i) => shapeId(i)),
    });
    expect(reply).toMatchObject({ code: "bad_message" });
    expect(await b.quiet()).toBe(true);
    expect((await storedShapes(stub))[0]).toMatchObject({ x: 200, y: 200 });
    close(a, b);
  });
});

describe("one stacking space", () => {
  it("notesOrder brings shapes and notes to the front together, over both; only changed rows are written, in one transaction", async () => {
    const { stub, a, b } = await room({
      notes: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }],
      shapes: [{ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 3 }],
    });
    const writes = await rowsWritten(stub);
    const txs = await transactions(stub);
    a.send({ type: "notesOrder", ids: [shapeId(0), noteId(0)], action: "front" });
    const ordered = await nextOfType(b, "notesOrdered");
    const z = Object.fromEntries(ordered.results.map((r) => [r.id, r.z]));
    expect(z[noteId(0)]).toBe(4);
    expect(z[shapeId(0)]).toBe(5);
    expect(ordered.results).toHaveLength(2);
    expect((await rowsWritten(stub)) - writes).toBe(2);
    expect((await transactions(stub)) - txs).toBe(1);
    const all = [...(await storedNotes(stub)), ...(await storedShapes(stub))];
    expect(stackOrder(all).map((s) => s.id)).toEqual([noteId(1), shapeId(1), noteId(0), shapeId(0)]);
    close(a, b);
  });

  it("send to back over notes and shapes; a shape already at the back is untouched (no write)", async () => {
    const { stub, a, b } = await room({ notes: [{ x: 0, y: 0, z: 5 }], shapes: [{ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 9 }] });
    const writes = await rowsWritten(stub);
    a.send({ type: "notesOrder", ids: [shapeId(0)], action: "back" });
    expect((await nextOfType(b, "notesOrdered")).results).toEqual([{ id: shapeId(0), z: 1, rev: 1 }]);
    expect((await rowsWritten(stub)) - writes).toBe(0);
    a.send({ type: "notesOrder", ids: [shapeId(1)], action: "back" });
    expect((await nextOfType(b, "notesOrdered")).results).toEqual([{ id: shapeId(1), z: 0, rev: 2 }]);
    expect((await rowsWritten(stub)) - writes).toBe(1);
    close(a, b);
  });

  it("at the bound the whole space (notes and shapes) is renumbered, reported first, and the new shape goes on top", async () => {
    const { stub, a, b } = await room({ notes: [{ x: 0, y: 0, z: -5 }], shapes: [{ x: 0, y: 0, z: NOTE_Z_LIMIT }] });
    a.send({ type: "shapeAdd", clientRef: "r1", kind: "oval", x: 0, y: 0 });
    const ordered = await nextOfType(b, "notesOrdered");
    expect(ordered.results).toEqual([
      { id: noteId(0), z: 0, rev: 2 },
      { id: shapeId(0), z: 1, rev: 2 },
    ]);
    expect((await nextOfType(b, "shapeAdded")).shape.z).toBe(2);
    expect((await storedShapes(stub))[0]).toMatchObject({ z: 1, rev: 2 });
    close(a, b);
  });

  it("frames never take part in stacking", async () => {
    const { stub, a, b } = await room({ frames: [{ x: 0, y: 0 }], shapes: [{ x: 0, y: 0 }] });
    const before = await runInDurableObject(stub, (_r, state) => state.storage.sql.exec("SELECT * FROM frames").toArray());
    a.send({ type: "notesOrder", ids: [shapeId(0), frameId(0)], action: "back" });
    expect((await nextOfType(b, "notesOrdered")).results.map((r) => r.id)).toEqual([shapeId(0)]);
    expect(await runInDurableObject(stub, (_r, state) => state.storage.sql.exec("SELECT * FROM frames").toArray())).toEqual(before);
    close(a, b);
  });
});

describe("itemsAdd with shapes", () => {
  it("adds shapes with their content (cleaned, clamped), 2 rows each, in one transaction; on top in rank order with notes", async () => {
    const { stub, a, b } = await room({ notes: [{ x: 0, y: 0, z: 3 }] });
    const writes = await rowsWritten(stub);
    const txs = await transactions(stub);
    const note = {
      ref: "n1", x: 10, y: 10, w: 160, h: 160, text: "Note", color: "yellow", fontSize: "m", bold: false, italic: false, textColor: "auto", align: "left",
      titleAlign: "left", titleFontSize: "m", titleBold: false, titleItalic: false, titleTextColor: "auto", rank: 1,
    };
    a.send({
      type: "itemsAdd",
      clientRef: "c1",
      notes: [note],
      shapes: [item("s1", { rank: 2, text: "  Parking lot\r\n" }), item("s2", { rank: 0, kind: "text", x: BOARD_WIDTH, y: BOARD_HEIGHT, fill: "none", strokeWidth: "none" })],
    });
    const mine = await nextOfType(a, "itemsAdded");
    const theirs = await nextOfType(b, "itemsAdded");
    expect(mine.clientRef).toBe("c1");
    expect(mine.refused).toEqual([]);
    expect(mine.shapes?.map((s) => s.ref)).toEqual(["s1", "s2"]);
    const [s1, s2] = mine.shapes!.map((s) => s.shape);
    expect(s1).toMatchObject({ kind: "diamond", text: "Parking lot", z: 6, rev: 1 });
    expect(s2).toMatchObject({ kind: "text", x: BOARD_WIDTH - 200, y: BOARD_HEIGHT - 160, z: 4 });
    expect(mine.notes[0]?.note.z).toBe(5);
    expect(theirs.shapes?.map((s) => s.ref)).toEqual([undefined, undefined]);
    expect(theirs.shapes?.map((s) => s.shape)).toEqual([s1, s2]);
    expect((await rowsWritten(stub)) - writes).toBe(6);
    expect((await transactions(stub)) - txs).toBe(1);
    close(a, b);
  });

  it("refuses shapes past the room's cap with shapes_full, each by index; nothing added = error only", async () => {
    const { a, b } = await room({ shapes: Array.from({ length: MAX_SHAPES_PER_ROOM - 1 }, () => ({ x: 0, y: 0 })) });
    a.send({ type: "itemsAdd", clientRef: "c1", shapes: [item("s1"), item("s2"), { ...item("s3"), kind: "star" }] });
    const added = await nextOfType(a, "itemsAdded");
    expect(added.shapes).toHaveLength(1);
    expect(added.refused).toEqual([
      { kind: "shape", index: 1, ref: "s2", reason: "shapes_full" },
      { kind: "shape", index: 2, ref: "s3", reason: "invalid" },
    ]);
    await nextOfType(b, "itemsAdded");
    a.send({ type: "itemsAdd", clientRef: "c2", shapes: [item("s4")] });
    expect(await nextOfType(a, "error")).toMatchObject({ code: "shapes_full", clientRef: "c2", refused: [{ kind: "shape", index: 0, ref: "s4", reason: "shapes_full" }] });
    expect(await b.quiet()).toBe(true);
    close(a, b);
  });
});

describe("the lock and burial", () => {
  it("a guest's live shape drag on a locked board is refused, naming the shape, and not relayed", async () => {
    const { id, a, b } = await room({ shapes: [{ x: 0, y: 0 }] });
    expect(await a.request({ type: "claimHost", token: await specHostToken(id) })).toEqual({ type: "hostGranted" });
    await nextOfType(b, "participantUpdated");
    expect(await a.request({ type: "lockSet", locked: true })).toMatchObject({ type: "lockChanged" });
    await nextOfType(b, "lockChanged");
    expect(await b.request({ type: "shapeMove", id: shapeId(0), x: 5, y: 5, final: false })).toMatchObject({ code: "board_locked", shapeId: shapeId(0) });
    expect(await b.request({ type: "frameMove", id: frameId(0), x: 5, y: 5, final: false, shapeIds: [shapeId(0)] })).toMatchObject({
      code: "board_locked",
      frameId: frameId(0),
      shapeIds: [shapeId(0)],
    });
    expect(await a.quiet(200)).toBe(true);
    // The host still edits shapes.
    a.send({ type: "shapeEdit", id: shapeId(0), text: "Host" });
    expect((await nextOfType(b, "shapeUpdated")).shape.text).toBe("Host");
    close(a, b);
  });

  it("End session deletes the shapes table with everything else", async () => {
    const { id, stub, a, b } = await room({ shapes: [{ x: 0, y: 0 }] });
    expect(await tables(stub)).toContain("shapes");
    expect(await a.request({ type: "claimHost", token: await specHostToken(id) })).toEqual({ type: "hostGranted" });
    a.send({ type: "endSession" });
    await a.waitClose();
    await b.waitClose();
    await new Promise((r) => setTimeout(r, 50));
    expect(await tables(stub)).toEqual(["meta"]);
  });

  it("expiry deletes the shapes table with everything else", async () => {
    const { stub, a, b } = await room({ shapes: [{ x: 0, y: 0 }] });
    close(a, b);
    await a.waitClose();
    await b.waitClose();
    await new Promise((r) => setTimeout(r, 50));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await tables(stub)).toEqual(["meta"]);
  });
});

describe(`schema migration 8 -> ${SCHEMA_VERSION}`, () => {
  it("adds an empty shapes table (every column but the key with a default) and leaves notes, frames and votes alone", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV8(sql);
      const store = new NoteStore(sql);
      expect(SCHEMA_VERSION).toBe(9);
      expect(version(sql)).toBe(9);
      expect(store.allShapes()).toEqual([]);
      expect(store.all().map((n) => [n.id, n.x, n.y, n.z, n.rev])).toEqual(V5_NOTES.map((n) => [n.id, n.x, n.y, n.z, n.rev]));
      expect(store.allFrames().map((f) => [f.id, f.title])).toEqual(V6_FRAMES.map((f) => [f.id, f.title]));
      expect(store.totals()).toEqual([{ noteId: "v5note0000000002", count: 2 }]);
      const columns = sql.exec<{ name: string; dflt_value: string | null }>("SELECT name, dflt_value FROM pragma_table_info('shapes')").toArray();
      expect(columns.map((c) => c.name)).toEqual([
        "id", "kind", "x", "y", "w", "h", "text", "fill", "stroke", "stroke_width", "stroke_style", "font_size",
        "bold", "italic", "underline", "text_color", "align", "valign", "z", "rev", "author_id",
      ]);
      expect(columns.filter((c) => c.name !== "id" && c.dflt_value === null)).toEqual([]);
      // Runs once: a second load writes nothing.
      expect(new NoteStore(sql).rowsWritten).toBe(0);
    });
  });

  it("is idempotent if the table already exists", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV8(sql);
      new NoteStore(sql);
      sql.exec("INSERT INTO shapes (id, kind, text, author_id) VALUES (?, 'text', 'Kept', ?)", shapeId(1), AUTHOR);
      // As if the step was interrupted after creating the table: it runs again and keeps the table.
      sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', 8)");
      const again = new NoteStore(sql);
      expect(version(sql)).toBe(SCHEMA_VERSION);
      expect(again.allShapes().map((x) => [x.id, x.text])).toEqual([[shapeId(1), "Kept"]]);
    });
  });

  it("shapes survive a restart; a row off the board is clamped on load, a bad row is skipped", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV8(sql);
      new NoteStore(sql);
      sql.exec("INSERT INTO shapes (id, kind, x, y, w, h, text, z, rev, author_id) VALUES (?, 'oval', 3100, 1950, 200, 120, 'Step 1', 3, 4, ?)", shapeId(1), AUTHOR);
      sql.exec("INSERT INTO shapes (id, kind, x, y, w, h, text, z, rev, author_id) VALUES (?, 'star', 0, 0, 200, 120, '', 0, 1, ?)", shapeId(2), AUTHOR);
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Priya");
    const { w, h, ...style } = shapeDefaults("rect");
    expect(c.shapes?.shapes).toEqual([
      { id: shapeId(1), kind: "oval", x: BOARD_WIDTH - 200, y: BOARD_HEIGHT - 120, w: 200, h: 120, text: "Step 1", ...style, z: 3, rev: 4, authorId: AUTHOR },
    ]);
    expect([w, h]).toEqual([200, 120]);
    c.close();
  });

  it("v0.20.0's note and frame statements still work on schema 9 (rollback safety), and it never reads shapes", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV8(sql);
      new NoteStore(sql);
      sql.exec("INSERT INTO shapes (id, kind, x, y, text, z, rev, author_id) VALUES (?, 'rect', 0, 0, 'Shape', 50, 1, ?)", shapeId(1), AUTHOR);
      sql.exec(V8_NOTE_INSERT, "fromV14code00001", 0, 0, 160, 160, "New", "green", "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", 9, 1, AUTHOR);
      const n = V5_NOTES[1];
      sql.exec(V8_NOTE_UPDATE, 10, 20, n.w, n.h, "Edited by v14", n.color, "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", n.z, n.rev + 1, n.id);
      for (const statement of V8_NOTE_DELETE) sql.exec(statement, V5_NOTES[0].id);
      sql.exec(V8_FRAME_INSERT, "fromV14frame0001", 0, 0, 640, 400, "Step 1", "blue", 1, AUTHOR, "m", 1, 0, "auto", "left");
      const f = V6_FRAMES[1];
      sql.exec(V8_FRAME_UPDATE, 10, 20, f.w, f.h, "Edited frame", f.color, f.rev + 1, "l", 0, 1, "red", "center", f.id);
      sql.exec(V8_FRAME_DELETE, V6_FRAMES[0].id);
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Priya");
    const notes = c.snapshot?.notes ?? [];
    expect(notes.map((x) => x.id)).toEqual([V5_NOTES[1].id, V5_NOTES[2].id, "fromV14code00001"]);
    expect(notes[0]).toMatchObject({ x: 10, y: 20, text: "Edited by v14" });
    expect(c.frames?.frames.map((x) => x.id)).toEqual([V6_FRAMES[1].id, V6_FRAMES[2].id, "fromV14frame0001"]);
    expect(c.frames?.frames[0]).toMatchObject({ title: "Edited frame", titleFontSize: "l", titleAlign: "center" });
    expect(c.shapes?.shapes.map((s) => s.id)).toEqual([shapeId(1)]);
    c.close();
  });
});
