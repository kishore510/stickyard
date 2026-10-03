import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@stickyard/shared";
import { createRoomCode, verifyRoomCode } from "../src/roomCode";
import {
  BASE,
  PAGES_ORIGIN,
  TEST_SIGNING_KEY,
  TestClient,
  callWorker,
  roomPath,
  specRoomCode,
  testEnv,
  wsRequest,
} from "./helpers";

/** Wraps the ROOM namespace and records every property touched on it (idFromName, get, getByName...). */
function spiedRoomNamespace() {
  const touched: string[] = [];
  const real = testEnv.ROOM;
  const ROOM = new Proxy(real, {
    get(target, prop) {
      touched.push(String(prop));
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ROOM, touched };
}

const flip = (c: string) => (c === "A" ? "B" : "A");

async function invalidCodes(): Promise<[string, string][]> {
  const { code, id } = await specRoomCode();
  const sig = code.split(".")[1] ?? "";
  return [
    ["empty", ""],
    ["tampered id", `${flip(id[0] ?? "A")}${id.slice(1)}.${sig}`],
    ["tampered signature", `${id}.${sig.slice(0, -1)}${flip(sig.at(-1) ?? "A")}`],
    ["truncated", code.slice(0, -1)],
    ["signature only", `.${sig}`],
    ["id only", id],
    ["no dot", `${id}${sig}`],
    ["signed with another key", (await specRoomCode("another-test-key")).code],
    ["swapped halves", `${sig}.${id}`],
    ["oversized", `${code}${"A".repeat(5000)}`],
    ["extra part", `${code}.x`],
    ["padded", `${code}=`],
    ["script", "<script>alert(1)</script>"],
  ];
}

describe("GET /health", () => {
  it("returns ok and the protocol version, with no Durable Object involved", async () => {
    const { ROOM, touched } = spiedRoomNamespace();
    const res = await callWorker(new Request(`${BASE}/health`, { headers: { Origin: PAGES_ORIGIN } }), { ROOM });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true, protocolVersion: PROTOCOL_VERSION });
    expect(touched).toEqual([]);
  });

  it("is readable by the Pages origin (CORS)", async () => {
    const res = await exports.default.fetch(new Request(`${BASE}/health`, { headers: { Origin: PAGES_ORIGIN } }));
    expect(res.headers.get("access-control-allow-origin")).toBe(PAGES_ORIGIN);
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("works without an Origin (curl), but grants no CORS", async () => {
    const res = await exports.default.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("room codes", () => {
  it("createRoomCode makes codes in the spec format that verify to their id", async () => {
    const code = await createRoomCode(TEST_SIGNING_KEY);
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    const id = code.split(".")[0];
    expect(await verifyRoomCode(code, TEST_SIGNING_KEY)).toBe(id);
    // The signature is exactly the spec's: HMAC-SHA256 over "stickyard-room-v1:" + id, 128 bits.
    expect((await specRoomCode(TEST_SIGNING_KEY, id)).code).toBe(code);
  });

  it("verifies a code built from the spec", async () => {
    const { code, id } = await specRoomCode();
    expect(await verifyRoomCode(code, TEST_SIGNING_KEY)).toBe(id);
  });

  it("rejects every invalid code, and null", async () => {
    for (const [label, code] of await invalidCodes()) {
      expect(await verifyRoomCode(code, TEST_SIGNING_KEY), label).toBeNull();
    }
    expect(await verifyRoomCode(null, TEST_SIGNING_KEY)).toBeNull();
  });

  it("codes are unique", async () => {
    const codes = new Set(await Promise.all(Array.from({ length: 50 }, () => createRoomCode(TEST_SIGNING_KEY))));
    expect(codes.size).toBe(50);
  });
});

describe("GET /ws?room=<code>", () => {
  it("a valid signed code reaches the room's Durable Object, addressed by id", async () => {
    const { code, id } = await specRoomCode();
    const { ROOM, touched } = spiedRoomNamespace();
    const res = await callWorker(wsRequest(roomPath(code)), { ROOM });
    expect(res.status).toBe(101);
    expect(touched).toContain("idFromName");
    res.webSocket?.accept();
    res.webSocket?.close();

    // Two sockets with the same code meet in the same room.
    const a = await TestClient.open(code);
    const b = await TestClient.open(code);
    await a.enter("Alex");
    const joined = await b.enter("Sam");
    expect(joined.participants.map((p) => p.name).sort()).toEqual(["Alex", "Sam"]);
    a.close();
    b.close();
    expect(id.length).toBe(22);
  });

  it("every invalid code gets the same 404, before any upgrade, and never touches a Durable Object", async () => {
    const bodies = new Set<string>();
    for (const [label, code] of await invalidCodes()) {
      const { ROOM, touched } = spiedRoomNamespace();
      const res = await callWorker(wsRequest(roomPath(code)), { ROOM });
      expect(res.status, label).toBe(404);
      expect(res.webSocket, label).toBeNull();
      expect(touched, label).toEqual([]);
      bodies.add(`${res.headers.get("content-type")}|${await res.text()}`);
    }
    expect(bodies.size).toBe(1);
  });

  it("an invalid code without an Upgrade header also gets 404, not 426", async () => {
    const res = await callWorker(wsRequest(roomPath("nope"), PAGES_ORIGIN, false));
    expect(res.status).toBe(404);
  });

  it("a valid code without an Upgrade header gets 426", async () => {
    const { code } = await specRoomCode();
    const res = await callWorker(wsRequest(roomPath(code), PAGES_ORIGIN, false));
    expect(res.status).toBe(426);
  });

  describe("Origin is checked first", () => {
    it.each([PAGES_ORIGIN, "http://localhost:5173", "http://127.0.0.1:8787"])("upgrades for %s", async (origin) => {
      const { code } = await specRoomCode();
      const res = await exports.default.fetch(wsRequest(roomPath(code), origin));
      expect(res.status).toBe(101);
      res.webSocket?.accept();
      res.webSocket?.close();
    });

    it.each([
      ["another site", "https://evil.example.test"],
      ["missing origin", null],
      ["malformed origin", "not a url"],
      ["opaque null origin", "null"],
      ["pages origin with a path", `${PAGES_ORIGIN}/stickyard`],
    ])("rejects %s with 403, even with a valid code", async (_label, origin) => {
      const { code } = await specRoomCode();
      const { ROOM, touched } = spiedRoomNamespace();
      const res = await callWorker(wsRequest(roomPath(code), origin), { ROOM });
      expect(res.status).toBe(403);
      expect(res.webSocket).toBeNull();
      expect(touched).toEqual([]);
    });
  });
});

describe("the old unauthenticated route is gone", () => {
  it("/ws without a room code never reaches a Durable Object", async () => {
    const { ROOM, touched } = spiedRoomNamespace();
    const res = await callWorker(wsRequest("/ws"), { ROOM });
    res.webSocket?.accept();
    res.webSocket?.close();
    expect(touched).toEqual([]);
  });

  it("a v2 hello without a room code gets no welcome", async () => {
    const client = await TestClient.openPath("/ws");
    const reply = await client.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    expect(reply).toMatchObject({ type: "error", code: "bad_message" });
    expect(await client.waitClose()).toBe(1000);
  });

  it("an old (protocol v1) page still gets version_mismatch, so it shows please reload", async () => {
    const client = await TestClient.openPath("/ws");
    const reply = await client.request({ type: "hello", protocolVersion: 1 });
    expect(reply).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await client.waitClose()).toBe(1000);
  });

  it("the legacy reply still needs an allowed Origin", async () => {
    const res = await exports.default.fetch(wsRequest("/ws", "https://evil.example.test"));
    expect(res.status).toBe(403);
  });
});

describe("other routes", () => {
  it.each([
    ["GET /", "GET", "/"],
    ["GET /rooms", "GET", "/rooms"],
    ["POST /ws", "POST", "/ws"],
    ["GET /nope", "GET", "/nope"],
  ])("%s gets 404", async (_label, method, path) => {
    const res = await exports.default.fetch(new Request(`${BASE}${path}`, { method, headers: { Origin: PAGES_ORIGIN } }));
    expect(res.status).toBe(404);
  });
});

describe("GET /rooms/check?room=<code>", () => {
  it("says ok for a valid code without touching a Durable Object", async () => {
    const { code } = await specRoomCode();
    const { ROOM, touched } = spiedRoomNamespace();
    const res = await callWorker(
      new Request(`${BASE}/rooms/check?room=${encodeURIComponent(code)}`, { headers: { Origin: PAGES_ORIGIN } }),
      { ROOM },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("access-control-allow-origin")).toBe(PAGES_ORIGIN);
    expect(touched).toEqual([]);
  });

  it("gives 404 for invalid codes", async () => {
    for (const [label, code] of await invalidCodes()) {
      const res = await callWorker(
        new Request(`${BASE}/rooms/check?room=${encodeURIComponent(code)}`, { headers: { Origin: PAGES_ORIGIN } }),
      );
      expect(res.status, label).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  it("needs an allowed Origin", async () => {
    const { code } = await specRoomCode();
    const res = await exports.default.fetch(
      new Request(`${BASE}/rooms/check?room=${encodeURIComponent(code)}`, { headers: { Origin: "https://evil.example.test" } }),
    );
    expect(res.status).toBe(403);
  });
});
