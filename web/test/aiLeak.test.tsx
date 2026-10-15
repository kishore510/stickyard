// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "../src/storage";
import { FakeWebSocket, button, cleanupUi, click, inRoom, installUi, noteAt, settle, type } from "./helpers/ui";

/*
 * Leak tests (AI part 1, v0.42.0): a room participant's key is theirs alone. It never reaches the
 * WebSocket (join included), the URL hash, the board file, a saved stencil, the stencils storage,
 * the preferences, an error's Details or the console; and nothing writes outside owned storage keys.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEVICE_KEY = "sk-ant-api03-FAKE-leak-device-key-0000dvce";
const SESSION_KEY = "sk-ant-api03-FAKE-leak-session-key-000sssn";
const KEYS = [DEVICE_KEY, SESSION_KEY];

const consoleCalls: unknown[][] = [];
const record =
  (_name: string) =>
  (...args: unknown[]) =>
    consoleCalls.push(args);

const contains = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return KEYS.some((k) => text.includes(k) || text.includes(k.slice(0, -4)));
};

async function openSettings() {
  const menu = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => /^Menu/.test(b.getAttribute("aria-label") ?? ""));
  await click(menu);
  await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.trim() === "Settings"));
}

beforeEach(() => {
  installUi();
  consoleCalls.length = 0;
  for (const name of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, name).mockImplementation(record(name));
});
afterEach(() => cleanupUi());

describe("the key stays on this page", () => {
  it("never reaches the WebSocket, the hash, the board file, a stencil, preferences, Details or the console", async () => {
    localStorage.setItem(STORAGE_KEYS.aiKey, DEVICE_KEY);
    const socket = await inRoom({ notes: [noteAt(1, { text: "An idea" })] });

    // The page's own messages (join included), with the remembered key loaded.
    const join = socket.ofType("join");
    expect(join).toHaveLength(1);
    expect(contains(join)).toBe(false);

    // A session key too, through the real sheet, in the room.
    await openSettings();
    expect(document.querySelector("[data-ai-status]")?.textContent).toContain("•••• dvce");
    await click(button("Replace key"));
    const field = document.querySelector<HTMLInputElement>("[data-ai-key-input]")!;
    await type(field, SESSION_KEY);
    await click(button("Save key"));
    // An error with the key echoed back: its Details are redacted.
    vi.stubGlobal("fetch", (url: string) =>
      Promise.resolve(
        String(url).startsWith("https://api.anthropic.com/")
          ? new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${SESSION_KEY}` } }), { status: 401 })
          : new Response("{}", { status: 404 }),
      ),
    );
    await click(button("Test key"));
    await click(button("Send"));
    for (let i = 0; i < 20 && !document.querySelector("[data-ai-error]"); i++) await settle();
    expect(document.querySelector("[data-ai-error]")?.textContent).toContain("[redacted]");
    expect(contains(document.body.innerHTML)).toBe(false);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();

    // Every message any socket of this page sent, and the URL.
    for (const s of FakeWebSocket.instances) expect(contains(s.sent)).toBe(false);
    expect(contains(window.location.href)).toBe(false);

    // The board file (v0.40.0), exported for real from the menu's Export board sheet.
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return "blob:fake/1";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const menu = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => /^Menu/.test(b.getAttribute("aria-label") ?? ""));
    await click(menu);
    await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.trim() === "Export board"));
    await click(document.querySelector<HTMLElement>('[data-export-sheet] [data-export="json"]'));
    for (let i = 0; i < 20 && blobs.length === 0; i++) await settle();
    expect(blobs).toHaveLength(1);
    const boardFile = await blobs[0]!.text();
    expect(boardFile).toContain("An idea");
    expect(contains(boardFile)).toBe(false);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();

    // A saved stencil and the stencils storage.
    const { saveStencil, loadStencils } = await import("../src/stencils/storage");
    const { BUILTIN_STENCILS } = await import("../src/stencils/builtins");
    expect(saveStencil({ ...BUILTIN_STENCILS[0]!, id: "mine-1", name: "Mine" }).ok).toBe(true);
    expect(contains(loadStencils())).toBe(false);
    expect(contains(localStorage.getItem(STORAGE_KEYS.stencils))).toBe(false);

    // Preferences: every stored value other than the one remembered key.
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)!;
      if (name === STORAGE_KEYS.aiKey) continue;
      expect(contains(localStorage.getItem(name)), name).toBe(false);
    }
    for (let i = 0; i < sessionStorage.length; i++) expect(contains(sessionStorage.getItem(sessionStorage.key(i)!))).toBe(false);

    // The console.
    expect(contains(consoleCalls)).toBe(false);
  });

  it("nothing writes outside the owned storage keys", async () => {
    localStorage.setItem(STORAGE_KEYS.aiKey, DEVICE_KEY);
    await inRoom({ host: true, notes: [noteAt(1)] });
    await openSettings();
    await click(button("Remove key"));
    await click(button("Save key")); // empty: nothing saved
    const owned = Object.values(STORAGE_KEYS);
    const prefixes = [STORAGE_KEYS.hostTokenPrefix, STORAGE_KEYS.voterKeyPrefix];
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)!;
      expect(owned.includes(name as (typeof owned)[number]) || prefixes.some((p) => name.startsWith(p)), name).toBe(true);
    }
    expect(sessionStorage.length).toBe(0);
  });
});
