import { describe, expect, it, vi } from "vitest";
import { PALETTE_SIZE } from "@stickyard/shared";
import { checkRoom, createErrorMessage, createRoom, type CreateResult, type FetchFn } from "../src/rooms/api";
import { participantColourClass } from "../src/rooms/colours";
import { parseJoinInput, roomHash, roomLink } from "../src/rooms/link";

const CODE = `${"a".repeat(22)}.${"B".repeat(22)}`;
/** A fake host token (43 base64url characters), never a real one. */
const HOST_TOKEN = "fakeHostToken".padEnd(43, "x");
const WORKER = "https://relay.example.test";
const PASSCODE = "test-passcode";

describe("parseJoinInput", () => {
  it.each([
    ["a bare code", CODE],
    ["a code with spaces around it", `  ${CODE}\n`],
    ["a full link", `https://kishore510.github.io/stickyard/#/room/${CODE}`],
    ["a local link", `http://127.0.0.1:5173/#/room/${CODE}`],
    ["just the hash", `#/room/${CODE}`],
    ["a hash without the #", `/room/${CODE}`],
    ["a link pasted with a trailing space", `https://kishore510.github.io/stickyard/#/room/${CODE} `],
  ])("accepts %s", (_label, input) => {
    expect(parseJoinInput(input)).toBe(CODE);
  });

  it.each([
    ["empty", ""],
    ["spaces", "   "],
    ["a word", "hello"],
    ["a short code", "abc.def"],
    ["a link to another page", "https://kishore510.github.io/stickyard/#/help"],
    ["a link with a malformed code", "https://kishore510.github.io/stickyard/#/room/abc"],
    ["two codes", `${CODE} ${CODE}`],
    ["a huge paste", "a".repeat(10_000)],
  ])("rejects %s", (_label, input) => {
    expect(parseJoinInput(input)).toBeNull();
  });
});

describe("room links", () => {
  it("the hash route", () => {
    expect(roomHash(CODE)).toBe(`#/room/${CODE}`);
  });

  it.each([
    ["https://kishore510.github.io", "/stickyard/", `https://kishore510.github.io/stickyard/#/room/${CODE}`],
    ["http://127.0.0.1:5173", "/", `http://127.0.0.1:5173/#/room/${CODE}`],
  ])("built from the page's origin %s and base path %s", (origin, base, expected) => {
    expect(roomLink(CODE, origin, base)).toBe(expected);
  });
});

describe("participant colours", () => {
  it("map colourIndex onto the token palette, modulo its size", () => {
    expect(participantColourClass(0)).toBe("bg-participant-1");
    expect(participantColourClass(7)).toBe("bg-participant-8");
    expect(participantColourClass(PALETTE_SIZE)).toBe("bg-participant-1");
    expect(participantColourClass(PALETTE_SIZE + 1)).toBe("bg-participant-2");
    expect(participantColourClass(19)).toBe(`bg-participant-${(19 % PALETTE_SIZE) + 1}`);
  });
});

function respond(status: number, body: unknown, headers: Record<string, string> = {}): FetchFn {
  return vi.fn<FetchFn>(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })),
  );
}

describe("createRoom", () => {
  it("POSTs the passcode in the JSON body only, and returns the code", async () => {
    const fetchFn = respond(200, { code: CODE, hostToken: HOST_TOKEN });
    expect(await createRoom(WORKER, PASSCODE, fetchFn)).toEqual({ ok: true, code: CODE });
    const [url, init] = vi.mocked(fetchFn).mock.calls[0] ?? [];
    expect(url).toBe(`${WORKER}/rooms`);
    expect(url).not.toContain(PASSCODE);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ passcode: PASSCODE });
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    for (const [, value] of headers) expect(value).not.toContain(PASSCODE);
    expect(init?.credentials ?? "omit").toBe("omit");
  });

  it.each<[string, FetchFn, CreateResult]>([
    ["401", respond(401, { error: "invalid_passcode" }), { ok: false, error: "invalid_passcode" }],
    [
      "429",
      respond(429, { error: "rate_limited" }, { "retry-after": "600" }),
      { ok: false, error: "rate_limited", retryAfterSeconds: 600 },
    ],
    ["429 without Retry-After", respond(429, { error: "rate_limited" }), { ok: false, error: "rate_limited" }],
    ["503 disabled", respond(503, { error: "creation_disabled" }), { ok: false, error: "creation_disabled" }],
    ["503 not configured", respond(503, { error: "not_configured" }), { ok: false, error: "not_configured" }],
    ["400", respond(400, { error: "bad_request" }), { ok: false, error: "bad_request" }],
    ["413", respond(413, { error: "too_large" }), { ok: false, error: "bad_request" }],
    ["403", respond(403, { error: "forbidden_origin" }), { ok: false, error: "forbidden_origin" }],
    ["an unknown error", respond(500, { error: "boom" }), { ok: false, error: "unreachable" }],
    ["a 200 with a malformed code", respond(200, { code: "<b>" }), { ok: false, error: "unreachable" }],
    ["a network error", vi.fn<FetchFn>(() => Promise.reject(new TypeError("Failed to fetch"))), { ok: false, error: "unreachable" }],
  ])("maps %s", async (_label, fetchFn, expected) => {
    expect(await createRoom(WORKER, PASSCODE, fetchFn)).toEqual(expected);
  });
});

describe("createErrorMessage", () => {
  it.each<[Extract<CreateResult, { ok: false }>, RegExp]>([
    [{ ok: false, error: "invalid_passcode" }, /passcode didn’t work/i],
    [{ ok: false, error: "rate_limited", retryAfterSeconds: 600 }, /10 minutes/],
    [{ ok: false, error: "rate_limited", retryAfterSeconds: 30 }, /1 minute\b/],
    [{ ok: false, error: "rate_limited", retryAfterSeconds: 3 * 3600 }, /3 hours/],
    [{ ok: false, error: "rate_limited" }, /too many/i],
    [{ ok: false, error: "creation_disabled" }, /switched off/i],
    [{ ok: false, error: "not_configured" }, /isn’t set up/i],
    [{ ok: false, error: "unreachable" }, /couldn’t reach/i],
  ])("%j", (result, pattern) => {
    expect(createErrorMessage(result)).toMatch(pattern);
  });

  it("never mentions the passcode value or which part failed", () => {
    const text = createErrorMessage({ ok: false, error: "invalid_passcode" });
    expect(text).not.toMatch(/length|character|first|last|almost|close/i);
  });
});

describe("checkRoom", () => {
  it("valid on 200", async () => {
    const fetchFn = respond(200, { ok: true });
    expect(await checkRoom(WORKER, CODE, fetchFn)).toBe("valid");
    expect(vi.mocked(fetchFn).mock.calls[0]?.[0]).toBe(`${WORKER}/rooms/check?room=${CODE}`);
  });

  it("invalid on 404", async () => {
    expect(await checkRoom(WORKER, CODE, respond(404, { error: "not_found" }))).toBe("invalid");
  });

  it("unreachable otherwise", async () => {
    expect(await checkRoom(WORKER, CODE, respond(503, { error: "not_configured" }))).toBe("unreachable");
    expect(await checkRoom(WORKER, CODE, vi.fn<FetchFn>(() => Promise.reject(new Error("x"))))).toBe("unreachable");
  });
});
