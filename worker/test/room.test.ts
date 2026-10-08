import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, MAX_PARTICIPANTS, MAX_TEXT_LENGTH, PROTOCOL_VERSION } from "@stickyard/shared";
import { SOCKET_LIMITS } from "../src/limits";
import { TestClient, nextOfType, specRoomCode } from "./helpers";

async function newRoom() {
  const { code, id } = await specRoomCode();
  const stub = env.ROOM.get(env.ROOM.idFromName(id));
  return { code, stub };
}

const hello = (protocolVersion = PROTOCOL_VERSION) => ({ type: "hello", protocolVersion });

describe("handshake", () => {
  it("answers hello with welcome", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request(hello())).toEqual({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    c.close();
  });

  it("answers a protocol v1 hello with version_mismatch (old cached pages)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request(hello(1))).toMatchObject({ type: "error", code: "version_mismatch" });
    // And it can't join after that.
    expect(await c.request({ type: "join", name: "Alex" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });

  it("answers a protocol v2 hello with version_mismatch (pages from before notes)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request(hello(2))).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Alex" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });

  it("answers a protocol v3 hello with version_mismatch (pages from before note sizes and styles)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request(hello(3))).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Alex" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });

  it("answers a protocol v4 hello with version_mismatch (pages from before title alignment)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request(hello(4))).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Alex" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });

  it("answers a protocol v5 hello with version_mismatch (pages from before title styling)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request(hello(5))).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Alex" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });

  it("answers a protocol v6 hello with version_mismatch (pages from before multi-select)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request(hello(6))).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Alex" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });

  it("answers a future protocol version with version_mismatch", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request(hello(PROTOCOL_VERSION + 1))).toMatchObject({ type: "error", code: "version_mismatch" });
    c.close();
  });

  it("join before hello is refused", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request({ type: "join", name: "Alex" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });
});

describe("join", () => {
  it("assigns an id and the lowest colour, and lists participants", async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    const b = await TestClient.open(code);
    const ja = await a.enter("Alex");
    expect(ja.you).toMatchObject({ name: "Alex", colourIndex: 0 });
    expect(ja.you.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(ja.participants).toEqual([ja.you]);

    const jb = await b.enter("Sam");
    expect(jb.you).toMatchObject({ name: "Sam", colourIndex: 1 });
    expect(jb.you.id).not.toBe(ja.you.id);
    expect(jb.participants).toHaveLength(2);
    expect(jb.participants).toContainEqual(ja.you);
    expect(jb.participants).toContainEqual(jb.you);

    expect(await a.next()).toEqual({ type: "participant_joined", participant: jb.you });
    a.close();
    b.close();
  });

  it("cleans the name on the server", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    const joined = await c.enter("  ‮Al​ex   B  ");
    expect(joined.you.name).toBe("Alex B");
    c.close();
  });

  it("allows duplicate names (they're unverified)", async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    const b = await TestClient.open(code);
    await a.enter("Alex");
    const jb = await b.enter("Alex");
    expect(jb.participants.map((p) => p.name)).toEqual(["Alex", "Alex"]);
    a.close();
    b.close();
  });

  it.each([
    ["empty", ""],
    ["spaces", "    "],
    ["invisible only", "​‮"],
    ["too long", "x".repeat(25)],
  ])("rejects a %s name with invalid_name, and the socket can try again", async (_label, name) => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    await c.request(hello());
    expect(await c.request({ type: "join", name })).toMatchObject({ type: "error", code: "invalid_name" });
    expect(await c.request({ type: "join", name: "Alex" })).toMatchObject({ type: "joined" });
    c.close();
  });

  it("a second join gets already_joined", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    await c.enter("Alex");
    expect(await c.request({ type: "join", name: "Sam" })).toMatchObject({ type: "error", code: "already_joined" });
    c.close();
  });

  it("ignores a client-claimed id and colour", async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    const ja = await a.enter("Alex");
    const b = await TestClient.open(code);
    await b.request(hello());
    const jb = await b.request({ type: "join", name: "Sam", id: ja.you.id, colourIndex: 0, colour: "red" });
    if (jb.type !== "joined") throw new Error("expected joined");
    expect(jb.you.id).not.toBe(ja.you.id);
    expect(jb.you.colourIndex).toBe(1);
    a.close();
    b.close();
  });

  it(`refuses the ${MAX_PARTICIPANTS + 1}th participant with room_full`, async () => {
    const { code } = await newRoom();
    const clients: TestClient[] = [];
    for (let i = 0; i < MAX_PARTICIPANTS; i++) {
      const c = await TestClient.open(code);
      await c.enter(`Person ${i}`);
      clients.push(c);
    }
    const extra = await TestClient.open(code);
    await extra.request(hello());
    expect(await extra.request({ type: "join", name: "One too many" })).toMatchObject({
      type: "error",
      code: "room_full",
    });
    // When someone leaves, there's room again.
    clients[0]?.close();
    const witness = clients[1];
    if (witness) await nextOfType(witness, "participant_left");
    expect(await extra.request({ type: "join", name: "Next" })).toMatchObject({ type: "joined" });
    for (const c of clients) c.close();
    extra.close();
  });

  it("reuses a colour after its owner leaves", async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    const b = await TestClient.open(code);
    const c = await TestClient.open(code);
    await a.enter("A");
    const jb = await b.enter("B");
    await c.enter("C");
    expect(jb.you.colourIndex).toBe(1);
    b.close();
    await nextOfType(a, "participant_left");
    const d = await TestClient.open(code);
    expect((await d.enter("D")).you.colourIndex).toBe(1);
    for (const x of [a, c, d]) x.close();
  });
});

describe("say and echo", () => {
  it("echoes to everyone, with the sender set by the server", async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    const b = await TestClient.open(code);
    const ja = await a.enter("Alex");
    const jb = await b.enter("Sam");
    await nextOfType(a, "participant_joined");

    a.send({ type: "say", text: "Hello <b>there</b>" });
    const expected = { type: "echo", from: ja.you.id, text: "Hello <b>there</b>" };
    expect(await a.next()).toEqual(expected);
    expect(await b.next()).toEqual(expected);

    // A forged sender is ignored.
    b.send({ type: "say", text: "it was me", from: ja.you.id });
    expect(await a.next()).toEqual({ type: "echo", from: jb.you.id, text: "it was me" });
    a.close();
    b.close();
  });

  it("doesn't echo to sockets that haven't joined", async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    const lurker = await TestClient.open(code);
    await a.enter("Alex");
    await lurker.request(hello());
    await a.request({ type: "say", text: "hi" });
    expect(await lurker.quiet()).toBe(true);
    a.close();
    lurker.close();
  });

  it("cleans the text", async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex");
    expect(await a.request({ type: "say", text: "  hi ‮  there​ " })).toMatchObject({ text: "hi there" });
    a.close();
  });

  it.each([
    ["empty", ""],
    ["blank", "  ​ "],
    ["too long", "y".repeat(MAX_TEXT_LENGTH + 1)],
  ])("rejects %s text with bad_message", async (_label, text) => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex");
    expect(await a.request({ type: "say", text })).toMatchObject({ type: "error", code: "bad_message" });
    a.close();
  });

  it("say before join gets not_joined", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request({ type: "say", text: "hi" })).toMatchObject({ type: "error", code: "not_joined" });
    await c.request(hello());
    expect(await c.request({ type: "say", text: "hi" })).toMatchObject({ type: "error", code: "not_joined" });
    c.close();
  });
});

describe("leaving", () => {
  it("tells the others", async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    const b = await TestClient.open(code);
    await a.enter("Alex");
    const jb = await b.enter("Sam");
    b.close();
    expect(await nextOfType(a, "participant_left")).toEqual({ type: "participant_left", id: jb.you.id });
    a.close();
  });

  it("a socket that never joined leaves silently", async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex");
    const lurker = await TestClient.open(code);
    await lurker.request(hello());
    lurker.close();
    expect(await a.quiet(200)).toBe(true);
    a.close();
  });

  it("a room without notes stores no rows (only its schema version)", async () => {
    const { code, stub } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex");
    await a.request({ type: "say", text: "hi" });
    a.close();
    await a.waitClose();
    const stored = await runInDurableObject(stub, async (_i, state) => ({
      keys: (await state.storage.list()).size,
      notes: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM notes").one().n,
      meta: state.storage.sql.exec<{ key: string }>("SELECT key FROM meta").toArray(),
    }));
    expect(stored).toEqual({ keys: 0, notes: 0, meta: [{ key: "schema_version" }] });
  });
});

describe("hibernation", () => {
  it("the participant list is rebuilt from socket attachments", async () => {
    const { code, stub } = await newRoom();
    const a = await TestClient.open(code);
    const b = await TestClient.open(code);
    const ja = await a.enter("Alex");
    const jb = await b.enter("Sam");
    await nextOfType(a, "participant_joined");

    await evictDurableObject(stub, { webSockets: "hibernate" });

    const c = await TestClient.open(code);
    const jc = await c.enter("Kai");
    expect(jc.you.colourIndex).toBe(2);
    expect(jc.participants).toHaveLength(3);
    expect(jc.participants).toContainEqual(ja.you);
    expect(jc.participants).toContainEqual(jb.you);

    // Sockets from before hibernation still work, with their server-set identity.
    a.send({ type: "say", text: "still here" });
    expect(await nextOfType(c, "echo")).toEqual({ type: "echo", from: ja.you.id, text: "still here" });
    // And still count as joined.
    a.send({ type: "join", name: "Again" });
    expect(await nextOfType(a, "error")).toMatchObject({ code: "already_joined" });
    for (const x of [a, b, c]) x.close();
  });
});

describe("rate limiting", () => {
  it("over the burst gets rate_limited, and the socket stays usable", async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex"); // 2 tokens used
    // Well past the burst, so slow test machines (which refill tokens while sending) still go
    // over, but under the violations that close the socket.
    const sent = SOCKET_LIMITS.burst + SOCKET_LIMITS.maxViolations / 2;
    const started = Date.now();
    for (let i = 0; i < sent; i++) a.send({ type: "say", text: `m${i}` });
    const replies = [];
    for (let i = 0; i < sent; i++) replies.push(await a.next());
    const elapsed = (Date.now() - started) / 1000;
    const limited = replies.filter((r) => r.type === "error" && r.code === "rate_limited").length;
    const echoed = replies.filter((r) => r.type === "echo").length;
    // Every message is answered: echoed if a token was there, rate_limited if not. The room refills
    // while a slow runner is still sending, so the echoes are bounded by what could have refilled
    // in the time that really passed, not by a fixed count.
    expect(limited + echoed).toBe(sent);
    const tokens = SOCKET_LIMITS.burst - 2 + Math.ceil(elapsed * SOCKET_LIMITS.refillPerSecond);
    expect(echoed).toBeLessThanOrEqual(Math.min(sent, tokens));
    expect(limited).toBeGreaterThanOrEqual(Math.max(0, sent - tokens));

    // Tokens come back over time.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await a.request({ type: "say", text: "later" })).toMatchObject({ type: "echo", text: "later" });
    a.close();
  });

  it(`closes the socket after ${SOCKET_LIMITS.maxViolations} violations in a window`, async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex");
    for (let i = 0; i < SOCKET_LIMITS.burst + SOCKET_LIMITS.maxViolations * 10; i++) a.send({ type: "say", text: "spam" });
    expect(await a.waitClose()).toBe(1008);
  });

  it("a sender at about twice the rate is still closed (violations needn't be consecutive)", async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    await a.enter("Alex");
    for (let i = 0; i < SOCKET_LIMITS.burst; i++) a.send({ type: "say", text: "fill" });
    // Each pause lets about one token back, so accepted and refused messages alternate.
    for (let i = 0; i < SOCKET_LIMITS.maxViolations * 2 + 4 && a.closeCode === null; i++) {
      a.send({ type: "say", text: "a" });
      a.send({ type: "say", text: "b" });
      await new Promise((resolve) => setTimeout(resolve, 1000 / SOCKET_LIMITS.refillPerSecond));
    }
    expect(await a.waitClose()).toBe(1008);
  });

  it("malformed messages count towards the limit too", async () => {
    const { code } = await newRoom();
    const a = await TestClient.open(code);
    for (let i = 0; i < SOCKET_LIMITS.burst + SOCKET_LIMITS.maxViolations * 10; i++) a.send("not json");
    expect(await a.waitClose()).toBe(1008);
  });
});

describe("malformed messages never throw and leave the socket usable", () => {
  it.each([
    ["non-JSON", "not json"],
    ["unknown type", JSON.stringify({ type: "nope" })],
    ["hello without version", JSON.stringify({ type: "hello" })],
    ["JSON null", "null"],
    ["say with an object", JSON.stringify({ type: "say", text: { a: 1 } })],
    ["a server message", JSON.stringify({ type: "echo", from: "AAAAAAAAAAAAAAAA", text: "x" })],
  ])("%s gets bad_message", async (_label, data) => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request(data)).toMatchObject({ type: "error", code: "bad_message" });
    expect((await c.enter("Alex")).type).toBe("joined");
    c.close();
  });

  it("binary frames get bad_message", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(await c.request(new ArrayBuffer(4))).toMatchObject({ type: "error", code: "bad_message" });
    expect((await c.enter("Alex")).type).toBe("joined");
    c.close();
  });

  it("an oversized message gets too_large", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    await c.enter("Alex");
    const big = JSON.stringify({ type: "say", text: "x".repeat(MAX_MESSAGE_BYTES) });
    expect(await c.request(big)).toMatchObject({ type: "error", code: "too_large" });
    expect(await c.request({ type: "say", text: "ok" })).toMatchObject({ type: "echo" });
    c.close();
  });
});
