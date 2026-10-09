import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  MAX_FOLLOWERS,
  MAX_ZOOM,
  PROTOCOL_VERSION,
  ROOM_ENDED_CLOSE_CODE,
  VIEWPORT_MARGIN,
  type ServerMessage,
} from "@stickyard/shared";
import { BRING_LIMITS, SOCKET_LIMITS, VIEWPORT_LIMITS } from "../src/limits";
import type { Room } from "../src/room";
import { SCHEMA_VERSION } from "../src/noteStore";
import { TestClient, fullMessageBudget, nextOfType, specHostToken, specRoomCode } from "./helpers";

/*
 * Protocol v19 (Follow and Bring to me, part 1: relay). A page follows one participant
 * (followStart / followStop); that participant's page sends `viewport` only while it has
 * followers, and the relay forwards it as viewportUpdate to those followers only. The followed
 * person hears only a count (followersChanged). A host may bring everyone to their view
 * (bringToMe → broughtToMe). Nothing is stored, nothing is scheduled; state lives in the socket
 * attachments (so it survives hibernation). Fake keys only; generic names.
 */

vi.setConfig({ testTimeout: 30_000 });

type Stub = DurableObjectStub<Room>;

async function newRoom() {
  const { code, id } = await specRoomCode();
  return { code, id, token: await specHostToken(id), stub: env.ROOM.get(env.ROOM.idFromName(id)) as Stub };
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
/** A random id in the server's format that names nobody. */
const unknownId = () => b64url(crypto.getRandomValues(new Uint8Array(12)));
const newKey = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
const rowsWritten = (stub: Stub) => runInDurableObject(stub, (r: Room) => r.rowsWritten);
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const closeAll = (...cs: TestClient[]) => cs.forEach((c) => c.close());

async function drain(...cs: TestClient[]) {
  for (const c of cs) while (!(await c.quiet(60))) await c.next(1).catch(() => undefined);
}

/** Every raw message a client receives from now on. */
function recorded(c: TestClient): string[] {
  const raw: string[] = [];
  c.ws.addEventListener("message", (e) => raw.push(String(e.data)));
  return raw;
}
const parsed = (raw: readonly string[]) => raw.map((r) => JSON.parse(r) as ServerMessage);

/** Counts every storage call the room makes from now on (see cursors.test.ts). */
async function watchStorage(stub: Stub): Promise<() => Promise<number>> {
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

/** Alex, Sam and Jo joined in a fresh room, joins drained. */
async function trio() {
  const room = await newRoom();
  const a = await TestClient.open(room.code);
  const b = await TestClient.open(room.code);
  const c = await TestClient.open(room.code);
  const alex = (await a.enter("Alex")).you;
  const sam = (await b.enter("Sam")).you;
  const jo = (await c.enter("Jo")).you;
  await drain(a, b, c);
  return { ...room, a, b, c, alex, sam, jo };
}

/** `who` follows `target`; the target hears the new count. */
async function follow(who: TestClient, target: TestClient, targetId: string, count: number) {
  who.send({ type: "followStart", target: targetId });
  expect(await nextOfType(target, "followersChanged")).toEqual({ type: "followersChanged", count });
}

const view = (x: number, y: number, zoom = 1) => ({ type: "viewport" as const, x, y, zoom });

describe("follow and unfollow", () => {
  it("followStart: the target hears a count only; the follower gets the target's viewports; followStop drops the count", async () => {
    const { a, b, c, alex } = await trio();
    await follow(c, a, alex.id, 1);
    expect(await c.quiet()).toBe(true);
    expect(await b.quiet()).toBe(true);
    a.send(view(100, 200, 0.5));
    expect(await c.next()).toEqual({ type: "viewportUpdate", id: alex.id, x: 100, y: 200, zoom: 0.5 });
    expect(await a.quiet()).toBe(true);
    expect(await b.quiet()).toBe(true);
    c.send({ type: "followStop" });
    expect(await a.next()).toEqual({ type: "followersChanged", count: 0 });
    a.send(view(1, 1));
    expect(await c.quiet()).toBe(true);
    closeAll(a, b, c);
  });

  it("two followers: the count goes 1, 2, 1, 0", async () => {
    const { a, b, c, alex } = await trio();
    await follow(b, a, alex.id, 1);
    await follow(c, a, alex.id, 2);
    a.send(view(5, 6));
    expect(await b.next()).toEqual({ type: "viewportUpdate", id: alex.id, x: 5, y: 6, zoom: 1 });
    expect(await c.next()).toEqual({ type: "viewportUpdate", id: alex.id, x: 5, y: 6, zoom: 1 });
    b.send({ type: "followStop" });
    expect(await a.next()).toEqual({ type: "followersChanged", count: 1 });
    c.send({ type: "followStop" });
    expect(await a.next()).toEqual({ type: "followersChanged", count: 0 });
    closeAll(a, b, c);
  });

  it("followStop while following nobody, or following the same person again: nothing sent", async () => {
    const { a, b, c, alex } = await trio();
    c.send({ type: "followStop" });
    await follow(c, a, alex.id, 1);
    c.send({ type: "followStart", target: alex.id });
    expect(await a.quiet()).toBe(true);
    expect(await b.quiet()).toBe(true);
    expect(await c.quiet()).toBe(true);
    closeAll(a, b, c);
  });

  it("a new followStart replaces the old one: the old target's count drops, the new one's rises", async () => {
    const { a, b, c, alex, sam } = await trio();
    await follow(c, a, alex.id, 1);
    c.send({ type: "followStart", target: sam.id });
    expect(await a.next()).toEqual({ type: "followersChanged", count: 0 });
    expect(await b.next()).toEqual({ type: "followersChanged", count: 1 });
    a.send(view(1, 2));
    b.send(view(3, 4));
    expect(await c.next()).toEqual({ type: "viewportUpdate", id: sam.id, x: 3, y: 4, zoom: 1 });
    expect(await c.quiet()).toBe(true);
    closeAll(a, b, c);
  });

  it("yourself: followEnded self, nobody is told anything (and an earlier follow ends)", async () => {
    const { a, b, c, alex, jo } = await trio();
    c.send({ type: "followStart", target: jo.id });
    expect(await c.next()).toEqual({ type: "followEnded", reason: "self" });
    expect(await a.quiet()).toBe(true);
    await follow(c, a, alex.id, 1);
    c.send({ type: "followStart", target: jo.id });
    expect(await a.next()).toEqual({ type: "followersChanged", count: 0 });
    expect(await c.next()).toEqual({ type: "followEnded", reason: "self" });
    expect(await b.quiet()).toBe(true);
    closeAll(a, b, c);
  });

  it("someone not in the room (an unknown id, or a socket that hasn't joined): followEnded not_found", async () => {
    const { code, a, b, c } = await trio();
    c.send({ type: "followStart", target: unknownId() });
    expect(await c.next()).toEqual({ type: "followEnded", reason: "not_found" });
    const lurker = await TestClient.open(code);
    await lurker.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    c.send({ type: "followStart", target: unknownId() });
    expect(await c.next()).toEqual({ type: "followEnded", reason: "not_found" });
    expect(await a.quiet()).toBe(true);
    expect(await b.quiet()).toBe(true);
    expect(await lurker.quiet()).toBe(true);
    closeAll(a, b, c, lurker);
  });

  it("before joining: not_joined, nothing stored in the attachment", async () => {
    const { code, a, alex } = await trio();
    const early = await TestClient.open(code);
    await early.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    expect(await early.request({ type: "followStart", target: alex.id })).toMatchObject({ type: "error", code: "not_joined" });
    expect(await early.request({ type: "followStop" })).toMatchObject({ type: "error", code: "not_joined" });
    expect(await a.quiet()).toBe(true);
    closeAll(a, early);
  });

  it("the follow lives in the attachment as the target's server id, never anything client-made", async () => {
    const { stub, a, c, alex } = await trio();
    await follow(c, a, alex.id, 1);
    const following = await runInDurableObject(stub, (_r, state) =>
      state.getWebSockets().map((ws) => (ws.deserializeAttachment() as { following: string | null }).following),
    );
    expect(following.sort()).toEqual([alex.id, null, null].sort());
    closeAll(a, c);
  });
});

describe("the follower cap", () => {
  it(`MAX_FOLLOWERS (${MAX_FOLLOWERS}) per person; the next is refused with followers_full and follows nobody`, async () => {
    const { code } = await newRoom();
    const leader = await TestClient.open(code);
    const leaderId = (await leader.enter("Alex")).you.id;
    const others: TestClient[] = [];
    for (let i = 0; i <= MAX_FOLLOWERS; i++) {
      const o = await TestClient.open(code);
      await o.enter(`Sam ${i}`);
      others.push(o);
    }
    await drain(leader, ...others);
    for (let i = 0; i < MAX_FOLLOWERS; i++) await follow(others[i]!, leader, leaderId, i + 1);
    const last = others[MAX_FOLLOWERS]!;
    expect(await last.request({ type: "followStart", target: leaderId })).toMatchObject({ type: "error", code: "followers_full" });
    expect(await leader.quiet()).toBe(true);
    leader.send(view(10, 10));
    for (let i = 0; i < MAX_FOLLOWERS; i++) expect(await nextOfType(others[i]!, "viewportUpdate")).toMatchObject({ x: 10 });
    expect(await last.quiet()).toBe(true);
    // A place frees up: the refused page can follow now.
    others[0]!.send({ type: "followStop" });
    expect(await leader.next()).toEqual({ type: "followersChanged", count: MAX_FOLLOWERS - 1 });
    await follow(last, leader, leaderId, MAX_FOLLOWERS);
    closeAll(leader, ...others);
  });
});

describe("viewport forwarding", () => {
  it("only to sockets following the sender, with the sender's id from its socket; never echoed", async () => {
    const { a, b, c, alex } = await trio();
    await follow(c, a, alex.id, 1);
    a.send(view(10.4, 20.6, 0.123456));
    expect(await c.next()).toEqual({ type: "viewportUpdate", id: alex.id, x: 10, y: 21, zoom: 0.123 });
    expect(await a.quiet()).toBe(true);
    expect(await b.quiet()).toBe(true);
    closeAll(a, b, c);
  });

  it("follower's own viewport goes nowhere unless it is followed itself", async () => {
    const { a, b, c, alex } = await trio();
    await follow(c, a, alex.id, 1);
    c.send(view(1, 1));
    expect(await a.quiet()).toBe(true);
    expect(await b.quiet()).toBe(true);
    closeAll(a, b, c);
  });

  it("the edges of the margin are forwarded as is", async () => {
    const { a, c, alex } = await trio();
    await follow(c, a, alex.id, 1);
    a.send(view(-VIEWPORT_MARGIN, BOARD_HEIGHT + VIEWPORT_MARGIN, MAX_ZOOM));
    expect(await c.next()).toEqual({ type: "viewportUpdate", id: alex.id, x: -VIEWPORT_MARGIN, y: BOARD_HEIGHT + VIEWPORT_MARGIN, zoom: MAX_ZOOM });
    a.send(view(BOARD_WIDTH + VIEWPORT_MARGIN, -VIEWPORT_MARGIN, 0.1));
    expect(await c.next()).toEqual({ type: "viewportUpdate", id: alex.id, x: BOARD_WIDTH + VIEWPORT_MARGIN, y: -VIEWPORT_MARGIN, zoom: 0.1 });
    closeAll(a, c);
  });

  it.each([
    ["x past the margin", JSON.stringify(view(-VIEWPORT_MARGIN - 1, 0))],
    ["y past the margin", JSON.stringify(view(0, BOARD_HEIGHT + VIEWPORT_MARGIN + 1))],
    ["zoom too small", JSON.stringify(view(0, 0, 0.01))],
    ["zoom too big", JSON.stringify(view(0, 0, 3))],
    ["NaN (sent as null)", JSON.stringify(view(Number.NaN, 0))],
    ["a huge number literal", '{"type":"viewport","x":1e999,"y":0,"zoom":1}'],
    ["a string", JSON.stringify({ type: "viewport", x: "1", y: 0, zoom: 1 })],
    ["an extra id", JSON.stringify({ type: "viewport", x: 1, y: 1, zoom: 1, id: "AAAAAAAAAAAAAAAA" })],
    ["followStart with a name", JSON.stringify({ type: "followStart", target: "AAAAAAAAAAAAAAAA", name: "Sam" })],
    ["bringToMe with a from", JSON.stringify({ type: "bringToMe", x: 1, y: 1, zoom: 1, from: "AAAAAAAAAAAAAAAA" })],
  ])("%s: a plain bad_message, nothing forwarded", async (_label, raw) => {
    const { a, b, c, alex } = await trio();
    await follow(c, a, alex.id, 1);
    expect(await a.request(raw)).toMatchObject({ type: "error", code: "bad_message" });
    expect(await b.quiet()).toBe(true);
    expect(await c.quiet()).toBe(true);
    closeAll(a, b, c);
  });

  it("with no followers: dropped, zero fan-out, zero storage calls, no reply", async () => {
    const { stub, a, b, c } = await trio();
    const before = await rowsWritten(stub);
    const ops = await watchStorage(stub);
    for (let i = 0; i < 5; i++) a.send(view(i, i));
    expect(await a.quiet(200)).toBe(true);
    expect(await b.quiet()).toBe(true);
    expect(await c.quiet()).toBe(true);
    expect(await ops()).toBe(0);
    expect(await rowsWritten(stub)).toBe(before);
    closeAll(a, b, c);
  });

  it("with followers: still zero storage calls and nothing scheduled", async () => {
    const { stub, a, c, alex } = await trio();
    await follow(c, a, alex.id, 1);
    const before = await rowsWritten(stub);
    const ops = await watchStorage(stub);
    for (let i = 0; i < 5; i++) a.send(view(i, i));
    for (let i = 0; i < 5; i++) await nextOfType(c, "viewportUpdate");
    c.send({ type: "followStop" });
    await nextOfType(a, "followersChanged");
    await settle();
    expect(await ops()).toBe(0);
    expect(await rowsWritten(stub)).toBe(before);
    expect(await runInDurableObject(stub, (r: Room) => r.timersPending)).toBe(false);
    expect(await runInDurableObject(stub, (_r, state) => state.storage.getAlarm())).toBeNull();
    closeAll(a, c);
  });

  it("before joining: dropped silently", async () => {
    const { code, a, b, c } = await trio();
    const early = await TestClient.open(code);
    early.send(view(1, 1));
    await early.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    early.send(view(1, 1));
    expect(await early.quiet()).toBe(true);
    expect(await a.quiet()).toBe(true);
    closeAll(a, b, c, early);
  });

  it("a locked board still forwards viewports and follows (they aren't board writes)", async () => {
    const { token, a, b, c, sam } = await trio();
    expect(await a.request({ type: "claimHost", token })).toEqual({ type: "hostGranted" });
    expect(await a.request({ type: "lockSet", locked: true })).toEqual({ type: "lockChanged", locked: true });
    await drain(b, c);
    await follow(c, b, sam.id, 1);
    b.send(view(7, 8));
    expect(await c.next()).toEqual({ type: "viewportUpdate", id: sam.id, x: 7, y: 8, zoom: 1 });
    closeAll(a, b, c);
  });
});

describe("leaving clears following both ways", () => {
  it("a follower closes (Leave): the target's count drops before participant_left", async () => {
    const { a, b, c, alex, jo } = await trio();
    await follow(c, a, alex.id, 1);
    c.close();
    expect(await a.next()).toEqual({ type: "followersChanged", count: 0 });
    expect(await a.next()).toEqual({ type: "participant_left", id: jo.id });
    expect(await nextOfType(b, "participant_left")).toEqual({ type: "participant_left", id: jo.id });
    expect(await b.quiet()).toBe(true);
    closeAll(a, b);
  });

  it("the target closes: each follower gets followEnded target_left before participant_left, and follows nobody after", async () => {
    const { stub, a, b, c, alex } = await trio();
    await follow(b, a, alex.id, 1);
    await follow(c, a, alex.id, 2);
    a.close();
    for (const f of [b, c]) {
      expect(await f.next()).toEqual({ type: "followEnded", reason: "target_left" });
      expect(await f.next()).toEqual({ type: "participant_left", id: alex.id });
    }
    const following = await runInDurableObject(stub, (_r, state) =>
      state.getWebSockets().flatMap((ws) => {
        const att = ws.deserializeAttachment() as { participant: unknown; following: string | null };
        return att.participant ? [att.following] : [];
      }),
    );
    expect(following).toEqual([null, null]);
    closeAll(b, c);
  });

  it("an evicted (rate-limited) target: followEnded; an evicted follower: the count drops", async () => {
    const { a, b, c, alex, sam } = await trio();
    await follow(c, a, alex.id, 1);
    await follow(a, b, sam.id, 1);
    for (let i = 0; i < SOCKET_LIMITS.burst + SOCKET_LIMITS.maxViolations * 10; i++) a.send({ type: "say", text: "spam" });
    expect(await a.waitClose()).toBe(1008);
    expect(await nextOfType(c, "followEnded")).toEqual({ type: "followEnded", reason: "target_left" });
    expect(await nextOfType(b, "followersChanged")).toEqual({ type: "followersChanged", count: 0 });
    closeAll(b, c);
  });

  it("End session: followers get followEnded before sessionEnded; nothing about following after it", async () => {
    const { token, a, b, c, alex, sam } = await trio();
    expect(await a.request({ type: "claimHost", token })).toEqual({ type: "hostGranted" });
    await drain(b, c);
    await follow(c, a, alex.id, 1);
    await follow(a, b, sam.id, 1);
    const got = { b: recorded(b), c: recorded(c) };
    a.send({ type: "endSession" });
    expect(await c.waitClose()).toBe(ROOM_ENDED_CLOSE_CODE);
    expect(await b.waitClose()).toBe(ROOM_ENDED_CLOSE_CODE);
    const types = parsed(got.c).map((m) => m.type);
    const ended = types.indexOf("sessionEnded");
    expect(ended).toBeGreaterThan(0);
    expect(types.slice(0, ended)).toContain("followEnded");
    const after = (raw: string[]) => parsed(raw).slice(parsed(raw).findIndex((m) => m.type === "sessionEnded"));
    for (const raw of [got.b, got.c]) {
      expect(after(raw).some((m) => m.type === "followEnded" || m.type === "followersChanged" || m.type === "viewportUpdate")).toBe(false);
    }
  });

  it("a reconnecting follower starts with no follow; the old socket's follow is gone", async () => {
    const { code, a, b, c, alex } = await trio();
    await follow(c, a, alex.id, 1);
    c.close();
    expect(await a.next()).toEqual({ type: "followersChanged", count: 0 });
    const back = await TestClient.open(code);
    await back.enter("Jo");
    await drain(a, b);
    a.send(view(1, 1));
    expect(await back.quiet()).toBe(true);
    closeAll(a, b, back);
  });

  it("a reconnecting target starts with no followers: the old followers were told it left", async () => {
    const { code, a, b, c, alex } = await trio();
    await follow(c, a, alex.id, 1);
    a.close();
    expect(await c.next()).toEqual({ type: "followEnded", reason: "target_left" });
    const back = await TestClient.open(code);
    const joined = await back.enter("Alex");
    expect(joined.you.id).not.toBe(alex.id);
    await drain(b, c);
    back.send(view(1, 1));
    expect(await c.quiet()).toBe(true);
    // Following the old id is not_found.
    c.send({ type: "followStart", target: alex.id });
    expect(await c.next()).toEqual({ type: "followEnded", reason: "not_found" });
    closeAll(b, c, back);
  });
});

describe("hibernation", () => {
  it("follows survive a wake (from attachments, never storage); counts and forwarding carry on; nothing stored", async () => {
    const { stub, a, b, c, alex } = await trio();
    await follow(c, a, alex.id, 1);
    await evictDurableObject(stub, { webSockets: "hibernate" });
    a.send(view(9, 10));
    expect(await nextOfType(c, "viewportUpdate")).toEqual({ type: "viewportUpdate", id: alex.id, x: 9, y: 10, zoom: 1 });
    await follow(b, a, alex.id, 2);
    await evictDurableObject(stub, { webSockets: "hibernate" });
    c.send({ type: "followStop" });
    expect(await a.next()).toEqual({ type: "followersChanged", count: 1 });
    await evictDurableObject(stub, { webSockets: "hibernate" });
    a.close();
    expect(await nextOfType(b, "followEnded")).toEqual({ type: "followEnded", reason: "target_left" });
    expect(await c.quiet()).toBe(true);
    const stored = await runInDurableObject(stub, async (_r, state) => ({
      keys: (await state.storage.list()).size,
      meta: state.storage.sql.exec<{ key: string }>("SELECT key FROM meta").toArray().map((r) => r.key),
    }));
    expect(stored).toEqual({ keys: 0, meta: ["schema_version"] });
    closeAll(b, c);
  });
});

describe("rate limits", () => {
  it(`VIEWPORT_LIMITS ${VIEWPORT_LIMITS.refillPerSecond}/s burst ${VIEWPORT_LIMITS.burst}; BRING_LIMITS 1 every 5 s, burst 2`, () => {
    expect(VIEWPORT_LIMITS).toEqual({ refillPerSecond: 10, burst: 10 });
    expect(BRING_LIMITS).toEqual({ refillPerSecond: 0.2, burst: 2 });
  });

  it("viewports over their own budget: dropped, each one a violation (no reply), never a throw; edits keep their budget", async () => {
    const { stub, a, b, c, alex } = await trio();
    await follow(c, a, alex.id, 1);
    await fullMessageBudget(stub);
    const got = recorded(c);
    const over = 5;
    for (let i = 0; i < VIEWPORT_LIMITS.burst + over; i++) a.send(view(i, i));
    await settle(300);
    const forwarded = parsed(got).filter((m) => m.type === "viewportUpdate").length;
    expect(forwarded).toBeGreaterThanOrEqual(VIEWPORT_LIMITS.burst);
    expect(forwarded).toBeLessThan(VIEWPORT_LIMITS.burst + over);
    expect(await a.quiet()).toBe(true);
    expect(a.closeCode).toBeNull();
    const strikes = await runInDurableObject(stub, (_r, state) =>
      state.getWebSockets().map((ws) => ws.deserializeAttachment() as { participant: { id: string } | null; strikes: number }).find((s) => s.participant?.id === alex.id)?.strikes,
    );
    expect(strikes).toBeGreaterThan(0);
    // SOCKET_LIMITS untouched by viewports: a whole burst of chat goes through.
    for (let i = 0; i < SOCKET_LIMITS.burst; i++) a.send({ type: "say", text: `m${i}` });
    const replies: ServerMessage[] = [];
    for (let i = 0; i < SOCKET_LIMITS.burst; i++) replies.push(await a.next());
    expect(replies.filter((r) => r.type === "error")).toEqual([]);
    closeAll(a, b, c);
  });

  it("a viewport flood closes the socket (1008) like any other abuse; its followers get followEnded", async () => {
    const { a, b, c, alex } = await trio();
    await follow(c, a, alex.id, 1);
    for (let i = 0; i < VIEWPORT_LIMITS.burst + SOCKET_LIMITS.maxViolations * 3; i++) a.send(view(i % 100, 1));
    expect(await a.waitClose()).toBe(1008);
    expect(await nextOfType(c, "followEnded")).toEqual({ type: "followEnded", reason: "target_left" });
    closeAll(b, c);
  });

  it("bringToMe over its tight budget: rate_limited to the host, nothing to the others", async () => {
    const { token, a, b, c } = await trio();
    expect(await a.request({ type: "claimHost", token })).toEqual({ type: "hostGranted" });
    await drain(b, c);
    const got = recorded(b);
    for (let i = 0; i < BRING_LIMITS.burst; i++) a.send({ type: "bringToMe", x: i, y: i, zoom: 1 });
    expect(await a.request({ type: "bringToMe", x: 99, y: 99, zoom: 1 })).toMatchObject({ type: "error", code: "rate_limited" });
    await settle(100);
    expect(parsed(got).filter((m) => m.type === "broughtToMe").map((m) => (m as { x: number }).x)).toEqual([0, 1]);
    closeAll(a, b, c);
  });
});

describe("bringToMe", () => {
  it("from a host: broughtToMe to everyone but the sender, with the host's id; nothing stored", async () => {
    const { stub, token, a, b, c, alex } = await trio();
    expect(await a.request({ type: "claimHost", token })).toEqual({ type: "hostGranted" });
    await drain(b, c);
    const before = await rowsWritten(stub);
    const ops = await watchStorage(stub);
    a.send({ type: "bringToMe", x: 300.6, y: 400.2, zoom: 0.75 });
    for (const o of [b, c]) expect(await o.next()).toEqual({ type: "broughtToMe", from: alex.id, x: 301, y: 400, zoom: 0.75 });
    expect(await a.quiet()).toBe(true);
    await settle();
    expect(await ops()).toBe(0);
    expect(await rowsWritten(stub)).toBe(before);
    closeAll(a, b, c);
  });

  it("from a guest: not_host, nothing sent (also during a lock and a silent round)", async () => {
    const { token, a, b, c } = await trio();
    expect(await b.request({ type: "bringToMe", x: 1, y: 1, zoom: 1 })).toMatchObject({ type: "error", code: "not_host" });
    expect(await a.request({ type: "claimHost", token })).toEqual({ type: "hostGranted" });
    expect(await a.request({ type: "lockSet", locked: true })).toEqual({ type: "lockChanged", locked: true });
    expect(await a.request({ type: "silentStart" })).toMatchObject({ type: "silentChanged", active: true });
    await drain(b, c);
    expect(await b.request({ type: "bringToMe", x: 1, y: 1, zoom: 1 })).toMatchObject({ type: "error", code: "not_host" });
    expect(await a.quiet()).toBe(true);
    expect(await c.quiet()).toBe(true);
    // The host still can, locked and silent.
    a.send({ type: "bringToMe", x: 2, y: 2, zoom: 1 });
    expect(await nextOfType(c, "broughtToMe")).toMatchObject({ x: 2, y: 2 });
    closeAll(a, b, c);
  });

  it("before joining: not_joined", async () => {
    const { code } = await newRoom();
    const early = await TestClient.open(code);
    await early.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    expect(await early.request({ type: "bringToMe", x: 1, y: 1, zoom: 1 })).toMatchObject({ type: "error", code: "not_joined" });
    early.close();
  });

  it("nothing is held back for a late joiner", async () => {
    const { code, token, a, b, c } = await trio();
    expect(await a.request({ type: "claimHost", token })).toEqual({ type: "hostGranted" });
    a.send({ type: "bringToMe", x: 5, y: 5, zoom: 1 });
    await nextOfType(b, "broughtToMe");
    const late = await TestClient.open(code);
    const raw = recorded(late);
    await late.enter("Kai");
    expect(await late.quiet(200)).toBe(true);
    expect(parsed(raw).some((m) => m.type === "broughtToMe")).toBe(false);
    closeAll(a, b, c, late);
  });
});

describe("the canary: a silent round", () => {
  /**
   * A host (Alex), a writer (Sam, with a key) and a follower (Jo). Sam adds a sealed note with
   * canary text far from everything, then pans to it while Jo follows; Alex brings everyone to a
   * spot; Jo follows Alex too. Every raw message to Alex and Jo is read: none names the sealed
   * note, its text or a writer id, and every viewport they get is exactly what the sender sent
   * (rounded), so it says nothing a cursor doesn't already: where that person is looking.
   */
  it("follow and bring messages never carry a sealed note; viewports are the sender's own numbers, whatever is sealed", async () => {
    const { code, token } = await newRoom();
    const host = await TestClient.open(code);
    const writer = await TestClient.open(code);
    const follower = await TestClient.open(code);
    const raw = { host: recorded(host), follower: recorded(follower) };
    const alex = (await host.enter("Alex", newKey())).you;
    const sam = (await writer.enter("Sam", newKey())).you;
    await follower.enter("Jo", newKey());
    await drain(host, writer, follower);
    expect(await host.request({ type: "claimHost", token })).toEqual({ type: "hostGranted" });
    expect(await host.request({ type: "silentStart" })).toMatchObject({ type: "silentChanged", active: true });
    await drain(writer, follower);

    const sequence = [view(5000, 3500, 1.5), view(5100, 3600, 2), view(200, 300, 0.4)];
    const runFollow = async () => {
      await follow(follower, writer, sam.id, 1);
      const got: ServerMessage[] = [];
      for (const v of sequence) {
        writer.send(v);
        got.push(await nextOfType(follower, "viewportUpdate"));
      }
      follower.send({ type: "followStop" });
      await nextOfType(writer, "followersChanged");
      return got;
    };
    const without = await runFollow();

    writer.send({ type: "noteAdd", clientRef: "s1", x: 5000, y: 3500, color: "yellow", text: "CANARY sealed text" });
    const sealed = (await nextOfType(writer, "noteAdded")).note;
    await drain(host, writer, follower);
    const withSealed = await runFollow();
    // The same numbers in, the same messages out: nothing about the sealed note changed them.
    expect(withSealed).toEqual(without);
    expect(withSealed).toEqual(sequence.map((v) => ({ type: "viewportUpdate", id: sam.id, x: v.x, y: v.y, zoom: v.zoom })));

    await follow(follower, host, alex.id, 1);
    host.send(view(10, 10));
    await nextOfType(follower, "viewportUpdate");
    host.send({ type: "bringToMe", x: 5000, y: 3500, zoom: 1 });
    await nextOfType(follower, "broughtToMe");
    await nextOfType(writer, "broughtToMe");
    writer.close();
    await nextOfType(follower, "participant_left");
    await drain(host, follower);

    for (const transcript of [raw.host, raw.follower]) {
      const text = transcript.join("\n");
      expect(text).not.toContain("CANARY");
      expect(text).not.toContain(sealed.id);
      // Every follow-related message is one of the known shapes, with no extra keys.
      for (const m of parsed(transcript)) {
        if (m.type === "viewportUpdate") expect(Object.keys(m).sort()).toEqual(["id", "type", "x", "y", "zoom"]);
        if (m.type === "followersChanged") expect(Object.keys(m).sort()).toEqual(["count", "type"]);
        if (m.type === "followEnded") expect(Object.keys(m).sort()).toEqual(["reason", "type"]);
        if (m.type === "broughtToMe") expect(Object.keys(m).sort()).toEqual(["from", "type", "x", "y", "zoom"]);
      }
    }
    closeAll(host, follower);
  });
});

describe("versions", () => {
  it("protocol 19 and stored schema 10 (no stored change); a v18 page is asked to reload", async () => {
    expect(PROTOCOL_VERSION).toBe(19);
    expect(SCHEMA_VERSION).toBe(10);
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request({ type: "hello", protocolVersion: 18 })).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Alex" })).toMatchObject({ type: "error", code: "bad_message" });
    expect(await c.request({ type: "followStart", target: unknownId() })).toMatchObject({ type: "error", code: "not_joined" });
    c.close();
  });
});
