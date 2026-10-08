import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  FRAME_DEFAULTS,
  FRAME_MAX_W,
  MAX_BATCH_ENTRIES,
  MAX_FRAMES_PER_ROOM,
  MAX_MESSAGE_BYTES,
  MAX_NOTES_PER_ROOM,
  NOTE_DEFAULTS,
  NOTE_MAX_W,
  NOTE_Z_LIMIT,
  PROTOCOL_VERSION,
  type FrameItem,
  type NoteItem,
} from "@stickyard/shared";
import { BATCH_LIMITS, SOCKET_LIMITS } from "../src/limits";
import { entriesOf, type Room } from "../src/room";
import { TestClient, emptyEntryBudget, nextOfType, specRoomCode } from "./helpers";

/*
 * Protocol v11 (slice create with content): itemsAdd adds notes and frames with their full
 * content in one message, one transaction and one broadcast. Generic fixtures.
 */

const noteId = (i: number) => `note${String(i).padStart(12, "0")}`;
const frameId = (i: number) => `frame${String(i).padStart(11, "0")}`;

const noteItem = (ref: string, extra: Partial<NoteItem> = {}): NoteItem => ({
  ref,
  x: 100,
  y: 200,
  w: 200,
  h: 120,
  text: "Idea one\nmore",
  color: "blue",
  fontSize: "l",
  bold: true,
  italic: false,
  textColor: "red",
  align: "center",
  titleAlign: "right",
  titleFontSize: "xl",
  titleBold: false,
  titleItalic: true,
  titleTextColor: "grey",
  ...extra,
});
const frameItem = (ref: string, extra: Partial<FrameItem> = {}): FrameItem => ({
  ref,
  x: 0,
  y: 0,
  w: 800,
  h: 500,
  title: "Start",
  color: "green",
  titleFontSize: "xl",
  titleBold: false,
  titleItalic: true,
  titleTextColor: "blue",
  titleAlign: "center",
  ...extra,
});
/** A note entry as it comes back: the content without the ref. */
const content = ({ ref: _, ...rest }: NoteItem | FrameItem) => rest;

async function newRoom() {
  const { code, id } = await specRoomCode();
  return { code, stub: env.ROOM.get(env.ROOM.idFromName(id)) };
}

/** A room seeded with `notes` notes (z given, or 0..n-1) and `frames` frames, and two joined clients. */
async function room({ notes = 0, frames = 0, zs }: { notes?: number; frames?: number; zs?: readonly number[] } = {}) {
  const { code, stub } = await newRoom();
  await runInDurableObject(stub, (_room, state) => {
    const z = zs ?? Array.from({ length: notes }, (_, i) => i);
    z.forEach((zi, i) => {
      state.storage.sql.exec(
        "INSERT INTO notes (id, x, y, text, color, rev, author_id, z) VALUES (?, 0, 0, 'Idea', 'yellow', 1, 'AAAAAAAAAAAAAAAA', ?)",
        noteId(i),
        zi,
      );
    });
    for (let i = 0; i < frames; i++) {
      state.storage.sql.exec("INSERT INTO frames (id, x, y, title, rev, author_id) VALUES (?, 0, 0, '', 1, 'AAAAAAAAAAAAAAAA')", frameId(i));
    }
  });
  const a = await TestClient.open(code);
  const b = await TestClient.open(code);
  const joined = await a.enter("Alex");
  await b.enter("Sam");
  await nextOfType(a, "participant_joined");
  return { code, stub, a, b, you: joined.you };
}

const rowsWritten = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (r: Room) => r.rowsWritten);
const transactions = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (r: Room) => r.transactions);
const counts = (stub: DurableObjectStub<Room>) =>
  runInDurableObject(stub, (_r, state) => ({
    notes: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM notes").one().n,
    frames: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM frames").one().n,
  }));
const close = (...cs: TestClient[]) => cs.forEach((c) => c.close());

describe("protocol v11", () => {
  it("a protocol v10 page is refused with version_mismatch (please reload)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(11);
    expect(await c.request({ type: "hello", protocolVersion: 10 })).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Priya" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });

  it("noteAdd and frameAdd still work unchanged (default size and style)", async () => {
    const { a, b } = await room();
    a.send({ type: "noteAdd", clientRef: "r1", x: 10, y: 10, color: "pink", text: "Idea" });
    expect((await nextOfType(b, "noteAdded")).note).toMatchObject({ x: 10, y: 10, ...NOTE_DEFAULTS, text: "Idea", color: "pink", rev: 1 });
    a.send({ type: "frameAdd", clientRef: "r2", x: 0, y: 0, color: "neutral", title: "Plan" });
    expect((await nextOfType(b, "frameAdded")).frame).toMatchObject({ w: 640, h: 400, title: "Plan", ...FRAME_DEFAULTS, rev: 1 });
    close(a, b);
  });
});

describe("itemsAdd", () => {
  it("adds notes and frames with their full content; refs and clientRef only in the sender's copy; author from the socket", async () => {
    const { a, b, you } = await room();
    const notes = [noteItem("n1"), noteItem("n2", { color: "pink", text: "Second" })];
    const frames = [frameItem("f1")];
    a.send({ type: "itemsAdd", clientRef: "c1", notes, frames });
    const mine = await nextOfType(a, "itemsAdded");
    const theirs = await nextOfType(b, "itemsAdded");
    expect(mine.clientRef).toBe("c1");
    expect(mine.notes.map((n) => n.ref)).toEqual(["n1", "n2"]);
    expect(mine.frames.map((f) => f.ref)).toEqual(["f1"]);
    expect(mine.refused).toEqual([]);
    expect(mine.notes[0]?.note).toMatchObject({ ...content(notes[0]!), rev: 1, authorId: you.id });
    expect(mine.notes[1]?.note).toMatchObject({ ...content(notes[1]!), rev: 1, authorId: you.id });
    expect(mine.frames[0]?.frame).toMatchObject({ ...content(frames[0]!), rev: 1, authorId: you.id });
    // Server ids, all different.
    const ids = [...mine.notes.map((n) => n.note.id), ...mine.frames.map((f) => f.frame.id)];
    expect(new Set(ids).size).toBe(3);
    expect(theirs).toEqual({ type: "itemsAdded", notes: mine.notes.map(({ note }) => ({ note })), frames: mine.frames.map(({ frame }) => ({ frame })), refused: [] });
    close(a, b);
  });

  it("one transaction, one broadcast, rev 1 per row; a note insert writes 2 rows and a frame insert 2 rows", async () => {
    const { stub, a, b } = await room();
    const writes = await rowsWritten(stub);
    const tx = await transactions(stub);
    a.send({ type: "itemsAdd", clientRef: "c1", notes: [noteItem("n1"), noteItem("n2"), noteItem("n3")], frames: [frameItem("f1"), frameItem("f2")] });
    const theirs = await nextOfType(b, "itemsAdded");
    expect([...theirs.notes.map((n) => n.note.rev), ...theirs.frames.map((f) => f.frame.rev)]).toEqual([1, 1, 1, 1, 1]);
    await nextOfType(a, "itemsAdded");
    expect(await b.quiet()).toBe(true);
    // Each row plus its primary-key index entry.
    expect((await rowsWritten(stub)) - writes).toBe(3 * 2 + 2 * 2);
    expect(await transactions(stub)).toBe(tx + 1);
    expect(await counts(stub)).toEqual({ notes: 3, frames: 2 });
    close(a, b);
  });

  it("is stored: a restart and a new join see every field", async () => {
    const { code, stub, a, b } = await room();
    a.send({ type: "itemsAdd", clientRef: "c1", notes: [noteItem("n1")], frames: [frameItem("f1")] });
    const added = await nextOfType(a, "itemsAdded");
    close(a, b);
    await evictDurableObject(stub);
    const c = await TestClient.open(code);
    await c.enter("Priya");
    expect(c.snapshot?.notes).toEqual([added.notes[0]?.note]);
    expect(c.frames?.frames).toEqual([added.frames[0]?.frame]);
    c.close();
  });

  it("text is cleaned like noteAdd and frameAdd; sizes and positions are clamped", async () => {
    const { a, b } = await room();
    a.send({
      type: "itemsAdd",
      clientRef: "c1",
      notes: [noteItem("n1", { text: "  Idea\r\none​\u0007 ", x: BOARD_WIDTH, y: BOARD_HEIGHT, w: NOTE_MAX_W, h: 96 })],
      frames: [frameItem("f1", { title: "  Start\n here ", x: BOARD_WIDTH, y: 10, w: FRAME_MAX_W, h: 300 })],
    });
    const { notes, frames } = await nextOfType(b, "itemsAdded");
    expect(notes[0]?.note).toMatchObject({ text: "Idea\none", x: BOARD_WIDTH - NOTE_MAX_W, y: BOARD_HEIGHT - 96, w: NOTE_MAX_W, h: 96 });
    expect(frames[0]?.frame).toMatchObject({ title: "Start here", x: BOARD_WIDTH - FRAME_MAX_W, y: 10, w: FRAME_MAX_W, h: 300 });
    close(a, b);
  });

  it("each entry is checked on its own: bad ones are refused by kind, index and ref; the rest are added", async () => {
    const { stub, a, b } = await room();
    a.send({
      type: "itemsAdd",
      clientRef: "c1",
      notes: [noteItem("n1"), { ...noteItem("n2"), fontSize: "huge" }, { ...noteItem("n3"), authorId: "BBBBBBBBBBBBBBBB" }, noteItem("n4")],
      frames: [{ ...frameItem("f1"), id: frameId(9) }, frameItem("f2"), { ref: "f3" }, "frame"],
    });
    const mine = await nextOfType(a, "itemsAdded");
    expect(mine.notes.map((n) => n.ref)).toEqual(["n1", "n4"]);
    expect(mine.frames.map((f) => f.ref)).toEqual(["f2"]);
    expect(mine.refused).toEqual([
      { kind: "note", index: 1, ref: "n2", reason: "invalid" },
      { kind: "note", index: 2, ref: "n3", reason: "invalid" },
      { kind: "frame", index: 0, ref: "f1", reason: "invalid" },
      { kind: "frame", index: 2, ref: "f3", reason: "invalid" },
      { kind: "frame", index: 3, reason: "invalid" },
    ]);
    expect((await nextOfType(b, "itemsAdded")).refused).toEqual([]);
    expect(await counts(stub)).toEqual({ notes: 2, frames: 1 });
    close(a, b);
  });

  it("unknown style keys are refused (the entry, not the message)", async () => {
    const { a, b } = await room();
    a.send({ type: "itemsAdd", clientRef: "c1", notes: [{ ...noteItem("n1"), textColor: "#ff0000" }, noteItem("n2")], frames: [{ ...frameItem("f1"), titleAlign: "justify" }] });
    const mine = await nextOfType(a, "itemsAdded");
    expect(mine.notes.map((n) => n.ref)).toEqual(["n2"]);
    expect(mine.refused.map((r) => r.ref)).toEqual(["n1", "f1"]);
    close(a, b);
  });

  it("a ref used twice refuses the whole message: nothing written, nothing broadcast", async () => {
    const { stub, a, b } = await room();
    const writes = await rowsWritten(stub);
    a.send({ type: "itemsAdd", clientRef: "c1", notes: [noteItem("x1")], frames: [frameItem("x1")] });
    expect(await nextOfType(a, "error")).toMatchObject({ code: "bad_message", clientRef: "c1" });
    expect(await b.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(writes);
    close(a, b);
  });

  it(`room caps (${MAX_NOTES_PER_ROOM} notes, ${MAX_FRAMES_PER_ROOM} frames): free slots are filled in order and the rest refused with the reason`, async () => {
    const { stub, a, b } = await room({ notes: MAX_NOTES_PER_ROOM - 2, frames: MAX_FRAMES_PER_ROOM - 1 });
    a.send({
      type: "itemsAdd",
      clientRef: "c1",
      notes: [noteItem("n1"), { ref: "bad" }, noteItem("n2"), noteItem("n3"), noteItem("n4")],
      frames: [frameItem("f1"), frameItem("f2")],
    });
    const mine = await nextOfType(a, "itemsAdded");
    expect(mine.notes.map((n) => n.ref)).toEqual(["n1", "n2"]);
    expect(mine.frames.map((f) => f.ref)).toEqual(["f1"]);
    expect(mine.refused).toEqual([
      { kind: "note", index: 1, ref: "bad", reason: "invalid" },
      { kind: "note", index: 3, ref: "n3", reason: "notes_full" },
      { kind: "note", index: 4, ref: "n4", reason: "notes_full" },
      { kind: "frame", index: 1, ref: "f2", reason: "frames_full" },
    ]);
    await nextOfType(b, "itemsAdded");
    expect(await counts(stub)).toEqual({ notes: MAX_NOTES_PER_ROOM, frames: MAX_FRAMES_PER_ROOM });
    close(a, b);
  });

  it("nothing added: no itemsAdded to anyone; the sender gets an error naming the message and each refused item", async () => {
    const { stub, a, b } = await room({ notes: MAX_NOTES_PER_ROOM, frames: MAX_FRAMES_PER_ROOM });
    const writes = await rowsWritten(stub);
    a.send({ type: "itemsAdd", clientRef: "c1", notes: [noteItem("n1")] });
    expect(await nextOfType(a, "error")).toMatchObject({ code: "notes_full", clientRef: "c1", refused: [{ kind: "note", index: 0, ref: "n1", reason: "notes_full" }] });
    a.send({ type: "itemsAdd", clientRef: "c2", frames: [frameItem("f1")] });
    expect(await nextOfType(a, "error")).toMatchObject({ code: "frames_full", clientRef: "c2", refused: [{ kind: "frame", index: 0, ref: "f1", reason: "frames_full" }] });
    a.send({ type: "itemsAdd", clientRef: "c3", notes: [{ ref: "n1" }] });
    expect(await nextOfType(a, "error")).toMatchObject({ code: "bad_message", clientRef: "c3", refused: [{ kind: "note", index: 0, ref: "n1", reason: "invalid" }] });
    expect(await b.quiet()).toBe(true);
    expect(await a.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(writes);
    close(a, b);
  });

  it("z is assigned in array order, on top of everything (max z + 1, ...)", async () => {
    const { a, b } = await room({ zs: [0, 7, 3] });
    a.send({ type: "itemsAdd", clientRef: "c1", notes: [noteItem("n1"), noteItem("n2"), noteItem("n3")] });
    const { notes } = await nextOfType(b, "itemsAdded");
    expect(notes.map((n) => n.note.z)).toEqual([8, 9, 10]);
    close(a, b);
  });

  it("at the bound the room is renumbered first (notesOrdered before itemsAdded) and the new notes still go on top, in order", async () => {
    const { stub, a, b } = await room({ zs: [NOTE_Z_LIMIT - 1, -3] });
    const tx = await transactions(stub);
    a.send({ type: "itemsAdd", clientRef: "c1", notes: [noteItem("n1"), noteItem("n2"), noteItem("n3")] });
    const ordered = await b.next();
    expect(ordered.type).toBe("notesOrdered");
    if (ordered.type !== "notesOrdered") return;
    expect(ordered.results.map((r) => [r.id, r.z, r.rev]).sort()).toEqual([
      [noteId(0), 1, 2],
      [noteId(1), 0, 2],
    ]);
    const added = await b.next();
    expect(added.type).toBe("itemsAdded");
    if (added.type !== "itemsAdded") return;
    const zs = added.notes.map((n) => n.note.z);
    expect(zs).toEqual([...zs].sort((x, y) => x - y));
    expect(Math.min(...zs)).toBeGreaterThan(1);
    expect(Math.max(...zs)).toBeLessThanOrEqual(NOTE_Z_LIMIT);
    // The renumbering and the inserts in one transaction.
    expect(await transactions(stub)).toBe(tx + 1);
    close(a, b);
  });

  it("before join gets not_joined naming the message", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    await c.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    expect(await c.request({ type: "itemsAdd", clientRef: "c1", notes: [noteItem("n1")] })).toMatchObject({ type: "error", code: "not_joined", clientRef: "c1" });
    c.close();
  });

  it("malformed messages get bad_message and never throw (empty, over 50 items, extra field)", async () => {
    const { a, b } = await room();
    const many = Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, i) => ({ ref: `r${i}` }));
    for (const bad of [
      { type: "itemsAdd", clientRef: "c1" },
      { type: "itemsAdd", clientRef: "c1", notes: [] },
      { type: "itemsAdd", clientRef: "c1", notes: many },
      { type: "itemsAdd", clientRef: "c1", notes: [noteItem("n1")], authorId: "BBBBBBBBBBBBBBBB" },
    ]) {
      expect(await a.request(bad)).toMatchObject({ type: "error", code: "bad_message" });
    }
    expect(await b.quiet()).toBe(true);
    close(a, b);
  });

  it("a message over the byte cap is refused by the existing guard (too_large), unparsed", async () => {
    const { stub, a, b } = await room();
    const writes = await rowsWritten(stub);
    const notes = Array.from({ length: 3 }, (_, i) => noteItem(`n${i}`, { text: "\ud800".repeat(280) }));
    const raw = JSON.stringify({ type: "itemsAdd", clientRef: "c1", notes });
    expect(raw.length).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(await a.request(raw)).toMatchObject({ type: "error", code: "too_large" });
    expect(await b.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(writes);
    close(a, b);
  });
});

describe("rate budget", () => {
  it("entries spend BATCH_LIMITS: one per note and frame", () => {
    expect(entriesOf({ type: "itemsAdd", clientRef: "c1", notes: [noteItem("a"), noteItem("b")], frames: [frameItem("c")] })).toBe(3);
    expect(entriesOf({ type: "itemsAdd", clientRef: "c1", frames: [frameItem("c")] })).toBe(1);
  });

  it("an itemsAdd is one message: 30 messages of 2 notes each (60 items, more than the burst of 40) all go through", async () => {
    expect(30).toBeLessThan(SOCKET_LIMITS.burst);
    expect(60).toBeGreaterThan(SOCKET_LIMITS.burst);
    const { a, b } = await room();
    for (let n = 0; n < 30; n++) a.send({ type: "itemsAdd", clientRef: `c${n}`, notes: [noteItem(`a${n}`), noteItem(`b${n}`)] });
    for (let n = 0; n < 30; n++) expect((await nextOfType(a, "itemsAdded")).clientRef).toBe(`c${n}`);
    expect(await a.quiet()).toBe(true);
    close(a, b);
  });

  it("over the entries budget, an itemsAdd is dropped with rate_limited naming the message", async () => {
    const { stub, a, b } = await room({ notes: MAX_BATCH_ENTRIES });
    // Spending the burst with live batches first only works if they beat the refill, which a busy
    // runner can't promise; so the bucket starts empty. Then a few itemsAdd of 20 frames each.
    expect(BATCH_LIMITS.entriesBurst).toBeGreaterThan(0);
    await emptyEntryBudget(stub, "Alex");
    const sends = 3;
    expect(sends).toBeLessThan(SOCKET_LIMITS.maxViolations);
    for (let n = 0; n < sends; n++) a.send({ type: "itemsAdd", clientRef: `c${n}`, frames: Array.from({ length: 20 }, (_, i) => frameItem(`f${i}`, { title: "" })) });
    const answers = new Map<string, string>();
    while (answers.size < sends) {
      const m = await a.next();
      if ((m.type === "error" || m.type === "itemsAdded") && m.clientRef !== undefined) answers.set(m.clientRef, m.type === "error" ? m.code : m.type);
    }
    expect([...answers.values()]).toContain("rate_limited");
    // The frames cap still holds: whatever got through filled at most the free slots.
    expect((await counts(stub)).frames).toBeLessThanOrEqual(MAX_FRAMES_PER_ROOM);
    expect(a.closeCode).toBeNull();
    close(a, b);
  });
});
