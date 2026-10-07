/// <reference types="vite/client" />
import { exports } from "cloudflare:workers";
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  BOARD_WRITES,
  PROTOCOL_VERSION,
  ROOM_ENDED_CLOSE_CODE,
  TIMER_MAX_MS,
  TIMER_MIN_MS,
  createRoomResponseSchema,
  type ClientMessageType,
  type ServerMessage,
} from "@stickyard/shared";
import { ENDED_REASON } from "../src/expiry";
import { hostTokenFor, verifyHostToken } from "../src/hostToken";
import type { Room } from "../src/room";
import { TEST_PASSCODE, TEST_SIGNING_KEY, TestClient, createRequest, freshIp, nextOfType, specHostToken, specRoomCode } from "./helpers";

/*
 * Protocol v12 (slice host): a host token from room creation, claimHost, the board lock, the
 * timer and End session. Fake keys only (vitest.config.ts).
 */

const hostSources = import.meta.glob<string>("../src/hostToken.ts", { query: "?raw", import: "default", eager: true });

async function newRoom() {
  const { code, id } = await specRoomCode();
  return { code, id, token: await specHostToken(id), stub: env.ROOM.get(env.ROOM.idFromName(id)) };
}

const rowsWritten = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (r: Room) => r.rowsWritten);
type Row = Record<string, SqlStorageValue>;
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
const meta = async (stub: DurableObjectStub<Room>) =>
  Object.fromEntries(((await allRows(stub)).meta ?? []).map((r) => [String(r.key), Number(r.value)]));
const closeAll = (...cs: TestClient[]) => cs.forEach((c) => c.close());

/** A room with a host (Alex, claimed) and a guest (Sam), and one note, one frame and one shape by Alex. */
async function hostedRoom() {
  const room = await newRoom();
  const host = await TestClient.open(room.code);
  const guest = await TestClient.open(room.code);
  await host.enter("Alex");
  await guest.enter("Sam");
  await nextOfType(host, "participant_joined");
  expect(await host.request({ type: "claimHost", token: room.token })).toEqual({ type: "hostGranted" });
  await nextOfType(guest, "participantUpdated");
  host.send({ type: "noteAdd", clientRef: "n1", x: 10, y: 10, color: "yellow", text: "Note" });
  const note = (await nextOfType(host, "noteAdded")).note;
  await nextOfType(guest, "noteAdded");
  host.send({ type: "frameAdd", clientRef: "f1", x: 0, y: 600, color: "neutral", title: "Frame" });
  const frame = (await nextOfType(host, "frameAdded")).frame;
  await nextOfType(guest, "frameAdded");
  host.send({ type: "shapeAdd", clientRef: "s1", kind: "rect", x: 1200, y: 10 });
  const shape = (await nextOfType(host, "shapeAdded")).shape;
  await nextOfType(guest, "shapeAdded");
  return { ...room, host, guest, note, frame, shape };
}

async function lock(host: TestClient, guest: TestClient, locked = true) {
  expect(await host.request({ type: "lockSet", locked })).toEqual({ type: "lockChanged", locked });
  expect(await nextOfType(guest, "lockChanged")).toEqual({ type: "lockChanged", locked });
}

describe("host token", () => {
  it("is the full HMAC of the room id under its own domain, 43 characters", async () => {
    const { id } = await specRoomCode();
    const token = await hostTokenFor(id, TEST_SIGNING_KEY);
    expect(token).toBe(await specHostToken(id));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is domain-separated from the room signature, and differs per room and per key", async () => {
    const a = await specRoomCode();
    const b = await specRoomCode();
    const token = await hostTokenFor(a.id, TEST_SIGNING_KEY);
    expect(token.slice(0, 22)).not.toBe(a.code.split(".")[1]);
    expect(await hostTokenFor(b.id, TEST_SIGNING_KEY)).not.toBe(token);
    expect(await hostTokenFor(a.id, "another-fake-key")).not.toBe(token);
  });

  it("verifies only the right room's token", async () => {
    const a = await specRoomCode();
    const b = await specRoomCode();
    expect(await verifyHostToken(await specHostToken(a.id), a.id, TEST_SIGNING_KEY)).toBe(true);
    expect(await verifyHostToken(await specHostToken(b.id), a.id, TEST_SIGNING_KEY)).toBe(false);
    expect(await verifyHostToken("x".repeat(43), a.id, TEST_SIGNING_KEY)).toBe(false);
    expect(await verifyHostToken(await specHostToken(a.id), a.id, "")).toBe(false);
  });

  it("is compared through safeEqual only (constant time), never with ===", () => {
    const text = Object.values(hostSources)[0] ?? "";
    expect(text).toContain("safeEqual(");
    expect(text).not.toMatch(/token\s*[!=]==|[!=]==\s*token/);
  });

  it("POST /rooms returns it with the code (and nowhere else)", async () => {
    const res = await exports.default.fetch(createRequest({ passcode: TEST_PASSCODE }, { ip: freshIp() }));
    expect(res.status).toBe(200);
    const body = createRoomResponseSchema.parse(await res.json());
    const id = body.code.split(".")[0]!;
    expect(body.hostToken).toBe(await specHostToken(id));
    // The room check and health answers don't carry it.
    const check = await exports.default.fetch(new Request(`https://relay.example.test/rooms/check?room=${encodeURIComponent(body.code)}`, { headers: { Origin: "https://kishore510.github.io" } }));
    expect(await check.text()).not.toContain(body.hostToken);
  });
});

describe("claimHost", () => {
  it("needs a join first", async () => {
    const { code, token } = await newRoom();
    const c = await TestClient.open(code);
    await c.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    expect(await c.request({ type: "claimHost", token })).toMatchObject({ type: "error", code: "not_joined" });
    c.close();
  });

  it("grants host to the claimer, tells the others, and later joiners see the flag", async () => {
    const { code, token } = await newRoom();
    const a = await TestClient.open(code);
    const b = await TestClient.open(code);
    const ja = await a.enter("Alex");
    expect(ja.you.host).toBe(false);
    await b.enter("Sam");
    await nextOfType(a, "participant_joined");
    expect(await a.request({ type: "claimHost", token })).toEqual({ type: "hostGranted" });
    expect(await nextOfType(b, "participantUpdated")).toEqual({ type: "participantUpdated", participant: { ...ja.you, host: true } });
    const c = await TestClient.open(code);
    const jc = await c.enter("Priya");
    expect(jc.participants.find((p) => p.id === ja.you.id)?.host).toBe(true);
    expect(jc.you.host).toBe(false);
    await nextOfType(a, "participant_joined");
    await nextOfType(b, "participant_joined");
    // Claiming again is fine and quiet for the others.
    expect(await a.request({ type: "claimHost", token })).toEqual({ type: "hostGranted" });
    expect(await b.quiet()).toBe(true);
    closeAll(a, b, c);
  });

  it("a wrong token (or another room's) is bad_host_token, writes nothing and grants nothing", async () => {
    const { code, stub } = await newRoom();
    const other = await specRoomCode();
    const a = await TestClient.open(code);
    const b = await TestClient.open(code);
    await a.enter("Alex");
    await b.enter("Sam");
    await nextOfType(a, "participant_joined");
    const before = await rowsWritten(stub);
    expect(await a.request({ type: "claimHost", token: await specHostToken(other.id) })).toMatchObject({ type: "error", code: "bad_host_token" });
    expect(await a.request({ type: "claimHost", token: "A".repeat(43) })).toMatchObject({ type: "error", code: "bad_host_token" });
    expect(await a.request({ type: "lockSet", locked: true })).toMatchObject({ type: "error", code: "not_host" });
    expect(await rowsWritten(stub)).toBe(before);
    expect(await b.quiet()).toBe(true);
    closeAll(a, b);
  });

  it("each bad token counts as a violation: enough of them close the socket", async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex");
    for (let i = 0; i < 25; i++) a.send({ type: "claimHost", token: "B".repeat(43) });
    expect(await a.waitClose()).toBe(1008);
  });

  it("a malformed token or extra fields are bad_message (strict), not a claim", async () => {
    const { code, token } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex");
    expect(await a.request({ type: "claimHost", token: "short" })).toMatchObject({ type: "error", code: "bad_message" });
    expect(await a.request({ type: "claimHost", token, host: true })).toMatchObject({ type: "error", code: "bad_message" });
    a.close();
  });

  it("no client field can make someone host: not the name, not join fields", async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    await a.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    const joined = await a.request({ type: "join", name: "host", host: true, participant: { host: true } });
    expect(joined).toMatchObject({ type: "joined", you: { host: false } });
    await nextOfType(a, "framesSnapshot");
    expect(await a.request({ type: "lockSet", locked: true })).toMatchObject({ type: "error", code: "not_host" });
    a.close();
  });

  it("several sockets may be host (a reload, a second tab)", async () => {
    const { code, token } = await newRoom();
    const a = await TestClient.open(code);
    const b = await TestClient.open(code);
    await a.enter("Alex");
    await b.enter("Alex");
    await nextOfType(a, "participant_joined");
    expect(await a.request({ type: "claimHost", token })).toEqual({ type: "hostGranted" });
    b.send({ type: "claimHost", token });
    expect(await nextOfType(b, "hostGranted")).toEqual({ type: "hostGranted" });
    await nextOfType(a, "participantUpdated");
    expect(await a.request({ type: "lockSet", locked: true })).toEqual({ type: "lockChanged", locked: true });
    expect(await nextOfType(b, "lockChanged")).toEqual({ type: "lockChanged", locked: true });
    // b is a host too, so the lock doesn't stop it.
    b.send({ type: "noteAdd", clientRef: "b1", x: 10, y: 10, color: "blue", text: "Mine" });
    expect((await nextOfType(b, "noteAdded")).note.text).toBe("Mine");
    closeAll(a, b);
  });

  it("host survives hibernation (it lives in the socket attachment)", async () => {
    const { code, token, stub } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex");
    await a.request({ type: "claimHost", token });
    await evictDurableObject(stub);
    expect(await a.request({ type: "lockSet", locked: true })).toEqual({ type: "lockChanged", locked: true });
    a.close();
  });
});

/** One message of every board-changing type, as a non-host would send it, with the ref fields a refusal must carry. */
function mutating(noteId: string, frameId: string, shapeId = "shape00000000000"): [ClientMessageType, Record<string, unknown>, Record<string, unknown>][] {
  return [
    ["noteAdd", { type: "noteAdd", clientRef: "g1", x: 100, y: 100, color: "pink", text: "Hi" }, { clientRef: "g1" }],
    ["noteEdit", { type: "noteEdit", id: noteId, text: "Changed" }, { noteId }],
    ["noteMove", { type: "noteMove", id: noteId, x: 300, y: 300, final: true }, { noteId }],
    ["noteResize", { type: "noteResize", id: noteId, x: 10, y: 10, w: 200, h: 200, final: true }, { noteId }],
    ["noteDelete", { type: "noteDelete", id: noteId }, { noteId }],
    ["noteBatch", { type: "noteBatch", ops: [{ op: "move", id: noteId, x: 50, y: 50 }], final: true }, { noteIds: [noteId] }],
    ["notesOrder", { type: "notesOrder", ids: [noteId], action: "back" }, { noteIds: [noteId] }],
    ["frameAdd", { type: "frameAdd", clientRef: "g2", x: 1000, y: 1000, color: "green", title: "No" }, { clientRef: "g2" }],
    ["frameEdit", { type: "frameEdit", id: frameId, title: "Changed" }, { frameId }],
    ["frameMove", { type: "frameMove", id: frameId, x: 40, y: 640, final: true, noteIds: [noteId] }, { frameId, noteIds: [noteId] }],
    ["frameResize", { type: "frameResize", id: frameId, x: 0, y: 600, w: 700, h: 500, final: true }, { frameId }],
    ["frameDelete", { type: "frameDelete", id: frameId }, { frameId }],
    ["itemsAdd", { type: "itemsAdd", clientRef: "g3", notes: [{ ref: "r1", x: 10, y: 10, w: 160, h: 160, text: "", color: "yellow", fontSize: "m", bold: false, italic: false, textColor: "auto", align: "left", titleFontSize: "m", titleBold: false, titleItalic: false, titleTextColor: "auto", titleAlign: "left" }] }, { clientRef: "g3" }],
    // Shapes (protocol v15).
    ["shapeAdd", { type: "shapeAdd", clientRef: "g4", kind: "rect", x: 10, y: 10 }, { clientRef: "g4" }],
    ["shapeEdit", { type: "shapeEdit", id: shapeId, text: "Changed" }, { shapeId }],
    ["shapeMove", { type: "shapeMove", id: shapeId, x: 300, y: 300, final: true }, { shapeId }],
    ["shapeResize", { type: "shapeResize", id: shapeId, x: 10, y: 10, w: 300, h: 200, final: true }, { shapeId }],
    ["shapeDelete", { type: "shapeDelete", id: shapeId }, { shapeId }],
    ["shapeBatch", { type: "shapeBatch", ops: [{ op: "move", id: shapeId, x: 50, y: 50 }], final: true }, { shapeIds: [shapeId] }],
  ];
}

describe("the lock", () => {
  it("every client message type is classified, and exactly these change the board", () => {
    const writes = Object.entries(BOARD_WRITES).filter(([, w]) => w).map(([t]) => t).sort();
    expect(writes).toEqual(mutating("x", "y").map(([t]) => t).sort());
  });

  it("only a host can set it; a guest gets not_host and nothing is written", async () => {
    const { host, guest, stub } = await hostedRoom();
    const before = await rowsWritten(stub);
    expect(await guest.request({ type: "lockSet", locked: true })).toMatchObject({ type: "error", code: "not_host" });
    expect(await rowsWritten(stub)).toBe(before);
    expect(await host.quiet()).toBe(true);
    closeAll(host, guest);
  });

  it("a host locks: everyone hears lockChanged, one meta row is written; setting it again writes nothing", async () => {
    const { host, guest, stub } = await hostedRoom();
    const before = await rowsWritten(stub);
    await lock(host, guest);
    const once = (await rowsWritten(stub)) - before;
    expect(once).toBeGreaterThan(0);
    expect(once).toBeLessThanOrEqual(2);
    expect((await meta(stub)).locked).toBe(1);
    // Unchanged: the sender is answered, nobody else hears, nothing is written.
    expect(await host.request({ type: "lockSet", locked: true })).toEqual({ type: "lockChanged", locked: true });
    expect(await guest.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(before + once);
    await lock(host, guest, false);
    expect((await meta(stub)).locked).toBe(0);
    closeAll(host, guest);
  });

  it.each(mutating("NOTE", "FRAME").map(([t]) => t))("refuses a guest's %s with board_locked and the rollback refs; no write, no broadcast", async (type) => {
    const { host, guest, stub, note, frame, shape } = await hostedRoom();
    await lock(host, guest);
    const [, message, refs] = mutating(note.id, frame.id, shape.id).find(([t]) => t === type)!;
    const before = await rowsWritten(stub);
    const rows = await allRows(stub);
    const reply = await guest.request(message);
    expect(reply).toMatchObject({ type: "error", code: "board_locked", ...refs });
    expect(await rowsWritten(stub)).toBe(before);
    expect(await allRows(stub)).toEqual(rows);
    expect(await host.quiet()).toBe(true);
    closeAll(host, guest);
  });

  it("live drags by a guest are refused too (and not relayed)", async () => {
    const { host, guest, note, frame } = await hostedRoom();
    await lock(host, guest);
    expect(await guest.request({ type: "noteMove", id: note.id, x: 5, y: 5, final: false })).toMatchObject({ code: "board_locked", noteId: note.id });
    expect(await guest.request({ type: "frameMove", id: frame.id, x: 5, y: 605, final: false })).toMatchObject({ code: "board_locked", frameId: frame.id });
    expect(await host.quiet(200)).toBe(true);
    closeAll(host, guest);
  });

  it("hosts still edit; chat, joining and leaving still work", async () => {
    const { code, host, guest, note } = await hostedRoom();
    await lock(host, guest);
    host.send({ type: "noteEdit", id: note.id, text: "Host edit" });
    expect((await nextOfType(guest, "noteUpdated")).note.text).toBe("Host edit");
    guest.send({ type: "say", text: "Can I?" });
    expect(await nextOfType(host, "echo")).toMatchObject({ text: "Can I?" });
    const c = await TestClient.open(code);
    const joined = await c.enter("Priya");
    expect(joined.locked).toBe(true);
    c.close();
    expect(await nextOfType(host, "participant_left")).toMatchObject({ type: "participant_left" });
    closeAll(host, guest);
  });

  it("refused messages still spend the rate budget", async () => {
    const { host, guest, stub } = await hostedRoom();
    await lock(host, guest);
    for (let i = 0; i < 40; i++) guest.send({ type: "noteAdd", clientRef: `r${i}`, x: 10, y: 10, color: "yellow", text: "x" });
    const codes = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const m = await guest.next();
      if (m.type === "error") codes.add(m.code);
    }
    expect(codes.has("board_locked")).toBe(true);
    // Each refusal took a token like any message: the guest's bucket is far below its burst of 40.
    const tokens = await runInDurableObject(stub, (_r, state) =>
      Math.min(...state.getWebSockets().map((ws) => (ws.deserializeAttachment() as { participant: { name: string } | null; tokens: number })).filter((a) => a.participant?.name === "Sam").map((a) => a.tokens)),
    );
    expect(tokens).toBeLessThan(20);
    closeAll(host, guest);
  });

  it("persists across hibernation and is sent to joiners in joined", async () => {
    const { code, host, guest, stub } = await hostedRoom();
    await lock(host, guest);
    closeAll(host, guest);
    await new Promise((r) => setTimeout(r, 50));
    await evictDurableObject(stub);
    const c = await TestClient.open(code);
    expect((await c.enter("Priya")).locked).toBe(true);
    expect(await c.request({ type: "noteAdd", clientRef: "z1", x: 1, y: 1, color: "yellow", text: "" })).toMatchObject({ code: "board_locked", clientRef: "z1" });
    c.close();
  });
});

describe("the timer", () => {
  it("only a host can start or stop it", async () => {
    const { host, guest, stub } = await hostedRoom();
    const before = await rowsWritten(stub);
    expect(await guest.request({ type: "timerStart", durationMs: 60_000 })).toMatchObject({ code: "not_host" });
    expect(await guest.request({ type: "timerStop" })).toMatchObject({ code: "not_host" });
    expect(await rowsWritten(stub)).toBe(before);
    closeAll(host, guest);
  });

  it("start: stored by the server's clock, sent to everyone with serverNow; replacing it works", async () => {
    const { host, guest, stub } = await hostedRoom();
    const t0 = Date.now();
    const started = await host.request({ type: "timerStart", durationMs: 300_000 });
    expect(started).toMatchObject({ type: "timerChanged", timer: { durationMs: 300_000 } });
    const timer = (started as Extract<ServerMessage, { type: "timerChanged" }>).timer!;
    expect(timer.startedAt).toBeGreaterThanOrEqual(t0 - 5_000);
    expect(timer.serverNow).toBeGreaterThanOrEqual(timer.startedAt);
    expect(await nextOfType(guest, "timerChanged")).toMatchObject({ timer: { startedAt: timer.startedAt, durationMs: 300_000 } });
    expect(await meta(stub)).toMatchObject({ timer_started_at: timer.startedAt, timer_duration_ms: 300_000 });
    const replaced = await host.request({ type: "timerStart", durationMs: 60_000 });
    expect(replaced).toMatchObject({ timer: { durationMs: 60_000 } });
    expect((await meta(stub)).timer_duration_ms).toBe(60_000);
    closeAll(host, guest);
  });

  it(`durations outside ${TIMER_MIN_MS} ms to ${TIMER_MAX_MS} ms are refused (bad_message), not clamped`, async () => {
    const { host, guest, stub } = await hostedRoom();
    const before = await rowsWritten(stub);
    for (const durationMs of [0, TIMER_MIN_MS - 1, TIMER_MAX_MS + 1, 1500.5, -5]) {
      expect(await host.request({ type: "timerStart", durationMs })).toMatchObject({ type: "error", code: "bad_message" });
    }
    expect(await rowsWritten(stub)).toBe(before);
    expect(await host.request({ type: "timerStart", durationMs: TIMER_MIN_MS })).toMatchObject({ timer: { durationMs: TIMER_MIN_MS } });
    expect(await host.request({ type: "timerStart", durationMs: TIMER_MAX_MS })).toMatchObject({ timer: { durationMs: TIMER_MAX_MS } });
    closeAll(host, guest);
  });

  it("stop clears it for everyone; stopping nothing writes nothing", async () => {
    const { host, guest, stub } = await hostedRoom();
    await host.request({ type: "timerStart", durationMs: 60_000 });
    await nextOfType(guest, "timerChanged");
    expect(await host.request({ type: "timerStop" })).toEqual({ type: "timerChanged", timer: null });
    expect(await nextOfType(guest, "timerChanged")).toEqual({ type: "timerChanged", timer: null });
    expect(await meta(stub)).not.toHaveProperty("timer_started_at");
    const before = await rowsWritten(stub);
    expect(await host.request({ type: "timerStop" })).toEqual({ type: "timerChanged", timer: null });
    expect(await guest.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(before);
    closeAll(host, guest);
  });

  it("persists across hibernation and joiners get it with serverNow", async () => {
    const { code, host, guest, stub } = await hostedRoom();
    const timer = ((await host.request({ type: "timerStart", durationMs: 600_000 })) as Extract<ServerMessage, { type: "timerChanged" }>).timer!;
    closeAll(host, guest);
    await new Promise((r) => setTimeout(r, 50));
    await evictDurableObject(stub);
    const c = await TestClient.open(code);
    const joined = await c.enter("Priya");
    expect(joined.timer).toMatchObject({ startedAt: timer.startedAt, durationMs: 600_000 });
    expect(joined.timer!.serverNow).toBeGreaterThanOrEqual(timer.serverNow);
    c.close();
  });
});

describe("End session", () => {
  it("only a host can end it", async () => {
    const { host, guest, stub } = await hostedRoom();
    expect(await guest.request({ type: "endSession" })).toMatchObject({ code: "not_host" });
    expect((await allRows(stub)).notes).toHaveLength(1);
    closeAll(host, guest);
  });

  it("tells everyone, closes every socket with 4411, deletes everything and leaves the ended_at tombstone", async () => {
    const { code, host, guest, stub } = await hostedRoom();
    await lock(host, guest);
    await host.request({ type: "timerStart", durationMs: 60_000 });
    await nextOfType(guest, "timerChanged");
    const lurker = await TestClient.open(code); // never joined
    const t0 = Date.now();
    host.send({ type: "endSession" });
    expect(await nextOfType(guest, "sessionEnded")).toEqual({ type: "sessionEnded" });
    expect(await nextOfType(host, "sessionEnded")).toEqual({ type: "sessionEnded" });
    expect(await host.waitClose()).toBe(ROOM_ENDED_CLOSE_CODE);
    expect(await guest.waitClose()).toBe(ROOM_ENDED_CLOSE_CODE);
    expect(await lurker.waitClose()).toBe(ROOM_ENDED_CLOSE_CODE);
    await new Promise((r) => setTimeout(r, 50));
    const rows = await allRows(stub);
    expect(Object.keys(rows)).toEqual(["meta"]);
    expect(rows.meta!.map((r) => r.key)).toEqual(["ended_at"]);
    expect(Number(rows.meta![0]!.value)).toBeGreaterThanOrEqual(t0 - 5_000);
    expect(await runInDurableObject(stub, (_r, state) => state.storage.getAlarm())).toBeNull();
  });

  it("later joins (any protocol version) are closed with 4411 'ended' and create nothing", async () => {
    const { code, host, guest, stub } = await hostedRoom();
    host.send({ type: "endSession" });
    await guest.waitClose();
    await new Promise((r) => setTimeout(r, 50));
    const rows = await allRows(stub);
    const before = await rowsWritten(stub);
    for (const version of [PROTOCOL_VERSION, 11]) {
      const c = await TestClient.open(code);
      const reason = new Promise<string>((resolve) => c.ws.addEventListener("close", (e) => resolve(e.reason)));
      c.send({ type: "hello", protocolVersion: version });
      expect(await c.waitClose()).toBe(ROOM_ENDED_CLOSE_CODE);
      expect(await reason).toBe(ENDED_REASON);
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(await rowsWritten(stub)).toBe(before);
    // After a wake, too: nothing is set up again and nothing is written.
    await evictDurableObject(stub);
    const c = await TestClient.open(code);
    expect(await c.waitClose()).toBe(ROOM_ENDED_CLOSE_CODE);
    await new Promise((r) => setTimeout(r, 50));
    expect(await allRows(stub)).toEqual(rows);
    expect(await rowsWritten(stub)).toBe(0);
  });

  it("an ended room's alarm (if one fires) does nothing", async () => {
    const { host, guest, stub } = await hostedRoom();
    host.send({ type: "endSession" });
    await guest.waitClose();
    await new Promise((r) => setTimeout(r, 50));
    const rows = await allRows(stub);
    await runInDurableObject(stub, (r: Room) => r.alarm());
    expect(await allRows(stub)).toEqual(rows);
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });
});

describe("protocol v12", () => {
  it("a protocol v11 page is refused with version_mismatch (please reload)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(12);
    expect(await c.request({ type: "hello", protocolVersion: 11 })).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Priya" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });

  it("joined carries locked: false and timer: null in a fresh room", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.enter("Alex")).toMatchObject({ locked: false, timer: null });
    c.close();
  });

  it("expiry still works and clears the lock and the timer", async () => {
    const { host, guest, stub } = await hostedRoom();
    await lock(host, guest);
    await host.request({ type: "timerStart", durationMs: 60_000 });
    closeAll(host, guest);
    await host.waitClose();
    await guest.waitClose();
    await new Promise((r) => setTimeout(r, 100));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const rows = await allRows(stub);
    expect(Object.keys(rows)).toEqual(["meta"]);
    expect(rows.meta!.map((r) => r.key)).toEqual(["expired_at"]);
  });
});
