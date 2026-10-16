// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyValueStore } from "../src/storage";

/*
 * Where the Anthropic key lives (AI part 1, v0.42.0). "This session only" is a module-private
 * variable (nothing in browser storage); "Remember on this device" is one registered stickyard: key.
 * State and UI hold only { place, tail }; the key itself is read at the moment of a send.
 */

const KEY = "sk-ant-api03-FAKE-store-test-key-00001234";
const OTHER = "sk-ant-api03-FAKE-store-test-key-0000wxyz";

class MemoryStore implements KeyValueStore {
  map = new Map<string, string>();
  writes: string[] = [];
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.writes.push(key);
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

class BlockedStore implements KeyValueStore {
  getItem(): string | null {
    throw new Error("SecurityError");
  }
  setItem(): void {
    throw new Error("QuotaExceededError");
  }
  removeItem(): void {
    throw new Error("SecurityError");
  }
}

async function fresh() {
  vi.resetModules();
  const keys = await import("../src/ai/keyStore");
  const { STORAGE_KEYS } = await import("../src/storage");
  return { ...keys, STORAGE_KEYS };
}

beforeEach(() => {
  localStorage.clear();
});

describe("cleaning and checking", () => {
  it("strips every whitespace character, and only hints at a format", async () => {
    const { cleanKey, looksLikeAnthropicKey, keyTail } = await fresh();
    expect(cleanKey(`  ${KEY.slice(0, 10)}\n${KEY.slice(10)}\t `)).toBe(KEY);
    expect(looksLikeAnthropicKey(KEY)).toBe(true);
    expect(looksLikeAnthropicKey("not-a-key")).toBe(false);
    expect(keyTail(KEY)).toBe("1234");
  });

  it("saves a key that doesn't look like one (the hint never blocks)", async () => {
    const { saveApiKey, readApiKey } = await fresh();
    const store = new MemoryStore();
    const result = saveApiKey("my-odd-key-value", "session", store);
    expect(result.ok).toBe(true);
    expect(readApiKey(store)).toBe("my-odd-key-value");
  });

  it("refuses an empty key", async () => {
    const { saveApiKey, keyStatus } = await fresh();
    const store = new MemoryStore();
    expect(saveApiKey("   \n ", "session", store)).toEqual({ ok: false, reason: "empty" });
    expect(keyStatus(store)).toEqual({ place: "none", tail: "" });
  });
});

describe("This session only", () => {
  it("writes nothing to storage, and keeps the key for a send", async () => {
    const { saveApiKey, readApiKey, keyStatus } = await fresh();
    const store = new MemoryStore();
    const result = saveApiKey(KEY, "session", store);
    expect(result).toEqual({ ok: true, status: { place: "session", tail: "1234" }, fellBack: false });
    expect(store.writes).toEqual([]);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(readApiKey(store)).toBe(KEY);
    expect(keyStatus(store)).toEqual({ place: "session", tail: "1234" });
  });

  it("is forgotten on reload (a fresh module)", async () => {
    const first = await fresh();
    const store = new MemoryStore();
    first.saveApiKey(KEY, "session", store);
    const second = await fresh();
    expect(second.readApiKey(store)).toBeNull();
    expect(second.keyStatus(store).place).toBe("none");
  });
});

describe("Remember on this device", () => {
  it("writes only the registered key", async () => {
    const { saveApiKey, readApiKey, keyStatus, STORAGE_KEYS } = await fresh();
    const store = new MemoryStore();
    const result = saveApiKey(KEY, "device", store);
    expect(result).toEqual({ ok: true, status: { place: "device", tail: "1234" }, fellBack: false });
    expect(store.writes).toEqual([STORAGE_KEYS.aiKey]);
    expect(store.map.get(STORAGE_KEYS.aiKey)).toBe(KEY);
    expect(STORAGE_KEYS.aiKey).toBe("stickyard:ai-key");
    expect(readApiKey(store)).toBe(KEY);
    expect(keyStatus(store)).toEqual({ place: "device", tail: "1234" });
  });

  it("survives a reload", async () => {
    const store = new MemoryStore();
    (await fresh()).saveApiKey(KEY, "device", store);
    const again = await fresh();
    expect(again.keyStatus(store)).toEqual({ place: "device", tail: "1234" });
    expect(again.readApiKey(store)).toBe(KEY);
  });

  it("blocked storage falls back to this session only and says so", async () => {
    const { saveApiKey, readApiKey, keyStatus } = await fresh();
    const store = new BlockedStore();
    const result = saveApiKey(KEY, "device", store);
    expect(result).toEqual({ ok: true, status: { place: "session", tail: "1234" }, fellBack: true });
    expect(readApiKey(store)).toBe(KEY);
    expect(keyStatus(store).place).toBe("session");
  });

  it("saving for the session clears a remembered key, and the other way round", async () => {
    const { saveApiKey, readApiKey, STORAGE_KEYS } = await fresh();
    const store = new MemoryStore();
    saveApiKey(KEY, "device", store);
    saveApiKey(OTHER, "session", store);
    expect(store.map.has(STORAGE_KEYS.aiKey)).toBe(false);
    expect(readApiKey(store)).toBe(OTHER);
    saveApiKey(KEY, "device", store);
    expect(readApiKey(store)).toBe(KEY);
    expect(store.map.get(STORAGE_KEYS.aiKey)).toBe(KEY);
  });

  it("moves the saved key between places without asking for it again", async () => {
    const { saveApiKey, moveApiKey, readApiKey, STORAGE_KEYS } = await fresh();
    const store = new MemoryStore();
    saveApiKey(KEY, "session", store);
    expect(moveApiKey("device", store)).toEqual({ status: { place: "device", tail: "1234" }, fellBack: false });
    expect(store.map.get(STORAGE_KEYS.aiKey)).toBe(KEY);
    expect(moveApiKey("session", store)).toEqual({ status: { place: "session", tail: "1234" }, fellBack: false });
    expect(store.map.has(STORAGE_KEYS.aiKey)).toBe(false);
    expect(readApiKey(store)).toBe(KEY);
    expect(moveApiKey("device", new BlockedStore()).fellBack).toBe(true);
  });
});

describe("Remove key", () => {
  it("clears both places", async () => {
    const { saveApiKey, removeApiKey, readApiKey, STORAGE_KEYS } = await fresh();
    const store = new MemoryStore();
    saveApiKey(KEY, "device", store);
    store.map.set(STORAGE_KEYS.aiKey, KEY);
    saveApiKey(OTHER, "session", store);
    store.map.set(STORAGE_KEYS.aiKey, KEY); // as if a second tab remembered one
    expect(removeApiKey(store)).toEqual({ place: "none", tail: "" });
    expect(store.map.has(STORAGE_KEYS.aiKey)).toBe(false);
    expect(readApiKey(store)).toBeNull();
  });
});

describe("the registry", () => {
  it("flags the key as secret, never backed up or exported", async () => {
    const { STORAGE_KEYS } = await fresh();
    const { SECRET_STORAGE_KEYS, isSecretStorageKey } = await import("../src/storage");
    expect(SECRET_STORAGE_KEYS).toEqual([STORAGE_KEYS.aiKey]);
    expect(isSecretStorageKey(STORAGE_KEYS.aiKey)).toBe(true);
    expect(isSecretStorageKey(STORAGE_KEYS.aiPrefs)).toBe(false);
    expect(STORAGE_KEYS.aiPrefs).toBe("stickyard:ai-prefs");
  });
});

describe("the Zustand state never holds the key", () => {
  it("only { place, tail } and preferences", async () => {
    vi.resetModules();
    const { useAi } = await import("../src/ai/aiStore");
    const result = useAi.getState().save(KEY);
    expect(result.ok).toBe(true);
    const state = useAi.getState();
    expect(state.place).toBe("session");
    expect(state.tail).toBe("1234");
    expect(JSON.stringify(state)).not.toContain(KEY);
    expect(JSON.stringify(state)).not.toContain(KEY.slice(0, -4));
    // Preferences are their own key, without the key in them.
    useAi.getState().setKeep("device");
    const prefs = localStorage.getItem("stickyard:ai-prefs") ?? "";
    expect(JSON.parse(prefs)).toEqual({ keep: "device", noticeSeen: false });
    expect(prefs).not.toContain(KEY);
    expect(localStorage.getItem("stickyard:ai-key")).toBe(KEY);
    useAi.getState().remove();
    expect(useAi.getState().place).toBe("none");
    expect(localStorage.getItem("stickyard:ai-key")).toBeNull();
  });

  it("reads preferences as untrusted data", async () => {
    localStorage.setItem("stickyard:ai-prefs", '{"keep":"everywhere","noticeSeen":"yes","extra":1}');
    vi.resetModules();
    const { useAi } = await import("../src/ai/aiStore");
    expect(useAi.getState().keep).toBe("session");
    expect(useAi.getState().noticeSeen).toBe(false);
    localStorage.setItem("stickyard:ai-prefs", "not json");
    vi.resetModules();
    const again = await import("../src/ai/aiStore");
    expect(again.useAi.getState().keep).toBe("session");
  });

  it("a key change bumps the key version (a running test's result is discarded)", async () => {
    vi.resetModules();
    const { useAi } = await import("../src/ai/aiStore");
    const v0 = useAi.getState().keyVersion;
    useAi.getState().save(KEY);
    const v1 = useAi.getState().keyVersion;
    expect(v1).toBeGreaterThan(v0);
    useAi.getState().remove();
    expect(useAi.getState().keyVersion).toBeGreaterThan(v1);
  });
});
