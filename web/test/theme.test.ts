import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nextPreference, parsePreference, readPreference, resolveTheme } from "../src/shell/theme";
import { STORAGE_KEYS, readKey, storageKey, writeKey } from "../src/storage";

const memory = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map };
};

describe("theme preference", () => {
  it("cycles follow system -> light -> dark", () => {
    expect(nextPreference("system")).toBe("light");
    expect(nextPreference("light")).toBe("dark");
    expect(nextPreference("dark")).toBe("system");
  });

  it("resolves system from the OS setting", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("falls back to system for anything unexpected", () => {
    expect(parsePreference("purple")).toBe("system");
    expect(parsePreference(null)).toBe("system");
  });

  it("is stored under the stickyard: prefix", () => {
    expect(STORAGE_KEYS.theme).toBe("stickyard:theme");
    const store = memory();
    store.setItem(STORAGE_KEYS.theme, "dark");
    expect(readPreference(store)).toBe("dark");
  });

  it("index.html applies the same key before first paint", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain(`localStorage.getItem("${STORAGE_KEYS.theme}")`);
  });
});

describe("storage", () => {
  it("every key uses the prefix", () => {
    for (const key of Object.values(STORAGE_KEYS)) expect(key.startsWith(storageKey(""))).toBe(true);
  });

  it("never throws when storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readKey("stickyard:x", blocked)).toBeNull();
    expect(writeKey("stickyard:x", "1", blocked)).toBe(false);
    expect(readKey("stickyard:x", undefined)).toBeNull();
  });
});
