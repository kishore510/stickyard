/// <reference types="vite/client" />
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, ROOM_EXPIRED_CLOSE_CODE } from "@stickyard/shared";
import { EXPIRED_REASON, nextExpiryAlarm, readTombstone } from "../src/expiry";
import { ALARM_RESET_SLACK_MS, ROOM_IDLE_EXPIRY_MS } from "../src/limits";
import type { Room } from "../src/room";
import { TestClient, nextOfType, specRoomCode } from "./helpers";

/*
 * Idle room expiry: the last socket to close sets the room's alarm ROOM_IDLE_EXPIRY_MS ahead
 * (unless one is already within ALARM_RESET_SLACK_MS of that); the alarm, with nobody
 * connected, deletes everything and leaves one tombstone row; a later join is closed with 4410.
 */

const DAY = 24 * 60 * 60 * 1000;
const wrangler = import.meta.glob<string>("../wrangler.jsonc", { query: "?raw", import: "default", eager: true });

async function newRoom() {
  const { code, id } = await specRoomCode();
  return { code, stub: env.ROOM.get(env.ROOM.idFromName(id)) };
}

const rowsWritten = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (r: Room) => r.rowsWritten);
const alarmAt = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (_r, state) => state.storage.getAlarm());
type Row = Record<string, SqlStorageValue>;
/** Every row of every user table (sqlite_* and _cf_* internals left out). */
const allRows = (stub: DurableObjectStub<Room>) =>
  runInDurableObject(stub, (_r, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
      .toArray()
      .map((t) => t.name);
    const rows: Record<string, Row[]> = {};
    for (const t of tables) rows[t] = state.storage.sql.exec<Row>(`SELECT * FROM ${t}`).toArray();
    return rows;
  });

/** Closes `c` and waits until the room has handled it (its close echo comes back). */
async function leave(c: TestClient): Promise<void> {
  c.close();
  await c.waitClose();
  // Let the Durable Object finish its close handler (getAlarm/setAlarm are awaited there).
  await new Promise((r) => setTimeout(r, 50));
}

/** A room with a note and a frame, everyone gone, and its alarm set. */
async function idleRoomWithContent() {
  const { code, stub } = await newRoom();
  const a = await TestClient.open(code);
  await a.enter("Alex");
  a.send({ type: "noteAdd", clientRef: "n1", x: 10, y: 10, color: "yellow", text: "Remember the milk" });
  await nextOfType(a, "noteAdded");
  a.send({ type: "frameAdd", clientRef: "f1", x: 0, y: 400, color: "green", title: "Plan" });
  await nextOfType(a, "frameAdded");
  await leave(a);
  return { code, stub };
}

/** Opens a socket and waits for the close; returns the code, reason and any message seen first. */
async function expectExpired(code: string, helloVersion = PROTOCOL_VERSION) {
  const c = await TestClient.open(code);
  const reason = new Promise<string>((resolve) => c.ws.addEventListener("close", (e) => resolve(e.reason)));
  c.send({ type: "hello", protocolVersion: helloVersion });
  expect(await c.waitClose()).toBe(ROOM_EXPIRED_CLOSE_CODE);
  expect(await reason).toBe(EXPIRED_REASON);
  expect(await c.quiet(50)).toBe(true);
  return c;
}

describe("constants", () => {
  it("expires after 7 days, resets the alarm at most once per hour of slack", () => {
    expect(ROOM_IDLE_EXPIRY_MS).toBe(7 * DAY);
    expect(ALARM_RESET_SLACK_MS).toBe(60 * 60 * 1000);
    expect(ROOM_EXPIRED_CLOSE_CODE).toBe(4410);
  });

  it("the compatibility date is on or after 2026-02-24, so deleteAll() also deletes the alarm", () => {
    const text = Object.values(wrangler)[0] ?? "";
    const date = /"compatibility_date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/.exec(text)?.[1];
    expect(date).toBeDefined();
    expect(date! >= "2026-02-24").toBe(true);
  });
});

describe("nextExpiryAlarm (pure)", () => {
  const now = 1_000_000_000;
  it("sets one when there is none", () => {
    expect(nextExpiryAlarm(null, now)).toBe(now + ROOM_IDLE_EXPIRY_MS);
  });
  it("moves an alarm that is earlier than the new time minus the slack", () => {
    expect(nextExpiryAlarm(now + 5, now)).toBe(now + ROOM_IDLE_EXPIRY_MS);
    expect(nextExpiryAlarm(now + ROOM_IDLE_EXPIRY_MS - ALARM_RESET_SLACK_MS - 1, now)).toBe(now + ROOM_IDLE_EXPIRY_MS);
  });
  it("leaves one within the slack (or later) alone", () => {
    expect(nextExpiryAlarm(now + ROOM_IDLE_EXPIRY_MS - ALARM_RESET_SLACK_MS, now)).toBeNull();
    expect(nextExpiryAlarm(now + ROOM_IDLE_EXPIRY_MS, now)).toBeNull();
    expect(nextExpiryAlarm(now + ROOM_IDLE_EXPIRY_MS + DAY, now)).toBeNull();
  });
});

describe("setting the alarm", () => {
  it("the last socket to close sets it about 7 days ahead, as one write", async () => {
    const { code, stub } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex");
    const before = await rowsWritten(stub);
    const t0 = Date.now();
    await leave(a);
    const at = await alarmAt(stub);
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThanOrEqual(t0 + ROOM_IDLE_EXPIRY_MS - 5_000);
    expect(at!).toBeLessThanOrEqual(Date.now() + ROOM_IDLE_EXPIRY_MS + 5_000);
    expect(await rowsWritten(stub)).toBe(before + 1);
  });

  it("a socket that never joined counts too", async () => {
    const { code, stub } = await newRoom();
    const a = await TestClient.open(code);
    await a.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    await leave(a);
    expect(await alarmAt(stub)).not.toBeNull();
  });

  it("a close that is not the last sets nothing and writes nothing", async () => {
    const { code, stub } = await newRoom();
    const a = await TestClient.open(code);
    const b = await TestClient.open(code);
    await a.enter("Alex");
    await b.enter("Sam");
    const before = await rowsWritten(stub);
    await leave(a);
    expect(await alarmAt(stub)).toBeNull();
    expect(await rowsWritten(stub)).toBe(before);
    await leave(b);
    expect(await alarmAt(stub)).not.toBeNull();
  });

  it("a second last-close within the slack writes nothing", async () => {
    const { code, stub } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex");
    await leave(a);
    const first = await alarmAt(stub);
    const before = await rowsWritten(stub);
    const b = await TestClient.open(code);
    await b.enter("Sam");
    await leave(b);
    expect(await alarmAt(stub)).toBe(first);
    expect(await rowsWritten(stub)).toBe(before);
  });

  it("an alarm earlier than the slack allows is moved forward", async () => {
    const { code, stub } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex");
    const soon = Date.now() + DAY;
    await runInDurableObject(stub, (_r, state) => state.storage.setAlarm(soon));
    await leave(a);
    expect(await alarmAt(stub)).toBeGreaterThan(soon + 5 * DAY);
  });

  it("joining never touches the alarm (and writes nothing)", async () => {
    const { code, stub } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex");
    await leave(a);
    const at = await alarmAt(stub);
    const before = await rowsWritten(stub);
    const b = await TestClient.open(code);
    await b.enter("Sam");
    expect(await alarmAt(stub)).toBe(at);
    expect(await rowsWritten(stub)).toBe(before);
    b.close();
  });

  it("a socket closed for going over the rate limit counts as leaving", async () => {
    const { code, stub } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex");
    // Far over SOCKET_LIMITS: the room closes the socket (1008).
    for (let i = 0; i < 200; i++) a.send({ type: "say", text: "x" });
    expect(await a.waitClose()).toBe(1008);
    await new Promise((r) => setTimeout(r, 50));
    expect(await alarmAt(stub)).not.toBeNull();
  });
});

describe("the alarm firing", () => {
  it("with a socket connected does nothing and writes nothing", async () => {
    const { code, stub } = await idleRoomWithContent();
    const b = await TestClient.open(code);
    await b.enter("Sam");
    expect(b.snapshot?.notes).toHaveLength(1);
    const before = await rowsWritten(stub);
    const rows = await allRows(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await rowsWritten(stub)).toBe(before);
    expect(await allRows(stub)).toEqual(rows);
    // The room still works.
    b.send({ type: "noteAdd", clientRef: "n2", x: 300, y: 10, color: "blue", text: "Still here" });
    expect((await nextOfType(b, "noteAdded")).note.text).toBe("Still here");
    b.close();
  });

  it("with nobody connected deletes notes, frames and meta, and leaves exactly the tombstone", async () => {
    const { stub } = await idleRoomWithContent();
    const before = await rowsWritten(stub);
    const t0 = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const rows = await allRows(stub);
    expect(Object.keys(rows)).toEqual(["meta"]);
    expect(rows.meta).toHaveLength(1);
    expect(rows.meta![0]!.key).toBe("expired_at");
    expect(Number(rows.meta![0]!.value)).toBeGreaterThanOrEqual(t0 - 5_000);
    // deleteAll() removed the alarm (compatibility date >= 2026-02-24).
    expect(await alarmAt(stub)).toBeNull();
    // The tombstone is the only write: one row plus its primary-key index entry.
    expect(await rowsWritten(stub)).toBe(before + 2);
    expect(await runInDurableObject(stub, (_r, state) => readTombstone(state.storage.sql))).not.toBeNull();
  });

  it("a join after expiry is closed with 4410 and creates no data", async () => {
    const { code, stub } = await idleRoomWithContent();
    await runDurableObjectAlarm(stub);
    const rows = await allRows(stub);
    const before = await rowsWritten(stub);
    const c = await expectExpired(code);
    c.send({ type: "join", name: "Priya" });
    expect(await c.quiet(50)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(await allRows(stub)).toEqual(rows);
    expect(await rowsWritten(stub)).toBe(before);
    // Closing that socket doesn't set an alarm on the dead room.
    expect(await alarmAt(stub)).toBeNull();
  });

  it("an older (v11 or v12-era) hello against an expired room still closes with 4410", async () => {
    const { code, stub } = await idleRoomWithContent();
    await runDurableObjectAlarm(stub);
    await expectExpired(code, 11);
    await expectExpired(code, 12);
    await expectExpired(code, 1);
    expect(Object.keys(await allRows(stub))).toEqual(["meta"]);
  });

  it("a room that never had data expires the same way", async () => {
    const { code, stub } = await newRoom();
    const a = await TestClient.open(code);
    await leave(a);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const rows = await allRows(stub);
    expect(Object.keys(rows)).toEqual(["meta"]);
    expect(rows.meta!.map((r) => r.key)).toEqual(["expired_at"]);
    await expectExpired(code);
  });

  it("firing twice is harmless: the tombstone stays and nothing more is written", async () => {
    const { stub } = await idleRoomWithContent();
    await runDurableObjectAlarm(stub);
    const before = await rowsWritten(stub);
    const rows = await allRows(stub);
    await runInDurableObject(stub, (r: Room) => r.alarm());
    expect(await allRows(stub)).toEqual(rows);
    expect(await rowsWritten(stub)).toBe(before);
  });
});

describe("hibernation", () => {
  it("the alarm survives eviction, and the rebuilt room expires from storage, not stale caches", async () => {
    const { code, stub } = await idleRoomWithContent();
    const at = await alarmAt(stub);
    await evictDurableObject(stub);
    expect(await alarmAt(stub)).toBe(at);
    // A visit after waking reads the notes from storage (cache rebuilt).
    const b = await TestClient.open(code);
    await b.enter("Sam");
    expect(b.snapshot?.notes.map((n) => n.text)).toEqual(["Remember the milk"]);
    await leave(b);
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await evictDurableObject(stub);
    // After expiry and another wake, nothing comes back.
    await expectExpired(code);
    expect(Object.keys(await allRows(stub))).toEqual(["meta"]);
  });

  it("a hibernated socket still counts as connected when the alarm fires", async () => {
    const { code, stub } = await idleRoomWithContent();
    const b = await TestClient.open(code);
    await b.enter("Sam");
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await allRows(stub)).notes).toHaveLength(1);
    b.close();
  });

  it("in-memory caches are reset at expiry, so the same instance can't serve old notes", async () => {
    const { code, stub } = await idleRoomWithContent();
    await runDurableObjectAlarm(stub);
    // Same instance (no eviction): a join still finds nothing.
    await expectExpired(code);
    expect(await runInDurableObject(stub, (r: Room) => r.expired)).toBe(true);
  });
});
