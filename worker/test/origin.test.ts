import { describe, expect, it } from "vitest";
import { isAllowedOrigin, parseAllowedOrigins } from "../src/origin";

const PAGES = "https://pages.example.test";
const allowed = parseAllowedOrigins(PAGES);

describe("isAllowedOrigin", () => {
  it.each([
    PAGES,
    "http://localhost",
    "http://localhost:5173",
    "http://localhost:8787",
    "http://127.0.0.1",
    "http://127.0.0.1:4173",
  ])("allows %s", (origin) => {
    expect(isAllowedOrigin(origin, allowed)).toBe(true);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["opaque null origin", "null"],
    ["other site", "https://evil.example.test"],
    ["pages origin over http", "http://pages.example.test"],
    ["pages origin with path", `${PAGES}/stickyard`],
    ["pages origin with trailing slash", `${PAGES}/`],
    ["pages origin with port", `${PAGES}:8443`],
    ["suffix attack", "https://pages.example.test.evil.test"],
    ["subdomain", "https://x.pages.example.test"],
    ["localhost lookalike", "http://localhost.evil.test"],
    ["https localhost", "https://localhost:5173"],
    ["other loopback address", "http://127.0.0.2"],
    ["localhost with path", "http://localhost:5173/x"],
    ["malformed", "not a url"],
    ["userinfo", "http://user@localhost:5173"],
    ["javascript scheme", "javascript:alert(1)"],
  ])("rejects %s", (_label, origin) => {
    expect(isAllowedOrigin(origin, allowed)).toBe(false);
  });
});

describe("parseAllowedOrigins", () => {
  it("splits, trims and drops empty entries", () => {
    expect(parseAllowedOrigins(" https://a.test , ,https://b.test ")).toEqual(["https://a.test", "https://b.test"]);
  });

  it("ignores entries that are not bare origins", () => {
    expect(parseAllowedOrigins("https://a.test/path,https://b.test")).toEqual(["https://b.test"]);
  });
});
