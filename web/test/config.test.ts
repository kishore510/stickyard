import { describe, expect, it } from "vitest";
import { toWebSocketUrl } from "../src/config";
import { storageKey } from "../src/storage";

describe("toWebSocketUrl", () => {
  it.each([
    ["https://relay.example.test", "wss://relay.example.test/ws"],
    ["https://relay.example.test/", "wss://relay.example.test/ws"],
    ["http://127.0.0.1:8787", "ws://127.0.0.1:8787/ws"],
  ])("%s -> %s", (input, expected) => {
    expect(toWebSocketUrl(input)).toBe(expected);
  });
});

describe("storageKey", () => {
  it("prefixes keys with the app name", () => {
    expect(storageKey("theme")).toBe("stickyard:theme");
  });
});
