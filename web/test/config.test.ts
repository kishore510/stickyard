import { describe, expect, it } from "vitest";
import { healthUrl, toWebSocketUrl } from "../src/config";
import { STORAGE_KEYS, storageKey } from "../src/storage";

const CODE = `${"a".repeat(22)}.${"B".repeat(22)}`;

describe("toWebSocketUrl", () => {
  it.each([
    ["https://relay.example.test", `wss://relay.example.test/ws?room=${CODE}`],
    ["https://relay.example.test/", `wss://relay.example.test/ws?room=${CODE}`],
    ["http://127.0.0.1:8787", `ws://127.0.0.1:8787/ws?room=${CODE}`],
  ])("%s -> %s", (input, expected) => {
    expect(toWebSocketUrl(input, CODE)).toBe(expected);
  });

  it("encodes the code", () => {
    expect(toWebSocketUrl("https://relay.example.test", "a&b=c")).toBe("wss://relay.example.test/ws?room=a%26b%3Dc");
  });
});

describe("healthUrl", () => {
  it("is /health on the relay", () => {
    expect(healthUrl("https://relay.example.test")).toBe("https://relay.example.test/health");
  });
});

describe("storage keys", () => {
  it("prefixes keys with the app name", () => {
    expect(storageKey("theme")).toBe("stickyard:theme");
  });

  it("remembers the last-used name under stickyard:name, and nothing for the passcode", () => {
    expect(STORAGE_KEYS).toEqual({
      theme: "stickyard:theme",
      lastSeenVersion: "stickyard:last-seen-version",
      name: "stickyard:name",
      palettePanel: "stickyard:palette-panel",
      propertiesPanel: "stickyard:properties-panel",
      chatPanel: "stickyard:chat-panel",
      // Protocol v12: one host token per room, stickyard:host:<room id> (never the passcode).
      hostTokenPrefix: "stickyard:host:",
      // Protocol v13: one random voter key per room, stickyard:voter:<room id>.
      voterKeyPrefix: "stickyard:voter:",
    });
  });
});
