/// <reference types="vite/client" />
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  MAX_NOTES_PER_ROOM,
  MAX_SEALED_PER_WRITER,
  NOTE_DEFAULTS,
  NOTE_Z_LIMIT,
  PROTOCOL_VERSION,
  REVEAL_CHUNK_NOTES,
  type NoteItem,
  type ServerMessage,
} from "@stickyard/shared";
import type { Room } from "../src/room";
import { NoteStore, SCHEMA_VERSION } from "../src/noteStore";
import { voterIdFor } from "../src/voterId";
import { writerIdFor } from "../src/writerId";
import { V5_NOTES } from "./fixtures/schemaV5";
import { V6_FRAMES } from "./fixtures/schemaV6";
import { V9_FRAME_INSERT, V9_NOTE_DELETE, V9_NOTE_INSERT, V9_NOTE_UPDATE, V9_SHAPE, loadSchemaV9 } from "./fixtures/schemaV9";
import { TEST_SIGNING_KEY, TestClient, nextOfType, specHostToken, specRoomCode } from "./helpers";

/*
 * Silent brainstorm, protocol v17 and stored schema 10 (part 1: relay and shared). While a round
 * is silent, notes added are sealed: only their writer's sockets ever hear about them (content,
 * id, position, size, colour, author), everyone else gets one count. The host reveals them all
 * at once. These tests drive the real Durable Object over WebSockets and read every raw message
 * each socket receives. Fake keys only (vitest.config.ts); generic text.
 */

const writerSources = import.meta.glob<string>("../src/writerId.ts", { query: "?raw", import: "default", eager: true });

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
/** A fresh client key as the web makes one: 128 random bits, base64url (22 characters). */
const newKey = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
/** A random id in the server's format that names nothing. */
const unknownId = () => b64url(crypto.getRandomValues(new Uint8Array(12)));

/** The writer id straight from the spec, independently of src/writerId.ts. */
async function specWriterId(roomId: string, key: string, signingKey = TEST_SIGNING_KEY): Promise<string> {
  const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`stickyard-writer-v1:${roomId}:${key}`))));
}

async function newRoom() {
  const { code, id } = await specRoomCode();
  return { code, id, token: await specHostToken(id), stub: env.ROOM.get(env.ROOM.idFromName(id)) };
}

type Stub = DurableObjectStub<Room>;
type Row = Record<string, SqlStorageValue>;
const rowsWritten = (stub: Stub) => runInDurableObject(stub, (r: Room) => r.rowsWritten);
const transactions = (stub: Stub) => runInDurableObject(stub, (r: Room) => r.transactions);
const allRows = (stub: Stub) =>
  runInDurableObject(stub, (_r, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
      .toArray()
      .map((t) => t.name);
    const rows: Record<string, Row[]> = {};
    for (const t of tables) rows[t] = state.storage.sql.exec<Row>(`SELECT * FROM ${t}`).toArray();
    return rows;
  });
const noteRows = async (stub: Stub) => (await allRows(stub)).notes ?? [];
const meta = async (stub: Stub) => Object.fromEntries(((await allRows(stub)).meta ?? []).map((r) => [String(r.key), Number(r.value)]));
const attachments = (stub: Stub) => runInDurableObject(stub, (_r, state) => state.getWebSockets().map((ws) => ws.deserializeAttachment() as unknown));
const closeAll = (...cs: TestClient[]) => cs.forEach((c) => c.close());
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
/** Reads and drops whatever a client has been sent until it is quiet. */
async function drain(...cs: TestClient[]) {
  for (const c of cs) while (!(await c.quiet(60))) await c.next(1).catch(() => undefined);
}
/** Everything a client has been sent until it is quiet. */
async function collect(c: TestClient): Promise<ServerMessage[]> {
  const out: ServerMessage[] = [];
  while (!(await c.quiet(80))) out.push(await c.next());
  return out;
}

/** Every raw message a client receives, from the moment it opens. */
function recorded(c: TestClient): string[] {
  const raw: string[] = [];
  c.ws.addEventListener("message", (e) => raw.push(String(e.data)));
  return raw;
}

/** Every string and every number anywhere in a list of raw messages. */
function leaves(raw: readonly string[]): { strings: string[]; numbers: number[] } {
  const strings: string[] = [];
  const numbers: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") strings.push(v);
    else if (typeof v === "number") numbers.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const r of raw) walk(JSON.parse(r));
  return { strings, numbers };
}

const noteItem = (ref: string, text: string, extra: Partial<NoteItem> = {}): NoteItem => {
  const { w, h, ...style } = NOTE_DEFAULTS;
  return { ref, x: 100, y: 100, w, h, text, color: "yellow", ...style, ...extra };
};

/** A room with a host (Hana, claimed), two guests (Ari and Ben), each with their own client key. */
async function silentRoom() {
  const room = await newRoom();
  const keys = { host: newKey(), a: newKey(), b: newKey() };
  const host = await TestClient.open(room.code);
  const a = await TestClient.open(room.code);
  const b = await TestClient.open(room.code);
  const raw = { host: recorded(host), b: recorded(b) };
  await host.enter("Hana", keys.host);
  await a.enter("Ari", keys.a);
  await b.enter("Ben", keys.b);
  expect(await host.request({ type: "claimHost", token: room.token })).toEqual({ type: "hostGranted" });
  await drain(host, a, b);
  return { ...room, keys, host, a, b, raw };
}

async function startSilent(host: TestClient, others: TestClient[]) {
  expect(await host.request({ type: "silentStart" })).toEqual({ type: "silentChanged", active: true, count: 0 });
  for (const o of others) expect(await nextOfType(o, "silentChanged")).toEqual({ type: "silentChanged", active: true, count: 0 });
}

/** A sealed add by `c`: its noteAdded (with clientRef), then the count to everyone in `all`. */
async function sealedAdd(c: TestClient, all: TestClient[], text: string, count: number, at = { x: 50, y: 50 }) {
  c.send({ type: "noteAdd", clientRef: "s1", ...at, color: "yellow", text });
  const added = await nextOfType(c, "noteAdded");
  expect(added.clientRef).toBe("s1");
  for (const o of all) expect(await nextOfType(o, "silentChanged")).toEqual({ type: "silentChanged", active: true, count });
  return added.note;
}

describe("versions", () => {
  it("protocol 17 and stored schema 10; a v16 page is asked to reload", async () => {
    expect(PROTOCOL_VERSION).toBe(17);
    expect(SCHEMA_VERSION).toBe(10);
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request({ type: "hello", protocolVersion: 16 })).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Ari" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });

  it("joined carries the silent state (off, 0 in a fresh room)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect((await c.enter("Ari")).silent).toEqual({ active: false, count: 0 });
    c.close();
  });
});

describe("writer id", () => {
  it("is the full HMAC of room id and key under its own domain, different from the voter id for the same key", async () => {
    const { id } = await specRoomCode();
    const key = newKey();
    const writer = await writerIdFor(id, key, TEST_SIGNING_KEY);
    expect(writer).toBe(await specWriterId(id, key));
    expect(writer).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(writer).not.toBe(await voterIdFor(id, key, TEST_SIGNING_KEY));
    expect(await writerIdFor(id, newKey(), TEST_SIGNING_KEY)).not.toBe(writer);
    expect(await writerIdFor((await specRoomCode()).id, key, TEST_SIGNING_KEY)).not.toBe(writer);
    expect(await writerIdFor(id, key, "")).toBeNull();
    expect(await writerIdFor("", key, TEST_SIGNING_KEY)).toBeNull();
  });

  it("the module only derives: it keeps nothing and logs nothing", () => {
    const text = Object.values(writerSources)[0] ?? "";
    expect(text).toContain("hmacSha256(");
    expect(text).toContain("stickyard-writer-v1:");
    expect(text).not.toMatch(/\bconsole\b|\bstorage\b|\bsql\b/);
  });

  it("join learns it before the snapshot; the attachment keeps the HMAC (never the key) and stays far under 16 KiB", async () => {
    const { code, id, stub } = await newRoom();
    const key = newKey();
    const c = await TestClient.open(code);
    await c.enter("😀".repeat(24), key);
    const list = await attachments(stub);
    const mine = list.find((a) => (a as { writerId?: string }).writerId);
    expect((mine as { writerId: string }).writerId).toBe(await specWriterId(id, key));
    expect(JSON.stringify(list)).not.toContain(key);
    for (const a of list) expect(new TextEncoder().encode(JSON.stringify(a)).length).toBeLessThan(1024);
    c.close();
  });

  it("a malformed key refuses the join (bad_message); no key joins without a writer", async () => {
    const { code, stub } = await newRoom();
    const c = await TestClient.open(code);
    await c.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    expect(await c.request({ type: "join", name: "Ari", key: "short" })).toMatchObject({ type: "error", code: "bad_message" });
    expect(await c.request({ type: "join", name: "Ari" })).toMatchObject({ type: "joined" });
    expect((await attachments(stub)).map((a) => (a as { writerId: unknown }).writerId)).toEqual([null]);
    c.close();
  });

  it("is stored only on sealed notes, never sent, and NULL once revealed; voter and writer ids for one key can't be joined", async () => {
    const { id, host, a, b, stub, keys, raw } = await silentRoom();
    const rawA = recorded(a);
    const before = await noteAdd(b, "visible");
    await drain(host, a, b);
    await startSilent(host, [a, b]);
    await a.request({ type: "claimVoter", key: keys.a });
    await sealedAdd(a, [host, a, b], "Idea", 1);
    const writer = await specWriterId(id, keys.a);
    const rows = await noteRows(stub);
    expect(rows.find((r) => r.id === before.id)).toMatchObject({ sealed: 0, writer: null });
    expect(rows.filter((r) => r.sealed === 1).map((r) => r.writer)).toEqual([writer]);
    for (const r of [...raw.host, ...raw.b, ...rawA]) {
      expect(r).not.toContain(writer);
      for (const k of Object.values(keys)) expect(r).not.toContain(k);
    }
    expect(writer).not.toBe(await voterIdFor(id, keys.a, TEST_SIGNING_KEY));
    await host.request({ type: "silentReveal" });
    await settle();
    expect((await noteRows(stub)).every((r) => r.sealed === 0 && r.writer === null)).toBe(true);
    closeAll(host, a, b);
  });
});

/** A plain note (not silent) by `c`, confirmed. */
async function noteAdd(c: TestClient, text: string, at = { x: 10, y: 10 }) {
  c.send({ type: "noteAdd", clientRef: "p1", ...at, color: "yellow", text });
  return (await nextOfType(c, "noteAdded")).note;
}

describe("the canary leak test", () => {
  it("nobody but the writer's sockets ever receives a sealed note's text, title, colour, place, size, id or author", async () => {
    const { code, stub, host, a, b, keys, raw } = await silentRoom();
    const rawA: string[] = recorded(a);
    // A visible note and frame from before the round, so carries and orders have something to touch.
    const frame = (await host.request({ type: "frameAdd", clientRef: "f1", x: 1000, y: 1000, color: "neutral", title: "Ideas" })) as Extract<ServerMessage, { type: "frameAdded" }>;
    const old = await noteAdd(b, "Before the round", { x: 1100, y: 1100 });
    await drain(host, a, b);
    await startSilent(host, [a, b]);
    const all = [host, a, b];
    const sealed = new Set<string>();

    // 1. Add.
    const s1 = await sealedAdd(a, all, "CANARY-title-1\nCANARY-body-1", 1, { x: 1200, y: 1200 });
    sealed.add(s1.id);

    // 2. A second socket for A (same key): its snapshot has A's sealed note, and it hears A's changes from now on.
    const a2 = await TestClient.open(code);
    await a2.enter("Ari", keys.a);
    expect(a2.snapshot?.notes.map((n) => n.id)).toEqual([old.id, s1.id]);
    await drain(host, a, b);

    // 3. Edit text, colour and style.
    a.send({ type: "noteEdit", id: s1.id, text: "CANARY-title-2\nCANARY-body-2", color: "purple", titleBold: true, fontSize: "xl" });
    expect((await nextOfType(a, "noteUpdated")).note).toMatchObject({ id: s1.id, color: "purple" });
    expect((await nextOfType(a2, "noteUpdated")).note).toMatchObject({ id: s1.id, color: "purple" });

    // 4. Move (live, then final) and 5. resize (live, then final) to canary places and sizes.
    a.send({ type: "noteMove", id: s1.id, x: 4000, y: 2900, final: false });
    expect(await nextOfType(a2, "noteMoved")).toMatchObject({ id: s1.id, final: false });
    a.send({ type: "noteMove", id: s1.id, x: 4321, y: 2987, final: true });
    expect(await nextOfType(a, "noteMoved")).toMatchObject({ id: s1.id, x: 4321, y: 2987, final: true });
    await nextOfType(a2, "noteMoved");
    a.send({ type: "noteResize", id: s1.id, x: 4321, y: 2987, w: 356, h: 412, final: false });
    expect(await nextOfType(a2, "noteResized")).toMatchObject({ final: false, w: 356 });
    a.send({ type: "noteResize", id: s1.id, x: 4321, y: 2987, w: 357, h: 413, final: true });
    expect(await nextOfType(a, "noteResized")).toMatchObject({ w: 357, h: 413, final: true });
    await nextOfType(a2, "noteResized");

    // 6. Batch: live, then final moves and resizes.
    a.send({ type: "noteBatch", ops: [{ op: "move", id: s1.id, x: 4100, y: 2700 }], final: false });
    expect(await nextOfType(a2, "notesBatchApplied")).toMatchObject({ final: false });
    a.send({ type: "noteBatch", ops: [{ op: "resize", id: s1.id, x: 4111, y: 2777, w: 359, h: 415 }], final: true });
    expect(await nextOfType(a, "notesBatchApplied")).toMatchObject({ final: true, results: [{ id: s1.id, w: 359 }] });
    await nextOfType(a2, "notesBatchApplied");

    // 7. Order: back, then front.
    for (const action of ["back", "front"] as const) {
      a.send({ type: "notesOrder", ids: [s1.id], action });
      expect((await nextOfType(a, "notesOrdered")).results.map((r) => r.id)).toContain(s1.id);
      await nextOfType(a2, "notesOrdered");
    }

    // 8. itemsAdd: two sealed notes and a frame. Others get the frame only, then the count.
    a.send({ type: "itemsAdd", clientRef: "i1", notes: [noteItem("n1", "CANARY-items-3", { x: 3333, y: 1777 }), noteItem("n2", "CANARY-items-4")], frames: [{ ref: "f2", x: 0, y: 3000, w: 640, h: 400, title: "Later", color: "neutral", titleFontSize: "m", titleBold: true, titleItalic: false, titleTextColor: "auto", titleAlign: "left" }] });
    const items = await nextOfType(a, "itemsAdded");
    expect(items.notes).toHaveLength(2);
    for (const { note } of items.notes) sealed.add(note.id);
    for (const o of [host, b]) {
      const theirs = await nextOfType(o, "itemsAdded");
      expect(theirs.notes).toEqual([]);
      expect(theirs.frames).toHaveLength(1);
      expect(await nextOfType(o, "silentChanged")).toEqual({ type: "silentChanged", active: true, count: 3 });
    }
    expect((await nextOfType(a2, "itemsAdded")).notes).toHaveLength(2);

    // 9. Duplicate-style itemsAdd (a ranked copy of a sealed note), notes only: others get just the count.
    a.send({ type: "itemsAdd", clientRef: "i2", notes: [noteItem("d1", "CANARY-dup-5", { rank: 0, color: "purple", x: 4321, y: 2987, w: 357, h: 413 })] });
    const dup = await nextOfType(a, "itemsAdded");
    sealed.add(dup.notes[0]!.note.id);
    for (const o of [host, b]) expect(await nextOfType(o, "silentChanged")).toEqual({ type: "silentChanged", active: true, count: 4 });

    // 10. Delete one, and 11. delete one in a final batch: each sends the count only.
    a.send({ type: "noteDelete", id: dup.notes[0]!.note.id });
    expect(await nextOfType(a, "noteDeleted")).toEqual({ type: "noteDeleted", id: dup.notes[0]!.note.id });
    for (const o of [host, b]) expect(await nextOfType(o, "silentChanged")).toEqual({ type: "silentChanged", active: true, count: 3 });
    const gone = items.notes[1]!.note;
    a.send({ type: "noteBatch", ops: [{ op: "delete", id: gone.id }], final: true });
    expect(await nextOfType(a, "notesBatchApplied")).toMatchObject({ results: [{ type: "noteDeleted", id: gone.id }] });
    for (const o of [host, b]) expect(await nextOfType(o, "silentChanged")).toEqual({ type: "silentChanged", active: true, count: 2 });

    // 12. Undo-style re-add of the deleted note (itemsAdd with its content).
    a.send({ type: "itemsAdd", clientRef: "i3", notes: [noteItem("u1", "CANARY-undo-6", { x: gone.x, y: gone.y })] });
    const undo = await nextOfType(a, "itemsAdded");
    sealed.add(undo.notes[0]!.note.id);
    for (const o of [host, b]) expect(await nextOfType(o, "silentChanged")).toEqual({ type: "silentChanged", active: true, count: 3 });

    // 13. frameMove carrying sealed notes (live and final): refused for A, nothing to anyone else.
    for (const final of [false, true]) {
      expect(await a.request({ type: "frameMove", id: frame.frame.id, x: 1500, y: 1500, final, noteIds: [s1.id, old.id] })).toMatchObject({ type: "error", code: "silent_active", frameId: frame.frame.id });
    }

    // 14. A vote on a sealed note: voting is off, so A alone hears voting_closed (its own id echoed).
    expect(await a.request({ type: "voteSet", noteId: s1.id, count: 1 })).toMatchObject({ type: "error", code: "voting_closed", noteId: s1.id });

    // 15. A late joiner without a key: no sealed note, the count only.
    const c = await TestClient.open(code);
    const rawC = recorded(c);
    const joinedC = await c.enter("Cleo");
    expect(joinedC.silent).toEqual({ active: true, count: 3 });
    expect(c.snapshot?.notes.map((n) => n.id)).toEqual([old.id]);

    // 16. A reconnect: A's second socket goes, a new one with A's key gets every sealed note of A's.
    a2.close();
    const a3 = await TestClient.open(code);
    await a3.enter("Ari", keys.a);
    const alive = [s1.id, items.notes[0]!.note.id, undo.notes[0]!.note.id];
    expect(a3.snapshot?.notes.map((n) => n.id)).toEqual([old.id, ...alive]);
    expect(a3.snapshot?.notes.find((n) => n.id === s1.id)).toMatchObject({ x: 4111, y: 2777, w: 359, h: 415, color: "purple", text: "CANARY-title-2\nCANARY-body-2" });

    // 17. Eviction: from storage alone, the same holds.
    await drain(host, a, b, c, a3);
    await evictDurableObject(stub);
    a.send({ type: "noteEdit", id: s1.id, text: "CANARY-after-eviction" });
    expect((await nextOfType(a, "noteUpdated")).note.text).toBe("CANARY-after-eviction");
    expect((await nextOfType(a3, "noteUpdated")).note.text).toBe("CANARY-after-eviction");
    const b2 = await TestClient.open(code);
    const rawB2 = recorded(b2);
    expect((await b2.enter("Ben", keys.b)).silent).toEqual({ active: true, count: 3 });
    expect(b2.snapshot?.notes.map((n) => n.id)).toEqual([old.id]);
    const a4 = await TestClient.open(code);
    await a4.enter("Ari", keys.a);
    expect(a4.snapshot?.notes.map((n) => n.id)).toEqual([old.id, ...alive]);
    await settle(150);

    // The transcripts: nothing sealed reached anyone but A's sockets.
    const canaryNumbers = [4321, 2987, 357, 413, 4000, 2900, 356, 412, 4100, 2700, 4111, 2777, 359, 415, 3333, 1777];
    for (const [who, transcript] of [["host", raw.host], ["B", raw.b], ["late joiner", rawC], ["B's second tab", rawB2]] as const) {
      const text = transcript.join("\n");
      expect(text, who).not.toContain("CANARY");
      expect(text, who).not.toContain("purple");
      for (const id of sealed) expect(text, `${who}: sealed id`).not.toContain(id);
      const { numbers } = leaves(transcript);
      for (const n of canaryNumbers) expect(numbers, `${who}: number ${n}`).not.toContain(n);
      // Count messages carry only the number.
      for (const r of transcript) {
        const m = JSON.parse(r) as { type: string };
        if (m.type === "silentChanged") expect(Object.keys(m).sort()).toEqual(["active", "count", "type"]);
      }
    }
    // Since the round started, the passive people got only these kinds of message.
    const sinceStart = (t: string[]) => t.slice(t.findIndex((r) => r.includes('"silentChanged"')));
    const kinds = (t: string[]) => new Set(t.map((r) => (JSON.parse(r) as { type: string }).type));
    const joining = ["welcome", "joined", "snapshot", "framesSnapshot", "shapesSnapshot"];
    for (const t of [sinceStart(raw.host), sinceStart(raw.b)]) {
      for (const k of kinds(t)) expect(["silentChanged", "participant_joined", "participant_left", "itemsAdded"]).toContain(k);
    }
    for (const t of [rawC, rawB2]) for (const k of kinds(t)) expect([...joining, "silentChanged", "participant_joined", "participant_left"]).toContain(k);
    // A got every one of its sealed notes.
    for (const id of sealed) expect(rawA.join("\n")).toContain(id);
    // The host gets nothing extra: exactly what the other passive guest got.
    expect(sinceStart(raw.host)).toEqual(sinceStart(raw.b));
    closeAll(host, a, b, c, a3, b2, a4);
  });

  it("two writers: each sees only their own sealed notes, and both counts add up", async () => {
    const { host, a, b, raw } = await silentRoom();
    const rawA = recorded(a);
    await startSilent(host, [a, b]);
    const sa = await sealedAdd(a, [host, a, b], "CANARY-a", 1);
    const sb = await sealedAdd(b, [host, a, b], "CANARY-b", 2);
    await settle();
    expect(rawA.join("\n")).not.toContain(sb.id);
    expect(rawA.join("\n")).not.toContain("CANARY-b");
    expect(raw.b.join("\n")).not.toContain(sa.id);
    expect(raw.b.join("\n")).not.toContain("CANARY-a");
    expect(raw.host.join("\n")).not.toMatch(/CANARY|noteAdded/);
    closeAll(host, a, b);
  });
});

describe("someone else's sealed note is an unknown id", () => {
  it("every message naming it is answered exactly as for a random unknown id, and writes nothing", async () => {
    const { host, a, b, stub } = await silentRoom();
    // Voting open before the round, so a vote on the sealed note is accepted as a message.
    await host.request({ type: "voteStart", budget: 5 });
    await b.request({ type: "claimVoter", key: newKey() });
    await drain(host, a, b);
    await startSilent(host, [a, b]);
    const s = await sealedAdd(a, [host, a, b], "CANARY", 1);
    const frame = (await host.request({ type: "frameAdd", clientRef: "f1", x: 1000, y: 1000, color: "neutral", title: "" })) as Extract<ServerMessage, { type: "frameAdded" }>;
    await drain(host, a, b);
    const probes = (id: string): unknown[] => [
      { type: "noteEdit", id, text: "Mine now" },
      { type: "noteEdit", id, color: "blue" },
      { type: "noteMove", id, x: 1, y: 1, final: false },
      { type: "noteMove", id, x: 1, y: 1, final: true },
      { type: "noteResize", id, x: 1, y: 1, w: 200, h: 200, final: false },
      { type: "noteResize", id, x: 1, y: 1, w: 200, h: 200, final: true },
      { type: "noteDelete", id },
      { type: "noteBatch", ops: [{ op: "move", id, x: 5, y: 5 }], final: false },
      { type: "noteBatch", ops: [{ op: "move", id, x: 5, y: 5 }, { op: "resize", id: "x" }], final: true },
      { type: "noteBatch", ops: [{ op: "delete", id }], final: true },
      { type: "notesOrder", ids: [id], action: "front" },
      { type: "notesOrder", ids: [id], action: "back" },
      { type: "frameMove", id: frame.frame.id, x: 0, y: 0, final: true, noteIds: [id] },
      { type: "voteSet", noteId: id, count: 1 },
    ];
    const before = await rowsWritten(stub);
    for (const [i, probe] of probes(s.id).entries()) {
      const unknown = unknownId();
      b.send(probe);
      const forSealed = JSON.stringify(await collect(b));
      b.send(probes(unknown)[i]);
      const forUnknown = JSON.stringify(await collect(b)).replaceAll(unknown, s.id);
      expect(forSealed, JSON.stringify(probe)).toBe(forUnknown);
    }
    expect(await rowsWritten(stub)).toBe(before);
    expect(await a.quiet()).toBe(true);
    expect(await host.quiet()).toBe(true);
    // A's note is untouched.
    expect((await noteRows(stub)).find((r) => r.id === s.id)).toMatchObject({ x: 50, y: 50, rev: 1, color: "yellow", text: "CANARY" });
    closeAll(host, a, b);
  });
});

describe("refusals while silent", () => {
  it("a page without a writer can't add notes (no_writer); frames and shapes still go in", async () => {
    const { code, host, a, b, stub } = await silentRoom();
    await startSilent(host, [a, b]);
    const c = await TestClient.open(code);
    await c.enter("Cleo");
    await drain(host, a, b);
    const before = await rowsWritten(stub);
    expect(await c.request({ type: "noteAdd", clientRef: "r1", x: 0, y: 0, color: "yellow", text: "Idea" })).toMatchObject({ type: "error", code: "no_writer", clientRef: "r1" });
    expect(await c.request({ type: "itemsAdd", clientRef: "i1", notes: [noteItem("n1", "Idea")] })).toMatchObject({
      type: "error",
      code: "no_writer",
      clientRef: "i1",
      refused: [{ kind: "note", index: 0, ref: "n1", reason: "no_writer" }],
    });
    expect(await rowsWritten(stub)).toBe(before);
    const mixed = await c.request({ type: "itemsAdd", clientRef: "i2", notes: [noteItem("n1", "Idea")], shapes: [] , frames: [{ ref: "f1", x: 0, y: 0, w: 640, h: 400, title: "", color: "neutral", titleFontSize: "m", titleBold: true, titleItalic: false, titleTextColor: "auto", titleAlign: "left" }] });
    expect(mixed).toMatchObject({ type: "itemsAdded", notes: [], refused: [{ kind: "note", ref: "n1", reason: "no_writer" }] });
    expect(await c.request({ type: "shapeAdd", clientRef: "s1", kind: "rect", x: 0, y: 0 })).toMatchObject({ type: "shapeAdded" });
    expect(await nextOfType(a, "shapeAdded")).toMatchObject({ type: "shapeAdded" });
    closeAll(host, a, b, c);
  });

  it("frameMove (live or final, host or guest) and starting a vote are refused with silent_active; other frame changes and shapes are allowed", async () => {
    const { host, a, b, stub } = await silentRoom();
    const added = (await host.request({ type: "frameAdd", clientRef: "f1", x: 1000, y: 1000, color: "neutral", title: "" })) as Extract<ServerMessage, { type: "frameAdded" }>;
    const id = added.frame.id;
    await drain(host, a, b);
    await startSilent(host, [a, b]);
    const before = await rowsWritten(stub);
    for (const c of [host, a]) {
      for (const final of [false, true]) {
        expect(await c.request({ type: "frameMove", id, x: 1100, y: 1100, final })).toEqual({ type: "error", code: "silent_active", message: expect.any(String), frameId: id });
      }
    }
    expect(await host.request({ type: "voteStart", budget: 5 })).toMatchObject({ type: "error", code: "silent_active" });
    expect(await a.request({ type: "voteStart", budget: 5 })).toMatchObject({ type: "error", code: "not_host" });
    expect(await rowsWritten(stub)).toBe(before);
    expect(await b.quiet()).toBe(true);
    expect(await a.request({ type: "frameResize", id, x: 1000, y: 1000, w: 700, h: 400, final: true })).toMatchObject({ type: "frameResized" });
    expect(await a.request({ type: "frameEdit", id, title: "Renamed" })).toMatchObject({ type: "frameUpdated" });
    expect(await a.request({ type: "frameAdd", clientRef: "f2", x: 0, y: 0, color: "blue", title: "" })).toMatchObject({ type: "frameAdded" });
    expect(await a.request({ type: "frameDelete", id })).toMatchObject({ type: "frameDeleted" });
    expect(await a.request({ type: "shapeAdd", clientRef: "s1", kind: "oval", x: 0, y: 0 })).toMatchObject({ type: "shapeAdded" });
    // Stopping or clearing a vote is still allowed.
    expect(await host.request({ type: "voteClear" })).toMatchObject({ type: "votingChanged" });
    closeAll(host, a, b);
  });

  it(`a writer may have at most ${MAX_SEALED_PER_WRITER} sealed notes (sealed_full), across all its sockets`, async () => {
    const { code, host, a, b, keys } = await silentRoom();
    await startSilent(host, [a, b]);
    const a2 = await TestClient.open(code);
    await a2.enter("Ari", keys.a);
    let made = 0;
    for (const size of [14, 14, 11]) {
      const reply = await a.request({ type: "itemsAdd", clientRef: `i${made}`, notes: Array.from({ length: size }, (_, i) => noteItem(`n${i}`, "")) });
      expect(reply).toMatchObject({ type: "itemsAdded" });
      made += size;
    }
    expect(made).toBe(MAX_SEALED_PER_WRITER - 1);
    // Two more from A's second socket in one message: one fits, one is refused.
    const two = await a2.request({ type: "itemsAdd", clientRef: "last", notes: [noteItem("x1", ""), noteItem("x2", "")] });
    expect(two).toMatchObject({ type: "itemsAdded", refused: [{ kind: "note", index: 1, ref: "x2", reason: "sealed_full" }] });
    await drain(a, a2);
    expect(await a.request({ type: "noteAdd", clientRef: "r1", x: 0, y: 0, color: "yellow", text: "" })).toMatchObject({ type: "error", code: "sealed_full", clientRef: "r1" });
    expect(await a.request({ type: "itemsAdd", clientRef: "i9", notes: [noteItem("n1", "")] })).toMatchObject({ type: "error", code: "sealed_full", refused: [{ reason: "sealed_full" }] });
    // Someone else still can.
    await drain(host, b);
    b.send({ type: "noteAdd", clientRef: "rb", x: 0, y: 0, color: "yellow", text: "" });
    expect(await nextOfType(b, "noteAdded")).toMatchObject({ clientRef: "rb" });
    closeAll(host, a, b, a2);
  });

  it("the room's 200-note cap still counts sealed notes", async () => {
    const { code, token, stub } = await newRoom();
    const keys = { a: newKey() };
    await runInDurableObject(stub, (_room, state) => {
      for (let i = 0; i < MAX_NOTES_PER_ROOM - 1; i++) {
        state.storage.sql.exec("INSERT INTO notes (id, x, y, text, color, rev, author_id) VALUES (?, 0, 0, '', 'yellow', 1, 'AAAAAAAAAAAAAAAA')", `seed${String(i).padStart(12, "0")}`);
      }
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const host = await TestClient.open(code);
    const a = await TestClient.open(code);
    await host.enter("Hana");
    await a.enter("Ari", keys.a);
    await host.request({ type: "claimHost", token });
    await drain(host, a);
    await startSilent(host, [a]);
    await sealedAdd(a, [host, a], "", 1);
    expect(await a.request({ type: "noteAdd", clientRef: "r2", x: 0, y: 0, color: "yellow", text: "" })).toMatchObject({ type: "error", code: "notes_full" });
    closeAll(host, a);
  });

  it("host-only: a guest's silentStart or silentReveal is not_host; a second start is silent_active; a reveal with none running answers only the sender", async () => {
    const { host, a, b, stub } = await silentRoom();
    const before = await rowsWritten(stub);
    expect(await a.request({ type: "silentStart" })).toMatchObject({ type: "error", code: "not_host" });
    expect(await a.request({ type: "silentReveal" })).toMatchObject({ type: "error", code: "not_host" });
    expect(await host.request({ type: "silentReveal" })).toEqual({ type: "silentChanged", active: false, count: 0 });
    expect(await rowsWritten(stub)).toBe(before);
    expect(await b.quiet()).toBe(true);
    await startSilent(host, [a, b]);
    const started = await rowsWritten(stub);
    expect(await host.request({ type: "silentStart" })).toMatchObject({ type: "error", code: "silent_active" });
    expect(await a.request({ type: "silentReveal" })).toMatchObject({ type: "error", code: "not_host" });
    expect(await rowsWritten(stub)).toBe(started);
    expect(await b.quiet()).toBe(true);
    closeAll(host, a, b);
  });

  it("the lock: a host may start a round on a locked board; a guest's notes are still board_locked", async () => {
    const { host, a, b } = await silentRoom();
    expect(await host.request({ type: "lockSet", locked: true })).toEqual({ type: "lockChanged", locked: true });
    await drain(a, b);
    await startSilent(host, [a, b]);
    expect(await a.request({ type: "noteAdd", clientRef: "r1", x: 0, y: 0, color: "yellow", text: "" })).toMatchObject({ type: "error", code: "board_locked", clientRef: "r1" });
    await sealedAdd(host, [host, a, b], "Host idea", 1);
    closeAll(host, a, b);
  });
});

describe("reveal", () => {
  it("everyone gets every sealed note (in chunks), then the state; one transaction, one row per note plus the flag; writer NULL; a second reveal writes nothing", async () => {
    const { host, a, b, stub } = await silentRoom();
    await startSilent(host, [a, b]);
    const all = [host, a, b];
    const mine = [await sealedAdd(a, all, "A1", 1), await sealedAdd(a, all, "A2", 2), await sealedAdd(b, all, "B1", 3)];
    // An edit keeps its rev in the reveal (the writer's copy and the revealed one match).
    a.send({ type: "noteEdit", id: mine[0]!.id, text: "A1 edited" });
    const edited = (await nextOfType(a, "noteUpdated")).note;
    await drain(...all);
    const rows = await rowsWritten(stub);
    const tx = await transactions(stub);
    host.send({ type: "silentReveal" });
    for (const c of all) {
      const revealed = await nextOfType(c, "notesRevealed");
      expect(revealed.final).toBe(true);
      expect(revealed.notes.map((n) => n.id)).toEqual(mine.map((n) => n.id));
      expect(revealed.notes[0]).toEqual(edited);
      expect(await c.next()).toEqual({ type: "silentChanged", active: false, count: 0 });
    }
    expect((await rowsWritten(stub)) - rows).toBe(mine.length + 1);
    expect((await transactions(stub)) - tx).toBe(1);
    expect((await noteRows(stub)).map((r) => [r.sealed, r.writer])).toEqual(mine.map(() => [0, null]));
    expect((await meta(stub)).silent_active).toBe(0);
    // Normal notes now: B can edit A's note, and everyone hears it.
    b.send({ type: "noteEdit", id: mine[0]!.id, text: "Together" });
    for (const c of all) expect((await nextOfType(c, "noteUpdated")).note.text).toBe("Together");
    const after = await rowsWritten(stub);
    expect(await host.request({ type: "silentReveal" })).toEqual({ type: "silentChanged", active: false, count: 0 });
    expect(await rowsWritten(stub)).toBe(after);
    // A new round is a new round: the count starts at 0 and new notes are sealed again.
    await startSilent(host, [a, b]);
    expect((await meta(stub)).silent_round).toBe(2);
    closeAll(host, a, b);
  });

  it(`a full board (${MAX_NOTES_PER_ROOM} sealed notes, 5 writers) goes out in chunks of ${REVEAL_CHUNK_NOTES}: ${MAX_NOTES_PER_ROOM} + 1 rows, one transaction`, async () => {
    const { code, id, token, stub } = await newRoom();
    const keys = Array.from({ length: 5 }, newKey);
    const writers = await Promise.all(keys.map((k) => specWriterId(id, k)));
    await runInDurableObject(stub, (_room, state) => {
      for (let i = 0; i < MAX_NOTES_PER_ROOM; i++) {
        state.storage.sql.exec(
          "INSERT INTO notes (id, x, y, text, color, rev, author_id, z, sealed, writer) VALUES (?, 0, 0, 'Idea', 'yellow', 1, 'AAAAAAAAAAAAAAAA', ?, 1, ?)",
          `seal${String(i).padStart(12, "0")}`,
          i,
          writers[i % 5]!,
        );
      }
      state.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('silent_active', 1), ('silent_round', 1)");
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const host = await TestClient.open(code);
    const joined = await host.enter("Hana");
    expect(joined.silent).toEqual({ active: true, count: MAX_NOTES_PER_ROOM });
    expect(host.snapshot?.notes).toEqual([]);
    const a = await TestClient.open(code);
    await a.enter("Ari", keys[0]);
    expect(a.snapshot?.notes).toHaveLength(MAX_NOTES_PER_ROOM / 5);
    expect(await host.request({ type: "claimHost", token })).toEqual({ type: "hostGranted" });
    await drain(host, a);
    const rows = await rowsWritten(stub);
    const tx = await transactions(stub);
    host.send({ type: "silentReveal" });
    const chunks: Extract<ServerMessage, { type: "notesRevealed" }>[] = [];
    for (;;) {
      const m = await host.next();
      if (m.type !== "notesRevealed") {
        expect(m).toEqual({ type: "silentChanged", active: false, count: 0 });
        break;
      }
      chunks.push(m);
    }
    expect(chunks.map((c) => c.notes.length)).toEqual([50, 50, 50, 50]);
    expect(chunks.map((c) => c.final)).toEqual([false, false, false, true]);
    expect(chunks.flatMap((c) => c.notes.map((n) => n.id))).toEqual(Array.from({ length: MAX_NOTES_PER_ROOM }, (_, i) => `seal${String(i).padStart(12, "0")}`));
    // Measured for docs/LIMITS.md.
    expect((await rowsWritten(stub)) - rows).toBe(MAX_NOTES_PER_ROOM + 1);
    expect((await transactions(stub)) - tx).toBe(1);
    expect((await noteRows(stub)).every((r) => r.sealed === 0 && r.writer === null)).toBe(true);
    closeAll(host, a);
  });
});

describe("stacking at the bound", () => {
  it("a renumbering writes sealed notes but never puts someone else's into notesOrdered", async () => {
    const { code, id, token, stub } = await newRoom();
    const keys = { a: newKey(), b: newKey() };
    const writerA = await specWriterId(id, keys.a);
    await runInDurableObject(stub, (_room, state) => {
      state.storage.sql.exec("INSERT INTO notes (id, x, y, text, color, rev, author_id, z) VALUES ('visible000000001', 0, 0, '', 'yellow', 1, 'AAAAAAAAAAAAAAAA', -5)");
      state.storage.sql.exec(
        "INSERT INTO notes (id, x, y, text, color, rev, author_id, z, sealed, writer) VALUES ('sealedA000000001', 0, 0, 'CANARY', 'yellow', 1, 'AAAAAAAAAAAAAAAA', ?, 1, ?)",
        NOTE_Z_LIMIT,
        writerA,
      );
      state.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('silent_active', 1), ('silent_round', 1)");
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const host = await TestClient.open(code);
    const a = await TestClient.open(code);
    const b = await TestClient.open(code);
    const rawHost = recorded(host);
    const rawB = recorded(b);
    await host.enter("Hana");
    await a.enter("Ari", keys.a);
    await b.enter("Ben", keys.b);
    await host.request({ type: "claimHost", token });
    await drain(host, a, b);
    // B's add needs a renumbering (the sealed note is at the bound): B hears its own and the visible note's new z.
    b.send({ type: "noteAdd", clientRef: "r1", x: 0, y: 0, color: "yellow", text: "" });
    const ordered = await nextOfType(b, "notesOrdered");
    expect(ordered.results.map((r) => r.id)).toEqual(["visible000000001"]);
    expect((await nextOfType(a, "notesOrdered")).results.map((r) => r.id).sort()).toEqual(["sealedA000000001", "visible000000001"]);
    expect((await nextOfType(host, "notesOrdered")).results.map((r) => r.id)).toEqual(["visible000000001"]);
    expect((await noteRows(stub)).find((r) => r.id === "sealedA000000001")?.z).toBe(1);
    await nextOfType(b, "noteAdded");
    // An itemsAdd and a notesOrder at the bound behave the same.
    await runInDurableObject(stub, (_room, state) => state.storage.sql.exec("UPDATE notes SET z = ? WHERE id = 'sealedA000000001'", NOTE_Z_LIMIT));
    await evictDurableObject(stub);
    await drain(host, a, b);
    b.send({ type: "notesOrder", ids: ["visible000000001"], action: "front" });
    expect((await nextOfType(b, "notesOrdered")).results.map((r) => r.id)).not.toContain("sealedA000000001");
    expect((await nextOfType(a, "notesOrdered")).results.map((r) => r.id)).toContain("sealedA000000001");
    await runInDurableObject(stub, (_room, state) => state.storage.sql.exec("UPDATE notes SET z = ? WHERE id = 'sealedA000000001'", NOTE_Z_LIMIT));
    await evictDurableObject(stub);
    await drain(host, a, b);
    b.send({ type: "itemsAdd", clientRef: "i1", notes: [noteItem("n1", "")] });
    expect((await nextOfType(b, "notesOrdered")).results.map((r) => r.id)).not.toContain("sealedA000000001");
    expect((await nextOfType(a, "notesOrdered")).results.map((r) => r.id)).toContain("sealedA000000001");
    await settle();
    for (const t of [rawHost, rawB]) {
      expect(t.join("\n")).not.toContain("sealedA000000001");
      expect(t.join("\n")).not.toContain("CANARY");
    }
    closeAll(host, a, b);
  });
});

describe("votes", () => {
  it("nobody can vote on a sealed note (ignored as unknown, its writer too), so totals never name one", async () => {
    const { host, a, b, keys } = await silentRoom();
    await host.request({ type: "voteStart", budget: 5 });
    await drain(host, a, b);
    await a.request({ type: "claimVoter", key: keys.a });
    await startSilent(host, [a, b]);
    const s = await sealedAdd(a, [host, a, b], "Idea", 1);
    a.send({ type: "voteSet", noteId: s.id, count: 2 });
    expect(await a.quiet()).toBe(true);
    host.send({ type: "voteStop" });
    expect(await nextOfType(b, "votesRevealed")).toMatchObject({ totals: [] });
    closeAll(host, a, b);
  });
});

describe("hibernation", () => {
  it("the round, the seals and each socket's writer come back from storage and attachments alone", async () => {
    const { code, host, a, b, stub, keys } = await silentRoom();
    await startSilent(host, [a, b]);
    const s = await sealedAdd(a, [host, a, b], "CANARY", 1);
    await evictDurableObject(stub);
    // Still silent: a new note is sealed, and only the count reaches the others.
    const s2 = await sealedAdd(a, [host, a, b], "CANARY-2", 2);
    expect(await b.quiet()).toBe(true);
    // A late joiner sees neither; the writer's new tab sees both.
    const c = await TestClient.open(code);
    await c.enter("Cleo");
    expect(c.snapshot?.notes).toEqual([]);
    const a2 = await TestClient.open(code);
    await a2.enter("Ari", keys.a);
    expect(a2.snapshot?.notes.map((n) => n.id)).toEqual([s.id, s2.id]);
    await evictDurableObject(stub);
    await drain(host, a, b, c);
    host.send({ type: "silentReveal" });
    for (const x of [host, b, c]) expect((await nextOfType(x, "notesRevealed")).notes.map((n) => n.id)).toEqual([s.id, s2.id]);
    closeAll(host, a, b, c, a2);
  });
});

describe("burial", () => {
  it("End session during a round drops the sealed notes with everything else", async () => {
    const { host, a, b, stub } = await silentRoom();
    await startSilent(host, [a, b]);
    await sealedAdd(a, [host, a, b], "Idea", 1);
    host.send({ type: "endSession" });
    await a.waitClose();
    await settle();
    const rows = await allRows(stub);
    expect(Object.keys(rows)).toEqual(["meta"]);
    expect(rows.meta?.map((r) => r.key)).toEqual(["ended_at"]);
  });

  it("expiry during a round drops them too", async () => {
    const { host, a, b, stub } = await silentRoom();
    await startSilent(host, [a, b]);
    await sealedAdd(a, [host, a, b], "Idea", 1);
    closeAll(host, a, b);
    await Promise.all([host.waitClose(), a.waitClose(), b.waitClose()]);
    await settle();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const rows = await allRows(stub);
    expect(Object.keys(rows)).toEqual(["meta"]);
    expect(rows.meta?.map((r) => r.key)).toEqual(["expired_at"]);
  });
});

describe(`schema migration 9 -> ${SCHEMA_VERSION}`, () => {
  it("adds sealed (0) and writer (NULL) to every note, with defaults, and leaves everything else alone", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV9(sql);
      const before = sql.exec<Row>("SELECT * FROM notes ORDER BY rowid").toArray();
      const store = new NoteStore(sql);
      expect(sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value).toBe(10);
      const after = sql.exec<Row>("SELECT * FROM notes ORDER BY rowid").toArray();
      expect(after.map(({ sealed: _s, writer: _w, ...rest }) => rest)).toEqual(before);
      expect(after.map((r) => [r.sealed, r.writer])).toEqual(before.map(() => [0, null]));
      const columns = sql.exec<{ name: string; dflt_value: string | null; notnull: number }>("SELECT name, dflt_value, \"notnull\" FROM pragma_table_info('notes')").toArray();
      expect(columns.find((c) => c.name === "sealed")).toMatchObject({ dflt_value: "0", notnull: 1 });
      expect(columns.find((c) => c.name === "writer")).toMatchObject({ dflt_value: "NULL", notnull: 0 });
      expect(store.all().map((n) => n.id)).toEqual(V5_NOTES.map((n) => n.id));
      expect(store.allFrames().map((f) => f.id)).toEqual(V6_FRAMES.map((f) => f.id));
      expect(store.allShapes().map((s) => s.id)).toEqual([V9_SHAPE[0]]);
      expect(store.totals()).toEqual([{ noteId: "v5note0000000002", count: 2 }]);
      expect(store.sealedCount).toBe(0);
      // Runs once: a second load writes nothing.
      expect(new NoteStore(sql).rowsWritten).toBe(0);
    });
  });

  it("is idempotent if it was interrupted after adding a column", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV9(sql);
      sql.exec("ALTER TABLE notes ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0");
      const store = new NoteStore(sql);
      expect(store.all()).toHaveLength(V5_NOTES.length);
      expect(sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('notes')").toArray().filter((c) => c.name === "sealed" || c.name === "writer")).toHaveLength(2);
    });
  });

  it("v0.24.0's note and frame statements still work on schema 10 (rollback safety): its notes are never sealed", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV9(sql);
      new NoteStore(sql);
      sql.exec(V9_NOTE_INSERT, "fromV16code00001", 0, 0, 160, 160, "New", "green", "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", 9, 1, "AAAAAAAAAAAAAAAA");
      const n = V5_NOTES[1];
      sql.exec(V9_NOTE_UPDATE, 10, 20, n.w, n.h, "Edited by v16", n.color, "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", n.z, n.rev + 1, n.id);
      for (const statement of V9_NOTE_DELETE) sql.exec(statement, V5_NOTES[0].id);
      sql.exec(V9_FRAME_INSERT, "fromV16frame0001", 0, 0, 640, 400, "Step 1", "blue", 1, "AAAAAAAAAAAAAAAA", "m", 1, 0, "auto", "left");
      expect(sql.exec<Row>("SELECT sealed, writer FROM notes WHERE id = 'fromV16code00001'").one()).toEqual({ sealed: 0, writer: null });
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Ari");
    expect(c.snapshot?.notes.map((x) => x.id)).toEqual([V5_NOTES[1].id, V5_NOTES[2].id, "fromV16code00001"]);
    expect(c.snapshot?.notes[0]).toMatchObject({ x: 10, y: 20, text: "Edited by v16" });
    c.close();
  });

  it("a sealed row without a writer (never written by us) is hidden from everyone until a reveal", async () => {
    const { code, stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      state.storage.sql.exec("INSERT INTO notes (id, x, y, text, color, rev, author_id, sealed) VALUES ('orphan0000000001', 0, 0, 'Idea', 'yellow', 1, 'AAAAAAAAAAAAAAAA', 1)");
      state.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('silent_active', 1)");
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    expect((await c.enter("Ari", newKey())).silent).toEqual({ active: true, count: 1 });
    expect(c.snapshot?.notes).toEqual([]);
    c.close();
  });
});

describe("costs (docs/LIMITS.md)", () => {
  it("rows: silentStart, a sealed add (2, as a note), an edit of one (1), a count broadcast (0); the count is one small message", async () => {
    const { host, a, b, stub, raw } = await silentRoom();
    let rows = await rowsWritten(stub);
    await startSilent(host, [a, b]);
    const start = (await rowsWritten(stub)) - rows;
    expect(start).toBe(4);
    rows = await rowsWritten(stub);
    const s = await sealedAdd(a, [host, a, b], "Idea", 1);
    expect((await rowsWritten(stub)) - rows).toBe(2);
    rows = await rowsWritten(stub);
    a.send({ type: "noteEdit", id: s.id, text: "Better idea" });
    await nextOfType(a, "noteUpdated");
    expect((await rowsWritten(stub)) - rows).toBe(1);
    // Edits and moves of a sealed note send the others nothing, not even a count.
    expect(await b.quiet()).toBe(true);
    const count = raw.b.filter((r) => r.includes('"silentChanged"')).at(-1) ?? "";
    expect(new TextEncoder().encode(count).length).toBeLessThan(64);
    // A second round's start rewrites both keys (1 row each).
    host.send({ type: "silentReveal" });
    await drain(host, a, b);
    rows = await rowsWritten(stub);
    await startSilent(host, [a, b]);
    expect((await rowsWritten(stub)) - rows).toBe(2);
    closeAll(host, a, b);
  });
});
