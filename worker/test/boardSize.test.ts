import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BOARD_HEIGHT, BOARD_WIDTH, FRAME_DEFAULT_H, FRAME_DEFAULT_W, NOTE_DEFAULT_H, NOTE_DEFAULT_W, PROTOCOL_VERSION, shapeDefaults } from "@stickyard/shared";
import { NoteStore, SCHEMA_VERSION } from "../src/noteStore";
import type { Room } from "../src/room";
import { TestClient, nextOfType, specRoomCode } from "./helpers";

/*
 * Board size, protocol v16: the board is 6400 x 4000 (was 3200 x 2000). The relay takes items at
 * the new far corner, clamps past the edge, refuses v15 pages, and loads rows stored on the old
 * board unchanged (no stored-schema bump). Generic fixtures.
 */

const AUTHOR = "AAAAAAAAAAAAAAAA";
/** The old board (v15), for rows stored before this change. */
const OLD = { w: 3200, h: 2000 };

async function newRoom() {
  const { code, id } = await specRoomCode();
  return { code, stub: env.ROOM.get(env.ROOM.idFromName(id)) };
}

async function joined() {
  const { code, stub } = await newRoom();
  const a = await TestClient.open(code);
  await a.enter("Alex");
  return { code, stub, a };
}

describe("protocol v16", () => {
  it("is the current version", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(16);
    expect([BOARD_WIDTH, BOARD_HEIGHT]).toEqual([2 * OLD.w, 2 * OLD.h]);
  });

  it("a protocol v15 page is refused with version_mismatch (please reload)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request({ type: "hello", protocolVersion: 15 })).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Priya" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });

  it("a page speaking the current protocol joins normally", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request({ type: "hello", protocolVersion: PROTOCOL_VERSION })).toMatchObject({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    c.send({ type: "join", name: "Priya" });
    expect((await nextOfType(c, "joined")).you.name).toBe("Priya");
    c.close();
  });
});

describe("the new far corner", () => {
  it("takes a note, a frame and a shape at the far corner of the new board", async () => {
    const { a } = await joined();
    const nx = BOARD_WIDTH - NOTE_DEFAULT_W;
    const ny = BOARD_HEIGHT - NOTE_DEFAULT_H;
    a.send({ type: "noteAdd", clientRef: "n1", x: nx, y: ny, color: "yellow", text: "Far" });
    expect((await nextOfType(a, "noteAdded")).note).toMatchObject({ x: nx, y: ny });

    const fx = BOARD_WIDTH - FRAME_DEFAULT_W;
    const fy = BOARD_HEIGHT - FRAME_DEFAULT_H;
    a.send({ type: "frameAdd", clientRef: "f1", x: fx, y: fy, color: "neutral", title: "Far" });
    expect((await nextOfType(a, "frameAdded")).frame).toMatchObject({ x: fx, y: fy });

    const { w, h } = shapeDefaults("rect");
    a.send({ type: "shapeAdd", clientRef: "s1", kind: "rect", x: BOARD_WIDTH - w, y: BOARD_HEIGHT - h });
    expect((await nextOfType(a, "shapeAdded")).shape).toMatchObject({ x: BOARD_WIDTH - w, y: BOARD_HEIGHT - h });
    a.close();
  });

  it("clamps items asked for past the new edge so they stay whole on the board", async () => {
    const { a } = await joined();
    a.send({ type: "noteAdd", clientRef: "n1", x: BOARD_WIDTH, y: BOARD_HEIGHT, color: "yellow", text: "Edge" });
    const note = (await nextOfType(a, "noteAdded")).note;
    expect(note).toMatchObject({ x: BOARD_WIDTH - NOTE_DEFAULT_W, y: BOARD_HEIGHT - NOTE_DEFAULT_H });

    a.send({ type: "noteMove", id: note.id, x: BOARD_WIDTH, y: BOARD_HEIGHT, final: true });
    expect(await nextOfType(a, "noteMoved")).toMatchObject({ x: BOARD_WIDTH - NOTE_DEFAULT_W, y: BOARD_HEIGHT - NOTE_DEFAULT_H });

    a.send({ type: "frameAdd", clientRef: "f1", x: BOARD_WIDTH, y: BOARD_HEIGHT, color: "neutral", title: "" });
    expect((await nextOfType(a, "frameAdded")).frame).toMatchObject({ x: BOARD_WIDTH - FRAME_DEFAULT_W, y: BOARD_HEIGHT - FRAME_DEFAULT_H });

    const { w, h } = shapeDefaults("oval");
    a.send({ type: "shapeAdd", clientRef: "s1", kind: "oval", x: BOARD_WIDTH, y: BOARD_HEIGHT });
    expect((await nextOfType(a, "shapeAdded")).shape).toMatchObject({ x: BOARD_WIDTH - w, y: BOARD_HEIGHT - h });

    // Past the board itself (beyond the schema's range) is bad input, answered, never a throw.
    expect(await a.request({ type: "noteMove", id: note.id, x: BOARD_WIDTH + 1, y: 0, final: true })).toMatchObject({ type: "error", code: "bad_message" });
    a.close();
  });
});

describe("rows stored on the old 3200 x 2000 board", () => {
  it("load unchanged, with no schema bump and nothing written", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      new NoteStore(sql);
      // The old board's far corners, at each kind's size.
      sql.exec("INSERT INTO notes (id, x, y, w, h, text, color, rev, author_id, z) VALUES ('oldCornerNote001', ?, ?, 160, 160, 'Old', 'yellow', 3, ?, 0)", OLD.w - 160, OLD.h - 160, AUTHOR);
      sql.exec("INSERT INTO frames (id, x, y, w, h, title, color, rev, author_id) VALUES ('oldCornerFrame01', ?, ?, 640, 400, 'Old', 'neutral', 2, ?)", OLD.w - 640, OLD.h - 400, AUTHOR);
      sql.exec("INSERT INTO shapes (id, kind, x, y, w, h, text, z, rev, author_id) VALUES ('oldCornerShape01', 'rect', ?, ?, 200, 120, 'Old', 1, 4, ?)", OLD.w - 200, OLD.h - 120, AUTHOR);
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Priya");
    expect(c.snapshot?.notes).toEqual([expect.objectContaining({ id: "oldCornerNote001", x: OLD.w - 160, y: OLD.h - 160, w: 160, h: 160, rev: 3 })]);
    expect(c.frames?.frames).toEqual([expect.objectContaining({ id: "oldCornerFrame01", x: OLD.w - 640, y: OLD.h - 400, w: 640, h: 400, rev: 2 })]);
    expect(c.shapes?.shapes).toEqual([expect.objectContaining({ id: "oldCornerShape01", x: OLD.w - 200, y: OLD.h - 120, w: 200, h: 120, rev: 4 })]);
    await runInDurableObject(stub, (r: Room, state) => {
      expect(r.rowsWritten).toBe(0);
      expect(state.storage.sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value).toBe(SCHEMA_VERSION);
    });
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(9);
    c.close();
  });
});
