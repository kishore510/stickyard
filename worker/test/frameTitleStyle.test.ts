import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FRAME_DEFAULTS, PROTOCOL_VERSION } from "@stickyard/shared";
import { NoteStore, SCHEMA_VERSION } from "../src/noteStore";
import type { Room } from "../src/room";
import { V5_NOTES } from "./fixtures/schemaV5";
import { V6_FRAMES, V6_FRAME_INSERT, V6_FRAME_UPDATE, loadSchemaV6 } from "./fixtures/schemaV6";
import { TestClient, nextOfType, specRoomCode } from "./helpers";

/*
 * Protocol v10 (slice frame title styling): frames gain title_font_size, title_bold,
 * title_italic, title_text_color and title_align (schema 7), each NOT NULL DEFAULT the value
 * that looks like v9's header, so existing frames look unchanged. Generic fixtures.
 */

const frameId = (i: number) => `frame${String(i).padStart(11, "0")}`;

async function newRoom() {
  const { code, id } = await specRoomCode();
  return { code, stub: env.ROOM.get(env.ROOM.idFromName(id)) };
}

/** A room with one frame (inserted the way v9 code does, so the style columns take their defaults) and two joined clients. */
async function room() {
  const { code, stub } = await newRoom();
  await runInDurableObject(stub, (_room, state) => {
    state.storage.sql.exec(V6_FRAME_INSERT, frameId(0), 0, 0, 640, 400, "Start", "neutral", 1, "AAAAAAAAAAAAAAAA");
  });
  const a = await TestClient.open(code);
  const b = await TestClient.open(code);
  await a.enter("Alex");
  await b.enter("Sam");
  await nextOfType(a, "participant_joined");
  return { code, stub, a, b };
}

const rowsWritten = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (r: Room) => r.rowsWritten);
type StyleRow = {
  id: string;
  title: string;
  title_font_size: string;
  title_bold: number;
  title_italic: number;
  title_text_color: string;
  title_align: string;
  rev: number;
};
const storedFrames = (stub: DurableObjectStub<Room>) =>
  runInDurableObject(stub, (_r, state) =>
    state.storage.sql.exec<StyleRow>("SELECT id, title, title_font_size, title_bold, title_italic, title_text_color, title_align, rev FROM frames ORDER BY rowid").toArray(),
  );
const version = (sql: SqlStorage) => sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value;
const close = (...cs: TestClient[]) => cs.forEach((c) => c.close());

describe("protocol v10", () => {
  it("a protocol v9 page is refused with version_mismatch (please reload)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(10);
    expect(await c.request({ type: "hello", protocolVersion: 9 })).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Priya" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });

  it("a new frame gets the default title style; the join snapshot carries it", async () => {
    const { code, a, b } = await room();
    expect(a.frames?.frames[0]).toMatchObject({ id: frameId(0), ...FRAME_DEFAULTS });
    a.send({ type: "frameAdd", clientRef: "r1", x: 0, y: 500, color: "green", title: "Stop" });
    expect((await nextOfType(b, "frameAdded")).frame).toMatchObject({ title: "Stop", ...FRAME_DEFAULTS });
    const c = await TestClient.open(code);
    await c.enter("Priya");
    expect(c.frames?.frames.map((f) => f.titleFontSize)).toEqual(["m", "m"]);
    close(a, b, c);
  });
});

describe("frameEdit with title style", () => {
  it("changes the style, bumps rev, stores one row and sends the whole frame to everyone", async () => {
    const { stub, a, b } = await room();
    const writes = await rowsWritten(stub);
    a.send({ type: "frameEdit", id: frameId(0), titleFontSize: "xl", titleBold: false, titleItalic: true, titleTextColor: "blue", titleAlign: "center" });
    const theirs = await nextOfType(b, "frameUpdated");
    const mine = await nextOfType(a, "frameUpdated");
    expect(theirs.frame).toMatchObject({ id: frameId(0), title: "Start", titleFontSize: "xl", titleBold: false, titleItalic: true, titleTextColor: "blue", titleAlign: "center", rev: 2 });
    expect(mine.frame).toEqual(theirs.frame);
    expect((await rowsWritten(stub)) - writes).toBe(1);
    expect((await storedFrames(stub))[0]).toEqual({
      id: frameId(0),
      title: "Start",
      title_font_size: "xl",
      title_bold: 0,
      title_italic: 1,
      title_text_color: "blue",
      title_align: "center",
      rev: 2,
    });
    close(a, b);
  });

  it("an edit that changes nothing writes nothing and sends nothing; one changed field among unchanged ones writes one row", async () => {
    const { stub, a, b } = await room();
    let writes = await rowsWritten(stub);
    a.send({ type: "frameEdit", id: frameId(0), ...FRAME_DEFAULTS, title: "Start" });
    expect(await b.quiet()).toBe(true);
    expect((await rowsWritten(stub)) - writes).toBe(0);
    writes = await rowsWritten(stub);
    a.send({ type: "frameEdit", id: frameId(0), ...FRAME_DEFAULTS, titleAlign: "right" });
    expect((await nextOfType(b, "frameUpdated")).frame).toMatchObject({ titleAlign: "right", titleBold: true, rev: 2 });
    expect((await rowsWritten(stub)) - writes).toBe(1);
    close(a, b);
  });

  it("last write wins, in arrival order", async () => {
    const { stub, a, b } = await room();
    a.send({ type: "frameEdit", id: frameId(0), titleTextColor: "red" });
    b.send({ type: "frameEdit", id: frameId(0), titleTextColor: "green" });
    await nextOfType(a, "frameUpdated");
    expect((await nextOfType(a, "frameUpdated")).frame).toMatchObject({ titleTextColor: "green", rev: 3 });
    expect((await storedFrames(stub))[0]?.title_text_color).toBe("green");
    close(a, b);
  });

  it("bad keys get bad_message and change nothing", async () => {
    const { stub, a, b } = await room();
    expect(await a.request({ type: "frameEdit", id: frameId(0), titleFontSize: "xxl" })).toMatchObject({ code: "bad_message" });
    expect(await a.request({ type: "frameEdit", id: frameId(0), titleTextColor: "#ff0000" })).toMatchObject({ code: "bad_message" });
    expect(await a.request({ type: "frameEdit", id: frameId(0), titleAlign: "justify" })).toMatchObject({ code: "bad_message" });
    expect(await a.request({ type: "frameEdit", id: frameId(0), titleBold: "yes" })).toMatchObject({ code: "bad_message" });
    expect(await a.request({ type: "frameAdd", clientRef: "r9", x: 0, y: 0, color: "neutral", title: "", titleFontSize: "l" })).toMatchObject({ code: "bad_message" });
    expect((await storedFrames(stub))[0]).toMatchObject({ title_font_size: "m", title_bold: 1, title_text_color: "auto", title_align: "left", rev: 1 });
    close(a, b);
  });
});

describe(`schema migration 6 -> ${SCHEMA_VERSION}`, () => {
  it("adds the five title style columns with defaults; frames look exactly as before and notes are untouched", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV6(sql);
      const store = new NoteStore(sql);
      expect(SCHEMA_VERSION).toBe(7);
      expect(version(sql)).toBe(7);
      expect(store.allFrames()).toEqual(V6_FRAMES.map((f) => ({ ...f, ...FRAME_DEFAULTS, authorId: "AAAAAAAAAAAAAAAA" })));
      expect(store.all().map((n) => [n.id, n.x, n.y, n.z, n.rev, n.text])).toEqual(V5_NOTES.map((n) => [n.id, n.x, n.y, n.z, n.rev, n.text]));
      const columns = sql.exec<{ name: string; dflt_value: string | null; notnull: number }>("SELECT name, dflt_value, \"notnull\" FROM pragma_table_info('frames')").toArray();
      expect(columns.map((c) => c.name)).toEqual(["id", "x", "y", "w", "h", "title", "color", "rev", "author_id", "title_font_size", "title_bold", "title_italic", "title_text_color", "title_align"]);
      const added = Object.fromEntries(columns.slice(9).map((c) => [c.name, [c.dflt_value, c.notnull]]));
      expect(added).toEqual({
        title_font_size: ["'m'", 1],
        title_bold: ["1", 1],
        title_italic: ["0", 1],
        title_text_color: ["'auto'", 1],
        title_align: ["'left'", 1],
      });
    });
  });

  it("runs once (a second load writes nothing) and is idempotent if some columns already exist", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV6(sql);
      // An interrupted migration: one column already added, version still 6.
      sql.exec("ALTER TABLE frames ADD COLUMN title_font_size TEXT NOT NULL DEFAULT 'm'");
      new NoteStore(sql);
      expect(version(sql)).toBe(SCHEMA_VERSION);
      const again = new NoteStore(sql);
      expect(again.rowsWritten).toBe(0);
      expect(again.allFrames()).toHaveLength(V6_FRAMES.length);
    });
  });

  it("v9 code's frame insert and update statements still work on schema 7 (rollback safety)", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV6(sql);
      const store = new NoteStore(sql);
      // A styled frame, saved by v10 code.
      const styled = { ...store.getFrame(V6_FRAMES[1].id)!, titleFontSize: "l" as const, titleItalic: true, rev: 4 };
      store.updateFrame(styled);
      // Then v9 code (after a rollback) inserts one frame and moves the styled one.
      sql.exec(V6_FRAME_INSERT, "fromV9code000001", 100, 900, 640, 400, "Continue", "green", 1, "AAAAAAAAAAAAAAAA");
      const f = V6_FRAMES[1];
      sql.exec(V6_FRAME_UPDATE, 900, 50, f.w, f.h, "Stop now", f.color, 5, f.id);
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Priya");
    const frames = c.frames?.frames ?? [];
    expect(frames.find((x) => x.id === "fromV9code000001")).toMatchObject({ title: "Continue", ...FRAME_DEFAULTS });
    // v9's update leaves the style columns alone.
    expect(frames.find((x) => x.id === V6_FRAMES[1].id)).toMatchObject({ x: 900, y: 50, title: "Stop now", titleFontSize: "l", titleItalic: true, rev: 5 });
    c.close();
  });

  it("title style survives a restart; a bad stored key skips the row (never fatal)", async () => {
    const { code, stub, a, b } = await room();
    a.send({ type: "frameEdit", id: frameId(0), titleFontSize: "s", titleAlign: "right" });
    await nextOfType(b, "frameUpdated");
    close(a, b);
    await runInDurableObject(stub, (_room, state) => {
      state.storage.sql.exec(V6_FRAME_INSERT, frameId(1), 0, 600, 640, 400, "Odd", "neutral", 1, "AAAAAAAAAAAAAAAA");
      state.storage.sql.exec("UPDATE frames SET title_text_color = 'teal' WHERE id = ?", frameId(1));
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Priya");
    expect(c.frames?.frames).toHaveLength(1);
    expect(c.frames?.frames[0]).toMatchObject({ id: frameId(0), titleFontSize: "s", titleAlign: "right", titleBold: true });
    c.close();
  });
});
