import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiErrorSchema, createRoomResponseSchema, isRoomCodeShape } from "@stickyard/shared";
import {
  BASE,
  PAGES_ORIGIN,
  TEST_PASSCODE,
  TestClient,
  callWorker,
  createRequest,
  freshIp,
  roomPath,
  wsRequest,
} from "./helpers";

const post = (body: unknown, opts: { origin?: string | null; ip?: string } = {}) =>
  exports.default.fetch(createRequest(body, { ip: freshIp(), ...opts }));

async function errorOf(res: Response): Promise<string> {
  const parsed = apiErrorSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("response is not an API error");
  return parsed.data.error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /rooms", () => {
  it("creates a room with the correct passcode", async () => {
    const res = await post({ passcode: TEST_PASSCODE });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe(PAGES_ORIGIN);
    const body = createRoomResponseSchema.parse(await res.json());
    expect(isRoomCodeShape(body.code)).toBe(true);
  });

  it("gives a different code each time", async () => {
    const ip = freshIp();
    const a = createRoomResponseSchema.parse(await (await post({ passcode: TEST_PASSCODE }, { ip })).json());
    const b = createRoomResponseSchema.parse(await (await post({ passcode: TEST_PASSCODE }, { ip })).json());
    expect(a.code).not.toBe(b.code);
  });

  it("a created code opens a room", async () => {
    const { code } = createRoomResponseSchema.parse(await (await post({ passcode: TEST_PASSCODE })).json());
    const client = await TestClient.open(code);
    const joined = await client.enter("Alex");
    expect(joined.you.name).toBe("Alex");
    client.close();
  });

  it.each([
    ["wrong passcode", "wrong-passcode"],
    ["one character off", `${TEST_PASSCODE.slice(0, -1)}x`],
    ["a prefix of it", TEST_PASSCODE.slice(0, 4)],
    ["it plus more", `${TEST_PASSCODE}x`],
    ["different case", TEST_PASSCODE.toUpperCase()],
  ])("%s gets the same generic 401", async (_label, passcode) => {
    const res = await post({ passcode });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_passcode" });
    expect(res.headers.get("access-control-allow-origin")).toBe(PAGES_ORIGIN);
  });

  describe("bad bodies", () => {
    it.each([
      ["not JSON", "passcode=test-passcode"],
      ["JSON null", "null"],
      ["missing passcode", {}],
      ["empty passcode", { passcode: "" }],
      ["number passcode", { passcode: 1234 }],
      ["extra fields", { passcode: TEST_PASSCODE, admin: true }],
      ["passcode over the length cap", { passcode: "x".repeat(257) }],
    ])("%s gets 400", async (_label, body) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe("bad_request");
    });

    it("a body over 1 KB gets 413", async () => {
      const res = await post({ passcode: "x".repeat(2000) });
      expect(res.status).toBe(413);
      expect(await errorOf(res)).toBe("too_large");
    });

    it("a streamed body over 1 KB (no Content-Length) gets 413", async () => {
      const chunk = new TextEncoder().encode("x".repeat(600));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      });
      const req = new Request(`${BASE}/rooms`, {
        method: "POST",
        headers: { Origin: PAGES_ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": freshIp() },
        body: stream,
      });
      const res = await exports.default.fetch(req);
      expect(res.status).toBe(413);
    });
  });

  describe("Origin and CORS", () => {
    it.each([
      ["missing", null],
      ["another site", "https://evil.example.test"],
      ["opaque null", "null"],
      ["pages origin with a path", `${PAGES_ORIGIN}/stickyard`],
    ])("POST with %s origin gets 403 and no CORS header", async (_label, origin) => {
      const res = await post({ passcode: TEST_PASSCODE }, { origin });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(await errorOf(res)).toBe("forbidden_origin");
    });

    it.each([PAGES_ORIGIN, "http://localhost:5173", "http://127.0.0.1:4173"])(
      "preflight from %s is allowed",
      async (origin) => {
        const res = await exports.default.fetch(
          new Request(`${BASE}/rooms`, {
            method: "OPTIONS",
            headers: {
              Origin: origin,
              "Access-Control-Request-Method": "POST",
              "Access-Control-Request-Headers": "content-type",
            },
          }),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe(origin);
        expect(res.headers.get("access-control-allow-methods")).toContain("POST");
        expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("content-type");
        expect(res.headers.get("vary")).toContain("Origin");
      },
    );

    it.each([
      ["another site", "https://evil.example.test"],
      ["missing", null],
    ])("preflight from %s gets 403", async (_label, origin) => {
      const headers = new Headers({ "Access-Control-Request-Method": "POST" });
      if (origin) headers.set("Origin", origin);
      const res = await exports.default.fetch(new Request(`${BASE}/rooms`, { method: "OPTIONS", headers }));
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  describe("missing secrets fail closed", () => {
    it.each([
      ["CREATE_PASSCODE", { CREATE_PASSCODE: undefined }],
      ["ROOM_SIGNING_KEY", { ROOM_SIGNING_KEY: undefined }],
      ["both (empty strings)", { CREATE_PASSCODE: "", ROOM_SIGNING_KEY: "" }],
    ])("without %s, creation gets 503 not_configured", async (_label, overrides) => {
      const res = await callWorker(createRequest({ passcode: TEST_PASSCODE }, { ip: freshIp() }), overrides);
      expect(res.status).toBe(503);
      expect(await errorOf(res)).toBe("not_configured");
    });

    it.each([
      ["CREATE_PASSCODE", { CREATE_PASSCODE: undefined }],
      ["ROOM_SIGNING_KEY", { ROOM_SIGNING_KEY: undefined }],
    ])("without %s, joining gets 503 too", async (_label, overrides) => {
      const { code } = createRoomResponseSchema.parse(await (await post({ passcode: TEST_PASSCODE })).json());
      const res = await callWorker(wsRequest(roomPath(code)), overrides);
      expect(res.status).toBe(503);
      expect(res.webSocket).toBeNull();
    });

    it("/health still works without secrets", async () => {
      const res = await callWorker(new Request(`${BASE}/health`), {
        CREATE_PASSCODE: undefined,
        ROOM_SIGNING_KEY: undefined,
      });
      expect(res.status).toBe(200);
    });
  });

  describe("kill switch (CREATION_ENABLED)", () => {
    it.each([
      ["missing", undefined],
      ["false", "false"],
      ["TRUE", "TRUE"],
      ["1", "1"],
      ["true with a space", "true "],
    ])("%s refuses creation with 503 creation_disabled", async (_label, value) => {
      const res = await callWorker(createRequest({ passcode: TEST_PASSCODE }, { ip: freshIp() }), {
        CREATION_ENABLED: value,
      });
      expect(res.status).toBe(503);
      expect(await errorOf(res)).toBe("creation_disabled");
    });

    it("existing rooms still accept joins while creation is off", async () => {
      const { code } = createRoomResponseSchema.parse(await (await post({ passcode: TEST_PASSCODE })).json());
      const res = await callWorker(wsRequest(roomPath(code)), { CREATION_ENABLED: "false" });
      expect(res.status).toBe(101);
      const ws = res.webSocket;
      if (!ws) throw new Error("expected a WebSocket");
      ws.accept();
      const client = new TestClient(ws);
      expect((await client.enter("Alex")).type).toBe("joined");
      client.close();
    });
  });
});

describe("the passcode never leaks", () => {
  const CANARY = "test-passcode-canary-value";

  function spyConsole() {
    return (["log", "info", "warn", "error", "debug", "trace"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
  }

  const dump = async (res: Response) =>
    `${res.status} ${[...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${await res.text()}`;

  it("is never in a response body, header or log, for any outcome", async () => {
    const spies = spyConsole();
    const ip = freshIp();
    const outputs = [
      await dump(await callWorker(createRequest({ passcode: CANARY }, { ip }))),
      await dump(await callWorker(createRequest({ passcode: CANARY, extra: 1 }, { ip }))),
      await dump(await callWorker(createRequest(`{"passcode":"${CANARY}"`, { ip }))),
      await dump(await callWorker(createRequest({ passcode: CANARY.repeat(60) }, { ip }))),
      await dump(await callWorker(createRequest({ passcode: CANARY }, { ip, origin: "https://evil.example.test" }))),
      await dump(await callWorker(createRequest({ passcode: CANARY }, { ip }), { CREATION_ENABLED: "false" })),
      await dump(await callWorker(createRequest({ passcode: CANARY }, { ip }), { ROOM_SIGNING_KEY: undefined })),
    ];
    for (const out of outputs) expect(out).not.toContain(CANARY);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(CANARY);
  });

  it("the correct passcode, the created code and the host token are not logged or echoed", async () => {
    const spies = spyConsole();
    const res = await callWorker(createRequest({ passcode: TEST_PASSCODE }, { ip: freshIp() }));
    const text = await res.text();
    const { code, hostToken } = createRoomResponseSchema.parse(JSON.parse(text));
    expect(text).not.toContain(TEST_PASSCODE);
    for (const [, v] of res.headers) {
      expect(v).not.toContain(TEST_PASSCODE);
      expect(v).not.toContain(hostToken);
    }
    for (const spy of spies) {
      const calls = JSON.stringify(spy.mock.calls);
      expect(calls).not.toContain(TEST_PASSCODE);
      expect(calls).not.toContain(code);
      expect(calls).not.toContain(hostToken);
    }
  });
});
