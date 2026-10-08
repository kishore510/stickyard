import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  FRAME_DEFAULTS,
  FRAME_DEFAULT_H,
  FRAME_DEFAULT_W,
  FRAME_MAX_H,
  FRAME_MIN_W,
  MAX_BATCH_ENTRIES,
  MAX_FRAMES_PER_ROOM,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "@stickyard/shared";
import { BATCH_LIMITS, SOCKET_LIMITS } from "../src/limits";
import { NoteStore, SCHEMA_VERSION } from "../src/noteStore";
import type { Room } from "../src/room";
import { V5_INSERT, V5_NOTES, V5_UPDATE, loadSchemaV5 } from "./fixtures/schemaV5";
import { TestClient, nextOfType, specRoomCode } from "./helpers";

/*
 * Protocol v9 (slice frames): frames in their own table (schema 6), frame messages, the carry
 * rule (a final frameMove moves its notes by the same clamped delta in one transaction), and the
 * two-message join (snapshot, then framesSnapshot, in one step). Generic fixtures.
 */

const noteId = (i: number) => `note${String(i).padStart(12, "0")}`;
const frameId = (i: number) => `frame${String(i).padStart(11, "0")}`;

async function newRoom() {
  const { code, id } = await specRoomCode();
  return { code, stub: env.ROOM.get(env.ROOM.idFromName(id)) };
}

interface SeedFrame {
  x: number;
  y: number;
  w?: number;
  h?: number;
  title?: string;
}

/** A room seeded with notes at the given positions and frames, and two joined clients. */
async function room(notes: readonly [number, number][] = [], frames: readonly SeedFrame[] = []) {
  const { code, stub } = await newRoom();
  await runInDurableObject(stub, (_room, state) => {
    notes.forEach(([x, y], i) => {
      state.storage.sql.exec(
        "INSERT INTO notes (id, x, y, text, color, rev, author_id, z) VALUES (?, ?, ?, 'Idea one', 'yellow', 1, 'AAAAAAAAAAAAAAAA', ?)",
        noteId(i),
        x,
        y,
        i,
      );
    });
    frames.forEach((f, i) => {
      state.storage.sql.exec(
        "INSERT INTO frames (id, x, y, w, h, title, color, rev, author_id) VALUES (?, ?, ?, ?, ?, ?, 'neutral', 1, 'AAAAAAAAAAAAAAAA')",
        frameId(i),
        f.x,
        f.y,
        f.w ?? FRAME_DEFAULT_W,
        f.h ?? FRAME_DEFAULT_H,
        f.title ?? "",
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
const storedFrames = (stub: DurableObjectStub<Room>) =>
  runInDurableObject(stub, (_r, state) =>
    state.storage.sql.exec<{ id: string; x: number; y: number; w: number; h: number; title: string; color: string; rev: number }>("SELECT id, x, y, w, h, title, color, rev FROM frames ORDER BY rowid").toArray(),
  );
const storedNotes = (stub: DurableObjectStub<Room>) =>
  runInDurableObject(stub, (_r, state) => state.storage.sql.exec<{ id: string; x: number; y: number; z: number; rev: number }>("SELECT id, x, y, z, rev FROM notes ORDER BY rowid").toArray());
const close = (...cs: TestClient[]) => cs.forEach((c) => c.close());
const version = (sql: SqlStorage) => sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value;

describe("version and join", () => {
  it("a protocol v8 page is refused with version_mismatch (please reload)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(9);
    expect(await c.request({ type: "hello", protocolVersion: 8 })).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Priya" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });

  it("joining sends snapshot (notes only, same shape) then framesSnapshot, with nothing between them", async () => {
    const { code, a, b } = await room([[10, 10]], [{ x: 100, y: 100, title: "Start" }]);
    expect(Object.keys(a.snapshot ?? {}).sort()).toEqual(["notes", "type"]);
    expect(a.frames?.frames.map((f) => f.title)).toEqual(["Start"]);
    // Someone keeps changing the board while a third person joins: nothing lands between the two.
    for (let i = 0; i < 20; i++) a.send({ type: "noteMove", id: noteId(0), x: 20 + i, y: 20, final: true });
    const c = await TestClient.open(code);
    c.send({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    c.send({ type: "join", name: "Priya" });
    const seen: ServerMessage["type"][] = [];
    for (;;) {
      const m = await c.next();
      seen.push(m.type);
      if (m.type === "framesSnapshot") break;
    }
    const at = seen.indexOf("snapshot");
    expect(at).toBeGreaterThan(-1);
    expect(seen[at + 1]).toBe("framesSnapshot");
    close(a, b, c);
  });
});

describe("frameAdd", () => {
  it("adds a frame at the default size, clamped, with a cleaned title; the sender's copy has its clientRef", async () => {
    const { stub, a, b } = await room();
    const writes = await rowsWritten(stub);
    a.send({ type: "frameAdd", clientRef: "r1", x: BOARD_WIDTH, y: 10, color: "green", title: "  Start\n here " });
    const mine = await nextOfType(a, "frameAdded");
    const theirs = await nextOfType(b, "frameAdded");
    expect(mine.clientRef).toBe("r1");
    expect(theirs.clientRef).toBeUndefined();
    expect(mine.frame).toMatchObject({ x: BOARD_WIDTH - FRAME_DEFAULT_W, y: 10, w: FRAME_DEFAULT_W, h: FRAME_DEFAULT_H, title: "Start here", color: "green", rev: 1 });
    expect(theirs.frame).toEqual(mine.frame);
    // One frame row, plus its primary-key index entry (SQLite counts both as rows written).
    expect((await rowsWritten(stub)) - writes).toBe(2);
    close(a, b);
  });

  it(`refuses the ${MAX_FRAMES_PER_ROOM + 1}th frame with frames_full, naming the clientRef`, async () => {
    const { a, b } = await room([], Array.from({ length: MAX_FRAMES_PER_ROOM }, () => ({ x: 0, y: 0 })));
    a.send({ type: "frameAdd", clientRef: "r9", x: 0, y: 0, color: "neutral", title: "" });
    expect(await nextOfType(a, "error")).toMatchObject({ code: "frames_full", clientRef: "r9" });
    expect(await b.quiet()).toBe(true);
    close(a, b);
  });

  it("before join gets not_joined naming the clientRef", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    await c.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    expect(await c.request({ type: "frameAdd", clientRef: "r1", x: 0, y: 0, color: "neutral", title: "" })).toMatchObject({ code: "not_joined", clientRef: "r1" });
    c.close();
  });
});

describe("frameEdit, frameResize, frameDelete", () => {
  it("an edit changes title and colour, bumps rev, stores and sends the whole frame; an unchanged edit writes and sends nothing", async () => {
    const { stub, a, b } = await room([], [{ x: 0, y: 0, title: "Start" }]);
    a.send({ type: "frameEdit", id: frameId(0), title: "Stop", color: "pink" });
    expect((await nextOfType(b, "frameUpdated")).frame).toMatchObject({ id: frameId(0), title: "Stop", color: "pink", rev: 2 });
    await nextOfType(a, "frameUpdated");
    const writes = await rowsWritten(stub);
    a.send({ type: "frameEdit", id: frameId(0), title: "Stop" });
    expect(await b.quiet()).toBe(true);
    expect((await rowsWritten(stub)) - writes).toBe(0);
    expect((await storedFrames(stub))[0]).toMatchObject({ title: "Stop", color: "pink", rev: 2 });
    close(a, b);
  });

  it("a malformed edit gets bad_message and changes nothing", async () => {
    const { stub, a, b } = await room([], [{ x: 0, y: 0, title: "Start" }]);
    expect(await a.request({ type: "frameEdit", id: frameId(0) })).toMatchObject({ code: "bad_message" });
    expect(await a.request({ type: "frameEdit", id: frameId(0), color: "teal" })).toMatchObject({ code: "bad_message" });
    expect(await a.request({ type: "frameEdit", id: frameId(0), title: "x".repeat(61) })).toMatchObject({ code: "bad_message" });
    expect((await storedFrames(stub))[0]).toMatchObject({ title: "Start", rev: 1 });
    close(a, b);
  });

  it("live resizes go to the others only and write nothing; the final one is clamped and stored", async () => {
    const { stub, a, b } = await room([], [{ x: 2000, y: 100 }]);
    const writes = await rowsWritten(stub);
    a.send({ type: "frameResize", id: frameId(0), x: 2000, y: 100, w: 900, h: 500, final: false });
    expect(await nextOfType(b, "frameResized")).toMatchObject({ w: 900, final: false, rev: 1 });
    expect(await a.quiet()).toBe(true);
    expect((await rowsWritten(stub)) - writes).toBe(0);
    // Past the right edge at that width: the final one comes back so the whole frame is on the board.
    a.send({ type: "frameResize", id: frameId(0), x: BOARD_WIDTH - 400, y: 100, w: 1200, h: FRAME_MAX_H, final: true });
    const done = await nextOfType(b, "frameResized");
    expect(done).toMatchObject({ x: BOARD_WIDTH - 1200, y: 100, w: 1200, h: FRAME_MAX_H, rev: 2, final: true });
    expect((await rowsWritten(stub)) - writes).toBe(1);
    close(a, b);
  });

  it("deleting a frame never deletes notes, even the ones inside it", async () => {
    const { stub, a, b } = await room([[150, 150]], [{ x: 100, y: 100, title: "Start" }]);
    a.send({ type: "frameDelete", id: frameId(0) });
    expect(await nextOfType(b, "frameDeleted")).toEqual({ type: "frameDeleted", id: frameId(0) });
    expect(await storedFrames(stub)).toEqual([]);
    expect((await storedNotes(stub)).map((n) => n.id)).toEqual([noteId(0)]);
    close(a, b);
  });

  it("unknown and deleted frames are ignored silently", async () => {
    const { a, b } = await room();
    a.send({ type: "frameEdit", id: frameId(5), title: "Stop" });
    a.send({ type: "frameMove", id: frameId(5), x: 1, y: 1, final: true });
    a.send({ type: "frameResize", id: frameId(5), x: 1, y: 1, w: 800, h: 600, final: true });
    a.send({ type: "frameDelete", id: frameId(5) });
    expect(await b.quiet()).toBe(true);
    expect(await a.quiet()).toBe(true);
    close(a, b);
  });
});

describe("frameMove and the carry rule", () => {
  it("a final move carries the named notes by the same delta: 1 + N rows, one transaction, one broadcast", async () => {
    const { stub, a, b } = await room(
      [
        [150, 150],
        [300, 200],
        [1500, 1500],
      ],
      [{ x: 100, y: 100, title: "Start" }],
    );
    const writes = await rowsWritten(stub);
    const txs = await transactions(stub);
    a.send({ type: "frameMove", id: frameId(0), x: 400, y: 300, final: true, noteIds: [noteId(0), noteId(1), "unknown000000000"] });
    const moved = await nextOfType(b, "frameMoved");
    expect(await nextOfType(a, "frameMoved")).toEqual(moved);
    expect(moved).toMatchObject({ id: frameId(0), x: 400, y: 300, rev: 2, final: true });
    expect(moved.notes).toEqual([
      { id: noteId(0), x: 450, y: 350, rev: 2 },
      { id: noteId(1), x: 600, y: 400, rev: 2 },
    ]);
    expect((await rowsWritten(stub)) - writes).toBe(3);
    expect((await transactions(stub)) - txs).toBe(1);
    expect((await storedNotes(stub)).map((n) => [n.x, n.y])).toEqual([
      [450, 350],
      [600, 400],
      [1500, 1500],
    ]);
    // Carrying never touches stacking.
    expect((await storedNotes(stub)).map((n) => n.z)).toEqual([0, 1, 2]);
    expect(await b.quiet()).toBe(true);
    close(a, b);
  });

  it("at the board edge the delta is clamped once for the whole group, so the arrangement is kept", async () => {
    // The carried note sticks out past the frame's right edge (900 + 160 = 1060 > 860), so the
    // group stops when the note reaches the edge, not the frame: both keep their spacing.
    const { stub, a, b } = await room([[900, 400]], [{ x: 100, y: 100, w: 760, h: 500 }]);
    a.send({ type: "frameMove", id: frameId(0), x: BOARD_WIDTH - 300, y: 100, final: true, noteIds: [noteId(0)] });
    const moved = await nextOfType(b, "frameMoved");
    const dx = BOARD_WIDTH - 1060;
    expect(moved).toMatchObject({ x: 100 + dx, y: 100 });
    expect(moved.notes).toEqual([{ id: noteId(0), x: 900 + dx, y: 400, rev: 2 }]);
    expect((await storedNotes(stub))[0]).toMatchObject({ x: 900 + dx, y: 400 });
    close(a, b);
  });

  it("without noteIds (Alt) the frame moves alone: 1 row", async () => {
    const { stub, a, b } = await room([[150, 150]], [{ x: 100, y: 100 }]);
    const writes = await rowsWritten(stub);
    a.send({ type: "frameMove", id: frameId(0), x: 500, y: 500, final: true });
    const moved = await nextOfType(b, "frameMoved");
    expect(moved.notes).toBeUndefined();
    expect((await rowsWritten(stub)) - writes).toBe(1);
    expect((await storedNotes(stub))[0]).toMatchObject({ x: 150, y: 150 });
    close(a, b);
  });

  it("live moves go to the others only, with the carried notes, coalesced, and write nothing", async () => {
    const { stub, a, b } = await room([[150, 150]], [{ x: 100, y: 100 }]);
    const writes = await rowsWritten(stub);
    for (let i = 1; i <= 5; i++) a.send({ type: "frameMove", id: frameId(0), x: 100 + i * 10, y: 100, final: false, noteIds: [noteId(0)] });
    let last: Extract<ServerMessage, { type: "frameMoved" }> | null = null;
    for (;;) {
      last = await nextOfType(b, "frameMoved");
      if (last.x === 150) break;
    }
    expect(last).toMatchObject({ final: false, rev: 1, notes: [{ id: noteId(0), x: 200, y: 150, rev: 1 }] });
    expect(await a.quiet()).toBe(true);
    expect((await rowsWritten(stub)) - writes).toBe(0);
    close(a, b);
  });

  it("an unchanged final move writes nothing but is still reported", async () => {
    const { stub, a, b } = await room([], [{ x: 100, y: 100 }]);
    const writes = await rowsWritten(stub);
    a.send({ type: "frameMove", id: frameId(0), x: 100, y: 100, final: true });
    expect(await nextOfType(b, "frameMoved")).toMatchObject({ x: 100, y: 100, rev: 1, final: true });
    expect((await rowsWritten(stub)) - writes).toBe(0);
    close(a, b);
  });

  it("a repeated or over-cap noteIds list is refused whole (bad_message naming the frame)", async () => {
    const { stub, a, b } = await room([[150, 150]], [{ x: 100, y: 100 }]);
    expect(await a.request({ type: "frameMove", id: frameId(0), x: 500, y: 500, final: true, noteIds: [noteId(0), noteId(0)] })).toMatchObject({ code: "bad_message" });
    expect(
      await a.request({ type: "frameMove", id: frameId(0), x: 500, y: 500, final: true, noteIds: Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, i) => noteId(i)) }),
    ).toMatchObject({ code: "bad_message" });
    expect((await storedFrames(stub))[0]).toMatchObject({ x: 100, y: 100 });
    expect(await b.quiet()).toBe(true);
    close(a, b);
  });

  it("carried ids on final moves spend the batch entries budget: over it, rate_limited naming the frame and its notes", async () => {
    expect(25 * MAX_BATCH_ENTRIES).toBeGreaterThan(BATCH_LIMITS.entriesBurst);
    expect(25).toBeLessThan(SOCKET_LIMITS.burst);
    const notes = Array.from({ length: MAX_BATCH_ENTRIES }, (_, i) => [200 + i, 200] as [number, number]);
    const { a, b } = await room(notes, [{ x: 100, y: 100, w: 1000, h: 600 }]);
    const ids = notes.map((_, i) => noteId(i));
    for (let n = 0; n < 25; n++) a.send({ type: "frameMove", id: frameId(0), x: 100 + (n % 2), y: 100, final: true, noteIds: ids });
    let error: Extract<ServerMessage, { type: "error" }> | null = null;
    for (;;) {
      const m = await a.next();
      if (m.type === "error") {
        error = m;
        break;
      }
    }
    expect(error).toMatchObject({ code: "rate_limited", frameId: frameId(0) });
    expect(error?.noteIds).toHaveLength(MAX_BATCH_ENTRIES);
    close(a, b);
  });

  it("z-order actions never touch frames", async () => {
    const { stub, a, b } = await room(
      [
        [150, 150],
        [160, 160],
      ],
      [{ x: 100, y: 100 }],
    );
    const before = await storedFrames(stub);
    a.send({ type: "notesOrder", ids: [noteId(0)], action: "front" });
    await nextOfType(b, "notesOrdered");
    expect(await storedFrames(stub)).toEqual(before);
    close(a, b);
  });
});

describe(`schema migration 5 -> ${SCHEMA_VERSION}`, () => {
  it("adds an empty frames table and leaves notes exactly as they were", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV5(sql);
      const store = new NoteStore(sql);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
      expect(version(sql)).toBe(SCHEMA_VERSION);
      expect(store.allFrames()).toEqual([]);
      expect(store.all().map((n) => [n.id, n.x, n.y, n.z, n.rev, n.text])).toEqual(V5_NOTES.map((n) => [n.id, n.x, n.y, n.z, n.rev, n.text]));
      const columns = sql.exec<{ name: string; dflt_value: string | null; notnull: number }>("SELECT name, dflt_value, \"notnull\" FROM pragma_table_info('frames')").toArray();
      // Schema 6's columns first (schema 7 adds the title style after them; frameTitleStyle.test.ts).
      expect(columns.map((c) => c.name).slice(0, 9)).toEqual(["id", "x", "y", "w", "h", "title", "color", "rev", "author_id"]);
      // Every column but the key has a default.
      expect(columns.filter((c) => c.name !== "id" && c.dflt_value === null)).toEqual([]);
    });
  });

  it("runs once (a second load writes nothing) and is idempotent if the table already exists", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV5(sql);
      sql.exec("CREATE TABLE frames (id TEXT PRIMARY KEY, x INTEGER NOT NULL DEFAULT 0, y INTEGER NOT NULL DEFAULT 0, w INTEGER NOT NULL DEFAULT 640, h INTEGER NOT NULL DEFAULT 400, title TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'neutral', rev INTEGER NOT NULL DEFAULT 1, author_id TEXT NOT NULL DEFAULT '')");
      new NoteStore(sql);
      expect(version(sql)).toBe(SCHEMA_VERSION);
      const again = new NoteStore(sql);
      expect(again.rowsWritten).toBe(0);
    });
  });

  it("frames survive a restart, and a frame row off the board is clamped on load, not dropped", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV5(sql);
      new NoteStore(sql);
      sql.exec("INSERT INTO frames (id, x, y, w, h, title, color, rev, author_id) VALUES (?, ?, ?, 640, 400, 'Continue', 'blue', 3, 'AAAAAAAAAAAAAAAA')", frameId(1), BOARD_WIDTH - 100, BOARD_HEIGHT - 100);
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Priya");
    expect(c.frames?.frames).toEqual([
      { id: frameId(1), x: BOARD_WIDTH - 640, y: BOARD_HEIGHT - 400, w: 640, h: 400, title: "Continue", color: "blue", ...FRAME_DEFAULTS, rev: 3, authorId: "AAAAAAAAAAAAAAAA" },
    ]);
    c.close();
  });

  it("v8 code's note insert and update statements still work on schema 6 (rollback safety), and it never reads frames", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV5(sql);
      new NoteStore(sql);
      sql.exec(V5_INSERT, "fromV8code000001", 0, 0, 160, 160, "x", "yellow", "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", 7, 1, "AAAAAAAAAAAAAAAA");
      const n = V5_NOTES[1];
      sql.exec(V5_UPDATE, 10, 20, n.w, n.h, "Edited by v8", n.color, "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", n.z, n.rev + 1, n.id);
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Priya");
    const notes = c.snapshot?.notes ?? [];
    expect(notes.find((x) => x.id === "fromV8code000001")?.z).toBe(7);
    expect(notes.find((x) => x.id === V5_NOTES[1].id)).toMatchObject({ x: 10, y: 20, text: "Edited by v8" });
    expect(c.frames?.frames).toEqual([]);
    c.close();
  });

  it("frame sizes in the clamp are frame sizes, not note sizes", async () => {
    const { a, b } = await room();
    a.send({ type: "frameAdd", clientRef: "r1", x: 0, y: 0, color: "neutral", title: "" });
    const { frame } = await nextOfType(a, "frameAdded");
    a.send({ type: "frameResize", id: frame.id, x: 0, y: 0, w: FRAME_MIN_W, h: FRAME_MAX_H, final: true });
    expect(await nextOfType(b, "frameResized")).toMatchObject({ w: FRAME_MIN_W, h: FRAME_MAX_H });
    close(a, b);
  });
});
