/// <reference types="vite/client" />
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_MESSAGE_BYTES,
  MAX_REACTIONS_PER_REACTOR,
  MAX_REACTIONS_PER_ROOM,
  NOTE_DEFAULTS,
  PROTOCOL_VERSION,
  REACTION_KEYS,
  type NoteItem,
  type ServerMessage,
} from "@stickyard/shared";
import type { Room } from "../src/room";
import { NoteStore, SCHEMA_VERSION } from "../src/noteStore";
import { REACTION_LIMITS, SOCKET_LIMITS } from "../src/limits";
import { V5_NOTES } from "./fixtures/schemaV5";
import { V6_FRAMES } from "./fixtures/schemaV6";
import { V9_SHAPE } from "./fixtures/schemaV9";
import { V10_NOTE_DELETE, V10_NOTE_INSERT, V10_SEALED, loadSchemaV10 } from "./fixtures/schemaV10";
import { TEST_SIGNING_KEY, TestClient, fullMessageBudget, nextOfType, specHostToken, specRoomCode } from "./helpers";

/*
 * Reactions on notes, protocol v20 and stored schema 11 (part 1 of 2: relay and shared). A
 * reactor is the dot-voting voter (claimVoter: an HMAC of the page's key). Everyone who may see a
 * note hears its counts; only the reactor's own sockets hear their own on/off; nobody ever hears
 * who reacted. These tests drive the real Durable Object over WebSockets. Fake keys only
 * (vitest.config.ts); generic names (Sam, Alex) and text.
 */

vi.setConfig({ testTimeout: 30_000 });

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const newKey = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
const unknownId = () => b64url(crypto.getRandomValues(new Uint8Array(12)));

/** The voter (reactor) id straight from the spec, independently of src/voterId.ts. */
async function specVoterId(roomId: string, key: string): Promise<string> {
  const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(TEST_SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`stickyard-voter-v1:${roomId}:${key}`))));
}

async function newRoom() {
  const { code, id } = await specRoomCode();
  return { code, id, token: await specHostToken(id), stub: env.ROOM.get(env.ROOM.idFromName(id)) };
}

type Stub = DurableObjectStub<Room>;
type Row = Record<string, SqlStorageValue>;
const rowsWritten = (stub: Stub) => runInDurableObject(stub, (r: Room) => r.rowsWritten);
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
const reactionRows = async (stub: Stub) => (await allRows(stub)).reactions ?? [];
const closeAll = (...cs: TestClient[]) => cs.forEach((c) => c.close());
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
async function drain(...cs: TestClient[]) {
  for (const c of cs) while (!(await c.quiet(60))) await c.next(1).catch(() => undefined);
}
function recorded(c: TestClient): string[] {
  const raw: string[] = [];
  c.ws.addEventListener("message", (e) => raw.push(String(e.data)));
  return raw;
}

/** Fills every socket's reaction bucket (REACTION_LIMITS), refill clock at now, so a test starts from a known budget. */
async function fullReactionBudget(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (_r: unknown, state: DurableObjectState) => {
    for (const ws of state.getWebSockets()) {
      const att = ws.deserializeAttachment() as Record<string, unknown> | null;
      if (att) ws.serializeAttachment({ ...att, reactTokens: REACTION_LIMITS.burst, reactAt: Date.now() });
    }
  });
}

async function addNote(c: TestClient, text: string, others: TestClient[] = []) {
  c.send({ type: "noteAdd", clientRef: "r1", x: 10, y: 10, color: "yellow", text });
  // Its own add (with the clientRef), not someone else's broadcast.
  let added = await nextOfType(c, "noteAdded");
  while (added.clientRef !== "r1") added = await nextOfType(c, "noteAdded");
  const note = added.note;
  for (const o of others) await nextOfType(o, "noteAdded");
  return note;
}

async function claim(c: TestClient, key: string) {
  await drain(c);
  const granted = await c.request({ type: "claimVoter", key });
  expect(granted.type).toBe("voterGranted");
  return granted as Extract<ServerMessage, { type: "voterGranted" }>;
}

const react = (noteId: string, key: string, on: boolean) => ({ type: "reactionSet", noteId, key, on });

/** A room with a host (Alex, claimed) and a guest (Sam), both voters, and three notes by Alex. */
async function reactionRoom() {
  const room = await newRoom();
  const keys = { alex: newKey(), sam: newKey() };
  const alex = await TestClient.open(room.code);
  const sam = await TestClient.open(room.code);
  await alex.enter("Alex", keys.alex);
  await sam.enter("Sam", keys.sam);
  await drain(alex, sam);
  expect(await alex.request({ type: "claimHost", token: room.token })).toEqual({ type: "hostGranted" });
  await drain(alex, sam);
  await claim(alex, keys.alex);
  await claim(sam, keys.sam);
  const notes = [await addNote(alex, "First", [sam]), await addNote(alex, "Second", [sam]), await addNote(alex, "Third", [sam])];
  await fullReactionBudget(room.stub);
  return { ...room, keys, alex, sam, notes };
}

describe("versions", () => {
  it("protocol 20 and stored schema 11; a v19 page is asked to reload", async () => {
    expect(PROTOCOL_VERSION).toBe(20);
    expect(SCHEMA_VERSION).toBe(11);
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request({ type: "hello", protocolVersion: 19 })).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Sam" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });
});

describe("reactionSet", () => {
  it("needs a join (not_joined) and a claimed voter (no_voter), each naming the note; writes nothing", async () => {
    const { code, stub } = await newRoom();
    const c = await TestClient.open(code);
    await c.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    const id = unknownId();
    expect(await c.request(react(id, "heart", true))).toMatchObject({ type: "error", code: "not_joined", noteId: id });
    const d = await TestClient.open(code);
    await d.enter("Sam", newKey());
    const note = await addNote(d, "Idea");
    const before = await rowsWritten(stub);
    expect(await d.request(react(note.id, "heart", true))).toMatchObject({ type: "error", code: "no_voter", noteId: note.id });
    expect(await rowsWritten(stub)).toBe(before);
    closeAll(c, d);
  });

  it("is an idempotent set: on, on, off gives 1, nothing, 0; counts add up across reactors", async () => {
    const { alex, sam, notes, stub } = await reactionRoom();
    const n = notes[0]!.id;
    sam.send(react(n, "heart", true));
    expect(await nextOfType(sam, "reactionCount")).toEqual({ type: "reactionCount", noteId: n, key: "heart", count: 1 });
    expect(await nextOfType(sam, "reactionMine")).toEqual({ type: "reactionMine", noteId: n, key: "heart", on: true });
    expect(await nextOfType(alex, "reactionCount")).toEqual({ type: "reactionCount", noteId: n, key: "heart", count: 1 });
    // The same again changes nothing and sends nothing, to anyone.
    const before = await rowsWritten(stub);
    sam.send(react(n, "heart", true));
    expect(await sam.quiet(200)).toBe(true);
    expect(await alex.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(before);
    // A second reactor: 2. Keys are counted apart.
    alex.send(react(n, "heart", true));
    expect(await nextOfType(sam, "reactionCount")).toEqual({ type: "reactionCount", noteId: n, key: "heart", count: 2 });
    expect(await nextOfType(alex, "reactionCount")).toEqual({ type: "reactionCount", noteId: n, key: "heart", count: 2 });
    sam.send(react(n, "plus", true));
    expect(await nextOfType(alex, "reactionCount")).toEqual({ type: "reactionCount", noteId: n, key: "plus", count: 1 });
    await drain(alex, sam);
    // Off: 1 left, and the reactor hears its own off.
    sam.send(react(n, "heart", false));
    expect(await nextOfType(alex, "reactionCount")).toEqual({ type: "reactionCount", noteId: n, key: "heart", count: 1 });
    expect(await nextOfType(sam, "reactionCount")).toEqual({ type: "reactionCount", noteId: n, key: "heart", count: 1 });
    expect(await nextOfType(sam, "reactionMine")).toEqual({ type: "reactionMine", noteId: n, key: "heart", on: false });
    // Off again: nothing.
    sam.send(react(n, "heart", false));
    expect(await sam.quiet(200)).toBe(true);
    expect(await alex.quiet()).toBe(true);
    expect((await reactionRows(stub)).length).toBe(2);
    closeAll(alex, sam);
  });

  it("the reactor's own on/off goes to every socket with its key and to nobody else", async () => {
    const { code, alex, sam, keys, notes } = await reactionRoom();
    const sam2 = await TestClient.open(code);
    await sam2.enter("Sam", keys.sam);
    await claim(sam2, keys.sam);
    await drain(alex, sam);
    const rawAlex = recorded(alex);
    sam.send(react(notes[1]!.id, "laugh", true));
    expect(await nextOfType(sam2, "reactionCount")).toMatchObject({ count: 1 });
    expect(await nextOfType(sam2, "reactionMine")).toEqual({ type: "reactionMine", noteId: notes[1]!.id, key: "laugh", on: true });
    await nextOfType(alex, "reactionCount");
    await settle(100);
    expect(rawAlex.some((r) => r.includes('"reactionMine"'))).toBe(false);
    closeAll(alex, sam, sam2);
  });

  it("an unknown or deleted note is refused with unknown_note (naming it); writes and relays nothing", async () => {
    const { alex, sam, notes, stub } = await reactionRoom();
    const before = await rowsWritten(stub);
    const id = unknownId();
    expect(await sam.request(react(id, "heart", true))).toMatchObject({ type: "error", code: "unknown_note", noteId: id });
    alex.send({ type: "noteDelete", id: notes[2]!.id });
    await nextOfType(sam, "noteDeleted");
    await drain(alex, sam);
    const rows = await rowsWritten(stub);
    expect(rows).toBeGreaterThan(before);
    expect(await sam.request(react(notes[2]!.id, "heart", true))).toMatchObject({ type: "error", code: "unknown_note", noteId: notes[2]!.id });
    expect(await rowsWritten(stub)).toBe(rows);
    expect(await alex.quiet()).toBe(true);
    closeAll(alex, sam);
  });

  it("bad input gets an error reply, never a throw: other keys, emoji, long ids, extra fields, oversize", async () => {
    const { sam, notes } = await reactionRoom();
    const n = notes[0]!.id;
    for (const bad of [
      { type: "reactionSet", noteId: n, key: "👍", on: true },
      { type: "reactionSet", noteId: n, key: "fire", on: true },
      { type: "reactionSet", noteId: `${n}AAAA`, key: "heart", on: true },
      { type: "reactionSet", noteId: n, key: "heart", on: true, reactorId: "x".repeat(43) },
      { type: "reactionSet", noteId: n, key: "heart" },
    ]) {
      await settle(60);
      expect(await sam.request(bad)).toMatchObject({ type: "error", code: "bad_message" });
    }
    expect(await sam.request({ type: "reactionSet", noteId: n, key: "x".repeat(MAX_MESSAGE_BYTES), on: true })).toMatchObject({ type: "error", code: "too_large" });
    // Still served.
    sam.send(react(n, "heart", true));
    expect(await nextOfType(sam, "reactionMine")).toMatchObject({ on: true });
    closeAll(sam);
  });

  it("a locked board still takes a guest's reactions, as voting does", async () => {
    const { alex, sam, notes } = await reactionRoom();
    expect(await alex.request({ type: "lockSet", locked: true })).toEqual({ type: "lockChanged", locked: true });
    await nextOfType(sam, "lockChanged");
    sam.send(react(notes[0]!.id, "celebrate", true));
    expect(await nextOfType(sam, "reactionCount")).toMatchObject({ key: "celebrate", count: 1 });
    expect(await nextOfType(alex, "reactionCount")).toMatchObject({ key: "celebrate", count: 1 });
    closeAll(alex, sam);
  });

  it("not after End session: the room is gone, and a later socket is closed with 4411", async () => {
    const { code, alex, sam, notes, stub } = await reactionRoom();
    sam.send(react(notes[0]!.id, "heart", true));
    await nextOfType(alex, "reactionCount");
    alex.send({ type: "endSession" });
    await sam.waitClose();
    await settle();
    expect(Object.keys(await allRows(stub))).toEqual(["meta"]);
    const late = await TestClient.open(code);
    late.send({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    late.send(react(notes[0]!.id, "heart", true));
    expect(await late.waitClose()).toBe(4411);
  });
});

describe("join and claim", () => {
  it("joining sends reactionsSnapshot right after shapesSnapshot: non-zero counts, note creation order then key order", async () => {
    const { code, alex, sam, notes } = await reactionRoom();
    sam.send(react(notes[1]!.id, "plus", true));
    await nextOfType(alex, "reactionCount");
    sam.send(react(notes[0]!.id, "thinking", true));
    await nextOfType(alex, "reactionCount");
    alex.send(react(notes[0]!.id, "heart", true));
    await nextOfType(sam, "reactionCount");
    sam.send(react(notes[0]!.id, "heart", true));
    await nextOfType(alex, "reactionCount");
    sam.send(react(notes[0]!.id, "thinking", false));
    await nextOfType(alex, "reactionCount");
    const c = await TestClient.open(code);
    await c.enter("Priya", newKey());
    expect(c.reactions).toEqual({
      type: "reactionsSnapshot",
      counts: [
        { noteId: notes[0]!.id, key: "heart", count: 2 },
        { noteId: notes[1]!.id, key: "plus", count: 1 },
      ],
    });
    closeAll(alex, sam, c);
  });

  it("my own set comes with voterGranted (every claim: reconnect, second tab); omitted when I have none", async () => {
    const { code, alex, sam, keys, notes } = await reactionRoom();
    sam.send(react(notes[1]!.id, "laugh", true));
    await nextOfType(alex, "reactionCount");
    sam.send(react(notes[0]!.id, "thumbs_up", true));
    await nextOfType(alex, "reactionCount");
    const tab = await TestClient.open(code);
    await tab.enter("Sam", keys.sam);
    expect(await claim(tab, keys.sam)).toEqual({
      type: "voterGranted",
      remaining: 5,
      mine: [],
      reactions: [
        { noteId: notes[0]!.id, key: "thumbs_up" },
        { noteId: notes[1]!.id, key: "laugh" },
      ],
    });
    const other = await TestClient.open(code);
    await other.enter("Priya", newKey());
    expect(await claim(other, newKey())).toEqual({ type: "voterGranted", remaining: 5, mine: [] });
    closeAll(alex, sam, tab, other);
  });

  it("reactions survive hibernation and a restart", async () => {
    const { code, alex, sam, keys, notes, stub } = await reactionRoom();
    sam.send(react(notes[0]!.id, "heart", true));
    await nextOfType(alex, "reactionCount");
    await evictDurableObject(stub, { webSockets: "close" });
    const back = await TestClient.open(code);
    await back.enter("Sam", keys.sam);
    expect(back.reactions?.counts).toEqual([{ noteId: notes[0]!.id, key: "heart", count: 1 }]);
    expect((await claim(back, keys.sam)).reactions).toEqual([{ noteId: notes[0]!.id, key: "heart" }]);
    back.close();
  });
});

describe("nobody's identity", () => {
  it("no reaction message names a reactor: only note ids, keys and counts; no key or voter id anywhere", async () => {
    const room = await newRoom();
    const keys = { alex: newKey(), sam: newKey(), priya: newKey() };
    const clients = { alex: await TestClient.open(room.code), sam: await TestClient.open(room.code), priya: await TestClient.open(room.code) };
    const raw = { alex: recorded(clients.alex), sam: recorded(clients.sam), priya: recorded(clients.priya) };
    const joined = {
      alex: await clients.alex.enter("Alex", keys.alex),
      sam: await clients.sam.enter("Sam", keys.sam),
      priya: await clients.priya.enter("Priya", keys.priya),
    };
    await drain(clients.alex, clients.sam, clients.priya);
    for (const name of ["alex", "sam", "priya"] as const) await claim(clients[name], keys[name]);
    const notes = [await addNote(clients.alex, "One"), await addNote(clients.sam, "Two")];
    await drain(clients.alex, clients.sam, clients.priya);
    await fullReactionBudget(room.stub);
    for (const [name, key] of [["alex", "heart"], ["sam", "heart"], ["priya", "plus"], ["sam", "laugh"]] as const) {
      for (const note of notes) {
        clients[name].send(react(note.id, key, true));
        await nextOfType(clients[name], "reactionMine");
      }
    }
    clients.priya.send(react(notes[0]!.id, "plus", false));
    await nextOfType(clients.priya, "reactionMine");
    // A late joiner and a reclaim: the snapshot and voterGranted too.
    const late = await TestClient.open(room.code);
    const rawLate = recorded(late);
    await late.enter("Jo", newKey());
    await claim(late, newKey());
    await claim(clients.sam, keys.sam);
    await settle(150);

    const secrets = [...Object.values(keys), ...(await Promise.all(Object.values(keys).map((k) => specVoterId(room.id, k))))];
    const people = [joined.alex.you.id, joined.sam.you.id, joined.priya.you.id];
    const noteIds = new Set(notes.map((n) => n.id));
    const allowed = new Set<string>([...noteIds, ...REACTION_KEYS, "reactionCount", "reactionMine", "reactionsSnapshot", "voterGranted"]);
    let seen = 0;
    for (const list of [raw.alex, raw.sam, raw.priya, rawLate]) {
      for (const r of list) {
        for (const s of secrets) expect(r).not.toContain(s);
        const m = JSON.parse(r) as { type: string };
        if (!["reactionCount", "reactionMine", "reactionsSnapshot", "voterGranted"].includes(m.type)) continue;
        seen++;
        for (const p of people) expect(r).not.toContain(p);
        const strings: string[] = [];
        const walk = (v: unknown): void => {
          if (typeof v === "string") strings.push(v);
          else if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === "object") Object.values(v).forEach(walk);
        };
        walk(m);
        for (const s of strings) expect(allowed.has(s), s).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(20);
    closeAll(clients.alex, clients.sam, clients.priya, late);
  });
});

describe("sealed notes (silent round)", () => {
  it("canary: a reaction on a sealed note is refused like an unknown id, and nothing about it reaches any socket, on any path, until the reveal", async () => {
    const room = await newRoom();
    const keys = { alex: newKey(), sam: newKey() };
    const alex = await TestClient.open(room.code);
    const sam = await TestClient.open(room.code);
    const raw: string[][] = [recorded(alex), recorded(sam)];
    await alex.enter("Alex", keys.alex);
    await sam.enter("Sam", keys.sam);
    await drain(alex, sam);
    expect(await alex.request({ type: "claimHost", token: room.token })).toEqual({ type: "hostGranted" });
    await drain(alex, sam);
    await claim(alex, keys.alex);
    await claim(sam, keys.sam);
    const open = await addNote(alex, "Visible", [sam]);
    await drain(alex, sam);
    expect(await alex.request({ type: "silentStart" })).toMatchObject({ type: "silentChanged", active: true });
    await nextOfType(sam, "silentChanged");
    sam.send({ type: "noteAdd", clientRef: "s1", x: 50, y: 50, color: "yellow", text: "Hidden" });
    const sealed = (await nextOfType(sam, "noteAdded")).note;
    await drain(alex, sam);
    await fullReactionBudget(room.stub);

    // Refused for everyone, its writer too, word for word as for an id that never existed.
    for (const c of [sam, alex]) {
      const never = unknownId();
      const forSealed = await c.request(react(sealed.id, "heart", true));
      const forNever = await c.request(react(never, "heart", true));
      expect(forSealed).toMatchObject({ type: "error", code: "unknown_note", noteId: sealed.id });
      expect(JSON.stringify(forSealed)).toBe(JSON.stringify(forNever).replaceAll(never, sealed.id));
    }
    expect((await reactionRows(room.stub)).length).toBe(0);
    // Reactions on visible notes still go to everyone during the round.
    sam.send(react(open.id, "plus", true));
    expect(await nextOfType(alex, "reactionCount")).toMatchObject({ noteId: open.id, count: 1 });
    await drain(alex, sam);

    // A row on the sealed note that the relay never wrote (say, left by a bug): the backstop keeps it from everyone, its writer included.
    const samVoter = await specVoterId(room.id, keys.sam);
    const alexVoter = await specVoterId(room.id, keys.alex);
    await runInDurableObject(room.stub, (_r, state) => {
      for (const reactor of [samVoter, alexVoter]) state.storage.sql.exec("INSERT INTO reactions (reactor_id, note_id, reaction_key) VALUES (?, ?, 'heart')", reactor, sealed.id);
    });
    await evictDurableObject(room.stub, { webSockets: "close" });
    await alex.waitClose();
    await sam.waitClose();
    // Reconnect (the join snapshot and the claim) for both, plus a second tab of the writer.
    const alex2 = await TestClient.open(room.code);
    const sam2 = await TestClient.open(room.code);
    const sam3 = await TestClient.open(room.code);
    raw.push(recorded(alex2), recorded(sam2), recorded(sam3));
    await alex2.enter("Alex", keys.alex);
    await sam2.enter("Sam", keys.sam);
    await sam3.enter("Sam", keys.sam);
    expect(sam2.snapshot?.notes.map((n) => n.id)).toContain(sealed.id);
    expect(sam2.reactions?.counts).toEqual([{ noteId: open.id, key: "plus", count: 1 }]);
    expect(alex2.reactions?.counts).toEqual([{ noteId: open.id, key: "plus", count: 1 }]);
    await drain(alex2, sam2, sam3);
    expect(await alex2.request({ type: "claimHost", token: room.token })).toEqual({ type: "hostGranted" });
    expect((await claim(sam2, keys.sam)).reactions).toEqual([{ noteId: open.id, key: "plus" }]);
    expect((await claim(alex2, keys.alex)).reactions).toBeUndefined();
    await fullReactionBudget(room.stub);
    // Other reactions keep going; still nothing about the sealed note.
    alex2.send(react(open.id, "plus", true));
    await nextOfType(sam2, "reactionCount");
    await drain(alex2, sam2, sam3);
    const reactionTypes = ['"reactionCount"', '"reactionMine"', '"reactionsSnapshot"', '"voterGranted"'];
    for (const list of raw) {
      for (const r of list) if (reactionTypes.some((t) => r.includes(t))) expect(r).not.toContain(sealed.id);
    }
    // Alex's sockets never heard of the sealed note at all, but for the refusals of Alex's own probes.
    for (const list of [raw[0]!, raw[2]!]) for (const r of list) if (!r.includes('"unknown_note"')) expect(r).not.toContain(sealed.id);

    // The reveal: now it's a normal note. The stored rows count, and new reactions go to everyone.
    alex2.send({ type: "silentReveal" });
    await nextOfType(sam2, "notesRevealed");
    await drain(alex2, sam2, sam3);
    sam2.send(react(sealed.id, "plus", true));
    expect(await nextOfType(alex2, "reactionCount")).toEqual({ type: "reactionCount", noteId: sealed.id, key: "plus", count: 1 });
    const late = await TestClient.open(room.code);
    await late.enter("Jo", newKey());
    expect(late.reactions?.counts).toEqual([
      { noteId: open.id, key: "plus", count: 2 },
      { noteId: sealed.id, key: "heart", count: 2 },
      { noteId: sealed.id, key: "plus", count: 1 },
    ]);
    closeAll(alex2, sam2, sam3, late);
  });
});

describe("deleted with their note", () => {
  it("noteDelete and a Clear board batch delete take the note's reactions in the same step; nothing about reactions is sent", async () => {
    const { code, alex, sam, notes, stub } = await reactionRoom();
    for (const n of notes) {
      sam.send(react(n.id, "heart", true));
      await nextOfType(sam, "reactionMine");
      alex.send(react(n.id, "heart", true));
      await nextOfType(alex, "reactionMine");
    }
    await drain(alex, sam);
    expect((await reactionRows(stub)).length).toBe(6);
    alex.send({ type: "noteDelete", id: notes[0]!.id });
    expect(await nextOfType(sam, "noteDeleted")).toEqual({ type: "noteDeleted", id: notes[0]!.id });
    expect(await sam.quiet()).toBe(true);
    expect((await reactionRows(stub)).map((r) => r.note_id).sort()).toEqual([notes[1]!.id, notes[1]!.id, notes[2]!.id, notes[2]!.id].sort());
    // Clear board deletes every note as final batch deletes.
    alex.send({ type: "noteBatch", ops: [{ op: "delete", id: notes[1]!.id }, { op: "delete", id: notes[2]!.id }], final: true });
    await nextOfType(sam, "notesBatchApplied");
    expect(await sam.quiet()).toBe(true);
    expect(await reactionRows(stub)).toEqual([]);
    const c = await TestClient.open(code);
    await c.enter("Jo");
    expect(c.reactions).toEqual({ type: "reactionsSnapshot", counts: [] });
    closeAll(alex, sam, c);
  });

  it("idle expiry drops the reactions table with everything else; the tombstone stays", async () => {
    const { alex, sam, notes, stub } = await reactionRoom();
    sam.send(react(notes[0]!.id, "heart", true));
    await nextOfType(alex, "reactionCount");
    closeAll(alex, sam);
    await alex.waitClose();
    await sam.waitClose();
    await settle();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const rows = await allRows(stub);
    expect(Object.keys(rows)).toEqual(["meta"]);
    expect(rows.meta!.map((r) => r.key)).toEqual(["expired_at"]);
  });
});

/** Fills a room with reaction rows straight in SQL (as if many people had reacted), then wakes it fresh so it loads them. */
async function fillRows(stub: Stub, rows: [reactor: string, noteId: string, key: string][]) {
  await runInDurableObject(stub, (_r, state) => {
    for (const row of rows) state.storage.sql.exec("INSERT INTO reactions (reactor_id, note_id, reaction_key) VALUES (?, ?, ?)", ...row);
  });
  await evictDurableObject(stub, { webSockets: "close" });
}

const noteItem = (ref: string): NoteItem => {
  const { w, h, ...style } = NOTE_DEFAULTS;
  return { ref, x: 100, y: 100, w, h, text: ref, color: "yellow", ...style };
};

/** A room with 20 notes and Sam as a voter. */
async function bigRoom() {
  const room = await newRoom();
  const key = newKey();
  const sam = await TestClient.open(room.code);
  await sam.enter("Sam", key);
  const noteIds: string[] = [];
  // Two messages: 20 full note items don't fit in one (MAX_MESSAGE_BYTES).
  for (const part of [0, 1]) {
    sam.send({ type: "itemsAdd", clientRef: `many${part}`, notes: Array.from({ length: 10 }, (_, i) => noteItem(`n${part}x${i}`)) });
    noteIds.push(...(await nextOfType(sam, "itemsAdded")).notes.map((n) => n.note.id));
  }
  sam.close();
  await sam.waitClose();
  return { ...room, key, noteIds };
}

async function rejoin(code: string, key: string) {
  const c = await TestClient.open(code);
  await c.enter("Sam", key);
  await claim(c, key);
  return c;
}

describe("caps", () => {
  it(`one reactor has at most ${MAX_REACTIONS_PER_REACTOR} reactions (reactor_full, naming the note); off still works, and frees one`, async () => {
    const { code, id, key, stub, noteIds } = await bigRoom();
    const reactor = await specVoterId(id, key);
    const combos = noteIds.flatMap((n) => REACTION_KEYS.map((k) => [n, k] as const));
    await fillRows(stub, combos.slice(0, MAX_REACTIONS_PER_REACTOR).map(([n, k]) => [reactor, n, k]));
    const sam = await rejoin(code, key);
    const [freeNote, freeKey] = combos[MAX_REACTIONS_PER_REACTOR]!;
    const before = await rowsWritten(stub);
    expect(await sam.request(react(freeNote, freeKey, true))).toMatchObject({ type: "error", code: "reactor_full", noteId: freeNote });
    expect(await rowsWritten(stub)).toBe(before);
    const [usedNote, usedKey] = combos[0]!;
    sam.send(react(usedNote, usedKey, false));
    expect(await nextOfType(sam, "reactionMine")).toMatchObject({ on: false });
    sam.send(react(freeNote, freeKey, true));
    expect(await nextOfType(sam, "reactionMine")).toMatchObject({ noteId: freeNote, on: true });
    sam.close();
  });

  it(`a room has at most ${MAX_REACTIONS_PER_ROOM} reaction rows (reactions_full, naming the note); off still works`, async () => {
    const { code, key, stub, noteIds } = await bigRoom();
    const combos = noteIds.flatMap((n) => REACTION_KEYS.map((k) => [n, k] as const));
    const rows: [string, string, string][] = [];
    for (let r = 0; rows.length < MAX_REACTIONS_PER_ROOM; r++) {
      for (const [n, k] of combos) if (rows.length < MAX_REACTIONS_PER_ROOM) rows.push([`reactor${String(r).padStart(36, "0")}`, n, k]);
    }
    await fillRows(stub, rows);
    const sam = await rejoin(code, key);
    expect(sam.reactions?.counts.reduce((sum, c) => sum + c.count, 0)).toBe(MAX_REACTIONS_PER_ROOM);
    const before = await rowsWritten(stub);
    expect(await sam.request(react(noteIds[0]!, "heart", true))).toMatchObject({ type: "error", code: "reactions_full", noteId: noteIds[0] });
    expect(await rowsWritten(stub)).toBe(before);
    sam.close();
  });
});

describe("rate", () => {
  it("reactions spend their own bucket: over it is rate_limited (naming the note), and edits still go through", async () => {
    const { alex, sam, notes, stub } = await reactionRoom();
    await fullMessageBudget(stub);
    await runInDurableObject(stub, (_r: unknown, state: DurableObjectState) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as { participant?: { name?: string } | null } & Record<string, unknown>;
        if (att.participant?.name === "Sam") ws.serializeAttachment({ ...att, reactTokens: 0, reactAt: Date.now() + 3_600_000 });
      }
    });
    expect(await sam.request(react(notes[0]!.id, "heart", true))).toMatchObject({ type: "error", code: "rate_limited", noteId: notes[0]!.id });
    expect(await reactionRows(stub)).toEqual([]);
    // Edits are untouched: the whole message burst is still there.
    const tokens = await runInDurableObject(stub, (_r: unknown, state: DurableObjectState) =>
      state.getWebSockets().map((ws) => ws.deserializeAttachment() as { participant?: { name?: string } | null; tokens: number }).find((a) => a.participant?.name === "Sam")?.tokens,
    );
    expect(tokens).toBeGreaterThanOrEqual(SOCKET_LIMITS.burst - 1);
    sam.send({ type: "noteEdit", id: notes[0]!.id, text: "Still editable" });
    expect((await nextOfType(alex, "noteUpdated")).note.text).toBe("Still editable");
    closeAll(alex, sam);
  });

  it("a reaction spends no SOCKET_LIMITS token", async () => {
    const { sam, notes, stub } = await reactionRoom();
    await fullMessageBudget(stub);
    for (const key of ["heart", "plus", "laugh"]) {
      sam.send(react(notes[0]!.id, key, true));
      await nextOfType(sam, "reactionMine");
    }
    const att = await runInDurableObject(stub, (_r: unknown, state: DurableObjectState) =>
      state.getWebSockets().map((ws) => ws.deserializeAttachment() as { participant?: { name?: string } | null; tokens: number; reactTokens: number }).find((a) => a.participant?.name === "Sam"),
    );
    expect(att?.tokens).toBe(SOCKET_LIMITS.burst);
    expect(att?.reactTokens).toBeLessThan(REACTION_LIMITS.burst);
    sam.close();
  });
});

describe("costs (docs/LIMITS.md)", () => {
  it("rows: on 2 (row and index), the same again 0, off 1; a note delete +1 per reaction on it", async () => {
    const { alex, sam, notes, stub } = await reactionRoom();
    const n = notes[0]!.id;
    let rows = await rowsWritten(stub);
    sam.send(react(n, "heart", true));
    await nextOfType(sam, "reactionMine");
    expect((await rowsWritten(stub)) - rows).toBe(2);
    rows = await rowsWritten(stub);
    sam.send(react(n, "heart", true));
    expect(await sam.quiet(200)).toBe(true);
    expect((await rowsWritten(stub)) - rows).toBe(0);
    sam.send(react(n, "heart", false));
    await nextOfType(sam, "reactionMine");
    expect((await rowsWritten(stub)) - rows).toBe(1);
    // A note's delete without reactions, then one with three.
    rows = await rowsWritten(stub);
    alex.send({ type: "noteDelete", id: notes[1]!.id });
    await nextOfType(sam, "noteDeleted");
    const plainDelete = (await rowsWritten(stub)) - rows;
    for (const key of ["heart", "plus", "laugh"]) {
      sam.send(react(notes[2]!.id, key, true));
      await nextOfType(sam, "reactionMine");
    }
    rows = await rowsWritten(stub);
    alex.send({ type: "noteDelete", id: notes[2]!.id });
    await nextOfType(sam, "noteDeleted");
    expect((await rowsWritten(stub)) - rows).toBe(plainDelete + 3);
    closeAll(alex, sam);
  });
});

const version = (sql: SqlStorage) => sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value;
const tableRows = (sql: SqlStorage, table: string) => sql.exec<Row>(`SELECT * FROM ${table} ORDER BY rowid`).toArray();

describe(`schema migration 10 -> ${SCHEMA_VERSION}`, () => {
  it("adds the reactions table (every column with a DEFAULT; reactor, note and key as the key); every existing table untouched", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV10(sql);
      const before = Object.fromEntries(["notes", "frames", "votes", "shapes"].map((t) => [t, tableRows(sql, t)]));
      const metaBefore = tableRows(sql, "meta").filter((r) => r.key !== "schema_version");
      const store = new NoteStore(sql);
      expect(version(sql)).toBe(11);
      for (const [t, rows] of Object.entries(before)) expect(tableRows(sql, t), t).toEqual(rows);
      expect(tableRows(sql, "meta").filter((r) => r.key !== "schema_version")).toEqual(metaBefore);
      const columns = sql.exec<{ name: string; dflt_value: string | null; notnull: number; pk: number }>("SELECT name, dflt_value, \"notnull\", pk FROM pragma_table_info('reactions')").toArray();
      expect(columns.map((c) => [c.name, c.dflt_value, c.notnull, c.pk])).toEqual([
        ["reactor_id", "''", 1, 1],
        ["note_id", "''", 1, 2],
        ["reaction_key", "''", 1, 3],
      ]);
      expect(store.all().map((n) => n.id)).toEqual([...V5_NOTES.map((n) => n.id), V10_SEALED.id]);
      expect(store.writerOf(V10_SEALED.id)).toBe(V10_SEALED.writer);
      expect(store.allFrames().map((f) => f.id)).toEqual(V6_FRAMES.map((f) => f.id));
      expect(store.allShapes().map((s) => s.id)).toEqual([V9_SHAPE[0]]);
      expect(store.totals()).toEqual([{ noteId: "v5note0000000002", count: 2 }]);
      expect(store.reactionCounts()).toEqual([]);
      // Runs once: a second load writes nothing.
      expect(new NoteStore(sql).rowsWritten).toBe(0);
    });
  });

  it("is idempotent if it was interrupted after making the table", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV10(sql);
      sql.exec("CREATE TABLE reactions (reactor_id TEXT NOT NULL DEFAULT '', note_id TEXT NOT NULL DEFAULT '', reaction_key TEXT NOT NULL DEFAULT '', PRIMARY KEY (reactor_id, note_id, reaction_key))");
      new NoteStore(sql);
      expect(version(sql)).toBe(SCHEMA_VERSION);
    });
  });

  it("on a populated room: reactions are added beside the old data; v0.32.0's note insert and delete still work (rows it leaves behind are ignored)", async () => {
    const { code, stub } = await newRoom();
    const [first, second] = [V5_NOTES[0].id, V5_NOTES[1].id];
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV10(sql);
      const store = new NoteStore(sql);
      expect(store.setReaction("r".repeat(43), first, "heart", true)).toBe(true);
      expect(store.setReaction("s".repeat(43), first, "heart", true)).toBe(true);
      expect(store.setReaction("r".repeat(43), second, "plus", true)).toBe(true);
      // Then v0.32.0 code (after a rollback) adds a note and deletes one: it knows nothing of reactions.
      sql.exec(V10_NOTE_INSERT, "fromV19code00001", 0, 0, 160, 160, "New", "green", "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", 9, 1, "AAAAAAAAAAAAAAAA", 0, null);
      for (const statement of V10_NOTE_DELETE) sql.exec(statement, first);
      sql.exec("DELETE FROM meta WHERE key = 'silent_active'");
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Sam");
    expect(c.snapshot?.notes.map((n) => n.id)).toContain("fromV19code00001");
    expect(c.snapshot?.notes.map((n) => n.id)).not.toContain(first);
    // The orphaned rows of the deleted note don't count (its id is random, so it never comes back).
    expect(c.reactions?.counts).toEqual([{ noteId: second, key: "plus", count: 1 }]);
    c.close();
  });

  it("bad stored rows are skipped, never fatal: unknown keys and notes that aren't there", async () => {
    const { code, stub } = await newRoom();
    const c = await TestClient.open(code);
    await c.enter("Sam");
    const note = await addNote(c, "Idea");
    c.close();
    await c.waitClose();
    await fillRows(stub, [
      ["r".repeat(43), note.id, "heart"],
      ["r".repeat(43), note.id, "fire"],
      ["r".repeat(43), unknownId(), "heart"],
    ]);
    const d = await TestClient.open(code);
    await d.enter("Alex");
    expect(d.reactions?.counts).toEqual([{ noteId: note.id, key: "heart", count: 1 }]);
    d.close();
  });
});
