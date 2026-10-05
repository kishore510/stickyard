import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BOARD_HEIGHT, BOARD_WIDTH, CURSOR_TOLERANCE, PROTOCOL_VERSION, ROOM_ENDED_CLOSE_CODE, type ServerMessage } from "@stickyard/shared";
import { CURSOR_LIMITS, SOCKET_LIMITS } from "../src/limits";
import type { Room } from "../src/room";
import { TestClient, nextOfType, specHostToken, specRoomCode } from "./helpers";

/*
 * Protocol v14 (live cursors). A page sends `cursor { x, y }` and `cursorLeft {}`; the relay
 * forwards `cursorMoved { id, x, y }` / `cursorGone { id }` to the OTHER joined sockets, with the
 * id from the sender's socket. Nothing is stored, nothing is scheduled, and cursor messages spend
 * their own budget (CURSOR_LIMITS), never SOCKET_LIMITS.
 */

async function newRoom() {
  const { code, id } = await specRoomCode();
  return { code, id, token: await specHostToken(id), stub: env.ROOM.get(env.ROOM.idFromName(id)) };
}

const rowsWritten = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (r: Room) => r.rowsWritten);
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const closeAll = (...cs: TestClient[]) => cs.forEach((c) => c.close());

/** Reads and drops whatever a client has been sent until it is quiet. */
async function drain(...cs: TestClient[]) {
  for (const c of cs) while (!(await c.quiet(60))) await c.next(1).catch(() => undefined);
}

/** Every message a client receives from now on (validated by TestClient's schema check too). */
function recorded(c: TestClient): ServerMessage[] {
  const got: ServerMessage[] = [];
  c.ws.addEventListener("message", (e) => got.push(JSON.parse(String(e.data)) as ServerMessage));
  return got;
}

/**
 * Counts every storage call the room makes from now on (SQL, KV, alarms, transactions), by
 * wrapping the methods of its own storage objects. Returns a reader for the count.
 */
async function watchStorage(stub: DurableObjectStub<Room>): Promise<() => Promise<number>> {
  await runInDurableObject(stub, (_r, state) => {
    const holder = globalThis as { __storageOps?: number };
    holder.__storageOps = 0;
    const wrap = (target: object, names: string[]) => {
      for (const name of names) {
        const record = target as Record<string, unknown>;
        const original = record[name];
        if (typeof original !== "function") continue;
        record[name] = (...args: unknown[]) => {
          holder.__storageOps = (holder.__storageOps ?? 0) + 1;
          return (original as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
    };
    wrap(state.storage.sql, ["exec"]);
    wrap(state.storage, ["get", "put", "delete", "list", "deleteAll", "getAlarm", "setAlarm", "deleteAlarm", "transaction", "transactionSync", "sync"]);
  });
  return () => runInDurableObject(stub, () => (globalThis as { __storageOps?: number }).__storageOps ?? 0);
}

/** Two joined people (Alex, Sam) in a fresh room, with the joins drained. */
async function pair() {
  const room = await newRoom();
  const a = await TestClient.open(room.code);
  const b = await TestClient.open(room.code);
  const ja = await a.enter("Alex");
  const jb = await b.enter("Sam");
  await nextOfType(a, "participant_joined");
  return { ...room, a, b, alex: ja.you, sam: jb.you };
}

describe("cursor relay", () => {
  it("forwards to the others only, with the sender's id from its socket; never echoed to the sender", async () => {
    const { a, b, alex } = await pair();
    a.send({ type: "cursor", x: 100, y: 200 });
    expect(await b.next()).toEqual({ type: "cursorMoved", id: alex.id, x: 100, y: 200 });
    expect(await a.quiet()).toBe(true);
    closeAll(a, b);
  });

  it("forwards to every other joined socket, not to sockets that haven't joined", async () => {
    const { code, a, b, alex } = await pair();
    const kai = await TestClient.open(code);
    await kai.enter("Kai");
    const lurker = await TestClient.open(code);
    await lurker.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    await drain(a, b);
    a.send({ type: "cursor", x: 5, y: 6 });
    expect(await b.next()).toEqual({ type: "cursorMoved", id: alex.id, x: 5, y: 6 });
    expect(await kai.next()).toEqual({ type: "cursorMoved", id: alex.id, x: 5, y: 6 });
    expect(await lurker.quiet()).toBe(true);
    expect(await a.quiet()).toBe(true);
    closeAll(a, b, kai, lurker);
  });

  it("is ignored silently before joining (no reply, nothing forwarded)", async () => {
    const { code, a, b } = await pair();
    const early = await TestClient.open(code);
    early.send({ type: "cursor", x: 5, y: 6 });
    early.send({ type: "cursorLeft" });
    await early.request({ type: "hello", protocolVersion: PROTOCOL_VERSION }).then((m) => expect(m.type).toBe("welcome"));
    early.send({ type: "cursor", x: 5, y: 6 });
    expect(await early.quiet()).toBe(true);
    expect(await a.quiet()).toBe(true);
    expect(await b.quiet()).toBe(true);
    closeAll(a, b, early);
  });

  it("clamps to the board and rounds to whole units", async () => {
    const { a, b, alex } = await pair();
    a.send({ type: "cursor", x: -CURSOR_TOLERANCE, y: BOARD_HEIGHT + CURSOR_TOLERANCE });
    expect(await b.next()).toEqual({ type: "cursorMoved", id: alex.id, x: 0, y: BOARD_HEIGHT });
    a.send({ type: "cursor", x: BOARD_WIDTH + 0.4, y: 10.6 });
    expect(await b.next()).toEqual({ type: "cursorMoved", id: alex.id, x: BOARD_WIDTH, y: 11 });
    closeAll(a, b);
  });

  it.each([
    ["out of range", JSON.stringify({ type: "cursor", x: -CURSOR_TOLERANCE - 1, y: 0 })],
    ["NaN (sent as null)", JSON.stringify({ type: "cursor", x: Number.NaN, y: 0 })],
    ["a string", JSON.stringify({ type: "cursor", x: "1", y: 0 })],
    ["missing y", JSON.stringify({ type: "cursor", x: 1 })],
    ["an extra id", JSON.stringify({ type: "cursor", x: 1, y: 1, id: "AAAAAAAAAAAAAAAA" })],
    ["an extra name", JSON.stringify({ type: "cursor", x: 1, y: 1, name: "Sam" })],
    ["cursorLeft with a field", JSON.stringify({ type: "cursorLeft", id: "AAAAAAAAAAAAAAAA" })],
    ["a huge number literal", '{"type":"cursor","x":1e999,"y":0}'],
  ])("%s gets bad_message and nothing is forwarded", async (_label, raw) => {
    const { a, b } = await pair();
    expect(await a.request(raw)).toMatchObject({ type: "error", code: "bad_message" });
    expect(await b.quiet()).toBe(true);
    closeAll(a, b);
  });

  it("someone alone in the room: dropped, nothing sent anywhere", async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex");
    a.send({ type: "cursor", x: 1, y: 1 });
    a.send({ type: "cursorLeft" });
    expect(await a.quiet()).toBe(true);
    // Someone joining later doesn't hear about a cursor that was never shown.
    const b = await TestClient.open(code);
    await b.enter("Sam");
    a.send({ type: "cursorLeft" });
    expect(await b.quiet()).toBe(true);
    closeAll(a, b);
  });

  it("cursorLeft: cursorGone to the others once; nothing when the cursor wasn't shown", async () => {
    const { a, b, alex } = await pair();
    a.send({ type: "cursorLeft" });
    expect(await b.quiet()).toBe(true);
    a.send({ type: "cursor", x: 1, y: 1 });
    await nextOfType(b, "cursorMoved");
    a.send({ type: "cursorLeft" });
    expect(await b.next()).toEqual({ type: "cursorGone", id: alex.id });
    a.send({ type: "cursorLeft" });
    expect(await b.quiet()).toBe(true);
    expect(await a.quiet()).toBe(true);
    closeAll(a, b);
  });
});

describe("cursors store nothing", () => {
  it("zero rows written and zero storage calls of any kind for cursor traffic", async () => {
    const { a, b, stub } = await pair();
    await drain(a, b);
    const before = await rowsWritten(stub);
    const ops = await watchStorage(stub);
    for (let i = 0; i < 10; i++) a.send({ type: "cursor", x: i * 10, y: i * 10 });
    for (let i = 0; i < 10; i++) await nextOfType(b, "cursorMoved");
    a.send({ type: "cursorLeft" });
    await nextOfType(b, "cursorGone");
    await settle();
    expect(await ops()).toBe(0);
    expect(await rowsWritten(stub)).toBe(before);
    closeAll(a, b);
  });

  it("nothing periodic is scheduled: no alarm and no pending timer while cursors move", async () => {
    const { a, b, stub } = await pair();
    a.send({ type: "cursor", x: 1, y: 1 });
    await nextOfType(b, "cursorMoved");
    expect(await runInDurableObject(stub, (r: Room) => r.timersPending)).toBe(false);
    expect(await runInDurableObject(stub, (_r, state) => state.storage.getAlarm())).toBeNull();
    // Nothing more arrives on its own: no heartbeats, no repeats.
    expect(await b.quiet(400)).toBe(true);
    closeAll(a, b);
  });

  it("hibernation: nothing about cursors is needed after a wake; relaying carries on", async () => {
    const { a, b, stub, alex } = await pair();
    a.send({ type: "cursor", x: 7, y: 8 });
    await nextOfType(b, "cursorMoved");
    await evictDurableObject(stub, { webSockets: "hibernate" });
    a.send({ type: "cursor", x: 9, y: 10 });
    expect(await nextOfType(b, "cursorMoved")).toEqual({ type: "cursorMoved", id: alex.id, x: 9, y: 10 });
    // The shown cursor is still known (it lives in the socket attachment, not storage).
    a.send({ type: "cursorLeft" });
    expect(await nextOfType(b, "cursorGone")).toEqual({ type: "cursorGone", id: alex.id });
    const stored = await runInDurableObject(stub, async (_r, state) => ({
      keys: (await state.storage.list()).size,
      meta: state.storage.sql.exec<{ key: string }>("SELECT key FROM meta").toArray().map((r) => r.key),
    }));
    expect(stored).toEqual({ keys: 0, meta: ["schema_version"] });
    closeAll(a, b);
  });
});

describe("cursorGone when someone goes", () => {
  it("on close (Leave): cursorGone, then participant_left", async () => {
    const { a, b, alex } = await pair();
    a.send({ type: "cursor", x: 1, y: 1 });
    await nextOfType(b, "cursorMoved");
    a.close();
    expect(await b.next()).toEqual({ type: "cursorGone", id: alex.id });
    expect(await b.next()).toEqual({ type: "participant_left", id: alex.id });
    b.close();
  });

  it("on close without a shown cursor: only participant_left", async () => {
    const { a, b, alex } = await pair();
    a.close();
    expect(await b.next()).toEqual({ type: "participant_left", id: alex.id });
    expect(await b.quiet()).toBe(true);
    b.close();
  });

  it("on a rate-limit close", async () => {
    const { a, b, alex } = await pair();
    a.send({ type: "cursor", x: 1, y: 1 });
    await nextOfType(b, "cursorMoved");
    for (let i = 0; i < SOCKET_LIMITS.burst + SOCKET_LIMITS.maxViolations * 10; i++) a.send({ type: "say", text: "spam" });
    expect(await a.waitClose()).toBe(1008);
    expect(await nextOfType(b, "cursorGone")).toEqual({ type: "cursorGone", id: alex.id });
    expect(await nextOfType(b, "participant_left")).toEqual({ type: "participant_left", id: alex.id });
    b.close();
  });

  it("on End session: every shown cursor goes before sessionEnded, nothing about cursors after it", async () => {
    const { a, b, token, alex } = await pair();
    expect(await a.request({ type: "claimHost", token })).toEqual({ type: "hostGranted" });
    await nextOfType(b, "participantUpdated");
    a.send({ type: "cursor", x: 1, y: 1 });
    b.send({ type: "cursor", x: 2, y: 2 });
    await nextOfType(b, "cursorMoved");
    await nextOfType(a, "cursorMoved");
    const got = recorded(b);
    a.send({ type: "endSession" });
    expect(await b.waitClose()).toBe(ROOM_ENDED_CLOSE_CODE);
    const types = got.map((m) => m.type);
    const ended = types.indexOf("sessionEnded");
    expect(ended).toBeGreaterThan(-1);
    expect(got.slice(0, ended)).toEqual(expect.arrayContaining([{ type: "cursorGone", id: alex.id }]));
    expect(got.slice(ended).some((m) => m.type === "cursorMoved" || m.type === "cursorGone")).toBe(false);
  });

  it("expiry: the alarm only buries a room nobody is in, so there is no cursor left to remove", async () => {
    const { a, b, stub, alex } = await pair();
    a.send({ type: "cursor", x: 1, y: 1 });
    await nextOfType(b, "cursorMoved");
    // While anyone is connected the alarm does nothing.
    await runInDurableObject(stub, (r: Room) => r.alarm());
    a.send({ type: "cursor", x: 2, y: 2 });
    expect(await nextOfType(b, "cursorMoved")).toEqual({ type: "cursorMoved", id: alex.id, x: 2, y: 2 });
    a.close();
    expect(await nextOfType(b, "cursorGone")).toEqual({ type: "cursorGone", id: alex.id });
    b.close();
    await b.waitClose();
    await settle();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  });
});

describe("cursor rate limits", () => {
  it(`CURSOR_LIMITS: ${CURSOR_LIMITS.refillPerSecond}/s, burst ${CURSOR_LIMITS.burst}; ${CURSOR_LIMITS.maxSilentDrops} silent drops per ${CURSOR_LIMITS.dropWindowMs / 1000} s`, () => {
    expect(CURSOR_LIMITS).toEqual({ refillPerSecond: 15, burst: 20, maxSilentDrops: 100, dropWindowMs: 10_000 });
  });

  it("over its own budget, cursor messages are dropped silently and the socket stays open", async () => {
    const { a, b } = await pair();
    const got = recorded(b);
    const sent = CURSOR_LIMITS.burst + 40;
    for (let i = 0; i < sent; i++) a.send({ type: "cursor", x: i, y: i });
    await settle(300);
    const moved = got.filter((m) => m.type === "cursorMoved").length;
    expect(moved).toBeGreaterThanOrEqual(CURSOR_LIMITS.burst);
    expect(moved).toBeLessThan(sent);
    expect(await a.quiet()).toBe(true);
    expect(a.closeCode).toBeNull();
    // Tokens come back.
    await settle(300);
    a.send({ type: "cursor", x: 3000, y: 3 });
    expect((await nextOfType(b, "cursorMoved")).x).toBe(3000);
    closeAll(a, b);
  });

  it("cursors never spend SOCKET_LIMITS tokens: edits and chat keep their whole budget", async () => {
    const { a, b } = await pair();
    await drain(a, b);
    for (let i = 0; i < CURSOR_LIMITS.burst * 2; i++) a.send({ type: "cursor", x: i, y: i });
    // enter() spent 2 tokens; everything else of the burst is still there.
    const says = SOCKET_LIMITS.burst - 2;
    for (let i = 0; i < says; i++) a.send({ type: "say", text: `m${i}` });
    const replies: ServerMessage[] = [];
    for (let i = 0; i < says; i++) replies.push(await a.next());
    expect(replies.filter((r) => r.type === "error")).toEqual([]);
    expect(replies.filter((r) => r.type === "echo")).toHaveLength(says);
    closeAll(a, b);
  });

  it("sustained abuse (past the silent drops in a window) counts as violations and closes the socket", async () => {
    const { a, b, alex } = await pair();
    a.send({ type: "cursor", x: 1, y: 1 });
    await nextOfType(b, "cursorMoved");
    const flood = CURSOR_LIMITS.burst + CURSOR_LIMITS.maxSilentDrops + SOCKET_LIMITS.maxViolations * 5;
    for (let i = 0; i < flood; i++) a.send({ type: "cursor", x: i % 100, y: 1 });
    expect(await a.waitClose()).toBe(1008);
    expect(await nextOfType(b, "cursorGone")).toEqual({ type: "cursorGone", id: alex.id });
    b.close();
  });

  it("a short burst over the budget (under the silent drops) is never a violation", async () => {
    const { a, b, stub } = await pair();
    // Two bursts: drops stay under maxSilentDrops in the window.
    for (let i = 0; i < CURSOR_LIMITS.burst + CURSOR_LIMITS.maxSilentDrops / 2; i++) a.send({ type: "cursor", x: 1, y: i });
    await settle(200);
    expect(a.closeCode).toBeNull();
    expect(await a.quiet()).toBe(true);
    // And no violation was recorded either: a socket's strikes are untouched.
    const strikes = await runInDurableObject(stub, (_r, state) => state.getWebSockets().map((ws) => (ws.deserializeAttachment() as { strikes: number }).strikes));
    expect(strikes).toEqual([0, 0]);
    closeAll(a, b);
  });
});

describe("lock and protocol", () => {
  it("a locked board still forwards a guest's cursor (cursors aren't board writes)", async () => {
    const { a, b, token, sam } = await pair();
    expect(await a.request({ type: "claimHost", token })).toEqual({ type: "hostGranted" });
    await nextOfType(b, "participantUpdated");
    expect(await a.request({ type: "lockSet", locked: true })).toEqual({ type: "lockChanged", locked: true });
    await nextOfType(b, "lockChanged");
    b.send({ type: "cursor", x: 40, y: 50 });
    expect(await a.next()).toEqual({ type: "cursorMoved", id: sam.id, x: 40, y: 50 });
    b.send({ type: "cursorLeft" });
    expect(await a.next()).toEqual({ type: "cursorGone", id: sam.id });
    expect(await b.quiet()).toBe(true);
    closeAll(a, b);
  });

  it("a protocol v13 page is refused with version_mismatch (please reload)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(PROTOCOL_VERSION).toBe(14);
    expect(await c.request({ type: "hello", protocolVersion: 13 })).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Priya" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });
});
