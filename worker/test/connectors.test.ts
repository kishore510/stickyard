/// <reference types="vite/client" />
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_DEFAULTS,
  CONNECTORS_SNAPSHOT_MAX_BYTES,
  MAX_CONNECTORS_PER_ROOM,
  PROTOCOL_VERSION,
  anchorPoint,
  clampConnectorPoint,
  utf8Length,
  type Box,
  type Connector,
  type ConnectorAnchor,
  type ConnectorEnd,
  type Note,
  type ServerMessage,
  type Shape,
} from "@stickyard/shared";
import type { Room } from "../src/room";
import { NoteStore, SCHEMA_VERSION } from "../src/noteStore";
import { CONNECTOR_LIMITS, SOCKET_LIMITS } from "../src/limits";
import { V5_NOTES } from "./fixtures/schemaV5";
import { V6_FRAMES } from "./fixtures/schemaV6";
import { V10_SEALED } from "./fixtures/schemaV10";
import { V11_NOTE_DELETE, V11_NOTE_INSERT, V11_REACTIONS, V11_SHAPE_DELETE, V11_SHAPE_ID, loadSchemaV11 } from "./fixtures/schemaV11";
import { TEST_SIGNING_KEY, TestClient, fullMessageBudget, nextOfType, specHostToken, specRoomCode, migratedRows } from "./helpers";

/*
 * Connectors (arrows), protocol v21 and stored schema 12, part 1 of 2: relay and shared, no UI.
 * A connector joins two endpoints, each a free board point or bound to a note or shape by an
 * anchor (a bound end stores no coordinates: pages work it out from the item's box). These tests
 * drive the real Durable Object over WebSockets. Fake keys only (vitest.config.ts); generic names
 * and text, and a hostile string wherever room text is involved.
 */

vi.setConfig({ testTimeout: 30_000 });

const HOSTILE = "<img src=x onerror=alert(1)>";
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const newKey = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
const unknownId = () => b64url(crypto.getRandomValues(new Uint8Array(12)));

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
type Added = Extract<ServerMessage, { type: "connectorAdded" }>;
const rowsWritten = (stub: Stub) => runInDurableObject(stub, (r: Room) => r.rowsWritten);
const allRows = (stub: Stub) =>
  runInDurableObject(stub, (_r, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
      .toArray()
      .map((t) => t.name);
    const rows: Record<string, Row[]> = {};
    // group_members (schema 13) is WITHOUT ROWID.
    for (const t of tables) rows[t] = state.storage.sql.exec<Row>(`SELECT * FROM ${t}${t === "group_members" ? "" : " ORDER BY rowid"}`).toArray();
    return rows;
  });
const connectorRows = async (stub: Stub) => (await allRows(stub)).connectors ?? [];
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

/** Every socket's connector bucket full (CONNECTOR_LIMITS) with its refill clock at now, and the message bucket too. */
async function fullBudgets(stub: Stub): Promise<void> {
  await fullMessageBudget(stub);
  await runInDurableObject(stub, (_r: unknown, state: DurableObjectState) => {
    for (const ws of state.getWebSockets()) {
      const att = ws.deserializeAttachment() as Record<string, unknown> | null;
      if (att) ws.serializeAttachment({ ...att, connectorTokens: CONNECTOR_LIMITS.burst, connectorAt: Date.now() });
    }
  });
}

/** One socket's attachment, by participant name. */
const attachmentOf = (stub: Stub, name: string) =>
  runInDurableObject(stub, (_r: unknown, state: DurableObjectState) =>
    state.getWebSockets().map((ws) => ws.deserializeAttachment() as { participant?: { name?: string } | null; tokens: number; connectorTokens: number }).find((a) => a.participant?.name === name),
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

const connectorAdd = (start: unknown, end: unknown, extra: Record<string, unknown> = {}) => ({ type: "connectorAdd", clientRef: "k1", start, end, ...CONNECTOR_DEFAULTS, ...extra });
const free = (x: number, y: number) => ({ x, y });
const bound = (item: string, anchor: ConnectorAnchor = "auto") => ({ item, anchor });

async function addConnector(c: TestClient, start: unknown, end: unknown, others: TestClient[] = [], extra: Record<string, unknown> = {}): Promise<Connector> {
  c.send(connectorAdd(start, end, extra));
  let added = await nextOfType(c, "connectorAdded");
  while (added.clientRef !== "k1") added = await nextOfType(c, "connectorAdded");
  for (const o of others) expect(await nextOfType(o, "connectorAdded")).toEqual({ type: "connectorAdded", connector: added.connector });
  return added.connector;
}

const boxOf = (item: { x: number; y: number; w: number; h: number }): Box => ({ x: item.x, y: item.y, w: item.w, h: item.h });
const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
/** Where a detached end lands: anchorPoint on the item's last box, rounded and clamped like any free point. */
const landing = (b: Box, anchor: ConnectorAnchor, other: { x: number; y: number }) => {
  const p = anchorPoint(b, anchor, other);
  return clampConnectorPoint(p.x, p.y);
};

/**
 * A room with a host (Alex, claimed) and a guest (Sam); two notes (n1 at 100,100 and n2 at
 * 1000,100, both 160 x 160), a rectangle (sh at 100,1000, 200 x 120) and a frame, all by Alex.
 */
async function connectorRoom() {
  const room = await newRoom();
  const alex = await TestClient.open(room.code);
  const sam = await TestClient.open(room.code);
  await alex.enter("Alex");
  await sam.enter("Sam");
  await drain(alex, sam);
  expect(await alex.request({ type: "claimHost", token: room.token })).toEqual({ type: "hostGranted" });
  await drain(alex, sam);
  const n1 = await addNote(alex, HOSTILE, { x: 100, y: 100 }, [sam]);
  const n2 = await addNote(alex, "Second", { x: 1000, y: 100 }, [sam]);
  const sh = await addShape(alex, { x: 100, y: 1000 }, [sam]);
  const frame = (await alex.request({ type: "frameAdd", clientRef: "f1", x: 3000, y: 2000, color: "neutral", title: HOSTILE })) as Extract<ServerMessage, { type: "frameAdded" }>;
  await drain(alex, sam);
  await fullBudgets(room.stub);
  return { ...room, alex, sam, n1, n2, sh, frame: frame.frame };
}

describe("versions", () => {
  it("protocol 21 or later and stored schema 12 or later; a v20 page is asked to reload", async () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(21);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request({ type: "hello", protocolVersion: 20 })).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Sam" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });
});

describe("connectorAdd", () => {
  it("the server assigns id, rev 1 and author; the sender's copy has its clientRef, everyone else's none", async () => {
    const { alex, sam, n1 } = await connectorRoom();
    const k = await addConnector(sam, bound(n1.id, "right"), free(900, 500), [alex], { dash: "dotted", ink: "purple", endHead: "none" });
    expect(k.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(k.authorId).not.toBe(n1.authorId);
    expect(k).toEqual({ id: k.id, start: { item: n1.id, anchor: "right" }, end: { x: 900, y: 500 }, ...CONNECTOR_DEFAULTS, dash: "dotted", ink: "purple", endHead: "none", rev: 1, authorId: k.authorId });
    closeAll(alex, sam);
  });

  it("free points are rounded and clamped onto the board", async () => {
    const { alex, sam } = await connectorRoom();
    const k = await addConnector(sam, free(-40, 10.6), free(6450.2, 4063), [alex]);
    expect(k.start).toEqual({ x: 0, y: 11 });
    expect(k.end).toEqual({ x: 6400, y: 4000 });
    closeAll(alex, sam);
  });

  it("binds to notes and shapes; a bound end is stored without coordinates", async () => {
    const { alex, sam, n1, sh, stub } = await connectorRoom();
    const k = await addConnector(alex, bound(n1.id, "bottom"), bound(sh.id, "top"), [sam]);
    const [row] = await connectorRows(stub);
    expect(row).toMatchObject({ id: k.id, start_item: n1.id, start_anchor: "bottom", start_x: null, start_y: null, end_item: sh.id, end_anchor: "top", end_x: null, end_y: null });
    closeAll(alex, sam);
  });

  it("refused: a zero-length arrow (also after clamping), both ends on the same item; nothing written or relayed", async () => {
    const { alex, sam, n1, stub } = await connectorRoom();
    const before = await rowsWritten(stub);
    for (const [start, end] of [
      [free(500, 500), free(500, 500)],
      [free(-10, -10), free(-30, -20)],
      [free(10.2, 10.4), free(9.8, 9.6)],
      [bound(n1.id, "top"), bound(n1.id, "bottom")],
      [bound(n1.id, "auto"), bound(n1.id, "auto")],
      // The free end exactly where the bound end resolves: the note's top middle.
      [bound(n1.id, "top"), free(180, 100)],
    ] as const) {
      expect(await sam.request(connectorAdd(start, end))).toMatchObject({ type: "error", code: "bad_message", clientRef: "k1" });
    }
    expect(await rowsWritten(stub)).toBe(before);
    expect(await alex.quiet()).toBe(true);
    closeAll(alex, sam);
  });

  it("refused with unknown_item: an unknown id, a deleted note or shape, a frame, a connector; nothing written", async () => {
    const { alex, sam, n2, sh, frame, stub } = await connectorRoom();
    const k = await addConnector(alex, free(10, 10), free(20, 20), [sam]);
    alex.send({ type: "noteDelete", id: n2.id });
    await nextOfType(sam, "noteDeleted");
    alex.send({ type: "shapeDelete", id: sh.id });
    await nextOfType(sam, "shapeDeleted");
    await drain(alex, sam);
    const before = await rowsWritten(stub);
    for (const id of [unknownId(), n2.id, sh.id, frame.id, k.id]) {
      expect(await sam.request(connectorAdd(bound(id), free(3000, 3000)))).toMatchObject({ type: "error", code: "unknown_item", clientRef: "k1" });
      expect(await sam.request(connectorAdd(free(3000, 3000), bound(id, "left")))).toMatchObject({ type: "error", code: "unknown_item", clientRef: "k1" });
    }
    expect(await rowsWritten(stub)).toBe(before);
    expect(await alex.quiet()).toBe(true);
    closeAll(alex, sam);
  });

  it("bad input gets an error reply, never a throw: hostile strings, raw CSS, extra fields, oversize", async () => {
    const { alex, sam, n1 } = await connectorRoom();
    for (const bad of [
      connectorAdd(bound(HOSTILE), free(1, 1)),
      connectorAdd(free(1, 1), free(2, 2), { ink: "#ff0000" }),
      connectorAdd(free(1, 1), free(2, 2), { ink: HOSTILE }),
      connectorAdd(free(1, 1), free(2, 2), { clientRef: HOSTILE }),
      connectorAdd(free(1, 1), free(2, 2), { id: n1.id }),
      connectorAdd(free(1, 1), free(2, 2), { text: HOSTILE }),
      connectorAdd({ x: 1, y: 2, item: n1.id, anchor: "auto" }, free(2, 2)),
      { type: "connectorUpdate", id: unknownId() },
      { type: "connectorDelete", id: HOSTILE },
    ]) {
      expect(await sam.request(bad)).toMatchObject({ type: "error", code: "bad_message" });
    }
    expect(await sam.request(JSON.stringify(connectorAdd(free(1, 1), free(2, 2), { pad: "x".repeat(5000) })))).toMatchObject({ type: "error", code: "too_large" });
    // Still connected and working.
    await addConnector(sam, free(1, 1), free(2, 2), [alex]);
    closeAll(alex, sam);
  });

  it(`a room holds at most ${MAX_CONNECTORS_PER_ROOM} (connectors_full, with the clientRef); update and delete still work, and a delete frees one`, async () => {
    const { code, stub } = await newRoom();
    const c = await TestClient.open(code);
    await c.enter("Sam");
    c.close();
    await c.waitClose();
    await runInDurableObject(stub, (_r, state) => {
      for (let i = 0; i < MAX_CONNECTORS_PER_ROOM; i++) {
        state.storage.sql.exec("INSERT INTO connectors (id, start_x, start_y, end_x, end_y, author_id) VALUES (?, ?, ?, ?, ?, ?)", `full${String(i).padStart(12, "0")}`, i, 10, i, 20, "AAAAAAAAAAAAAAAA");
      }
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const d = await TestClient.open(code);
    await d.enter("Sam");
    expect(d.connectors?.connectors).toHaveLength(MAX_CONNECTORS_PER_ROOM);
    const before = await rowsWritten(stub);
    expect(await d.request(connectorAdd(free(1, 1), free(2, 2)))).toMatchObject({ type: "error", code: "connectors_full", clientRef: "k1" });
    expect(await rowsWritten(stub)).toBe(before);
    const first = d.connectors!.connectors[0]!;
    expect(await d.request({ type: "connectorUpdate", id: first.id, dash: "dashed" })).toMatchObject({ type: "connectorUpdated", connector: { id: first.id, dash: "dashed", rev: 2 } });
    expect(await d.request({ type: "connectorDelete", id: first.id })).toEqual({ type: "connectorDeleted", id: first.id });
    await addConnector(d, free(1, 1), free(2, 2));
    d.close();
  });
});

describe("connectorUpdate", () => {
  it("any endpoint or style field, last write wins in arrival order, one rev per stored change, to everyone", async () => {
    const { alex, sam, n1, sh } = await connectorRoom();
    const k = await addConnector(alex, free(10, 10), free(500, 500), [sam]);
    sam.send({ type: "connectorUpdate", id: k.id, route: "elbow", width: "thick" });
    const u1 = await nextOfType(alex, "connectorUpdated");
    expect(u1.connector).toEqual({ ...k, route: "elbow", width: "thick", rev: 2 });
    expect((await nextOfType(sam, "connectorUpdated")).connector).toEqual(u1.connector);
    alex.send({ type: "connectorUpdate", id: k.id, start: bound(n1.id, "left") });
    expect((await nextOfType(sam, "connectorUpdated")).connector).toMatchObject({ start: { item: n1.id, anchor: "left" }, rev: 3 });
    sam.send({ type: "connectorUpdate", id: k.id, start: bound(sh.id), startHead: "arrow" });
    expect((await nextOfType(alex, "connectorUpdated")).connector).toMatchObject({ start: { item: n1.id, anchor: "left" }, rev: 3 });
    expect((await nextOfType(alex, "connectorUpdated")).connector).toMatchObject({ start: { item: sh.id, anchor: "auto" }, startHead: "arrow", rev: 4 });
    await drain(sam);
    // A free end again, clamped.
    alex.send({ type: "connectorUpdate", id: k.id, start: free(6460, -5) });
    expect((await nextOfType(sam, "connectorUpdated")).connector).toMatchObject({ start: { x: 6400, y: 0 }, rev: 5 });
    closeAll(alex, sam);
  });

  it("an unchanged update writes and sends nothing; an unknown or deleted connector is ignored silently", async () => {
    const { alex, sam, n1, stub } = await connectorRoom();
    const k = await addConnector(alex, bound(n1.id, "top"), free(500, 500), [sam]);
    await drain(alex, sam);
    const before = await rowsWritten(stub);
    alex.send({ type: "connectorUpdate", id: k.id, start: bound(n1.id, "top"), end: free(500.2, 499.8), ...CONNECTOR_DEFAULTS });
    alex.send({ type: "connectorUpdate", id: unknownId(), dash: "dashed" });
    expect(await alex.quiet(200)).toBe(true);
    expect(await sam.quiet()).toBe(true);
    alex.send({ type: "connectorDelete", id: k.id });
    await nextOfType(sam, "connectorDeleted");
    alex.send({ type: "connectorUpdate", id: k.id, dash: "dashed" });
    expect(await sam.quiet(200)).toBe(true);
    // Only the delete wrote (1 row, as a shape delete).
    expect((await rowsWritten(stub)) - before).toBe(1);
    closeAll(alex, sam);
  });

  it("refused (naming the connector): zero length, both ends on one item, an unknown or deleted bind; nothing written", async () => {
    const { alex, sam, n1, n2, stub } = await connectorRoom();
    const k = await addConnector(alex, bound(n1.id), free(500, 500), [sam]);
    alex.send({ type: "noteDelete", id: n2.id });
    await nextOfType(sam, "noteDeleted");
    await drain(alex, sam);
    const before = await rowsWritten(stub);
    expect(await sam.request({ type: "connectorUpdate", id: k.id, start: free(500, 500) })).toMatchObject({ type: "error", code: "bad_message", connectorId: k.id });
    expect(await sam.request({ type: "connectorUpdate", id: k.id, end: bound(n1.id, "left") })).toMatchObject({ type: "error", code: "bad_message", connectorId: k.id });
    expect(await sam.request({ type: "connectorUpdate", id: k.id, end: bound(n2.id) })).toMatchObject({ type: "error", code: "unknown_item", connectorId: k.id });
    expect(await sam.request({ type: "connectorUpdate", id: k.id, end: bound(unknownId()), dash: "dashed" })).toMatchObject({ type: "error", code: "unknown_item", connectorId: k.id });
    expect(await rowsWritten(stub)).toBe(before);
    expect(await alex.quiet()).toBe(true);
    // A style change alone never re-checks the geometry.
    expect(await sam.request({ type: "connectorUpdate", id: k.id, dash: "dashed" })).toMatchObject({ type: "connectorUpdated" });
    closeAll(alex, sam);
  });
});

describe("connectorDelete", () => {
  it("to everyone; the row goes; an unknown id is ignored silently", async () => {
    const { alex, sam, stub } = await connectorRoom();
    const k = await addConnector(alex, free(10, 10), free(500, 500), [sam]);
    sam.send({ type: "connectorDelete", id: k.id });
    expect(await nextOfType(alex, "connectorDeleted")).toEqual({ type: "connectorDeleted", id: k.id });
    expect(await nextOfType(sam, "connectorDeleted")).toEqual({ type: "connectorDeleted", id: k.id });
    expect(await connectorRows(stub)).toEqual([]);
    sam.send({ type: "connectorDelete", id: k.id });
    sam.send({ type: "connectorDelete", id: unknownId() });
    expect(await alex.quiet(200)).toBe(true);
    expect(await sam.quiet()).toBe(true);
    closeAll(alex, sam);
  });
});

describe("gating", () => {
  it("a locked board refuses a guest's add, update and delete (board_locked, naming what to roll back); the host's go through", async () => {
    const { alex, sam, stub } = await connectorRoom();
    const k = await addConnector(alex, free(10, 10), free(500, 500), [sam]);
    alex.send({ type: "lockSet", locked: true });
    await nextOfType(sam, "lockChanged");
    await drain(alex, sam);
    const before = await rowsWritten(stub);
    expect(await sam.request(connectorAdd(free(1, 1), free(2, 2)))).toMatchObject({ type: "error", code: "board_locked", clientRef: "k1" });
    expect(await sam.request({ type: "connectorUpdate", id: k.id, dash: "dashed" })).toMatchObject({ type: "error", code: "board_locked", connectorId: k.id });
    expect(await sam.request({ type: "connectorDelete", id: k.id })).toMatchObject({ type: "error", code: "board_locked", connectorId: k.id });
    expect(await rowsWritten(stub)).toBe(before);
    expect(await alex.quiet()).toBe(true);
    alex.send({ type: "connectorUpdate", id: k.id, dash: "dashed" });
    expect((await nextOfType(sam, "connectorUpdated")).connector.dash).toBe("dashed");
    await addConnector(alex, free(1, 1), free(2, 2), [sam]);
    closeAll(alex, sam);
  });

  it("a silent round refuses all three for everyone, host included (silent_active, naming what to roll back); nothing written or relayed", async () => {
    const { alex, sam, stub } = await connectorRoom();
    const k = await addConnector(alex, free(10, 10), free(500, 500), [sam]);
    expect(await alex.request({ type: "silentStart" })).toMatchObject({ type: "silentChanged", active: true });
    await nextOfType(sam, "silentChanged");
    const before = await rowsWritten(stub);
    for (const c of [alex, sam]) {
      expect(await c.request(connectorAdd(free(1, 1), free(2, 2)))).toMatchObject({ type: "error", code: "silent_active", clientRef: "k1" });
      expect(await c.request({ type: "connectorUpdate", id: k.id, dash: "dashed" })).toMatchObject({ type: "error", code: "silent_active", connectorId: k.id });
      expect(await c.request({ type: "connectorDelete", id: k.id })).toMatchObject({ type: "error", code: "silent_active", connectorId: k.id });
    }
    expect(await rowsWritten(stub)).toBe(before);
    expect(await alex.quiet()).toBe(true);
    expect(await sam.quiet()).toBe(true);
    // After the reveal they work again.
    alex.send({ type: "silentReveal" });
    await nextOfType(sam, "silentChanged");
    await drain(alex, sam);
    expect(await sam.request({ type: "connectorDelete", id: k.id })).toEqual({ type: "connectorDeleted", id: k.id });
    closeAll(alex, sam);
  });

  it("needs a join (not_joined, naming what it was about)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    await c.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    expect(await c.request(connectorAdd(free(1, 1), free(2, 2)))).toMatchObject({ type: "error", code: "not_joined", clientRef: "k1" });
    const id = unknownId();
    expect(await c.request({ type: "connectorDelete", id })).toMatchObject({ type: "error", code: "not_joined", connectorId: id });
    c.close();
  });
});

describe("sealed notes", () => {
  it("during a round, a bind to someone's sealed note gets exactly the reply a random id gets (silent_active), its writer's too", async () => {
    const room = await newRoom();
    const keys = { host: newKey(), a: newKey() };
    const host = await TestClient.open(room.code);
    const a = await TestClient.open(room.code);
    await host.enter("Hana", keys.host);
    await a.enter("Ari", keys.a);
    await drain(host, a);
    expect(await host.request({ type: "claimHost", token: room.token })).toEqual({ type: "hostGranted" });
    const visible = await addNote(host, "Visible", { x: 2000, y: 2000 }, [a]);
    await drain(host, a);
    expect(await host.request({ type: "silentStart" })).toMatchObject({ type: "silentChanged", active: true });
    await drain(host, a);
    a.send({ type: "noteAdd", clientRef: "n9", x: 300, y: 300, color: "pink", text: "CANARY sealed" });
    const sealed = (await nextOfType(a, "noteAdded")).note;
    await drain(host, a);
    const random = unknownId();
    for (const c of [a, host]) {
      for (const shape of [(id: string) => connectorAdd(bound(id), bound(visible.id)), (id: string) => connectorAdd(free(5, 5), bound(id, "top"))]) {
        const toSealed = await answers(c, shape(sealed.id));
        const toRandom = await answers(c, shape(random));
        expect(toSealed).toEqual(toRandom);
        expect(toSealed).toMatchObject([{ type: "error", code: "silent_active", clientRef: "k1" }]);
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
    expect(a.snapshot?.notes.map((n) => n.id)).toEqual([note.id, visible.id]);
    expect(other.snapshot?.notes.map((n) => n.id)).toEqual([visible.id]);
    await drain(a, other);
    const random = unknownId();
    for (const client of [a, other]) {
      const toSealed = await answers(client, connectorAdd(bound(note.id), bound(visible.id)));
      const toRandom = await answers(client, connectorAdd(bound(random), bound(visible.id)));
      expect(toSealed).toEqual(toRandom);
      expect(toSealed).toMatchObject([{ type: "error", code: "unknown_item", clientRef: "k1" }]);
    }
    closeAll(a, other);
  });
});

describe("join", () => {
  it("connectorsSnapshot comes right after reactionsSnapshot on every join (creation order), and survives a wake", async () => {
    const { code, alex, sam, n1, stub } = await connectorRoom();
    const k1 = await addConnector(alex, bound(n1.id), free(900, 900), [sam]);
    const k2 = await addConnector(sam, free(10, 10), free(30, 30), [alex]);
    const c = await TestClient.open(code);
    const raw = recorded(c);
    await c.enter("Jo");
    const kinds = raw.map((r) => (JSON.parse(r) as { type: string }).type);
    // Protocol v22: groupsSnapshot follows.
    expect(kinds).toEqual(["welcome", "joined", "snapshot", "framesSnapshot", "shapesSnapshot", "reactionsSnapshot", "connectorsSnapshot", "groupsSnapshot"]);
    expect(c.connectors).toEqual({ type: "connectorsSnapshot", connectors: [k1, k2] });
    await evictDurableObject(stub);
    const d = await TestClient.open(code);
    await d.enter("Kim");
    expect(d.connectors?.connectors).toEqual([k1, k2]);
    closeAll(alex, sam, c, d);
  });

  it("a mid-round join: connectorsSnapshot, then silentMine", async () => {
    const { code, alex, sam } = await connectorRoom();
    const k = await addConnector(alex, free(10, 10), free(40, 40), [sam]);
    alex.send({ type: "silentStart" });
    await nextOfType(sam, "silentChanged");
    const c = await TestClient.open(code);
    await c.enter("Jo", newKey());
    expect(c.connectors?.connectors).toEqual([k]);
    expect(await c.next()).toEqual({ type: "silentMine", ids: [] });
    closeAll(alex, sam, c);
  });

  it(`a full room's connectorsSnapshot (${MAX_CONNECTORS_PER_ROOM} connectors, both ends bound) is under 90% of its cap`, async () => {
    const { code, alex, sam, n1, n2, stub } = await connectorRoom();
    closeAll(alex, sam);
    await runInDurableObject(stub, (_r, state) => {
      for (let i = 0; i < MAX_CONNECTORS_PER_ROOM; i++) {
        state.storage.sql.exec(
          "INSERT INTO connectors (id, start_item, start_anchor, end_item, end_anchor, route, dash, width, ink, start_head, end_head, rev, author_id) VALUES (?, ?, 'bottom', ?, 'bottom', 'straight', 'dashed', 'medium', 'neutral', 'arrow', 'arrow', ?, ?)",
          `full${String(i).padStart(12, "0")}`,
          n1.id,
          n2.id,
          Number.MAX_SAFE_INTEGER,
          n1.authorId,
        );
      }
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    const raw = recorded(c);
    await c.enter("Jo");
    const snapshot = raw.find((r) => r.includes('"connectorsSnapshot"'))!;
    expect(c.connectors?.connectors).toHaveLength(MAX_CONNECTORS_PER_ROOM);
    expect(utf8Length(snapshot)).toBeLessThan(CONNECTORS_SNAPSHOT_MAX_BYTES * 0.9);
    c.close();
  });
});

/* ── The delete rule: a bound end becomes free at its last anchor point, in the same transaction ── */

/**
 * Three connectors in a connector room: k1 from n1 (auto) to a free point, k2 from n1 (bottom) to
 * the shape (auto), k3 free to free. Returns them with the boxes they hang on.
 */
async function detachRoom() {
  const room = await connectorRoom();
  const { alex, sam, n1, sh } = room;
  const k1 = await addConnector(alex, bound(n1.id), free(1000, 180), [sam]);
  const k2 = await addConnector(alex, bound(n1.id, "bottom"), bound(sh.id), [sam]);
  const k3 = await addConnector(sam, free(3000, 3000), free(3100, 3100), [alex]);
  await drain(alex, sam);
  return { ...room, k1, k2, k3 };
}

/** Reads `count` messages and checks the item delete comes first, then connectorUpdated (in creation order). */
async function deleteThenDetached(c: TestClient, deleteType: string, count: number): Promise<Connector[]> {
  const first = await c.next();
  expect(first.type).toBe(deleteType);
  const updates: Connector[] = [];
  for (let i = 0; i < count; i++) {
    const m = await c.next();
    expect(m.type).toBe("connectorUpdated");
    if (m.type === "connectorUpdated") updates.push(m.connector);
  }
  expect(await c.quiet()).toBe(true);
  return updates;
}

describe("the delete rule", () => {
  it("noteDelete: each end bound to the note turns free where anchorPoint says, rev + 1, after noteDeleted; others untouched", async () => {
    const { alex, sam, n1, sh, k1, k2, k3, stub } = await detachRoom();
    alex.send({ type: "noteDelete", id: n1.id });
    const forSam = await deleteThenDetached(sam, "noteDeleted", 2);
    const forAlex = await deleteThenDetached(alex, "noteDeleted", 2);
    expect(forAlex).toEqual(forSam);
    // k1: auto towards its free end (1000, 180): the note's right middle. Pinned by hand too.
    expect(forSam[0]).toEqual({ ...k1, start: { x: 260, y: 180 }, rev: 2 });
    expect(forSam[0]!.start).toEqual(landing(boxOf(n1), "auto", { x: 1000, y: 180 }));
    // k2: the note's bottom middle; its other end stays bound to the shape.
    expect(forSam[1]).toEqual({ ...k2, start: landing(boxOf(n1), "bottom", centre(boxOf(sh))), rev: 2 });
    expect(forSam[1]!.start).toEqual({ x: 180, y: 260 });
    const rows = await connectorRows(stub);
    expect(rows.map((r) => [r.id, r.start_item, r.start_x, r.start_y, r.rev])).toEqual([
      [k1.id, null, 260, 180, 2],
      [k2.id, null, 180, 260, 2],
      [k3.id, null, 3000, 3000, 1],
    ]);
    closeAll(alex, sam);
  });

  it("a final noteBatch delete (two notes, one connector between them): both ends free from the boxes they had, one update", async () => {
    const { alex, sam, n1, n2 } = await connectorRoom();
    const k = await addConnector(alex, bound(n1.id), bound(n2.id, "auto"), [sam]);
    await drain(alex, sam);
    alex.send({ type: "noteBatch", ops: [{ op: "delete", id: n1.id }, { op: "delete", id: n2.id }], final: true });
    const [updated] = await deleteThenDetached(sam, "notesBatchApplied", 1);
    expect(updated).toEqual({
      ...k,
      start: landing(boxOf(n1), "auto", centre(boxOf(n2))),
      end: landing(boxOf(n2), "auto", centre(boxOf(n1))),
      rev: 2,
    });
    expect(updated!.start).toEqual({ x: 260, y: 180 });
    expect(updated!.end).toEqual({ x: 1000, y: 180 });
    closeAll(alex, sam);
  });

  it("shapeDelete and a final shapeBatch delete detach ends bound to shapes the same way", async () => {
    const { alex, sam, n1, sh, k2 } = await detachRoom();
    alex.send({ type: "shapeDelete", id: sh.id });
    const [u] = await deleteThenDetached(sam, "shapeDeleted", 1);
    expect(u).toEqual({ ...k2, end: landing(boxOf(sh), "auto", anchorPoint(boxOf(n1), "bottom", { x: 0, y: 0 })), rev: 2 });
    const sh2 = await addShape(alex, { x: 2000, y: 1000 }, [sam]);
    const k = await addConnector(sam, free(2100, 3000), bound(sh2.id, "bottom"), [alex]);
    await drain(alex, sam);
    alex.send({ type: "shapeBatch", ops: [{ op: "delete", id: sh2.id }], final: true });
    const [v] = await deleteThenDetached(sam, "shapesBatchApplied", 1);
    expect(v).toEqual({ ...k, end: { x: 2100, y: 1120 }, rev: 2 });
    closeAll(alex, sam);
  });

  it("Clear board (the page's batch deletes of every note and shape, then frames): every bound end turns free, no connector is deleted; the page then deletes them", async () => {
    const { code, alex, sam, n1, n2, sh, frame, k1, k2, k3 } = await detachRoom();
    alex.send({ type: "noteBatch", ops: [{ op: "delete", id: n1.id }, { op: "delete", id: n2.id }], final: true });
    const fromNotes = await deleteThenDetached(sam, "notesBatchApplied", 2);
    expect(fromNotes.map((k) => k.id)).toEqual([k1.id, k2.id]);
    alex.send({ type: "shapeBatch", ops: [{ op: "delete", id: sh.id }], final: true });
    const [fromShape] = await deleteThenDetached(sam, "shapesBatchApplied", 1);
    expect(fromShape).toMatchObject({ id: k2.id, start: { x: 180, y: 260 }, rev: 3 });
    expect(fromShape!.end).toEqual(landing(boxOf(sh), "auto", { x: 180, y: 260 }));
    // A frame delete touches no connector.
    alex.send({ type: "frameDelete", id: frame.id });
    expect(await nextOfType(sam, "frameDeleted")).toEqual({ type: "frameDeleted", id: frame.id });
    expect(await sam.quiet()).toBe(true);
    const c = await TestClient.open(code);
    await c.enter("Jo");
    expect(c.connectors?.connectors.map((k) => [k.id, "item" in k.start, "item" in k.end])).toEqual([
      [k1.id, false, false],
      [k2.id, false, false],
      [k3.id, false, false],
    ]);
    await drain(alex, sam, c);
    for (const k of [k1, k2, k3]) alex.send({ type: "connectorDelete", id: k.id });
    for (const k of [k1, k2, k3]) expect(await nextOfType(sam, "connectorDeleted")).toEqual({ type: "connectorDeleted", id: k.id });
    const d = await TestClient.open(code);
    await d.enter("Kim");
    expect(d.connectors).toEqual({ type: "connectorsSnapshot", connectors: [] });
    closeAll(alex, sam, c, d);
  });

  it("each delete path writes the item delete and the detaches in one transaction", async () => {
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
      const note = (id: string, x: number): Note => ({ id, x, y: 100, w: 160, h: 160, text: HOSTILE, color: "yellow", fontSize: "m", bold: false, italic: false, textColor: "auto", align: "left", titleAlign: "left", titleFontSize: "m", titleBold: false, titleItalic: false, titleTextColor: "auto", z: 0, rev: 1, authorId: author });
      const shape = (id: string): Shape => ({ id, kind: "rect", x: 100, y: 1000, w: 200, h: 120, text: "", fill: "neutral", stroke: "neutral", strokeWidth: "thin", strokeStyle: "solid", fontSize: "m", bold: false, italic: false, underline: false, textColor: "auto", align: "center", valign: "middle", z: 1, rev: 1, authorId: author });
      const conn = (id: string, start: ConnectorEnd): Connector => ({ id, start, end: { x: 3000, y: 3000 }, ...CONNECTOR_DEFAULTS, rev: 1, authorId: author });
      store.insert(note("noteA0000000000a", 100));
      store.insert(note("noteB0000000000b", 1000));
      store.insertShape(shape("shapeA000000000a"));
      store.insertShape(shape("shapeB000000000b"));
      for (const [id, item] of [["connA0000000000a", "noteA0000000000a"], ["connB0000000000b", "noteB0000000000b"], ["connC0000000000c", "shapeA000000000a"], ["connD0000000000d", "shapeB000000000b"]] as const) {
        store.insertConnector(conn(id, { item, anchor: "auto" }));
      }
      // Since schema 13 each path returns its effects: the detached connectors (and group changes).
      const paths: [string, () => Connector[]][] = [
        ["delete", () => store.delete("noteA0000000000a").connectors],
        ["applyBatch", () => store.applyBatch([], ["noteB0000000000b"]).connectors],
        ["deleteShape", () => store.deleteShape("shapeA000000000a").connectors],
        ["applyShapeBatch", () => store.applyShapeBatch([], ["shapeB000000000b"]).connectors],
      ];
      for (const [name, run] of paths) {
        outside.length = 0;
        transacts = 0;
        const detached = run();
        expect(detached, name).toHaveLength(1);
        expect(transacts, name).toBe(1);
        expect(outside, name).toEqual([]);
      }
      expect(store.allConnectors().every((k) => !("item" in k.start))).toBe(true);
    });
  });

  it("moving a bound item writes nothing extra (a bound end has no coordinates to keep up to date)", async () => {
    const { alex, sam, n1, n2, stub } = await connectorRoom();
    // Baseline: a final move of an unbound note.
    let before = await rowsWritten(stub);
    alex.send({ type: "noteMove", id: n2.id, x: 1200, y: 300, final: true });
    await nextOfType(sam, "noteMoved");
    const plain = (await rowsWritten(stub)) - before;
    await addConnector(alex, bound(n1.id), free(900, 900), [sam]);
    await addConnector(alex, bound(n1.id, "top"), bound(n2.id), [sam]);
    await drain(alex, sam);
    before = await rowsWritten(stub);
    alex.send({ type: "noteMove", id: n1.id, x: 400, y: 600, final: false });
    alex.send({ type: "noteMove", id: n1.id, x: 500, y: 700, final: true });
    await nextOfType(sam, "noteMoved");
    await nextOfType(sam, "noteMoved");
    alex.send({ type: "noteResize", id: n1.id, x: 500, y: 700, w: 300, h: 200, final: true });
    await nextOfType(sam, "noteResized");
    expect((await rowsWritten(stub)) - before).toBe(2 * plain);
    expect(await sam.quiet()).toBe(true);
    closeAll(alex, sam);
  });
});

describe("burial", () => {
  it("End session drops the connectors with everything else", async () => {
    const { alex, sam, stub } = await detachRoom();
    alex.send({ type: "endSession" });
    await alex.waitClose();
    await sam.waitClose();
    const rows = await allRows(stub);
    expect(Object.keys(rows)).toEqual(["meta"]);
  });

  it("idle expiry drops them too; the tombstone stays", async () => {
    const { alex, sam, stub } = await detachRoom();
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

describe("rate", () => {
  it("connector messages spend their own bucket: an empty one is rate_limited (naming what to roll back), and edits still go through", async () => {
    const { alex, sam, n1, stub } = await connectorRoom();
    const k = await addConnector(alex, free(10, 10), free(500, 500), [sam]);
    await fullBudgets(stub);
    await runInDurableObject(stub, (_r: unknown, state: DurableObjectState) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as { participant?: { name?: string } | null } & Record<string, unknown>;
        // An hour ahead: no refill can happen during the test, however slow the runner.
        if (att.participant?.name === "Sam") ws.serializeAttachment({ ...att, connectorTokens: 0, connectorAt: Date.now() + 3_600_000 });
      }
    });
    const before = await rowsWritten(stub);
    expect(await sam.request(connectorAdd(free(1, 1), free(2, 2)))).toMatchObject({ type: "error", code: "rate_limited", clientRef: "k1" });
    expect(await sam.request({ type: "connectorUpdate", id: k.id, dash: "dashed" })).toMatchObject({ type: "error", code: "rate_limited", connectorId: k.id });
    expect(await sam.request({ type: "connectorDelete", id: k.id })).toMatchObject({ type: "error", code: "rate_limited", connectorId: k.id });
    expect(await rowsWritten(stub)).toBe(before);
    expect((await attachmentOf(stub, "Sam"))?.tokens).toBeGreaterThanOrEqual(SOCKET_LIMITS.burst - 1);
    sam.send({ type: "noteEdit", id: n1.id, text: "Still editable" });
    expect((await nextOfType(alex, "noteUpdated")).note.text).toBe("Still editable");
    closeAll(alex, sam);
  });

  it("a connector message spends no SOCKET_LIMITS token", async () => {
    const { alex, sam, stub } = await connectorRoom();
    await fullBudgets(stub);
    const k = await addConnector(sam, free(10, 10), free(500, 500), [alex]);
    sam.send({ type: "connectorUpdate", id: k.id, dash: "dashed" });
    await nextOfType(sam, "connectorUpdated");
    const att = await attachmentOf(stub, "Sam");
    expect(att?.tokens).toBe(SOCKET_LIMITS.burst);
    expect(att?.connectorTokens).toBeLessThan(CONNECTOR_LIMITS.burst);
    closeAll(alex, sam);
  });

  it(`a full bucket takes ${CONNECTOR_LIMITS.burst} at once; past it, only what the refill allows in the time it took (explicit time budget)`, async () => {
    const { alex, sam, stub } = await connectorRoom();
    const k = await addConnector(alex, free(10, 10), free(500, 500), [sam]);
    await drain(alex, sam);
    await fullBudgets(stub);
    const extra = 5;
    const started = Date.now();
    const dashes = ["dashed", "solid"] as const;
    for (let i = 0; i < CONNECTOR_LIMITS.burst + extra; i++) sam.send({ type: "connectorUpdate", id: k.id, dash: dashes[i % 2] });
    let accepted = 0;
    let limited = 0;
    while (accepted + limited < CONNECTOR_LIMITS.burst + extra) {
      const m = await sam.next(10_000);
      if (m.type === "connectorUpdated") accepted++;
      else if (m.type === "error" && m.code === "rate_limited") limited++;
    }
    const seconds = (Date.now() - started) / 1000;
    expect(accepted).toBeGreaterThanOrEqual(CONNECTOR_LIMITS.burst);
    // The bucket refilled for at most `seconds`: no more than that many extra (plus one for a partial token).
    expect(accepted).toBeLessThanOrEqual(CONNECTOR_LIMITS.burst + Math.ceil(seconds * CONNECTOR_LIMITS.refillPerSecond) + 1);
    expect(accepted + limited).toBe(CONNECTOR_LIMITS.burst + extra);
    closeAll(alex, sam);
  });
});

describe("costs (docs/LIMITS.md)", () => {
  it("rows: an add 2, an update 1 (unchanged 0), a delete 1, each detached connector +1 on its item's delete", async () => {
    const { alex, sam, n1, n2, stub } = await connectorRoom();
    let rows = await rowsWritten(stub);
    const k = await addConnector(alex, bound(n1.id), free(900, 900), [sam]);
    expect((await rowsWritten(stub)) - rows).toBe(2);
    rows = await rowsWritten(stub);
    alex.send({ type: "connectorUpdate", id: k.id, end: free(800, 800), ink: "blue" });
    await nextOfType(sam, "connectorUpdated");
    expect((await rowsWritten(stub)) - rows).toBe(1);
    rows = await rowsWritten(stub);
    alex.send({ type: "connectorUpdate", id: k.id, ink: "blue" });
    expect(await sam.quiet(200)).toBe(true);
    expect((await rowsWritten(stub)) - rows).toBe(0);
    alex.send({ type: "connectorDelete", id: k.id });
    await nextOfType(sam, "connectorDeleted");
    expect((await rowsWritten(stub)) - rows).toBe(1);
    // A note delete without connectors, then one with three bound to it.
    const extra = await addNote(alex, "Spare", { x: 3000, y: 100 }, [sam]);
    rows = await rowsWritten(stub);
    alex.send({ type: "noteDelete", id: extra.id });
    await nextOfType(sam, "noteDeleted");
    const plainDelete = (await rowsWritten(stub)) - rows;
    for (const anchor of ["top", "left", "bottom"] as const) await addConnector(alex, bound(n2.id, anchor), free(5000, 3000), [sam]);
    await drain(alex, sam);
    rows = await rowsWritten(stub);
    alex.send({ type: "noteDelete", id: n2.id });
    await nextOfType(sam, "noteDeleted");
    for (let i = 0; i < 3; i++) await nextOfType(sam, "connectorUpdated");
    expect((await rowsWritten(stub)) - rows).toBe(plainDelete + 3);
    closeAll(alex, sam);
  });
});

/* ── Stored schema 12 ── */

const version = (sql: SqlStorage) => sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value;
const tableRows = (sql: SqlStorage, table: string) => sql.exec<Row>(`SELECT * FROM ${table} ORDER BY rowid`).toArray();

describe(`schema migration 11 -> ${SCHEMA_VERSION}`, () => {
  it("adds the connectors table (every column but the key with a DEFAULT); every existing table untouched", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV11(sql);
      const before = Object.fromEntries(["notes", "frames", "votes", "shapes", "reactions"].map((t) => [t, tableRows(sql, t)]));
      const metaBefore = tableRows(sql, "meta").filter((r) => r.key !== "schema_version");
      const store = new NoteStore(sql);
      expect(version(sql)).toBe(SCHEMA_VERSION);
      for (const [t, rows] of Object.entries(before)) expect(tableRows(sql, t), t).toEqual(migratedRows(t, rows));
      expect(tableRows(sql, "meta").filter((r) => r.key !== "schema_version")).toEqual(metaBefore);
      const columns = sql.exec<{ name: string; dflt_value: string | null; notnull: number; pk: number }>("SELECT name, dflt_value, \"notnull\", pk FROM pragma_table_info('connectors')").toArray();
      expect(columns.map((c) => [c.name, c.dflt_value, c.notnull, c.pk])).toEqual([
        ["id", null, 0, 1],
        ["start_item", "NULL", 0, 0],
        ["start_anchor", "NULL", 0, 0],
        ["start_x", "NULL", 0, 0],
        ["start_y", "NULL", 0, 0],
        ["end_item", "NULL", 0, 0],
        ["end_anchor", "NULL", 0, 0],
        ["end_x", "NULL", 0, 0],
        ["end_y", "NULL", 0, 0],
        ["route", "'straight'", 1, 0],
        ["dash", "'solid'", 1, 0],
        ["width", "'medium'", 1, 0],
        ["ink", "'neutral'", 1, 0],
        ["start_head", "'none'", 1, 0],
        ["end_head", "'arrow'", 1, 0],
        ["rev", "1", 1, 0],
        ["author_id", "''", 1, 0],
      ]);
      // Old rows load unchanged.
      expect(store.all().map((n) => n.id)).toEqual([...V5_NOTES.map((n) => n.id), V10_SEALED.id]);
      expect(store.writerOf(V10_SEALED.id)).toBe(V10_SEALED.writer);
      expect(store.allFrames().map((f) => f.id)).toEqual(V6_FRAMES.map((f) => f.id));
      expect(store.allShapes().map((s) => s.id)).toEqual([V11_SHAPE_ID]);
      expect(store.reactionCounts()).toEqual([{ noteId: V11_REACTIONS[0][1], key: "heart", count: 2 }]);
      expect(store.allConnectors()).toEqual([]);
      // Runs once: a second load writes nothing.
      expect(new NoteStore(sql).rowsWritten).toBe(0);
    });
  });

  it("is idempotent if it was interrupted after making the table", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV11(sql);
      sql.exec("CREATE TABLE connectors (id TEXT PRIMARY KEY)");
      new NoteStore(sql);
      expect(version(sql)).toBe(SCHEMA_VERSION);
    });
  });

  it("on a populated room: connectors beside the old data; v0.34.0's statements still work, and a connector bound to an item it deleted is skipped on load", async () => {
    const { code, stub } = await newRoom();
    const [first, second] = [V5_NOTES[0].id, V5_NOTES[1].id];
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV11(sql);
      // The round in the fixture is over (a reveal), so connectors can be added.
      sql.exec("UPDATE notes SET sealed = 0, writer = NULL");
      sql.exec("UPDATE meta SET value = 0 WHERE key = 'silent_active'");
      const store = new NoteStore(sql);
      const conn = (id: string, start: ConnectorEnd, end: ConnectorEnd): Connector => ({ id, start, end, ...CONNECTOR_DEFAULTS, rev: 1, authorId: "AAAAAAAAAAAAAAAA" });
      store.insertConnector(conn("conn000000000001", { item: first, anchor: "auto" }, { x: 2000, y: 2000 }));
      store.insertConnector(conn("conn000000000002", { item: second, anchor: "top" }, { item: V11_SHAPE_ID, anchor: "auto" }));
      store.insertConnector(conn("conn000000000003", { x: 1, y: 1 }, { x: 50, y: 60 }));
      // Then v0.34.0 code (after a rollback) adds a note, deletes one and deletes the shape: it knows nothing of connectors.
      sql.exec(V11_NOTE_INSERT, "fromV20code00001", 0, 0, 160, 160, HOSTILE, "green", "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", 9, 1, "AAAAAAAAAAAAAAAA", 0, null);
      for (const statement of V11_NOTE_DELETE) sql.exec(statement, first);
      sql.exec(V11_SHAPE_DELETE, V11_SHAPE_ID);
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Sam");
    expect(c.snapshot?.notes.map((n) => n.id)).toContain("fromV20code00001");
    expect(c.snapshot?.notes.map((n) => n.id)).not.toContain(first);
    // Bound to a note or shape that isn't there: skipped (ids are random, so it never comes back); the rest load.
    expect(c.connectors?.connectors.map((k) => k.id)).toEqual(["conn000000000003"]);
    c.close();
  });

  it("bad stored rows are skipped, never fatal: unknown keys, half an endpoint, a bad anchor, no author; off-board points are clamped", async () => {
    const { code, stub } = await newRoom();
    const c = await TestClient.open(code);
    await c.enter("Sam");
    const note = await addNote(c, HOSTILE, { x: 300, y: 300 });
    c.close();
    await c.waitClose();
    await runInDurableObject(stub, (_r, state) => {
      const sql = state.storage.sql;
      const author = "AAAAAAAAAAAAAAAA";
      sql.exec("INSERT INTO connectors (id, start_x, start_y, end_x, end_y, ink, author_id) VALUES ('bad0000000000001', 1, 1, 2, 2, ?, ?)", HOSTILE, author);
      sql.exec("INSERT INTO connectors (id, start_x, end_x, end_y, author_id) VALUES ('bad0000000000002', 1, 2, 2, ?)", author);
      sql.exec("INSERT INTO connectors (id, start_item, start_anchor, end_x, end_y, author_id) VALUES ('bad0000000000003', ?, 'middle', 2, 2, ?)", note.id, author);
      // A row with no author (every column defaulted) doesn't validate either, as for shapes.
      sql.exec("INSERT INTO connectors (id, start_x, start_y, end_x, end_y) VALUES ('bad0000000000005', 1, 1, 2, 2)");
      sql.exec("INSERT INTO connectors (id, start_x, start_y, end_x, end_y, author_id) VALUES ('ok00000000000004', -50, 9000, 2, 2, ?)", author);
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const d = await TestClient.open(code);
    await d.enter("Alex");
    expect(d.connectors?.connectors).toMatchObject([{ id: "ok00000000000004", start: { x: 0, y: 4000 }, end: { x: 2, y: 2 } }]);
    d.close();
  });
});
