import { describe, expect, it } from "vitest";
import {
  MAX_PASSCODE_LENGTH,
  PROTOCOL_VERSION,
  apiErrorSchema,
  createRoomRequestSchema,
  createRoomResponseSchema,
  healthResponseSchema,
  isRoomCodeShape,
  roomCheckResponseSchema,
} from "../src/index";

const CODE = `${"a".repeat(22)}.${"B".repeat(22)}`;

describe("createRoomRequestSchema", () => {
  it("accepts a passcode", () => {
    expect(createRoomRequestSchema.safeParse({ passcode: "test-passcode" }).success).toBe(true);
  });

  it.each([
    ["missing", {}],
    ["empty", { passcode: "" }],
    ["not a string", { passcode: 12345 }],
    ["too long", { passcode: "x".repeat(MAX_PASSCODE_LENGTH + 1) }],
    ["extra fields", { passcode: "test-passcode", admin: true }],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(createRoomRequestSchema.safeParse(value).success).toBe(false);
  });
});

describe("createRoomResponseSchema", () => {
  it("accepts a code", () => {
    expect(createRoomResponseSchema.safeParse({ code: CODE }).success).toBe(true);
  });

  it("rejects a malformed code", () => {
    expect(createRoomResponseSchema.safeParse({ code: "nope" }).success).toBe(false);
  });
});

describe("apiErrorSchema", () => {
  it.each([
    "invalid_passcode",
    "rate_limited",
    "creation_disabled",
    "not_configured",
    "bad_request",
    "too_large",
    "forbidden_origin",
    "not_found",
  ])("accepts %s", (error) => {
    expect(apiErrorSchema.safeParse({ error }).success).toBe(true);
  });

  it("rejects unknown codes", () => {
    expect(apiErrorSchema.safeParse({ error: "boom" }).success).toBe(false);
  });
});

describe("healthResponseSchema", () => {
  it("accepts the health reply", () => {
    expect(healthResponseSchema.safeParse({ ok: true, protocolVersion: PROTOCOL_VERSION }).success).toBe(true);
  });

  it("rejects other shapes", () => {
    expect(healthResponseSchema.safeParse({ ok: true }).success).toBe(false);
    expect(healthResponseSchema.safeParse({ ok: false, protocolVersion: 2 }).success).toBe(false);
  });
});

describe("roomCheckResponseSchema", () => {
  it("accepts ok", () => {
    expect(roomCheckResponseSchema.safeParse({ ok: true }).success).toBe(true);
  });
});

describe("isRoomCodeShape", () => {
  it("accepts <22 base64url>.<22 base64url>", () => {
    expect(isRoomCodeShape(CODE)).toBe(true);
    expect(isRoomCodeShape(`${"-".repeat(22)}.${"_".repeat(22)}`)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["no dot", "a".repeat(45)],
    ["short id", `${"a".repeat(21)}.${"b".repeat(22)}`],
    ["long signature", `${"a".repeat(22)}.${"b".repeat(23)}`],
    ["padding", `${"a".repeat(21)}=.${"b".repeat(22)}`],
    ["standard base64 characters", `${"a".repeat(21)}+.${"b".repeat(21)}/`],
    ["extra part", `${CODE}.x`],
    ["whitespace", ` ${CODE}`],
    ["oversized", "a".repeat(5000)],
  ])("rejects %s", (_label, code) => {
    expect(isRoomCodeShape(code)).toBe(false);
  });
});
