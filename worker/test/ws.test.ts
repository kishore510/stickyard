import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, serverMessageSchema, type ServerMessage } from "@stickyard/shared";

// Matches ALLOWED_ORIGINS in wrangler.jsonc.
const PAGES_ORIGIN = "https://kishore510.github.io";

function upgrade(origin: string | null, path = "/ws"): Promise<Response> {
  const headers = new Headers({ Upgrade: "websocket" });
  if (origin !== null) headers.set("Origin", origin);
  return exports.default.fetch(`https://relay.example.test${path}`, { headers });
}

async function openSocket(origin = PAGES_ORIGIN): Promise<WebSocket> {
  const res = await upgrade(origin);
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("expected a WebSocket");
  ws.accept();
  return ws;
}

/** Send one frame and resolve with the next server message. */
function roundTrip(ws: WebSocket, data: string | ArrayBuffer): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no reply")), 2000);
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        const parsed = serverMessageSchema.safeParse(JSON.parse(String(event.data)));
        if (parsed.success) resolve(parsed.data);
        else reject(new Error(`invalid server message: ${String(event.data)}`));
      },
      { once: true },
    );
    ws.send(data);
  });
}

const hello = (protocolVersion = PROTOCOL_VERSION) => JSON.stringify({ type: "hello", protocolVersion });

describe("GET /health", () => {
  it("returns ok and the protocol version", async () => {
    const res = await exports.default.fetch("https://relay.example.test/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true, protocolVersion: PROTOCOL_VERSION });
  });
});

describe("routing", () => {
  it("404s unknown paths", async () => {
    const res = await exports.default.fetch("https://relay.example.test/nope");
    expect(res.status).toBe(404);
  });

  it("426s /ws without an upgrade header", async () => {
    const res = await exports.default.fetch("https://relay.example.test/ws", {
      headers: { Origin: PAGES_ORIGIN },
    });
    expect(res.status).toBe(426);
  });
});

describe("Origin check on /ws", () => {
  it.each([PAGES_ORIGIN, "http://localhost:5173", "http://127.0.0.1:8787"])("upgrades for %s", async (origin) => {
    const res = await upgrade(origin);
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
  ])("rejects %s with 403 before upgrading", async (_label, origin) => {
    const res = await upgrade(origin);
    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();
  });
});

describe("handshake", () => {
  it("answers hello with welcome", async () => {
    const ws = await openSocket();
    expect(await roundTrip(ws, hello())).toEqual({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    ws.close();
  });

  it("answers a different protocol version with version_mismatch", async () => {
    const ws = await openSocket();
    const reply = await roundTrip(ws, hello(PROTOCOL_VERSION + 1));
    expect(reply).toMatchObject({ type: "error", code: "version_mismatch" });
  });

  it.each([
    ["non-JSON", "not json"],
    ["unknown type", JSON.stringify({ type: "nope" })],
    ["hello without version", JSON.stringify({ type: "hello" })],
    ["JSON null", "null"],
  ])("answers %s with bad_message and keeps the socket usable", async (_label, data) => {
    const ws = await openSocket();
    expect(await roundTrip(ws, data)).toMatchObject({ type: "error", code: "bad_message" });
    expect(await roundTrip(ws, hello())).toEqual({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    ws.close();
  });

  it("answers binary frames with bad_message", async () => {
    const ws = await openSocket();
    expect(await roundTrip(ws, new ArrayBuffer(4))).toMatchObject({ type: "error", code: "bad_message" });
    ws.close();
  });

  it("answers an oversized message with too_large and keeps the socket usable", async () => {
    const ws = await openSocket();
    const big = JSON.stringify({ type: "hello", protocolVersion: 1, pad: "x".repeat(MAX_MESSAGE_BYTES) });
    expect(await roundTrip(ws, big)).toMatchObject({ type: "error", code: "too_large" });
    expect(await roundTrip(ws, hello())).toEqual({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    ws.close();
  });
});
