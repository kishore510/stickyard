// @vitest-environment happy-dom
import { PROTOCOL_VERSION } from "@stickyard/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The app shell, rendered for real: menu, sheets, hash routes, theme and the What's new dot.
 * The connection check is stubbed (no sockets in tests). Modules are re-imported for each
 * test so stores read storage afresh.
 */

vi.mock("../src/connection/store", async () => {
  const { create } = await import("zustand");
  return { useConnectionCheck: create(() => ({ status: "connected", start: () => () => {} })) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement;

async function mount(hash = "#/") {
  window.history.replaceState(null, "", `/${hash}`);
  vi.resetModules();
  const { App } = await import("../src/App");
  const { startTheme } = await import("../src/shell/theme");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    startTheme();
    root?.render(<App />);
  });
}

/** Lets hashchange/popstate events land and React re-render. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const dialogTitle = () => dialog()?.querySelector("h2")?.textContent;
const byLabel = (label: string | RegExp) =>
  [...document.querySelectorAll<HTMLElement>("button, a")].find((el) => {
    const name = el.getAttribute("aria-label") ?? el.textContent ?? "";
    return typeof label === "string" ? name === label : label.test(name);
  });
const button = (text: string | RegExp) =>
  [...document.querySelectorAll<HTMLElement>("button")].find((b) =>
    typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? ""),
  );

async function click(el: HTMLElement | undefined) {
  expect(el).toBeDefined();
  await act(async () => el?.click());
  await settle();
}

async function openFromMenu(item: string) {
  await click(byLabel(/^Menu/));
  const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.includes(item));
  await click(entry);
}

async function press(key: string, target: EventTarget = document.activeElement ?? document.body) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await settle();
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

describe("sheets open from the menu, close by Esc and X, and use the hash", () => {
  it.each([
    ["Help", "#/help", "Help"],
    ["What’s new", "#/changelog", "What’s new"],
    ["About Stickyard", "#/about", "About Stickyard"],
  ])("%s", async (item, hash, title) => {
    await mount();
    await openFromMenu(item);
    expect(dialogTitle()).toBe(title);
    expect(window.location.hash).toBe(hash);
    expect(dialog()?.getAttribute("aria-modal")).toBe("true");

    await press("Escape");
    expect(dialog()).toBeNull();
    expect(window.location.hash).toBe("#/");

    await openFromMenu(item);
    expect(dialogTitle()).toBe(title);
    await click(byLabel("Close"));
    expect(dialog()).toBeNull();
  });

  it("returns focus to the menu button on close", async () => {
    await mount();
    await openFromMenu("About Stickyard");
    expect(dialog()?.contains(document.activeElement)).toBe(true);
    await press("Escape");
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Menu/);
  });

  it("keeps Tab inside the sheet", async () => {
    await mount("#/about");
    const focusable = [...(dialog()?.querySelectorAll<HTMLElement>("button, a[href], summary") ?? [])];
    focusable.at(-1)?.focus();
    await press("Tab");
    expect(document.activeElement).toBe(focusable[0]);
  });

  it("tapping outside closes", async () => {
    await mount();
    await openFromMenu("Help");
    const overlay = dialog()?.parentElement;
    await act(async () => overlay?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    await settle();
    expect(dialog()).toBeNull();
  });
});

describe("deep links", () => {
  it.each([
    ["#/help", "Help"],
    ["#/help/names", "Names and identity"],
    ["#/changelog", "What’s new"],
    ["#/about", "About Stickyard"],
  ])("%s opens %s", async (hash, title) => {
    await mount(hash);
    expect(dialogTitle()).toBe(title);
  });

  it("a deep-linked topic has a back arrow to Help, and close goes home", async () => {
    await mount("#/help/names");
    await click(byLabel("Back"));
    expect(dialogTitle()).toBe("Help");
    expect(window.location.hash).toBe("#/help");
    await click(byLabel("Close"));
    expect(dialog()).toBeNull();
    expect(window.location.hash).toBe("#/");
  });

  it("an unknown topic says so instead of failing", async () => {
    await mount("#/help/not-a-topic");
    expect(dialog()?.textContent).toContain("This topic isn’t available");
  });

  it("an unknown route shows not found inside the shell", async () => {
    await mount("#/nope");
    expect(document.querySelector("h1")?.textContent).toBe("Page not found");
    expect(document.querySelector("header")).not.toBeNull();
  });
});

describe("Help", () => {
  it("shows the quick start card and the topics list", async () => {
    await mount("#/help");
    expect(button(/Quick start/)).toBeDefined();
    const topics = [...(dialog()?.querySelectorAll('[aria-labelledby="help-topics"] li') ?? [])].map((li) => li.textContent);
    expect(topics).toEqual(["Starting and joining a session", "Notes", "Text and shapes", "Participants", "Chat", "Names and identity", "Connection", "Touch and keyboard tips", "Running a session", "Dot voting", "Silent brainstorm"]);
  });

  it("search filters topics", async () => {
    await mount("#/help");
    const input = dialog()?.querySelector<HTMLInputElement>('input[type="search"]');
    expect(input?.placeholder).toBe("Search help");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "reload");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const results = dialog()?.querySelector('[aria-label="Search results"]');
    expect(results?.querySelectorAll("li")[0]?.textContent).toContain("Connection");
    expect(results?.textContent).not.toContain("Touch and keyboard tips");
  });

  it("a topic opened from Help has a back arrow to Help", async () => {
    await mount();
    await openFromMenu("Help");
    await click(button("Connection"));
    expect(dialogTitle()).toBe("Connection");
    expect(window.location.hash).toBe("#/help/connection");
    await click(byLabel("Back"));
    expect(dialogTitle()).toBe("Help");
    // Close steps back past both sheets to the page underneath.
    await click(byLabel("Close"));
    expect(dialog()).toBeNull();
    expect(window.location.hash).toBe("#/");
  });
});

describe("What's new", () => {
  it("shows the current version with the This version badge", async () => {
    await mount("#/changelog");
    const current = dialog()?.querySelector('[aria-current="true"]');
    expect(current?.querySelector("h3")?.textContent).toBe("0.30.0");
    expect(current?.textContent).toContain("This version");
    expect(current?.textContent).toMatch(/Added|Changed|Fixed/);
  });

  it("the menu dot shows for an unseen version and clears after opening", async () => {
    localStorage.setItem("stickyard:last-seen-version", "0.2.0");
    await mount();
    expect(document.querySelector('[data-testid="unseen-dot"]')).not.toBeNull();
    expect(byLabel(/^Menu/)?.getAttribute("aria-label")).toBe("Menu (new: what’s changed)");

    await openFromMenu("What’s new");
    await press("Escape");
    expect(document.querySelector('[data-testid="unseen-dot"]')).toBeNull();
    expect(localStorage.getItem("stickyard:last-seen-version")).toBe("0.30.0");
  });

  it("no dot once this version has been seen", async () => {
    localStorage.setItem("stickyard:last-seen-version", "0.30.0");
    await mount();
    expect(document.querySelector('[data-testid="unseen-dot"]')).toBeNull();
  });
});

describe("About", () => {
  const detail = (term: string) =>
    [...(dialog()?.querySelectorAll("dt") ?? [])].find((dt) => dt.textContent === term)?.nextElementSibling?.textContent;

  it("shows version, build, protocol and relay", async () => {
    await mount("#/about");
    expect(detail("Version")).toBe("0.30.0");
    expect(detail("Build")).toMatch(/^([0-9a-f]{4,40}|dev)$/);
    expect(detail("Built")).not.toBe("unknown");
    expect(detail("Protocol")).toBe(`v${PROTOCOL_VERSION}`);
    expect(detail("Relay")).toMatch(/^[\w.-]+(:\d+)?$/);
  });

  it("Copy details copies only the allowed fields", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const token = "fakeHostToken".padEnd(43, "x");
    localStorage.setItem("stickyard:host:aaaaaaaaaaaaaaaaaaaaaa", token);
    await mount("#/about");
    await click(button("Copy details"));
    const copied = writeText.mock.calls[0] as unknown as [string];
    expect(copied[0]).not.toContain(token);
    localStorage.removeItem("stickyard:host:aaaaaaaaaaaaaaaaaaaaaa");
    const lines = copied[0].split("\n");
    expect(lines.map((l) => l.split(/[ :]/)[0])).toEqual(["Stickyard", "Build", "Protocol", "Browser"]);
    expect(copied[0]).not.toMatch(/relay|workers\.dev|stickyard:/i);
    expect(button("Copied")).toBeDefined();
  });

  it("Privacy matches this version", async () => {
    await mount("#/about");
    const privacy = dialog()?.querySelector('[aria-labelledby="about-privacy"]')?.textContent ?? "";
    for (const claim of [
      "visible to everyone in the session",
      "never verified",
      "never stored in your browser",
      "short-term request logs",
      "contains the session’s room code",
      "approximate location",
      "possibly your IP address",
      "the last name you joined with",
      "Notes are stored by the relay",
      "random id the relay gave the visit that added it (not your name)",
      // Idle room expiry (v0.14.0).
      "a session’s notes, frames and shapes are deleted automatically once nobody has been in it for 7 days",
      "keeps only the time it expired",
      "link stops working",
      // Slice z-order: stacking order is stored with each note.
      "stacking order (which notes are in front)",
      // Slice frames: frames are stored with the room.
      "Frames are stored with the room",
      "position, size, title, colour and title style",
      // Slice 2.6: the panel layout is a layout preference kept on this device.
      "how wide the board’s side panels are and whether they’re collapsed",
      "layout preferences only",
      "no session content and nothing about you",
      "stays on this device",
      // Protocol v12: the host key, on the creator's device only.
      "host key",
      "only on the device that started the session",
      "removed when the session ends or expires",
      // Protocol v13: dot voting's key on this device, and anonymous votes on the relay.
      "random voting key",
      "clearing this browser’s data resets your dots",
      "stores votes against a scrambled version of that key, not your name",
      "never reveals who voted for what",
      // Protocol v17: silent brainstorm's hidden writer id, removed at the reveal.
      "hidden writer id",
      "removed from every note when the host reveals them",
      // Live cursors (v0.19.0): pointers shared live, never stored; the two switches stored here.
      // Follow and Bring to me (protocol v19): views passed on live to followers only, a count, never stored.
      "only to the people following you",
      "never who",
      "None of this is stored by the relay or in your browser",
      "pointer’s position on the board is passed on live",
      "never stored",
      "whether you show other people’s cursors and share yours",
      // Export (v0.22.0): made in the browser, nothing uploaded.
      "Export PNG and Export Markdown are made in your browser",
      "nothing is uploaded or sent to the relay",
    ]) {
      expect(privacy, claim).toContain(claim);
    }
    // Slice 0.5 text that is no longer true.
    expect(privacy).not.toContain("only checks that the relay is reachable");
    expect(privacy).not.toContain("When joining sessions arrives");
    expect(privacy).not.toContain("Nothing is saved");
    expect(privacy).not.toContain("don’t expire");
  });

  it("has Privacy and Credits sections", async () => {
    await mount("#/about");
    expect(dialog()?.querySelector("#about-privacy")?.textContent).toBe("Privacy");
    expect(dialog()?.textContent).toContain("No analytics, no tracking");
    expect(dialog()?.textContent).not.toMatch(/no network requests/i);
    expect(dialog()?.querySelector("#about-credits")?.textContent).toBe("Credits");
    expect(dialog()?.textContent).toContain("Zustand");
  });
});

describe("theme", () => {
  it("cycles and persists under the stickyard: prefix", async () => {
    await mount();
    expect(byLabel(/^Theme: follow system/)).toBeDefined();
    await click(byLabel(/^Theme:/));
    expect(localStorage.getItem("stickyard:theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    await click(byLabel(/^Theme:/));
    expect(localStorage.getItem("stickyard:theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("restores the stored choice on load", async () => {
    localStorage.setItem("stickyard:theme", "dark");
    await mount();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(byLabel(/^Theme: dark/)).toBeDefined();
  });
});

describe("shell landmarks", () => {
  it("has header, nav, main, footer and a skip link", async () => {
    await mount();
    for (const tag of ["header", "nav", "main", "footer"]) expect(document.querySelector(tag), tag).not.toBeNull();
    expect(button("Skip to content") ?? byLabel("Skip to content")).toBeDefined();
    expect(document.querySelector("main h1")?.textContent).toBe("Stickyard");
  });

  it("the menu has icon + label items with a divider, and arrow keys move between them", async () => {
    await mount();
    await click(byLabel(/^Menu/));
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent?.replace("New", ""))).toEqual(["Help", "What’s new", "About Stickyard"]);
    expect(document.querySelectorAll('[role="menu"] [role="separator"]')).toHaveLength(1);
    expect(document.activeElement).toBe(items[0]);
    await press("ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    await press("ArrowUp");
    await press("ArrowUp");
    expect(document.activeElement).toBe(items[2]);
    await press("Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Menu/);
  });
});
