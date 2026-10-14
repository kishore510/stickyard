/// <reference types="vite/client" />
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_DEFAULTS,
  GROUPS_SNAPSHOT_MAX_BYTES,
  MAX_GROUP_LABEL,
  MAX_GROUP_MEMBERS,
  MAX_GROUPS_PER_ROOM,
  MAX_NOTES_PER_ROOM,
  MAX_SHAPES_PER_ROOM,
  PROTOCOL_VERSION,
  utf8Length,
  type Group,
  type Note,
  type ServerMessage,
  type Shape,
} from "@stickyard/shared";
import type { Room } from "../src/room";
import { NoteStore, SCHEMA_VERSION } from "../src/noteStore";
import { GROUP_LIMITS, SOCKET_LIMITS } from "../src/limits";
import { V5_NOTES } from "./fixtures/schemaV5";
import { V6_FRAMES } from "./fixtures/schemaV6";
import { V10_SEALED } from "./fixtures/schemaV10";
import { V12_CONNECTOR_IDS, V12_NOTE_DELETE, V12_NOTE_INSERT, V12_SHAPE_DELETE, V12_SHAPE_ID, loadSchemaV12 } from "./fixtures/schemaV12";
import { TEST_SIGNING_KEY, TestClient, fullMessageBudget, nextOfType, specHostToken, specRoomCode } from "./helpers";

/*
 * Group boxes, protocol v22 and stored schema 13, structure part 1 of 3: relay and shared, no UI.
 * A group is a set of notes and shapes (never frames, connectors or other groups) with a label and
 * a colour key; an item is in at most one group; a group below 2 members is dissolved by the relay.
 * These tests drive the real Durable Object over WebSockets. Fake keys only (vitest.config.ts);
 * generic names and text, and a hostile string as a label and wherever room text is involved.
 */

vi.setConfig({ testTimeout: 30_000 });

const HOSTILE = "<img src=x onerror=alert(1)>";
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const newKey = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
const unknownId = () => b64url(crypto.getRandomValues(new Uint8Array(12)));
const sorted = (ids: readonly string[]) => [...ids].sort();

/** The writer id straight from the spec, independently of src/writerId.ts. */
async function specWriterId(roomId: string, key: string): Promise<string> {
  const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(TEST_SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`stickyard-writer-v1:${roomId}:${key}`))));
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
const groupRows = async (stub: Stub) => (await allRows(stub)).groups ?? [];
const memberRows = async (stub: Stub) => (await allRows(stub)).group_members ?? [];
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

/**
 * Everything the room answers `c` to `message`, independent of runner speed: a socket's messages
 * are handled in order, and a hello after joining is answered with welcome to the sender only.
 */
async function answers(c: TestClient, message: unknown): Promise<ServerMessage[]> {
  c.send(message);
  c.send({ type: "hello", protocolVersion: PROTOCOL_VERSION });
  const out: ServerMessage[] = [];
  for (;;) {
    const m = await c.next(10_000);
    if (m.type === "welcome") return out;
    out.push(m);
  }
}

/** Every socket's group buckets full (GROUP_LIMITS) with their refill clocks at now, and the message bucket too. */
async function fullBudgets(stub: Stub): Promise<void> {
  await fullMessageBudget(stub);
  await runInDurableObject(stub, (_r: unknown, state: DurableObjectState) => {
    for (const ws of state.getWebSockets()) {
      const att = ws.deserializeAttachment() as Record<string, unknown> | null;
      if (att) ws.serializeAttachment({ ...att, groupTokens: GROUP_LIMITS.burst, groupAt: Date.now(), groupMemberTokens: GROUP_LIMITS.membersBurst, groupMemberAt: Date.now() });
    }
  });
}

/** Sets one socket's attachment fields, by participant name. */
const patchAttachment = (stub: Stub, name: string, patch: Record<string, unknown>) =>
  runInDurableObject(stub, (_r: unknown, state: DurableObjectState) => {
    for (const ws of state.getWebSockets()) {
      const att = ws.deserializeAttachment() as { participant?: { name?: string } | null } & Record<string, unknown>;
      if (att.participant?.name === name) ws.serializeAttachment({ ...att, ...patch });
    }
  });

/** One socket's attachment, by participant name. */
const attachmentOf = (stub: Stub, name: string) =>
  runInDurableObject(stub, (_r: unknown, state: DurableObjectState) =>
    state
      .getWebSockets()
      .map((ws) => ws.deserializeAttachment() as { participant?: { name?: string } | null; tokens: number; groupTokens: number; groupMemberTokens: number })
      .find((a) => a.participant?.name === name),
  );

async function addNote(c: TestClient, text: string, at: { x: number; y: number }, others: TestClient[] = []): Promise<Note> {
  c.send({ type: "noteAdd", clientRef: "n1", ...at, color: "yellow", text });
  let added = await nextOfType(c, "noteAdded");
  while (added.clientRef !== "n1") added = await nextOfType(c, "noteAdded");
  for (const o of others) await nextOfType(o, "noteAdded");
  return added.note;
}

async function addShape(c: TestClient, at: { x: number; y: number }, others: TestClient[] = []): Promise<Shape> {
  c.send({ type: "shapeAdd", clientRef: "s1", kind: "rect", ...at });
  let added = await nextOfType(c, "shapeAdded");
  while (added.clientRef !== "s1") added = await nextOfType(c, "shapeAdded");
  for (const o of others) await nextOfType(o, "shapeAdded");
  return added.shape;
}

const groupCreate = (members: readonly string[], extra: Record<string, unknown> = {}) => ({ type: "groupCreate", clientRef: "g1", label: HOSTILE, color: "blue", members, ...extra });

/** A groupCreate by `c`: its groupCreated (with clientRef); each of `others` gets the same without it. */
async function createGroup(c: TestClient, members: readonly string[], others: TestClient[] = [], extra: Record<string, unknown> = {}): Promise<Group> {
  c.send(groupCreate(members, extra));
  let created = await nextOfType(c, "groupCreated");
  while (created.clientRef !== "g1") created = await nextOfType(c, "groupCreated");
  for (const o of others) expect(await nextOfType(o, "groupCreated")).toEqual({ type: "groupCreated", group: created.group });
  return created.group;
}

/**
 * A room with a host (Alex, claimed) and a guest (Sam): four notes (n1..n4), two rectangles (s1,
 * s2), a frame and a connector (n1 to s1), all by Alex.
 */
async function groupRoom() {
  const room = await newRoom();
  const alex = await TestClient.open(room.code);
  const sam = await TestClient.open(room.code);
  await alex.enter("Alex");
  await sam.enter("Sam");
  await drain(alex, sam);
  expect(await alex.request({ type: "claimHost", token: room.token })).toEqual({ type: "hostGranted" });
  await drain(alex, sam);
  const n1 = await addNote(alex, HOSTILE, { x: 100, y: 100 }, [sam]);
  const n2 = await addNote(alex, "Second", { x: 400, y: 100 }, [sam]);
  const n3 = await addNote(alex, "Third", { x: 700, y: 100 }, [sam]);
  const n4 = await addNote(alex, "Fourth", { x: 1000, y: 100 }, [sam]);
  const s1 = await addShape(alex, { x: 100, y: 1000 }, [sam]);
  const s2 = await addShape(alex, { x: 400, y: 1000 }, [sam]);
  const frame = (await alex.request({ type: "frameAdd", clientRef: "f1", x: 3000, y: 2000, color: "neutral", title: HOSTILE })) as Extract<ServerMessage, { type: "frameAdded" }>;
  await drain(alex, sam);
  alex.send({ type: "connectorAdd", clientRef: "k1", start: { item: n1.id, anchor: "auto" }, end: { item: s1.id, anchor: "auto" }, ...CONNECTOR_DEFAULTS });
  const connector = (await nextOfType(alex, "connectorAdded")).connector;
  await drain(alex, sam);
  await fullBudgets(room.stub);
  return { ...room, alex, sam, n1, n2, n3, n4, s1, s2, frame: frame.frame, connector };
}

describe("versions", () => {
  it("protocol 22 and stored schema 13; a v21 page is asked to reload", async () => {
    expect(PROTOCOL_VERSION).toBe(22);
    expect(SCHEMA_VERSION).toBe(13);
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request({ type: "hello", protocolVersion: 21 })).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Sam" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });
});

describe("groupCreate", () => {
  it("the server assigns id and rev 1; members in id order; the label is cleaned (never rendered here); the sender's copy has its clientRef", async () => {
    const { alex, sam, n1, n2, n3, s1, s2, stub } = await groupRoom();
    const g = await createGroup(sam, [s1.id, n2.id, n1.id], [alex], { label: `  ${HOSTILE}\n`, color: "purple" });
    expect(g).toEqual({ id: g.id, label: HOSTILE, color: "purple", members: sorted([n1.id, n2.id, s1.id]), rev: 1 });
    expect(g.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(await groupRows(stub)).toEqual([{ id: g.id, label: HOSTILE, color: "purple", rev: 1 }]);
    expect(sorted((await memberRows(stub)).map((r) => `${String(r.item_id)}:${String(r.group_id)}`))).toEqual(sorted([n1.id, n2.id, s1.id].map((id) => `${id}:${g.id}`)));
    // An empty label is allowed.
    const h = await createGroup(alex, [n3.id, s2.id], [sam], { label: "" });
    expect(h.label).toBe("");
    closeAll(alex, sam);
  });

  it("refused: fewer than 2 members (group_size), duplicates, a label over 40 characters, a colour that isn't a key (bad_message); nothing written or relayed", async () => {
    const { alex, sam, n1, stub } = await groupRoom();
    const before = await rowsWritten(stub);
    for (const members of [[], [n1.id]]) expect(await answers(sam, groupCreate(members))).toMatchObject([{ type: "error", code: "group_size", clientRef: "g1" }]);
    expect(await answers(sam, groupCreate([n1.id, n1.id]))).toMatchObject([{ type: "error", code: "bad_message" }]);
    expect(await answers(sam, groupCreate([n1.id, unknownId()], { label: "x".repeat(MAX_GROUP_LABEL + 1) }))).toMatchObject([{ type: "error", code: "bad_message" }]);
    expect(await answers(sam, groupCreate([n1.id, unknownId()], { color: "#ff0000" }))).toMatchObject([{ type: "error", code: "bad_message" }]);
    expect(await answers(sam, groupCreate(Array.from({ length: MAX_GROUP_MEMBERS + 1 }, () => unknownId())))).toMatchObject([{ type: "error", code: "bad_message" }]);
    expect(await rowsWritten(stub)).toBe(before);
    expect(await alex.quiet()).toBe(true);
    closeAll(alex, sam);
  });

  it("refused with unknown_item: an unknown id, a deleted note or shape, a frame, a connector, a group; nothing written", async () => {
    const { alex, sam, n1, n2, n3, n4, s1, s2, frame, connector, stub } = await groupRoom();
    const g = await createGroup(alex, [n3.id, n4.id], [sam]);
    alex.send({ type: "noteDelete", id: n2.id });
    await nextOfType(sam, "noteDeleted");
    alex.send({ type: "shapeDelete", id: s2.id });
    await nextOfType(sam, "shapeDeleted");
    await drain(alex, sam);
    const before = await rowsWritten(stub);
    for (const id of [unknownId(), n2.id, s2.id, frame.id, connector.id, g.id]) {
      expect(await answers(sam, groupCreate([n1.id, id]))).toMatchObject([{ type: "error", code: "unknown_item", clientRef: "g1" }]);
    }
    expect(await rowsWritten(stub)).toBe(before);
    expect(await alex.quiet()).toBe(true);
    // The room is unchanged: s1 can still be grouped.
    await createGroup(sam, [n1.id, s1.id], [alex]);
    closeAll(alex, sam);
  });

  it(`a room holds at most ${MAX_GROUPS_PER_ROOM} groups (groups_full, with the clientRef); a delete frees one`, async () => {
    const { code, alex, sam, stub } = await groupRoom();
    closeAll(alex, sam);
    await alex.waitClose();
    await sam.waitClose();
    // 30 groups of two shapes each, straight into storage (60 shapes is past the shape cap, so notes too).
    const items: string[] = [];
    await runInDurableObject(stub, (_r, state) => {
      const sql = state.storage.sql;
      for (let i = 0; i < 2 * MAX_GROUPS_PER_ROOM; i++) {
        const id = `full${String(i).padStart(12, "0")}`;
        items.push(id);
        sql.exec("INSERT INTO notes (id, x, y, text, color, rev, author_id) VALUES (?, 0, 0, '', 'yellow', 1, 'AAAAAAAAAAAAAAAA')", id);
      }
      for (let g = 0; g < MAX_GROUPS_PER_ROOM; g++) {
        const id = `grp${String(g).padStart(13, "0")}`;
        sql.exec("INSERT INTO groups (id, label, color, rev) VALUES (?, '', 'neutral', 1)", id);
        for (const item of items.slice(2 * g, 2 * g + 2)) sql.exec("INSERT INTO group_members (item_id, group_id) VALUES (?, ?)", item, id);
      }
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Jo");
    expect(c.groups?.groups).toHaveLength(MAX_GROUPS_PER_ROOM);
    const spare = await addNote(c, "Spare", { x: 5000, y: 100 });
    const spare2 = await addNote(c, "Spare 2", { x: 5300, y: 100 });
    const before = await rowsWritten(stub);
    expect(await answers(c, groupCreate([spare.id, spare2.id]))).toMatchObject([{ type: "error", code: "groups_full", clientRef: "g1" }]);
    expect(await rowsWritten(stub)).toBe(before);
    // Updates, member changes and deletes still work; a delete frees a place.
    const first = c.groups!.groups[0]!;
    expect(await c.request({ type: "groupUpdate", id: first.id, color: "green" })).toMatchObject({ type: "groupUpdated", group: { id: first.id, color: "green", rev: 2 } });
    expect(await c.request({ type: "groupDelete", id: first.id })).toEqual({ type: "groupDeleted", id: first.id });
    expect((await createGroup(c, [spare.id, spare2.id])).members).toEqual(sorted([spare.id, spare2.id]));
    c.close();
  });
});

describe("moving an item between groups", () => {
  it("an item already in another group moves; the group it leaves keeps going at 2 or more (groupUpdated, rev + 1) or is dissolved below 2 (groupDeleted)", async () => {
    const { alex, sam, n1, n2, n3, n4, s1, stub } = await groupRoom();
    const a = await createGroup(alex, [n1.id, n2.id, n3.id], [sam]);
    // n3 moves from a (3 -> 2 members: kept) into b.
    alex.send(groupCreate([n3.id, s1.id]));
    const created = await nextOfType(sam, "groupCreated");
    expect(created.group.members).toEqual(sorted([n3.id, s1.id]));
    expect(await sam.next()).toEqual({ type: "groupUpdated", group: { ...a, members: sorted([n1.id, n2.id]), rev: 2 } });
    expect(await sam.quiet()).toBe(true);
    await drain(alex);
    const b = created.group;
    // A third group takes n1 (from a: 2 -> 1, dissolved) and s1 (from b: 2 -> 1, dissolved).
    alex.send(groupCreate([n1.id, s1.id, n4.id]));
    const c = (await nextOfType(sam, "groupCreated")).group;
    expect(c.members).toEqual(sorted([n1.id, n4.id, s1.id]));
    expect(await sam.next()).toEqual({ type: "groupDeleted", id: a.id });
    expect(await sam.next()).toEqual({ type: "groupDeleted", id: b.id });
    expect(await sam.quiet()).toBe(true);
    // Storage holds only c, and no member rows for n2 or n3 (both left alone, in no group).
    expect((await groupRows(stub)).map((r) => r.id)).toEqual([c.id]);
    expect(sorted((await memberRows(stub)).map((r) => String(r.item_id)))).toEqual(sorted([n1.id, n4.id, s1.id]));
    closeAll(alex, sam);
  });

  it("groupMembers add moves an item from another group the same way", async () => {
    const { alex, sam, n1, n2, n3, n4 } = await groupRoom();
    const a = await createGroup(alex, [n1.id, n2.id], [sam]);
    const b = await createGroup(alex, [n3.id, n4.id], [sam]);
    alex.send({ type: "groupMembers", id: b.id, add: [n1.id], remove: [] });
    expect(await nextOfType(sam, "groupUpdated")).toEqual({ type: "groupUpdated", group: { ...b, members: sorted([n1.id, n3.id, n4.id]), rev: 2 } });
    expect(await sam.next()).toEqual({ type: "groupDeleted", id: a.id });
    expect(await sam.quiet()).toBe(true);
    closeAll(alex, sam);
  });
});

describe("groupUpdate", () => {
  it("a label and/or a colour, last write wins in arrival order, one rev per stored change, to everyone", async () => {
    const { alex, sam, n1, n2, stub } = await groupRoom();
    const g = await createGroup(alex, [n1.id, n2.id], [sam]);
    sam.send({ type: "groupUpdate", id: g.id, label: " Team\tideas " });
    alex.send({ type: "groupUpdate", id: g.id, color: "orange" });
    const first = await nextOfType(alex, "groupUpdated");
    const second = await nextOfType(alex, "groupUpdated");
    expect([first.group.rev, second.group.rev]).toEqual([2, 3]);
    expect(second.group).toEqual({ ...g, label: "Team ideas", color: "orange", rev: 3 });
    expect(await groupRows(stub)).toEqual([{ id: g.id, label: "Team ideas", color: "orange", rev: 3 }]);
    closeAll(alex, sam);
  });

  it("an unchanged update writes and sends nothing; an unknown or deleted group is unknown_group (naming it)", async () => {
    const { alex, sam, n1, n2, stub } = await groupRoom();
    const g = await createGroup(alex, [n1.id, n2.id], [sam], { label: "Same", color: "green" });
    await drain(alex, sam);
    const before = await rowsWritten(stub);
    expect(await answers(sam, { type: "groupUpdate", id: g.id, label: "Same", color: "green" })).toEqual([]);
    expect(await answers(sam, { type: "groupUpdate", id: g.id, label: "  Same " })).toEqual([]);
    expect(await rowsWritten(stub)).toBe(before);
    expect(await alex.quiet()).toBe(true);
    const random = unknownId();
    expect(await answers(sam, { type: "groupUpdate", id: random, color: "pink" })).toMatchObject([{ type: "error", code: "unknown_group", groupId: random }]);
    alex.send({ type: "groupDelete", id: g.id });
    await nextOfType(sam, "groupDeleted");
    expect(await answers(sam, { type: "groupUpdate", id: g.id, color: "pink" })).toMatchObject([{ type: "error", code: "unknown_group", groupId: g.id }]);
    closeAll(alex, sam);
  });
});

describe("groupMembers", () => {
  it("add and remove in one message: one groupUpdated with the full member list, rev + 1", async () => {
    const { alex, sam, n1, n2, n3, n4, s1, stub } = await groupRoom();
    const g = await createGroup(alex, [n1.id, n2.id, n3.id], [sam]);
    sam.send({ type: "groupMembers", id: g.id, add: [s1.id, n4.id], remove: [n2.id] });
    const updated = await nextOfType(alex, "groupUpdated");
    expect(updated.group).toEqual({ ...g, members: sorted([n1.id, n3.id, n4.id, s1.id]), rev: 2 });
    expect(await nextOfType(sam, "groupUpdated")).toEqual(updated);
    expect(sorted((await memberRows(stub)).map((r) => String(r.item_id)))).toEqual(sorted([n1.id, n3.id, n4.id, s1.id]));
    closeAll(alex, sam);
  });

  it("a no-op (adding members it has, removing items it hasn't) writes and sends nothing", async () => {
    const { alex, sam, n1, n2, n3, stub } = await groupRoom();
    const g = await createGroup(alex, [n1.id, n2.id], [sam]);
    await drain(alex, sam);
    const before = await rowsWritten(stub);
    expect(await answers(sam, { type: "groupMembers", id: g.id, add: [n1.id], remove: [n3.id, unknownId()] })).toEqual([]);
    expect(await rowsWritten(stub)).toBe(before);
    expect(await alex.quiet()).toBe(true);
    closeAll(alex, sam);
  });

  it("removing down to fewer than 2 dissolves the group (groupDeleted); the items stay", async () => {
    const { alex, sam, n1, n2, stub } = await groupRoom();
    const g = await createGroup(alex, [n1.id, n2.id], [sam]);
    sam.send({ type: "groupMembers", id: g.id, add: [], remove: [n1.id] });
    expect(await nextOfType(alex, "groupDeleted")).toEqual({ type: "groupDeleted", id: g.id });
    expect(await nextOfType(sam, "groupDeleted")).toEqual({ type: "groupDeleted", id: g.id });
    expect(await groupRows(stub)).toEqual([]);
    expect(await memberRows(stub)).toEqual([]);
    expect((await allRows(stub)).notes!.map((r) => r.id)).toContain(n1.id);
    closeAll(alex, sam);
  });

  it(`refused: past ${MAX_GROUP_MEMBERS} members (group_size), a bad member (unknown_item), an unknown group (unknown_group); nothing written`, async () => {
    const { code, alex, sam, n1, n2, frame, connector, stub } = await groupRoom();
    const g = await createGroup(alex, [n1.id, n2.id], [sam]);
    closeAll(alex, sam);
    await alex.waitClose();
    await sam.waitClose();
    const extra: string[] = [];
    await runInDurableObject(stub, (_r, state) => {
      for (let i = 0; i < MAX_GROUP_MEMBERS - 1; i++) {
        const id = `more${String(i).padStart(12, "0")}`;
        extra.push(id);
        state.storage.sql.exec("INSERT INTO notes (id, x, y, text, color, rev, author_id) VALUES (?, 0, 0, '', 'yellow', 1, 'AAAAAAAAAAAAAAAA')", id);
      }
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Jo");
    await fullBudgets(stub);
    const before = await rowsWritten(stub);
    // 2 + 99 = 101.
    expect(await answers(c, { type: "groupMembers", id: g.id, add: extra, remove: [] })).toMatchObject([{ type: "error", code: "group_size", groupId: g.id }]);
    for (const id of [unknownId(), frame.id, connector.id, g.id]) {
      expect(await answers(c, { type: "groupMembers", id: g.id, add: [id], remove: [] })).toMatchObject([{ type: "error", code: "unknown_item", groupId: g.id }]);
    }
    const random = unknownId();
    expect(await answers(c, { type: "groupMembers", id: random, add: [n1.id], remove: [] })).toMatchObject([{ type: "error", code: "unknown_group", groupId: random }]);
    expect(await rowsWritten(stub)).toBe(before);
    // Exactly 100 is fine (2 + 98, one removed and one added in the same message is fine too).
    const updated = await c.request({ type: "groupMembers", id: g.id, add: extra.slice(0, MAX_GROUP_MEMBERS - 2), remove: [] });
    expect(updated).toMatchObject({ type: "groupUpdated", group: { id: g.id, rev: 2 } });
    if (updated.type === "groupUpdated") expect(updated.group.members).toHaveLength(MAX_GROUP_MEMBERS);
    c.close();
  });
});

describe("groupDelete", () => {
  it("ungroups: groupDeleted to everyone, the group's rows go, every item stays exactly as it was", async () => {
    const { alex, sam, n1, n2, s1, stub } = await groupRoom();
    const g = await createGroup(alex, [n1.id, n2.id, s1.id], [sam]);
    const before = await allRows(stub);
    sam.send({ type: "groupDelete", id: g.id });
    expect(await nextOfType(alex, "groupDeleted")).toEqual({ type: "groupDeleted", id: g.id });
    expect(await nextOfType(sam, "groupDeleted")).toEqual({ type: "groupDeleted", id: g.id });
    expect(await alex.quiet()).toBe(true);
    const after = await allRows(stub);
    expect(after.groups).toEqual([]);
    expect(after.group_members).toEqual([]);
    for (const t of ["notes", "shapes", "frames", "connectors"]) expect(after[t], t).toEqual(before[t]);
    closeAll(alex, sam);
  });

  it("an unknown or already deleted group is unknown_group (naming it); nothing written", async () => {
    const { alex, sam, n1, n2, stub } = await groupRoom();
    const g = await createGroup(alex, [n1.id, n2.id], [sam]);
    alex.send({ type: "groupDelete", id: g.id });
    await nextOfType(sam, "groupDeleted");
    await drain(alex, sam);
    const before = await rowsWritten(stub);
    expect(await answers(sam, { type: "groupDelete", id: g.id })).toMatchObject([{ type: "error", code: "unknown_group", groupId: g.id }]);
    expect(await rowsWritten(stub)).toBe(before);
    expect(await alex.quiet()).toBe(true);
    closeAll(alex, sam);
  });
});

/* ── Dissolving below 2 when a member is deleted, on every delete path ── */

/** Reads messages until the client is quiet. */
async function typesUntilQuiet(c: TestClient): Promise<ServerMessage[]> {
  const out: ServerMessage[] = [];
  while (!(await c.quiet(150))) out.push(await c.next());
  return out;
}

describe("a member's delete", () => {
  it("noteDelete: a group left with 2 or more gets groupUpdated (rev + 1); one left with 1 is dissolved; both after noteDeleted and the connector's freed end", async () => {
    const { alex, sam, n1, n2, n3, n4, s1, connector } = await groupRoom();
    const big = await createGroup(alex, [n1.id, n2.id, n3.id], [sam]);
    const pair = await createGroup(alex, [n4.id, s1.id], [sam]);
    alex.send({ type: "noteDelete", id: n1.id });
    const seen = await typesUntilQuiet(sam);
    expect(seen.map((m) => m.type)).toEqual(["noteDeleted", "connectorUpdated", "groupUpdated"]);
    expect(seen[1]).toMatchObject({ connector: { id: connector.id } });
    expect(seen[2]).toEqual({ type: "groupUpdated", group: { ...big, members: sorted([n2.id, n3.id]), rev: 2 } });
    alex.send({ type: "noteDelete", id: n4.id });
    expect(await typesUntilQuiet(sam)).toEqual([{ type: "noteDeleted", id: n4.id }, { type: "groupDeleted", id: pair.id }]);
    closeAll(alex, sam);
  });

  it("a final noteBatch delete: every group it touches dissolves or shrinks, in one groupDeleted / groupUpdated each, after notesBatchApplied", async () => {
    const { alex, sam, n1, n2, n3, n4, s1 } = await groupRoom();
    const a = await createGroup(alex, [n1.id, n2.id], [sam]);
    const b = await createGroup(alex, [n3.id, n4.id, s1.id], [sam]);
    alex.send({ type: "noteBatch", ops: [{ op: "delete", id: n1.id }, { op: "delete", id: n3.id }], final: true });
    const seen = await typesUntilQuiet(sam);
    expect(seen.map((m) => m.type)).toEqual(["notesBatchApplied", "connectorUpdated", "groupDeleted", "groupUpdated"]);
    expect(seen[2]).toEqual({ type: "groupDeleted", id: a.id });
    expect(seen[3]).toEqual({ type: "groupUpdated", group: { ...b, members: sorted([n4.id, s1.id]), rev: 2 } });
    closeAll(alex, sam);
  });

  it("shapeDelete and a final shapeBatch delete do the same for shapes", async () => {
    const { alex, sam, n2, n3, s1, s2 } = await groupRoom();
    const a = await createGroup(alex, [n2.id, s1.id], [sam]);
    const b = await createGroup(alex, [n3.id, s2.id], [sam]);
    alex.send({ type: "shapeDelete", id: s1.id });
    expect((await typesUntilQuiet(sam)).map((m) => (m.type === "groupDeleted" ? `groupDeleted:${m.id === a.id}` : m.type))).toEqual(["shapeDeleted", "connectorUpdated", "groupDeleted:true"]);
    alex.send({ type: "shapeBatch", ops: [{ op: "delete", id: s2.id }], final: true });
    expect(await typesUntilQuiet(sam)).toEqual([{ type: "shapesBatchApplied", results: [{ type: "shapeDeleted", id: s2.id }], final: true }, { type: "groupDeleted", id: b.id }]);
    closeAll(alex, sam);
  });

  it("Clear board (the page's batch deletes, without deleting groups first): every group dissolves, once each; nothing is left", async () => {
    const { code, alex, sam, n1, n2, n3, n4, s1, s2, frame, stub } = await groupRoom();
    const a = await createGroup(alex, [n1.id, n2.id, s1.id], [sam]);
    const b = await createGroup(alex, [n3.id, n4.id, s2.id], [sam]);
    alex.send({ type: "noteBatch", ops: [n1, n2, n3, n4].map((n) => ({ op: "delete", id: n.id })), final: true });
    const fromNotes = await typesUntilQuiet(sam);
    expect(fromNotes.filter((m) => m.type.startsWith("group"))).toEqual([
      { type: "groupDeleted", id: a.id },
      { type: "groupDeleted", id: b.id },
    ]);
    alex.send({ type: "shapeBatch", ops: [s1, s2].map((s) => ({ op: "delete", id: s.id })), final: true });
    expect((await typesUntilQuiet(sam)).filter((m) => m.type.startsWith("group"))).toEqual([]);
    alex.send({ type: "frameDelete", id: frame.id });
    await nextOfType(sam, "frameDeleted");
    expect(await groupRows(stub)).toEqual([]);
    expect(await memberRows(stub)).toEqual([]);
    const c = await TestClient.open(code);
    await c.enter("Jo");
    expect(c.groups).toEqual({ type: "groupsSnapshot", groups: [] });
    closeAll(alex, sam, c);
  });

  it("each delete path writes the item delete and the group changes in one transaction", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_r, state) => {
      const sql = state.storage.sql;
      let inside = false;
      let transacts = 0;
      const outside: string[] = [];
      const watched = new Proxy(sql, {
        get(target, prop, receiver) {
          if (prop !== "exec") return Reflect.get(target, prop, receiver);
          return (query: string, ...bindings: SqlStorageValue[]) => {
            if (/^\s*(INSERT|UPDATE|DELETE)/i.test(query) && !inside) outside.push(query);
            return target.exec(query, ...bindings);
          };
        },
      });
      const store = new NoteStore(watched, (fn) => {
        transacts++;
        inside = true;
        try {
          state.storage.transactionSync(fn);
        } finally {
          inside = false;
        }
      });
      const author = "AAAAAAAAAAAAAAAA";
      const note = (id: string): Note => ({ id, x: 100, y: 100, w: 160, h: 160, text: HOSTILE, color: "yellow", fontSize: "m", bold: false, italic: false, textColor: "auto", align: "left", titleAlign: "left", titleFontSize: "m", titleBold: false, titleItalic: false, titleTextColor: "auto", z: 0, rev: 1, authorId: author });
      const shape = (id: string): Shape => ({ id, kind: "rect", x: 100, y: 1000, w: 200, h: 120, text: "", fill: "neutral", stroke: "neutral", strokeWidth: "thin", strokeStyle: "solid", fontSize: "m", bold: false, italic: false, underline: false, textColor: "auto", align: "center", valign: "middle", z: 1, rev: 1, authorId: author });
      const notes = ["noteA0000000000a", "noteB0000000000b", "noteC0000000000c", "noteD0000000000d"];
      const shapes = ["shapeA000000000a", "shapeB000000000b", "shapeC000000000c", "shapeD000000000d"];
      for (const id of notes) store.insert(note(id));
      for (const id of shapes) store.insertShape(shape(id));
      // Four pairs: each path dissolves one.
      const pairs = notes.map((n, i) => [n, shapes[i]!] as const);
      pairs.forEach(([n, s], i) => store.changeGroups([{ id: `group${String(i).padStart(11, "0")}`, label: HOSTILE, color: "neutral", members: sorted([n, s]), rev: 1 }], [], []));
      expect(store.allGroups()).toHaveLength(4);
      const paths: [string, () => { groups: { dissolved: readonly string[] } }][] = [
        ["delete", () => store.delete(notes[0]!)],
        ["applyBatch", () => store.applyBatch([], [notes[1]!])],
        ["deleteShape", () => store.deleteShape(shapes[2]!)],
        ["applyShapeBatch", () => store.applyShapeBatch([], [shapes[3]!])],
      ];
      for (const [name, run] of paths) {
        outside.length = 0;
        transacts = 0;
        const effects = run();
        expect(effects.groups.dissolved, name).toHaveLength(1);
        expect(transacts, name).toBe(1);
        expect(outside, name).toEqual([]);
      }
      expect(store.allGroups()).toEqual([]);
      expect(sql.exec("SELECT COUNT(*) AS n FROM group_members").one().n).toBe(0);
      expect(sql.exec("SELECT COUNT(*) AS n FROM groups").one().n).toBe(0);
    });
  });

  it("a frame delete touches no group; moving or resizing a member writes nothing for groups (the box is never stored)", async () => {
    const { alex, sam, n1, n2, n3, frame, stub } = await groupRoom();
    let before = await rowsWritten(stub);
    alex.send({ type: "noteMove", id: n3.id, x: 1200, y: 300, final: true });
    await nextOfType(sam, "noteMoved");
    const plain = (await rowsWritten(stub)) - before;
    await createGroup(alex, [n1.id, n2.id], [sam]);
    before = await rowsWritten(stub);
    alex.send({ type: "noteMove", id: n1.id, x: 500, y: 700, final: true });
    expect((await typesUntilQuiet(sam)).map((m) => m.type)).toEqual(["noteMoved"]);
    expect((await rowsWritten(stub)) - before).toBe(plain);
    alex.send({ type: "frameDelete", id: frame.id });
    expect((await typesUntilQuiet(sam)).map((m) => m.type)).toEqual(["frameDeleted"]);
    expect(await groupRows(stub)).toHaveLength(1);
    closeAll(alex, sam);
  });
});

describe("burial", () => {
  it("End session drops the groups with everything else", async () => {
    const { alex, sam, n1, n2, stub } = await groupRoom();
    await createGroup(alex, [n1.id, n2.id], [sam]);
    alex.send({ type: "endSession" });
    await alex.waitClose();
    await sam.waitClose();
    expect(Object.keys(await allRows(stub))).toEqual(["meta"]);
  });

  it("idle expiry drops them too; the tombstone stays", async () => {
    const { alex, sam, n1, n2, stub } = await groupRoom();
    await createGroup(alex, [n1.id, n2.id], [sam]);
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

describe("gating", () => {
  it("a locked board refuses a guest's four group messages (board_locked, naming what to roll back); the host's go through", async () => {
    const { alex, sam, n1, n2, n3, stub } = await groupRoom();
    const g = await createGroup(alex, [n1.id, n2.id], [sam]);
    alex.send({ type: "lockSet", locked: true });
    await nextOfType(sam, "lockChanged");
    await drain(alex, sam);
    const before = await rowsWritten(stub);
    expect(await answers(sam, groupCreate([n3.id, n1.id]))).toMatchObject([{ type: "error", code: "board_locked", clientRef: "g1" }]);
    expect(await answers(sam, { type: "groupUpdate", id: g.id, color: "pink" })).toMatchObject([{ type: "error", code: "board_locked", groupId: g.id }]);
    expect(await answers(sam, { type: "groupMembers", id: g.id, add: [n3.id], remove: [] })).toMatchObject([{ type: "error", code: "board_locked", groupId: g.id }]);
    expect(await answers(sam, { type: "groupDelete", id: g.id })).toMatchObject([{ type: "error", code: "board_locked", groupId: g.id }]);
    expect(await rowsWritten(stub)).toBe(before);
    expect(await alex.quiet()).toBe(true);
    alex.send({ type: "groupUpdate", id: g.id, color: "pink" });
    expect((await nextOfType(sam, "groupUpdated")).group.color).toBe("pink");
    closeAll(alex, sam);
  });

  it("a silent round refuses all four for everyone, host included (silent_active, naming what to roll back); nothing written or relayed", async () => {
    const { alex, sam, n1, n2, n3, stub } = await groupRoom();
    const g = await createGroup(alex, [n1.id, n2.id], [sam]);
    expect(await alex.request({ type: "silentStart" })).toMatchObject({ type: "silentChanged", active: true });
    await nextOfType(sam, "silentChanged");
    const before = await rowsWritten(stub);
    for (const c of [alex, sam]) {
      expect(await answers(c, groupCreate([n3.id, n1.id]))).toMatchObject([{ type: "error", code: "silent_active", clientRef: "g1" }]);
      expect(await answers(c, { type: "groupUpdate", id: g.id, color: "pink" })).toMatchObject([{ type: "error", code: "silent_active", groupId: g.id }]);
      expect(await answers(c, { type: "groupMembers", id: g.id, add: [n3.id], remove: [] })).toMatchObject([{ type: "error", code: "silent_active", groupId: g.id }]);
      expect(await answers(c, { type: "groupDelete", id: g.id })).toMatchObject([{ type: "error", code: "silent_active", groupId: g.id }]);
    }
    expect(await rowsWritten(stub)).toBe(before);
    expect(await alex.quiet()).toBe(true);
    expect(await sam.quiet()).toBe(true);
    alex.send({ type: "silentReveal" });
    await nextOfType(sam, "silentChanged");
    await drain(alex, sam);
    expect(await sam.request({ type: "groupDelete", id: g.id })).toEqual({ type: "groupDeleted", id: g.id });
    closeAll(alex, sam);
  });

  it("needs a join (not_joined, naming what it was about)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    await c.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    expect(await c.request(groupCreate([unknownId(), unknownId()]))).toMatchObject({ type: "error", code: "not_joined", clientRef: "g1" });
    const id = unknownId();
    expect(await c.request({ type: "groupDelete", id })).toMatchObject({ type: "error", code: "not_joined", groupId: id });
    c.close();
  });
});

describe("sealed notes", () => {
  it("during a round, naming someone's sealed note gets exactly the reply a random id gets (silent_active), its writer's too", async () => {
    const room = await newRoom();
    const keys = { host: newKey(), a: newKey() };
    const host = await TestClient.open(room.code);
    const a = await TestClient.open(room.code);
    await host.enter("Hana", keys.host);
    await a.enter("Ari", keys.a);
    await drain(host, a);
    expect(await host.request({ type: "claimHost", token: room.token })).toEqual({ type: "hostGranted" });
    const visible = await addNote(host, "Visible", { x: 2000, y: 2000 }, [a]);
    const other = await addNote(host, "Other", { x: 2300, y: 2000 }, [a]);
    await drain(host, a);
    const g = await createGroup(host, [visible.id, other.id], [a]);
    expect(await host.request({ type: "silentStart" })).toMatchObject({ type: "silentChanged", active: true });
    await drain(host, a);
    a.send({ type: "noteAdd", clientRef: "n9", x: 300, y: 300, color: "pink", text: "CANARY sealed" });
    const sealed = (await nextOfType(a, "noteAdded")).note;
    await drain(host, a);
    const random = unknownId();
    for (const c of [a, host]) {
      for (const make of [(id: string) => groupCreate([id, visible.id]), (id: string) => ({ type: "groupMembers", id: g.id, add: [id], remove: [] })]) {
        const toSealed = await answers(c, make(sealed.id));
        expect(toSealed).toEqual(await answers(c, make(random)));
        expect(toSealed).toMatchObject([{ type: "error", code: "silent_active" }]);
      }
    }
    closeAll(host, a);
  });

  it("a sealed row outside a round (never written so by us) is refused exactly as an unknown id (unknown_item), for everyone, its writer too", async () => {
    const room = await newRoom();
    const key = newKey();
    const writer = await specWriterId(room.id, key);
    const c = await TestClient.open(room.code);
    await c.enter("Ari", key);
    const note = await addNote(c, "Hidden later", { x: 300, y: 300 });
    const visible = await addNote(c, "Visible", { x: 2000, y: 2000 });
    const visible2 = await addNote(c, "Visible too", { x: 2300, y: 2000 });
    const g = await createGroup(c, [visible.id, visible2.id]);
    c.close();
    await c.waitClose();
    await runInDurableObject(room.stub, (_r, state) => {
      state.storage.sql.exec("UPDATE notes SET sealed = 1, writer = ? WHERE id = ?", writer, note.id);
    });
    await evictDurableObject(room.stub, { webSockets: "close" });
    const a = await TestClient.open(room.code);
    const other = await TestClient.open(room.code);
    await a.enter("Ari", key);
    await other.enter("Ben", newKey());
    await drain(a, other);
    const random = unknownId();
    for (const client of [a, other]) {
      for (const make of [(id: string) => groupCreate([id, visible.id]), (id: string) => ({ type: "groupMembers", id: g.id, add: [id], remove: [] })]) {
        const toSealed = await answers(client, make(note.id));
        expect(toSealed).toEqual(await answers(client, make(random)));
        expect(toSealed).toMatchObject([{ type: "error", code: "unknown_item" }]);
      }
    }
    closeAll(a, other);
  });

  it("a stored group naming a sealed note (never written so by us) leaves it out on load, for everyone", async () => {
    const room = await newRoom();
    const key = newKey();
    const writer = await specWriterId(room.id, key);
    const c = await TestClient.open(room.code);
    await c.enter("Ari", key);
    const [x, y, z] = [await addNote(c, "One", { x: 100, y: 100 }), await addNote(c, "Two", { x: 400, y: 100 }), await addNote(c, "Three", { x: 700, y: 100 })];
    const g = await createGroup(c, [x.id, y.id, z.id]);
    const h = await createGroup(c, [await addNote(c, "Four", { x: 1000, y: 100 }).then((n) => n.id), await addNote(c, "Five", { x: 1300, y: 100 }).then((n) => n.id)]);
    c.close();
    await c.waitClose();
    await runInDurableObject(room.stub, (_r, state) => {
      state.storage.sql.exec("UPDATE notes SET sealed = 1, writer = ? WHERE id = ?", writer, x.id);
      state.storage.sql.exec("UPDATE notes SET sealed = 1, writer = ? WHERE id = ?", writer, h.members[0]);
    });
    await evictDurableObject(room.stub, { webSockets: "close" });
    for (const k of [key, newKey()]) {
      const d = await TestClient.open(room.code);
      await d.enter("Jo", k);
      expect(d.groups?.groups).toEqual([{ ...g, members: sorted([y.id, z.id]) }]);
      expect(JSON.stringify(d.groups)).not.toContain(x.id);
      d.close();
    }
  });
});

describe("join", () => {
  it("groupsSnapshot comes right after connectorsSnapshot on every join (creation order), and survives a wake", async () => {
    const { code, alex, sam, n1, n2, n3, s1, stub } = await groupRoom();
    const a = await createGroup(alex, [n1.id, n2.id], [sam]);
    const b = await createGroup(sam, [n3.id, s1.id], [alex], { label: "", color: "neutral" });
    const c = await TestClient.open(code);
    const raw = recorded(c);
    await c.enter("Jo");
    const kinds = raw.map((r) => (JSON.parse(r) as { type: string }).type);
    expect(kinds).toEqual(["welcome", "joined", "snapshot", "framesSnapshot", "shapesSnapshot", "reactionsSnapshot", "connectorsSnapshot", "groupsSnapshot"]);
    expect(c.groups).toEqual({ type: "groupsSnapshot", groups: [a, b] });
    await evictDurableObject(stub);
    const d = await TestClient.open(code);
    await d.enter("Kim");
    expect(d.groups?.groups).toEqual([a, b]);
    closeAll(alex, sam, c, d);
  });

  it("a mid-round join: groupsSnapshot, then silentMine", async () => {
    const { code, alex, sam, n1, n2 } = await groupRoom();
    const g = await createGroup(alex, [n1.id, n2.id], [sam]);
    alex.send({ type: "silentStart" });
    await nextOfType(sam, "silentChanged");
    const c = await TestClient.open(code);
    await c.enter("Jo", newKey());
    expect(c.groups?.groups).toEqual([g]);
    expect(await c.next()).toEqual({ type: "silentMine", ids: [] });
    closeAll(alex, sam, c);
  });

  it(`a full room's groupsSnapshot (${MAX_GROUPS_PER_ROOM} groups, every note and shape grouped, longest labels) is under 90% of its cap`, async () => {
    const { code, stub } = await newRoom();
    const c0 = await TestClient.open(code);
    await c0.enter("Setup");
    c0.close();
    await c0.waitClose();
    await runInDurableObject(stub, (_r, state) => {
      const sql = state.storage.sql;
      const items: string[] = [];
      for (let i = 0; i < MAX_NOTES_PER_ROOM; i++) {
        const id = `note${String(i).padStart(12, "0")}`;
        items.push(id);
        sql.exec("INSERT INTO notes (id, x, y, text, color, rev, author_id) VALUES (?, 0, 0, '', 'yellow', 1, 'AAAAAAAAAAAAAAAA')", id);
      }
      for (let i = 0; i < MAX_SHAPES_PER_ROOM; i++) {
        const id = `shap${String(i).padStart(12, "0")}`;
        items.push(id);
        sql.exec("INSERT INTO shapes (id, author_id) VALUES (?, 'AAAAAAAAAAAAAAAA')", id);
      }
      for (let g = 0; g < MAX_GROUPS_PER_ROOM; g++) {
        const id = `grp${String(g).padStart(13, "0")}`;
        // The longest label storage keeps: 40 four-byte characters (lone surrogates, 6 bytes each
        // escaped, are the shared test's worst case; SQLite keeps text as UTF-8, so none survive here).
        sql.exec("INSERT INTO groups (id, label, color, rev) VALUES (?, ?, 'neutral', ?)", id, "😀".repeat(MAX_GROUP_LABEL), Number.MAX_SAFE_INTEGER);
        items.forEach((item, i) => {
          if (i % MAX_GROUPS_PER_ROOM === g) sql.exec("INSERT INTO group_members (item_id, group_id) VALUES (?, ?)", item, id);
        });
      }
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    const raw = recorded(c);
    await c.enter("Jo");
    const snapshot = raw.find((r) => r.includes('"groupsSnapshot"'))!;
    expect(c.groups?.groups).toHaveLength(MAX_GROUPS_PER_ROOM);
    expect(c.groups!.groups.reduce((n, g) => n + g.members.length, 0)).toBe(MAX_NOTES_PER_ROOM + MAX_SHAPES_PER_ROOM);
    expect(utf8Length(snapshot)).toBeLessThan(GROUPS_SNAPSHOT_MAX_BYTES * 0.9);
    c.close();
  });
});

describe("rate", () => {
  it("group messages spend their own bucket: an empty one is rate_limited (naming what to roll back), and edits still go through", async () => {
    const { alex, sam, n1, n2, n3, stub } = await groupRoom();
    const g = await createGroup(alex, [n1.id, n2.id], [sam]);
    await fullBudgets(stub);
    // An hour ahead: no refill can happen during the test, however slow the runner.
    await patchAttachment(stub, "Sam", { groupTokens: 0, groupAt: Date.now() + 3_600_000 });
    const before = await rowsWritten(stub);
    expect(await sam.request(groupCreate([n3.id, n1.id]))).toMatchObject({ type: "error", code: "rate_limited", clientRef: "g1" });
    expect(await sam.request({ type: "groupUpdate", id: g.id, color: "pink" })).toMatchObject({ type: "error", code: "rate_limited", groupId: g.id });
    expect(await sam.request({ type: "groupMembers", id: g.id, add: [n3.id], remove: [] })).toMatchObject({ type: "error", code: "rate_limited", groupId: g.id });
    expect(await sam.request({ type: "groupDelete", id: g.id })).toMatchObject({ type: "error", code: "rate_limited", groupId: g.id });
    expect(await rowsWritten(stub)).toBe(before);
    expect((await attachmentOf(stub, "Sam"))?.tokens).toBeGreaterThanOrEqual(SOCKET_LIMITS.burst - 1);
    sam.send({ type: "noteEdit", id: n1.id, text: "Still editable" });
    expect((await nextOfType(alex, "noteUpdated")).note.text).toBe("Still editable");
    closeAll(alex, sam);
  });

  it("members spend a second budget: a message naming more ids than are left is rate_limited and spends nothing", async () => {
    const { alex, sam, n1, n2, n3, n4, stub } = await groupRoom();
    await patchAttachment(stub, "Sam", { groupMemberTokens: 3, groupMemberAt: Date.now() + 3_600_000 });
    expect(await answers(sam, groupCreate([n1.id, n2.id, n3.id, n4.id]))).toMatchObject([{ type: "error", code: "rate_limited", clientRef: "g1" }]);
    expect((await attachmentOf(stub, "Sam"))?.groupMemberTokens).toBe(3);
    const g = await createGroup(sam, [n1.id, n2.id], [alex]);
    expect((await attachmentOf(stub, "Sam"))?.groupMemberTokens).toBe(1);
    expect(await answers(sam, { type: "groupMembers", id: g.id, add: [n3.id], remove: [n1.id] })).toMatchObject([{ type: "error", code: "rate_limited", groupId: g.id }]);
    // A groupUpdate or a groupDelete names no members, so it spends none.
    expect(await sam.request({ type: "groupUpdate", id: g.id, color: "pink" })).toMatchObject({ type: "groupUpdated" });
    expect(await sam.request({ type: "groupDelete", id: g.id })).toEqual({ type: "groupDeleted", id: g.id });
    expect((await attachmentOf(stub, "Sam"))?.groupMemberTokens).toBe(1);
    closeAll(alex, sam);
  });

  it("a group message spends no SOCKET_LIMITS token", async () => {
    const { alex, sam, n1, n2, stub } = await groupRoom();
    await fullBudgets(stub);
    const g = await createGroup(sam, [n1.id, n2.id], [alex]);
    sam.send({ type: "groupUpdate", id: g.id, color: "pink" });
    await nextOfType(sam, "groupUpdated");
    const att = await attachmentOf(stub, "Sam");
    expect(att?.tokens).toBe(SOCKET_LIMITS.burst);
    expect(att?.groupTokens).toBeLessThan(GROUP_LIMITS.burst);
    closeAll(alex, sam);
  });

  it(`the burst covers ungrouping and re-adding every group at once (${GROUP_LIMITS.burst} messages, ${GROUP_LIMITS.membersBurst} members)`, () => {
    expect(GROUP_LIMITS.burst).toBeGreaterThanOrEqual(2 * MAX_GROUPS_PER_ROOM);
    expect(GROUP_LIMITS.membersBurst).toBeGreaterThanOrEqual(MAX_NOTES_PER_ROOM + MAX_SHAPES_PER_ROOM);
  });

  it(`a full bucket takes ${GROUP_LIMITS.burst} at once; past it, only what the refill allows in the time it took (explicit time budget)`, async () => {
    const { alex, sam, n1, n2, stub } = await groupRoom();
    const g = await createGroup(alex, [n1.id, n2.id], [sam]);
    await drain(alex, sam);
    await fullBudgets(stub);
    const extra = 5;
    const started = Date.now();
    const colors = ["pink", "green"] as const;
    for (let i = 0; i < GROUP_LIMITS.burst + extra; i++) sam.send({ type: "groupUpdate", id: g.id, color: colors[i % 2] });
    let accepted = 0;
    let limited = 0;
    while (accepted + limited < GROUP_LIMITS.burst + extra) {
      const m = await sam.next(10_000);
      if (m.type === "groupUpdated") accepted++;
      else if (m.type === "error" && m.code === "rate_limited") limited++;
    }
    const seconds = (Date.now() - started) / 1000;
    expect(accepted).toBeGreaterThanOrEqual(GROUP_LIMITS.burst);
    expect(accepted).toBeLessThanOrEqual(GROUP_LIMITS.burst + Math.ceil(seconds * GROUP_LIMITS.refillPerSecond) + 1);
    expect(accepted + limited).toBe(GROUP_LIMITS.burst + extra);
    closeAll(alex, sam);
  });
});

describe("costs (docs/LIMITS.md)", () => {
  it("rows: create 2 + 1 per member, update 1 (unchanged 0), members 1 per id changed + 1, delete 1 + 1 per member, a dissolve 1 + 1 per member left", async () => {
    const { alex, sam, n1, n2, n3, n4, s1, s2, stub } = await groupRoom();
    const cost = async (run: () => Promise<unknown>) => {
      const before = await rowsWritten(stub);
      await run();
      return (await rowsWritten(stub)) - before;
    };
    let g: Group | null = null;
    expect(await cost(async () => (g = await createGroup(alex, [n1.id, n2.id, n3.id], [sam])))).toBe(2 + 3);
    const id = g!.id;
    expect(await cost(async () => {
      alex.send({ type: "groupUpdate", id, label: "Renamed", color: "green" });
      await nextOfType(sam, "groupUpdated");
    })).toBe(1);
    expect(await cost(async () => expect(await answers(alex, { type: "groupUpdate", id, label: "Renamed" })).toEqual([]))).toBe(0);
    expect(await cost(async () => {
      alex.send({ type: "groupMembers", id, add: [n4.id, s1.id], remove: [n1.id] });
      await nextOfType(sam, "groupUpdated");
    })).toBe(3 + 1);
    // A move: n4's member row changes group, s2's is new; the group n4 left (4 -> 3) gets a rev; the new group's row 2.
    expect(await cost(async () => {
      await createGroup(alex, [n4.id, s2.id], [sam]);
      await nextOfType(sam, "groupUpdated");
    })).toBe(2 + 2 + 1);
    // groupDelete of a 3-member group: the row and its 3 members.
    expect(await cost(async () => {
      alex.send({ type: "groupDelete", id });
      await nextOfType(sam, "groupDeleted");
    })).toBe(1 + 3);
    closeAll(alex, sam);
  });

  it("a batch delete of N grouped notes: the plain delete, + 1 per grouped note, + 1 per group shrunk, + 1 + members left per group dissolved", async () => {
    const { alex, sam, n2, n3, n4, s1, s2, stub } = await groupRoom();
    // Baseline: the same batch with nobody grouped, measured on spare notes.
    const spare = [await addNote(alex, "A", { x: 3000, y: 100 }, [sam]), await addNote(alex, "B", { x: 3300, y: 100 }, [sam])];
    await drain(alex, sam);
    let before = await rowsWritten(stub);
    alex.send({ type: "noteBatch", ops: spare.map((n) => ({ op: "delete", id: n.id })), final: true });
    await nextOfType(sam, "notesBatchApplied");
    const plain = (await rowsWritten(stub)) - before;
    // n2 goes: this one shrinks to n3 and s2. n4 goes: this one is dissolved, s1 left alone.
    await createGroup(alex, [n2.id, n3.id, s2.id], [sam]);
    await createGroup(alex, [n4.id, s1.id], [sam]);
    await drain(alex, sam);
    before = await rowsWritten(stub);
    alex.send({ type: "noteBatch", ops: [n2, n4].map((n) => ({ op: "delete", id: n.id })), final: true });
    await nextOfType(sam, "notesBatchApplied");
    await drain(alex, sam);
    // 2 grouped notes' member rows, 1 shrunk group's rev, 1 dissolved group's row and its 1 member left.
    expect((await rowsWritten(stub)) - before).toBe(plain + 2 + 1 + (1 + 1));
    closeAll(alex, sam);
  });
});

/* ── Stored schema 13 ── */

const version = (sql: SqlStorage) => sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value;
const tableRows = (sql: SqlStorage, table: string) => sql.exec<Row>(`SELECT * FROM ${table} ORDER BY rowid`).toArray();

describe(`schema migration 12 -> ${SCHEMA_VERSION}`, () => {
  it("adds the groups and group_members tables (every column but the keys with a DEFAULT); every existing table untouched", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV12(sql);
      const before = Object.fromEntries(["notes", "frames", "votes", "shapes", "reactions", "connectors"].map((t) => [t, tableRows(sql, t)]));
      const metaBefore = tableRows(sql, "meta").filter((r) => r.key !== "schema_version");
      const store = new NoteStore(sql);
      expect(version(sql)).toBe(13);
      for (const [t, rows] of Object.entries(before)) expect(tableRows(sql, t), t).toEqual(rows);
      expect(tableRows(sql, "meta").filter((r) => r.key !== "schema_version")).toEqual(metaBefore);
      const columns = (t: string) =>
        sql.exec<{ name: string; dflt_value: string | null; notnull: number; pk: number }>(`SELECT name, dflt_value, "notnull", pk FROM pragma_table_info('${t}')`).toArray().map((c) => [c.name, c.dflt_value, c.notnull, c.pk]);
      expect(columns("groups")).toEqual([
        ["id", null, 0, 1],
        ["label", "''", 1, 0],
        ["color", "'neutral'", 1, 0],
        ["rev", "1", 1, 0],
      ]);
      expect(columns("group_members")).toEqual([
        ["item_id", null, 1, 1],
        ["group_id", "''", 1, 0],
      ]);
      // Old rows load unchanged.
      expect(store.all().map((n) => n.id)).toEqual([...V5_NOTES.map((n) => n.id), V10_SEALED.id]);
      expect(store.writerOf(V10_SEALED.id)).toBe(V10_SEALED.writer);
      expect(store.allFrames().map((f) => f.id)).toEqual(V6_FRAMES.map((f) => f.id));
      expect(store.allShapes().map((s) => s.id)).toEqual([V12_SHAPE_ID]);
      expect(store.allConnectors().map((k) => k.id)).toEqual([...V12_CONNECTOR_IDS]);
      expect(store.allGroups()).toEqual([]);
      // Runs once: a second load writes nothing.
      expect(new NoteStore(sql).rowsWritten).toBe(0);
    });
  });

  it("is idempotent if it was interrupted after making the tables", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV12(sql);
      sql.exec("CREATE TABLE groups (id TEXT PRIMARY KEY)");
      new NoteStore(sql);
      expect(version(sql)).toBe(SCHEMA_VERSION);
    });
  });

  it("on a populated room: groups beside the old data; v0.36.0's statements still work, and a group left below 2 by its deletes is dropped on load", async () => {
    const { code, stub } = await newRoom();
    const [first, second, third] = [V5_NOTES[0].id, V5_NOTES[1].id, V5_NOTES[2].id];
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV12(sql);
      // The round in the fixture is over (a reveal), so groups can be made.
      sql.exec("UPDATE notes SET sealed = 0, writer = NULL");
      sql.exec("UPDATE meta SET value = 0 WHERE key = 'silent_active'");
      const store = new NoteStore(sql);
      store.changeGroups([{ id: "grp0000000000001", label: HOSTILE, color: "neutral", members: sorted([first, V12_SHAPE_ID]), rev: 1 }], [], []);
      store.changeGroups([{ id: "grp0000000000002", label: "", color: "pink", members: sorted([second, third, V10_SEALED.id]), rev: 1 }], [], []);
      // Then v0.36.0 code (after a rollback) adds a note, deletes one and deletes the shape: it knows nothing of groups.
      sql.exec(V12_NOTE_INSERT, "fromV21code00001", 0, 0, 160, 160, HOSTILE, "green", "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", 9, 1, "AAAAAAAAAAAAAAAA", 0, null);
      for (const statement of V12_NOTE_DELETE) sql.exec(statement, third);
      sql.exec(V12_SHAPE_DELETE, V12_SHAPE_ID);
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Sam");
    expect(c.snapshot?.notes.map((n) => n.id)).toContain("fromV21code00001");
    // Group 1 lost the shape (one member left): dropped. Group 2 lost `third` and keeps two.
    expect(c.groups?.groups).toEqual([{ id: "grp0000000000002", label: "", color: "pink", members: sorted([second, V10_SEALED.id]), rev: 1 }]);
    // Dropped in memory only: loading wrote nothing, and `first` can join a new group.
    const g = await createGroup(c, [first, "fromV21code00001"]);
    expect(g.members).toEqual(sorted([first, "fromV21code00001"]));
    c.close();
  });

  it("bad stored rows are skipped, never fatal: a colour that isn't a key, an unclean or long label, members that are frames or missing, a member of a missing group", async () => {
    const { code, stub } = await newRoom();
    const c = await TestClient.open(code);
    await c.enter("Sam");
    const notes = [await addNote(c, HOSTILE, { x: 300, y: 300 }), await addNote(c, "Two", { x: 600, y: 300 }), await addNote(c, "Three", { x: 900, y: 300 })];
    const frame = (await c.request({ type: "frameAdd", clientRef: "f1", x: 3000, y: 2000, color: "neutral", title: "" })) as Extract<ServerMessage, { type: "frameAdded" }>;
    c.close();
    await c.waitClose();
    await runInDurableObject(stub, (_r, state) => {
      const sql = state.storage.sql;
      const pairs: [string, string, string][] = [
        ["bad0000000000001", "", HOSTILE],
        ["bad0000000000002", " untrimmed ", "neutral"],
        ["bad0000000000003", "x".repeat(MAX_GROUP_LABEL + 1), "neutral"],
        ["bad0000000000004", "", "neutral"],
        ["ok00000000000005", HOSTILE, "blue"],
      ];
      for (const [id, label, color] of pairs) sql.exec("INSERT INTO groups (id, label, color, rev) VALUES (?, ?, ?, 1)", id, label, color);
      // Groups 1 to 3 have two good members each, but fail on their own row. Group 4's members are a frame and a missing item.
      sql.exec("INSERT INTO group_members (item_id, group_id) VALUES (?, 'bad0000000000001')", notes[0]!.id);
      sql.exec("INSERT INTO group_members (item_id, group_id) VALUES (?, 'bad0000000000002')", notes[1]!.id);
      sql.exec("INSERT INTO group_members (item_id, group_id) VALUES (?, 'bad0000000000004')", frame.frame.id);
      sql.exec("INSERT INTO group_members (item_id, group_id) VALUES ('missing000000001', 'bad0000000000004')");
      sql.exec("INSERT INTO group_members (item_id, group_id) VALUES (?, 'ok00000000000005')", notes[2]!.id);
      sql.exec("INSERT INTO group_members (item_id, group_id) VALUES ('missing000000002', 'nogroup000000001')");
      // Group 5 gets a second good member: a shape.
      sql.exec("INSERT INTO shapes (id, author_id) VALUES ('shape00000000001', 'AAAAAAAAAAAAAAAA')");
      sql.exec("INSERT INTO group_members (item_id, group_id) VALUES ('shape00000000001', 'ok00000000000005')");
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const d = await TestClient.open(code);
    await d.enter("Alex");
    expect(d.groups?.groups).toEqual([{ id: "ok00000000000005", label: HOSTILE, color: "blue", members: sorted([notes[2]!.id, "shape00000000001"]), rev: 1 }]);
    d.close();
  });
});
