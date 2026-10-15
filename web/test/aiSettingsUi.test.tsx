// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { button, cleanupUi, click, installUi, mount, settle, type } from "./helpers/ui";

/*
 * Settings and the AI (your own key) section (AI part 1, v0.42.0), rendered for real on the start
 * page with no room joined. Fake keys only; the fake fetch answers api.anthropic.com's count_tokens.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "sk-ant-api03-FAKE-settings-ui-key-0000abcd";

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const sheet = () => document.querySelector<HTMLElement>("[data-settings-sheet]");
const status = () => document.querySelector<HTMLElement>("[data-ai-status]")?.textContent?.trim() ?? "";
const announcer = () => document.querySelector<HTMLElement>("[data-ai-announcer]");
const keyInput = () => document.querySelector<HTMLInputElement>("[data-ai-key-input]");
const radio = (value: "session" | "device") => document.querySelector<HTMLInputElement>(`input[name="ai-keep"][value="${value}"]`);
const errorBox = () => document.querySelector<HTMLElement>("[data-ai-error]");
const menuButton = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => /^Menu/.test(b.getAttribute("aria-label") ?? ""));

async function openSettings() {
  await click(menuButton());
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.trim() === "Settings");
  await click(item);
}

async function saveKey(value = KEY) {
  await type(keyInput()!, value);
  await click(button("Save key"));
}

async function choose(value: "session" | "device") {
  await act(async () => radio(value)?.click());
  await settle();
}

type Reply = (url: string, init: RequestInit) => Response | Promise<Response>;
let anthropic: Reply = () => new Response(JSON.stringify({ input_tokens: 5 }), { status: 200 });
const calls: { url: string; init: RequestInit }[] = [];

beforeEach(() => {
  installUi();
  calls.length = 0;
  anthropic = () => new Response(JSON.stringify({ input_tokens: 5 }), { status: 200 });
  const health = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    if (String(url).startsWith("https://api.anthropic.com/")) {
      calls.push({ url: String(url), init });
      return Promise.resolve(anthropic(String(url), init));
    }
    return health(url, init);
  });
});
afterEach(() => cleanupUi());

describe("Settings in the menu", () => {
  it("is on the start page with no room joined, and opens a sheet with the AI section", async () => {
    await mount("#/");
    await openSettings();
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Settings");
    expect(sheet()).not.toBeNull();
    expect(sheet()?.querySelector("h3")?.textContent).toBe("AI (your own key)");
    expect(sheet()?.textContent).toContain(
      "AI features use your own Anthropic API key, and you pay Anthropic for what you use. Anything you choose to send goes to Anthropic's API. Nothing is sent until you press Send.",
    );
    expect(status()).toBe("No key saved.");
    // No AI feature button anywhere.
    expect(document.body.textContent).not.toMatch(/Summar|Sentiment|Board setup/);
  });

  it("focus starts on Close, Esc closes, and focus returns to the menu button", async () => {
    await mount("#/");
    await openSettings();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(menuButton());
  });

  it("stacks over another sheet: Esc closes Settings alone", async () => {
    await mount("#/help");
    const { useSettings } = await import("../src/settings/settingsStore");
    await act(async () => useSettings.getState().show());
    await settle();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(sheet()).toBeNull();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Help");
  });
});

describe("the key form", () => {
  it("has a password field that browsers and password managers leave alone, and Show/Hide", async () => {
    await mount("#/");
    await openSettings();
    const field = keyInput()!;
    expect(field.type).toBe("password");
    expect(document.querySelector(`label[for="${field.id}"]`)?.textContent).toBe("Anthropic API key");
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(field.getAttribute("autocapitalize")).toBe("off");
    expect(field.getAttribute("autocorrect")).toBe("off");
    expect(field.getAttribute("spellcheck")).toBe("false");
    expect(field.hasAttribute("data-1p-ignore")).toBe(true);
    expect(field.hasAttribute("data-lpignore")).toBe(true);
    expect(field.className).toContain("font-mono");
    const show = button("Show")!;
    expect(show.getAttribute("aria-pressed")).toBe("false");
    await click(show);
    expect(field.type).toBe("text");
    expect(button("Hide")?.getAttribute("aria-pressed")).toBe("true");
    const hint = sheet()?.querySelector<HTMLAnchorElement>("a[href^='https://platform.claude.com']");
    expect(hint?.textContent).toContain("Claude Console");
    expect(hint?.rel).toContain("noreferrer");
  });

  it("saves for this session only by default, stores nothing, and announces it", async () => {
    await mount("#/");
    await openSettings();
    expect(radio("session")?.checked).toBe(true);
    await saveKey(`  ${KEY}\n`);
    expect(status()).toBe("Key saved for this session only (•••• abcd). It's forgotten when you reload or close the tab.");
    expect(announcer()?.getAttribute("aria-live")).toBe("polite");
    expect(announcer()?.textContent).toContain("Key saved");
    expect(localStorage.getItem("stickyard:ai-key")).toBeNull();
    for (let i = 0; i < localStorage.length; i++) expect(localStorage.getItem(localStorage.key(i)!)).not.toContain(KEY);
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(keyInput()).toBeNull();
    expect(button("Test key")).toBeDefined();
    expect(button("Replace key")).toBeDefined();
    expect(button("Remove key")).toBeDefined();
  });

  it("hints at a key that doesn't look like one but saves it anyway", async () => {
    await mount("#/");
    await openSettings();
    await type(keyInput()!, "abcd-efgh-ijkl");
    expect(sheet()?.textContent).toContain("doesn't look like an Anthropic API key");
    await click(button("Save key"));
    expect(status()).toContain("Key saved for this session only (•••• ijkl)");
  });

  it("an empty key isn't saved", async () => {
    await mount("#/");
    await openSettings();
    await saveKey("   ");
    expect(status()).toBe("No key saved.");
    expect(sheet()?.textContent).toContain("Paste your key first.");
  });

  it("Replace key shows the form with Cancel", async () => {
    await mount("#/");
    await openSettings();
    await saveKey();
    await click(button("Replace key"));
    expect(keyInput()).not.toBeNull();
    await click(button("Cancel"));
    expect(keyInput()).toBeNull();
    expect(status()).toContain("•••• abcd");
    await click(button("Replace key"));
    await saveKey("sk-ant-api03-FAKE-settings-ui-key-0000wxyz");
    expect(status()).toContain("•••• wxyz");
  });

  it("Remove key needs no confirm, clears it and announces it", async () => {
    localStorage.setItem("stickyard:ai-key", KEY);
    await mount("#/");
    await openSettings();
    expect(status()).toBe("Key remembered on this device (•••• abcd).");
    await click(button("Remove key"));
    expect(status()).toBe("No key saved.");
    expect(announcer()?.textContent).toContain("Key removed.");
    expect(localStorage.getItem("stickyard:ai-key")).toBeNull();
  });
});

describe("Remember on this device", () => {
  it("shows the red warning page first; Cancel keeps this session only", async () => {
    await mount("#/");
    await openSettings();
    await choose("device");
    const warning = document.querySelector<HTMLElement>("[data-ai-remember-warning]");
    expect(warning?.textContent).toContain(
      "It's stored unencrypted in this browser. Anyone who uses this browser, and other pages on this web address, could read it and spend on your Anthropic account. Only choose this on a device that's yours alone.",
    );
    expect(warning?.querySelector(".text-status-error, .border-status-error")).not.toBeNull();
    expect(document.activeElement?.textContent?.trim()).toBe("Cancel");
    await click(button("Cancel"));
    expect(document.querySelector("[data-ai-remember-warning]")).toBeNull();
    expect(radio("session")?.checked).toBe(true);
  });

  it("once confirmed, remembers the key on this device", async () => {
    await mount("#/");
    await openSettings();
    await saveKey();
    await choose("device");
    await click(button("Remember on this device"));
    expect(status()).toBe("Key remembered on this device (•••• abcd).");
    expect(localStorage.getItem("stickyard:ai-key")).toBe(KEY);
    expect(radio("device")?.checked).toBe(true);
    // Back to this session only: the stored copy goes.
    await choose("session");
    expect(localStorage.getItem("stickyard:ai-key")).toBeNull();
    expect(status()).toContain("Key saved for this session only");
  });

  it("blocked storage falls back to this session only and says so", async () => {
    await mount("#/");
    await openSettings();
    await saveKey();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    await choose("device");
    await click(button("Remember on this device"));
    expect(status()).toContain("Key saved for this session only");
    expect(announcer()?.textContent).toContain("This browser won't store it");
  });
});

describe("Test key", () => {
  it("goes through the check-before-sending page, then counts tokens for both models", async () => {
    await mount("#/");
    await openSettings();
    await saveKey();
    await click(button("Test key"));
    const check = document.querySelector<HTMLElement>("[data-send-check]");
    expect(check?.textContent).toContain("Claude Haiku 5.5");
    expect(check?.textContent).toContain("Claude Sonnet 5.5");
    expect(check?.textContent).toContain("What's sent");
    expect(check?.querySelectorAll("li").length).toBeGreaterThan(0);
    expect(check?.textContent).toMatch(/estimate/i);
    expect(check?.textContent).toContain("It goes straight from this browser to api.anthropic.com. Stickyard has no AI server.");
    expect(document.activeElement?.textContent?.trim()).toBe("Cancel");
    // The first-time notice is not shown for Test key.
    expect(document.querySelector("[data-ai-notice]")).toBeNull();
    expect(calls).toHaveLength(0);
    await click(button("Send"));
    for (let i = 0; i < 20 && !/Last test worked/.test(sheet()?.textContent ?? ""); i++) await settle();
    expect(calls.map((c) => c.url)).toEqual(["https://api.anthropic.com/v1/messages/count_tokens", "https://api.anthropic.com/v1/messages/count_tokens"]);
    expect(sheet()?.textContent).toMatch(/Last test worked at \d{2}:\d{2}\./);
    expect(announcer()?.textContent).toMatch(/Last test worked at \d{2}:\d{2}\./);
  });

  it("Cancel on the check page sends nothing", async () => {
    await mount("#/");
    await openSettings();
    await saveKey();
    await click(button("Test key"));
    await click(button("Cancel"));
    expect(document.querySelector("[data-send-check]")).toBeNull();
    expect(calls).toHaveLength(0);
    expect(document.activeElement?.textContent?.trim()).toBe("Test key");
  });

  it("names the model that failed, with Details and Retry", async () => {
    anthropic = (_url, init) => {
      const model = (JSON.parse(String(init.body)) as { model: string }).model;
      return model === "claude-sonnet-5-5"
        ? new Response(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model: claude-sonnet-5-5" }, request_id: "req_fake_1" }), { status: 404 })
        : new Response(JSON.stringify({ input_tokens: 5 }), { status: 200 });
    };
    await mount("#/");
    await openSettings();
    await saveKey();
    await click(button("Test key"));
    await click(button("Send"));
    for (let i = 0; i < 20 && !errorBox(); i++) await settle();
    expect(errorBox()?.getAttribute("role")).toBe("alert");
    expect(errorBox()?.textContent).toContain("Claude Sonnet 5.5");
    expect(errorBox()?.textContent).not.toContain("Claude Haiku 5.5");
    expect(errorBox()?.textContent).toContain("HTTP 404 · not_found_error · model: claude-sonnet-5-5 · request req_fake_1");
    expect(sheet()?.textContent).toMatch(/Last test failed at \d{2}:\d{2}\./);
    anthropic = () => new Response(JSON.stringify({ input_tokens: 5 }), { status: 200 });
    await click(button("Retry"));
    for (let i = 0; i < 20 && errorBox(); i++) await settle();
    expect(errorBox()).toBeNull();
    expect(sheet()?.textContent).toMatch(/Last test worked/);
  });

  it("a cancelled test is not a failure", async () => {
    anthropic = (_url, init) => new Promise<Response>((_res, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    await mount("#/");
    await openSettings();
    await saveKey();
    await click(button("Test key"));
    await click(button("Send"));
    expect(document.querySelector("[data-ai-testing]")?.textContent).toContain("Testing");
    await click(button("Cancel"));
    expect(errorBox()).toBeNull();
    expect(sheet()?.textContent).not.toMatch(/Last test/);
    expect(announcer()?.textContent).toContain("Test cancelled.");
  });

  it("a key change during a test discards its result", async () => {
    let release: (() => void) | undefined;
    anthropic = () => new Promise<Response>((res) => (release = () => res(new Response(JSON.stringify({ input_tokens: 5 }), { status: 200 }))));
    await mount("#/");
    await openSettings();
    await saveKey();
    await click(button("Test key"));
    await click(button("Send"));
    await click(button("Remove key"));
    await act(async () => release?.());
    await settle();
    await settle();
    expect(sheet()?.textContent).not.toMatch(/Last test/);
    expect(status()).toBe("No key saved.");
  });
});
