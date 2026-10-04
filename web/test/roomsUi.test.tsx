// @vitest-environment happy-dom
import { FRAME_DEFAULTS, MAX_NOTES_PER_ROOM, MAX_NOTE_TEXT, PROTOCOL_VERSION, type Frame, type Note, NOTE_DEFAULTS, NOTE_MAX_H, NOTE_MAX_W, type Participant } from "@stickyard/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Starting, joining and using a room, rendered for real. `fetch` and `WebSocket` are
 * replaced by fakes the tests drive by hand.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = `${"a".repeat(22)}.${"B".repeat(22)}`;
/** A fake host token (43 base64url characters), never a real one. */
const HOST_TOKEN = "fakeHostToken".padEnd(43, "x");
const PASSCODE = "test-passcode-in-the-ui";
const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0, host: false };
const sam: Participant = { id: "BBBBBBBBBBBBBBBB", name: "Sam", colourIndex: 9, host: false };

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
}
/** A board-bar command that is off (since v0.15.1 it stays focusable: aria-disabled, never hidden). */
const isOff = (el: Element | null | undefined) => el?.getAttribute("aria-disabled") === "true";
/** The tooltip a command points at (aria-describedby): its name, or why it's off. */
const tipOf = (el: Element | null | undefined) => {
  const id = el?.getAttribute("aria-describedby");
  return id ? document.getElementById(id) : null;
};
const lastSocket = () => {
  const s = FakeWebSocket.instances.at(-1);
  if (!s) throw new Error("no socket");
  return s;
};
async function server(socket: FakeWebSocket, event: "open" | "close" | { close: number } | { data: unknown }) {
  await act(async () => {
    if (event === "open") socket.onopen?.();
    else if (event === "close") socket.onclose?.({ code: 1006 });
    else if ("close" in event) socket.onclose?.({ code: event.close });
    else socket.onmessage?.({ data: JSON.stringify(event.data) });
  });
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: Route;
const fetchCalls: [string, RequestInit | undefined][] = [];
const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const healthy: Route = (url) =>
  url.endsWith("/health") ? jsonResponse(200, { ok: true, protocolVersion: PROTOCOL_VERSION }) : jsonResponse(404, {});

let root: Root | undefined;

/*
 * Breakpoints: by default there's no matchMedia match (phone layout). setWide(true) makes every
 * min-width query match (a 1280px window) and tells listeners, like a resize or rotation.
 */
let wide = false;
const mediaListeners = new Set<() => void>();
function setWide(value: boolean) {
  wide = value;
  for (const listener of mediaListeners) listener();
}
const fakeMatchMedia = (query: string) => ({
  get matches() {
    return wide && query.includes("min-width");
  },
  media: query,
  addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
  removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
});

async function mount(hash = "#/") {
  window.history.replaceState(null, "", `/${hash}`);
  vi.resetModules();
  const { App } = await import("../src/App");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<App />));
  await settle();
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

const byText = (selector: string, text: string | RegExp) =>
  [...document.querySelectorAll<HTMLElement>(selector)].find((el) =>
    typeof text === "string" ? el.textContent?.trim() === text : text.test(el.textContent ?? ""),
  );
const button = (text: string | RegExp) => byText("button", text);
const input = (label: string) => {
  const l = byText("label", label);
  const id = l?.getAttribute("for");
  const el = id ? document.getElementById(id) : l?.querySelector("input");
  if (!(el instanceof HTMLInputElement)) throw new Error(`no input labelled ${label}`);
  return el;
};
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit(el: HTMLElement | undefined) {
  const form = el?.closest("form");
  if (!form) throw new Error("no form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}
async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => el.click());
  await settle();
}
const alertText = () => [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(" ");

function storageSnapshot() {
  const dump = (s: Storage) => JSON.stringify(Object.fromEntries(Array.from({ length: s.length }, (_, i) => [s.key(i), s.getItem(s.key(i) ?? "")])));
  return `${dump(localStorage)}|${dump(sessionStorage)}`;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  FakeWebSocket.instances = [];
  fetchCalls.length = 0;
  routes = healthy;
  wide = false;
  mediaListeners.clear();
  vi.stubGlobal("matchMedia", fakeMatchMedia);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    fetchCalls.push([url, init]);
    return Promise.resolve(routes(url, init));
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("home", () => {
  it("is a welcome screen: one h1 (the wordmark as text), the decorative mark, the tagline, both actions and three points", async () => {
    await mount();
    const main = document.querySelector("main");
    expect(main?.querySelectorAll("h1")).toHaveLength(1);
    expect(main?.querySelector("h1")?.textContent).toBe("Stickyard");
    const mark = main?.querySelector("svg[data-stickyard-mark]");
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(main?.textContent).toContain("Sticky-note boards for workshops and retros. No accounts: open a link, type a name.");
    expect(button("Start session")).toBeDefined();
    expect(button("Join")).toBeDefined();
    const points = [...(main?.querySelectorAll("[data-welcome-points] li") ?? [])].map((li) => li.textContent);
    expect(points).toHaveLength(3);
    expect(main?.textContent).not.toContain("LOCAL-FIRST");
    expect(main?.textContent).not.toContain("echo room");
    // The version stays on the page.
    expect(document.querySelector("footer")?.textContent).toMatch(/Stickyard v\d+\.\d+\.\d+/);
  });

  it("sheets open over the welcome screen, and closing goes back to it", async () => {
    await mount();
    await click(byText("footer a", /Stickyard v/));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(window.location.hash).toBe("#/about");
    expect(document.querySelector("main h1")?.textContent).toBe("Stickyard");
    await click(document.querySelector<HTMLElement>('[role="dialog"] [aria-label="Close"]') ?? undefined);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(window.location.hash).toBe("#/");
    expect(document.querySelector("main svg[data-stickyard-mark]")).not.toBeNull();
  });

  it("has Start a session, Join a session and the connection status", async () => {
    await mount();
    expect(document.querySelector("main h1")?.textContent).toBe("Stickyard");
    expect(byText("h2", "Start a session")).toBeDefined();
    expect(byText("h2", "Join a session")).toBeDefined();
    expect(document.body.textContent).toContain(`Connected (protocol v${PROTOCOL_VERSION})`);
  });

  it("the passcode field is a password field a password manager can fill, length-capped", async () => {
    await mount();
    const field = input("Create passcode");
    expect(field.type).toBe("password");
    expect(field.autocomplete).toBe("current-password");
    expect(field.maxLength).toBe(256);
    expect(field.required).toBe(true);
  });

  it.each([
    ["the same protocol", PROTOCOL_VERSION, "Connected"],
    ["another protocol", PROTOCOL_VERSION + 1, "Please reload"],
  ])("the status line with %s says %s", async (_label, version, text) => {
    routes = (url) => (url.endsWith("/health") ? jsonResponse(200, { ok: true, protocolVersion: version }) : jsonResponse(404, {}));
    await mount();
    expect(document.body.textContent).toContain(text);
  });

  it("the status line says cannot connect when /health fails", async () => {
    routes = () => {
      throw new TypeError("Failed to fetch");
    };
    await mount();
    expect(document.body.textContent).toContain("Cannot connect");
  });
});

describe("start a session", () => {
  it("creates a room, goes to it, clears the passcode, and stores only the room's host token", async () => {
    routes = (url, init) =>
      url.endsWith("/rooms") && init?.method === "POST" ? jsonResponse(200, { code: CODE, hostToken: HOST_TOKEN }) : healthy(url, init);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await mount();
    const before = storageSnapshot();
    const field = input("Create passcode");
    await type(field, PASSCODE);
    await submit(button("Start session"));

    const post = fetchCalls.find(([url]) => url.endsWith("/rooms"));
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ passcode: PASSCODE });
    expect(post?.[0]).not.toContain(PASSCODE);
    expect(window.location.hash).toBe(`#/room/${CODE}`);

    // The one new key: this room's host token (protocol v12), under stickyard:host:<room id>.
    expect(localStorage.getItem(`stickyard:host:${CODE.split(".")[0]}`)).toBe(HOST_TOKEN);
    localStorage.removeItem(`stickyard:host:${CODE.split(".")[0]}`);
    expect(storageSnapshot()).toBe(before);
    expect(storageSnapshot()).not.toContain(PASSCODE);
    for (const call of setItem.mock.calls) expect(JSON.stringify(call)).not.toContain(PASSCODE);
    // The token is never in the address.
    expect(window.location.href).not.toContain(HOST_TOKEN);
  });

  it.each([
    ["wrong passcode", jsonResponse(401, { error: "invalid_passcode" }), /passcode didn’t work/i],
    ["rate limited", jsonResponse(429, { error: "rate_limited" }, { "retry-after": "900" }), /15 minutes/],
    ["creation disabled", jsonResponse(503, { error: "creation_disabled" }), /switched off/i],
    ["not configured", jsonResponse(503, { error: "not_configured" }), /isn’t set up/i],
  ])("%s shows a friendly message and clears the passcode", async (_label, response, message) => {
    routes = (url, init) => (url.endsWith("/rooms") ? response : healthy(url, init));
    await mount();
    const before = storageSnapshot();
    await type(input("Create passcode"), PASSCODE);
    await submit(button("Start session"));
    expect(alertText()).toMatch(message);
    expect(input("Create passcode").value).toBe("");
    expect(window.location.hash).toBe("#/");
    expect(storageSnapshot()).toBe(before);
  });

  it("a network failure says the relay couldn't be reached", async () => {
    routes = (url, init) => {
      if (url.endsWith("/rooms")) throw new TypeError("Failed to fetch");
      return healthy(url, init);
    };
    await mount();
    await type(input("Create passcode"), PASSCODE);
    await submit(button("Start session"));
    expect(alertText()).toMatch(/couldn’t reach/i);
  });
});

describe("join a session", () => {
  it.each([
    ["a pasted full link", `https://kishore510.github.io/stickyard/#/room/${CODE}`],
    ["just a code", CODE],
  ])("by %s", async (_label, value) => {
    await mount();
    await type(input("Session link or code"), value);
    await submit(button("Join"));
    expect(window.location.hash).toBe(`#/room/${CODE}`);
  });

  it("something that isn't a link or code gets a message", async () => {
    await mount();
    await type(input("Session link or code"), "hello there");
    await submit(button("Join"));
    expect(alertText()).toMatch(/doesn’t look like a Stickyard link/i);
    expect(window.location.hash).toBe("#/");
  });
});

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

async function joinAs(name: string) {
  await type(input("Your name"), name);
  await submit(button("Join"));
  const socket = lastSocket();
  await server(socket, "open");
  await server(socket, { data: { type: "welcome", protocolVersion: PROTOCOL_VERSION } });
  return socket;
}

describe("the name sheet", () => {
  it("opens on a room link, says names are unverified, and focuses the name", async () => {
    await mount(`#/room/${CODE}`);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Join session");
    expect(dialog()?.textContent).toMatch(/names aren’t verified/i);
    expect(dialog()?.textContent).toMatch(/anyone with the link can join/i);
    expect(document.activeElement).toBe(input("Your name"));
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("prefills the last-used name", async () => {
    localStorage.setItem("stickyard:name", "Alex");
    await mount(`#/room/${CODE}`);
    expect(input("Your name").value).toBe("Alex");
  });

  it("joins: hello, then join with the name, and remembers it", async () => {
    await mount(`#/room/${CODE}`);
    const socket = await joinAs("Alex");
    expect(socket.url).toContain(`/ws?room=${CODE}`);
    expect(socket.sent).toEqual([
      { type: "hello", protocolVersion: PROTOCOL_VERSION },
      { type: "join", name: "Alex" },
    ]);
    await server(socket, { data: { type: "joined", you: alex, participants: [alex], locked: false, timer: null } });
    expect(dialog()).toBeNull();
    expect(localStorage.getItem("stickyard:name")).toBe("Alex");
  });

  it("an invalid name is announced in the sheet", async () => {
    await mount(`#/room/${CODE}`);
    const socket = await joinAs("Alex");
    await server(socket, { data: { type: "error", code: "invalid_name", message: "x" } });
    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toMatch(/name/i);
  });

  it("an empty name is refused before sending", async () => {
    await mount(`#/room/${CODE}`);
    await type(input("Your name"), "  ​ ");
    await submit(button("Join"));
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(dialog()?.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("closing the sheet goes home", async () => {
    await mount(`#/room/${CODE}`);
    await click(dialog()?.querySelector<HTMLElement>('[aria-label="Close"]') ?? undefined);
    expect(window.location.hash).toBe("#/");
  });
});

async function inRoom() {
  await mount(`#/room/${CODE}`);
  const socket = await joinAs("Alex");
  await server(socket, { data: { type: "joined", you: alex, participants: [alex, sam], locked: false, timer: null } });
  return socket;
}

/** Open a top bar button by its label prefix (e.g. "Participants", "Chat"). */
async function openFromTopBar(label: string) {
  await click(document.querySelector<HTMLElement>(`header [aria-label^="${label}"]`) ?? undefined);
}

describe("the room", () => {
  it("a room link goes straight to the name sheet: no welcome screen", async () => {
    await mount(`#/room/${CODE}`);
    expect(document.querySelector("svg[data-stickyard-mark]")).toBeNull();
    expect(document.body.textContent).not.toContain("Sticky-note boards for workshops and retros.");
    expect(byText("label", "Your name")).toBeDefined();
  });

  it("is a full-bleed board: no Session heading, message box or People list on the page", async () => {
    await inRoom();
    expect(document.querySelector("main h1")).toBeNull();
    expect(byText("label", "Message")).toBeUndefined();
    expect(document.querySelector('[aria-labelledby="people-heading"]')).toBeNull();
    expect(document.querySelector('[aria-label="Board"]')).not.toBeNull();
    // No page footer under the board.
    expect(document.querySelector("footer")).toBeNull();
  });

  it("Participants (top bar) lists people with a colour dot from the token palette, and always the name", async () => {
    await inRoom();
    expect(document.querySelector('header [aria-label^="Participants"]')?.getAttribute("aria-label")).toBe("Participants: 2 people in this session");
    await openFromTopBar("Participants");
    expect(window.location.hash).toBe("#/participants");
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Participants");
    const people = [...(dialog()?.querySelectorAll('[aria-label="People in this session"] li') ?? [])];
    expect(people.map((li) => li.textContent?.replace(" (you)", ""))).toEqual(["Alex", "Sam"]);
    expect(people[0]?.textContent).toContain("(you)");
    expect(people[0]?.querySelector('[aria-hidden="true"]')?.className).toContain("bg-participant-1");
    // colourIndex 9 → 9 % 8 = 1 → the second palette colour.
    expect(people[1]?.querySelector('[aria-hidden="true"]')?.className).toContain("bg-participant-2");
    expect(dialog()?.textContent).toMatch(/names aren’t verified/i);
  });

  it("Participants is in the menu only while in a session", async () => {
    await mount();
    await click(document.querySelector<HTMLElement>('[aria-label^="Menu"]') ?? undefined);
    expect(byText('[role="menuitem"]', "Participants")).toBeUndefined();
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    await inRoom();
    await click(document.querySelector<HTMLElement>('[aria-label^="Menu"]') ?? undefined);
    await click(byText('[role="menuitem"]', "Participants"));
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Participants");
  });

  it("renders participant names as plain text, never HTML", async () => {
    const socket = await inRoom();
    await server(socket, { data: { type: "participant_joined", participant: { id: "CCCCCCCCCCCCCCCC", name: "<i>Kai</i>", colourIndex: 2, host: false } } });
    await openFromTopBar("Participants");
    expect(dialog()?.textContent).toContain("<i>Kai</i>");
    expect(dialog()?.querySelector("i")).toBeNull();
  });

  it("announces joins and leaves in a polite live region, batched into one toast", async () => {
    const socket = await inRoom();
    await server(socket, { data: { type: "snapshot", notes: [] } });
    const live = () => [...document.querySelectorAll('[aria-live="polite"]')].map((e) => e.textContent).join(" ");
    await server(socket, { data: { type: "participant_joined", participant: { id: "CCCCCCCCCCCCCCCC", name: "Kai", colourIndex: 2, host: false } } });
    await server(socket, { data: { type: "participant_left", id: sam.id } });
    expect(live()).not.toContain("Kai joined");
    // A leave waits a short grace (a quick reconnect cancels it), so the toast comes after it.
    await act(() => new Promise((resolve) => setTimeout(resolve, 3100)));
    expect(live()).toContain("Kai joined, Sam left");
  });

  it("Copy link (in Participants) copies the page's own room link", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await inRoom();
    await openFromTopBar("Participants");
    await click(button("Copy link"));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/#/room/${CODE}`);
  });

  it("Leave (in Participants) closes the socket and goes home", async () => {
    const socket = await inRoom();
    await openFromTopBar("Participants");
    await click(button("Leave session"));
    expect(socket.closed).toBe(true);
    expect(window.location.hash).toBe("#/");
  });

  it("a dropped connection says so politely and reconnects by itself; offline, it offers Rejoin", async () => {
    const socket = await inRoom();
    await server(socket, "close");
    const status = document.querySelector<HTMLElement>("[data-connection-status]");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent).toMatch(/Reconnecting…/);
    expect(alertText()).not.toMatch(/connection lost/i);
    await act(async () => window.dispatchEvent(new Event("offline")));
    await settle();
    expect(document.querySelector("[data-connection-status]")?.textContent).toMatch(/You’re offline/);
    await click(button("Rejoin"));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("opening Help keeps you in the room, and closing it returns to the room", async () => {
    const socket = await inRoom();
    await click(document.querySelector<HTMLElement>('[aria-label^="Menu"]') ?? undefined);
    await click(byText('[role="menuitem"]', "Help"));
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Help");
    expect(socket.closed).toBe(false);
    expect(document.querySelector('[aria-label="Board"]')).not.toBeNull();
  });
});

describe("chat", () => {
  const chatButton = () => document.querySelector<HTMLElement>('header [aria-label^="Chat"]');
  const messages = () => document.querySelector('[aria-label="Messages"]');

  it("is collapsed by default: a button, no messages shown", async () => {
    await inRoom();
    expect(chatButton()?.getAttribute("aria-label")).toBe("Chat");
    expect(chatButton()?.getAttribute("aria-expanded")).toBe("false");
    expect(messages()).toBeNull();
  });

  it("counts unread messages from others while collapsed, and clears them on open", async () => {
    const socket = await inRoom();
    await server(socket, { data: { type: "echo", from: sam.id, text: "One" } });
    await server(socket, { data: { type: "echo", from: sam.id, text: "Two" } });
    expect(chatButton()?.getAttribute("aria-label")).toBe("Chat, 2 unread");
    expect(chatButton()?.querySelector('[data-testid="unread-dot"]')).not.toBeNull();
    await openFromTopBar("Chat");
    expect(messages()?.textContent).toContain("Two");
    await click(dialog()?.querySelector<HTMLElement>('[aria-label="Close"]') ?? undefined);
    expect(chatButton()?.getAttribute("aria-label")).toBe("Chat");
    expect(chatButton()?.querySelector('[data-testid="unread-dot"]')).toBeNull();
  });

  it("sends a message with Send and shows echoes; says messages aren't saved", async () => {
    const socket = await inRoom();
    await openFromTopBar("Chat");
    expect(dialog()?.textContent).toMatch(/aren’t saved/i);
    await type(input("Message"), "Hello all");
    await submit(button("Send"));
    expect(socket.sent.at(-1)).toEqual({ type: "say", text: "Hello all" });
    expect(input("Message").value).toBe("");
    await server(socket, { data: { type: "echo", from: alex.id, text: "Hello all" } });
    expect(messages()?.textContent).toContain("Alex");
    expect(messages()?.textContent).toContain("Hello all");
  });

  it("each message shows when it arrived, as a <time> with the full date in its tooltip", async () => {
    const socket = await inRoom();
    await server(socket, { data: { type: "echo", from: sam.id, text: "Hi" } });
    await openFromTopBar("Chat");
    const time = messages()?.querySelector("time");
    expect(time?.getAttribute("datetime")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(time?.getAttribute("title")).toBeTruthy();
    expect(time?.textContent).toMatch(/\d/);
  });

  it("from md up, the chat panel has a resize grip (arrow keys too; double-click resets), and keeps the size", async () => {
    setWide(true);
    await inRoom();
    await click(document.querySelector<HTMLElement>('[data-chat-dock] [aria-label^="Chat"]') ?? undefined);
    const panel = () => document.querySelector<HTMLElement>('[data-chat-dock] [role="region"]');
    const grip = () => panel()?.querySelector<HTMLElement>('[aria-label="Resize chat"]');
    expect(grip()).toBeTruthy();
    expect(panel()?.className).toContain("w-chat-w");
    await act(async () => {
      grip()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
    expect(panel()?.style.width).toMatch(/px$/);
    expect(JSON.parse(localStorage.getItem("stickyard:chat-panel") ?? "null")).toMatchObject({ width: expect.any(Number) });
    await act(async () => {
      grip()?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(panel()?.style.width).toBe("");
    expect(panel()?.className).toContain("w-chat-w");
  });

  it("renders chat text and names as plain text, never HTML", async () => {
    const socket = await inRoom();
    const evil = '<img src=x onerror="alert(1)"><b>bold</b>';
    await server(socket, { data: { type: "participant_joined", participant: { id: "CCCCCCCCCCCCCCCC", name: "<i>Kai</i>", colourIndex: 2, host: false } } });
    await server(socket, { data: { type: "echo", from: "CCCCCCCCCCCCCCCC", text: evil } });
    await openFromTopBar("Chat");
    expect(messages()?.textContent).toContain(evil);
    expect(messages()?.textContent).toContain("<i>Kai</i>");
    expect(document.querySelector("img")).toBeNull();
    expect(messages()?.querySelector("b, i")).toBeNull();
  });

  it("from md up, chat is a floating button on the board instead of a top bar button", async () => {
    setWide(true);
    const socket = await inRoom();
    expect(chatButton()).toBeNull();
    const floating = () => document.querySelector<HTMLElement>('[data-chat-dock] [aria-label^="Chat"]');
    await server(socket, { data: { type: "echo", from: sam.id, text: "Hi" } });
    expect(floating()?.getAttribute("aria-label")).toBe("Chat, 1 unread");
    await click(floating() ?? undefined);
    expect(messages()?.textContent).toContain("Hi");
    expect(floating()?.getAttribute("aria-label")).toBe("Chat");
  });
});

describe("the board", () => {
  const N1 = "NNNNNNNNNNNNNNN1";
  const one: Note = { id: N1, x: 40, y: 60, ...NOTE_DEFAULTS, text: "Idea one", color: "yellow", z: 0, rev: 1, authorId: sam.id };
  const notes = () => [...document.querySelectorAll<HTMLElement>('[aria-roledescription="note"]')];
  const position = (note: HTMLElement | undefined) => note?.closest<HTMLElement>(".react-flow__node")?.style.transform.replaceAll(" ", "");
  const sentOfType = (socket: FakeWebSocket, type: string) =>
    (socket.sent as Record<string, unknown>[]).filter((m) => m.type === type);
  const textarea = () => dialog()?.querySelector("textarea") ?? null;
  const titleField = () => dialog()?.querySelector<HTMLInputElement>('input[name="title"]') ?? null;
  async function typeArea(value: string) {
    const el = textarea();
    if (!el) throw new Error("no editor");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function typeTitle(value: string) {
    const el = titleField();
    if (!el) throw new Error("no title field");
    await type(el, value);
  }
  async function key(el: HTMLElement | null | undefined, k: string, init: KeyboardEventInit = {}) {
    if (!el) throw new Error("no element");
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
    });
  }
  async function withNotes(...list: Note[]) {
    const socket = await inRoom();
    await server(socket, { data: { type: "snapshot", notes: list } });
    return socket;
  }

  it("renders the snapshot's notes as plain text, labelled with colour and truncated text", async () => {
    const evil = '<img src=x onerror="alert(1)"><b>Needs follow-up</b>';
    await withNotes(one, { ...one, id: "NNNNNNNNNNNNNNN2", text: evil, color: "pink" });
    expect(notes().map((n) => n.getAttribute("aria-label"))).toEqual([
      "Yellow note: Idea one",
      `Pink note: ${evil.slice(0, 40)}…`,
    ]);
    expect(notes()[1]?.textContent).toBe(evil);
    expect(document.querySelector("img")).toBeNull();
    expect(notes()[0]?.tabIndex).toBe(0);
    // Positioned by the canvas (React Flow's node wrapper), in board units.
    expect(position(notes()[0])).toBe("translate(40px,60px)");
  });

  it("Add note opens the add sheet; a colour tile sends noteAdd and opens the editor; Enter saves", async () => {
    const socket = await withNotes();
    await click(document.querySelector<HTMLElement>('[aria-label="Add note"]') ?? undefined);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Add note");
    await click(dialog()?.querySelector<HTMLElement>('[aria-label="Blue note"]') ?? undefined);
    const [add] = sentOfType(socket, "noteAdd");
    expect(add).toMatchObject({ color: "blue", text: "" });
    expect(notes()).toHaveLength(1);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Edit note");
    await server(socket, {
      data: { type: "noteAdded", clientRef: add?.clientRef, note: { ...one, color: "blue", text: "", authorId: alex.id } },
    });
    await typeTitle("Idea one");
    await key(titleField(), "Enter");
    await settle();
    expect(sentOfType(socket, "noteEdit")).toEqual([{ type: "noteEdit", id: N1, text: "Idea one" }]);
    expect(dialog()).toBeNull();
    expect(notes()[0]?.textContent).toBe("Idea one");
  });

  it("the editor shows the first line as Title and the rest as Body, and joins them on save", async () => {
    const socket = await withNotes({ ...one, text: "Idea one\nline two" });
    await key(notes()[0], "Enter");
    expect(titleField()?.value).toBe("Idea one");
    expect(textarea()?.value).toBe("line two");
    await typeArea("line two\nline three");
    await click(byText("button", "Done"));
    expect(sentOfType(socket, "noteEdit")).toEqual([{ type: "noteEdit", id: N1, text: "Idea one\nline two\nline three" }]);
  });

  it("Shift+Enter in Body doesn't save (it's a new line)", async () => {
    const socket = await withNotes(one);
    await key(notes()[0], "Enter");
    await typeArea("more");
    await key(textarea(), "Enter", { shiftKey: true });
    expect(dialog()).not.toBeNull();
    expect(sentOfType(socket, "noteEdit")).toEqual([]);
  });

  it("a remote edit while typing doesn't replace the draft", async () => {
    const socket = await withNotes(one);
    await key(notes()[0], "Enter");
    await typeTitle("My draft");
    await server(socket, { data: { type: "noteUpdated", note: { ...one, text: "Remote text", rev: 2 } } });
    expect(titleField()?.value).toBe("My draft");
    await click(byText("button", "Done"));
    expect(sentOfType(socket, "noteEdit").at(-1)).toEqual({ type: "noteEdit", id: N1, text: "My draft" });
  });

  it("arrow keys move a note, then commit the position", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await withNotes(one);
    await key(notes()[0], "ArrowRight");
    await key(notes()[0], "ArrowDown", { shiftKey: true });
    expect(position(notes()[0])).toBe("translate(50px,110px)");
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(sentOfType(socket, "noteMove").at(-1)).toEqual({ type: "noteMove", id: N1, x: 50, y: 110, final: true });
    vi.useRealTimers();
  });

  it("Delete asks first when the note has text, and deletes on yes", async () => {
    const socket = await withNotes(one, { ...one, id: "NNNNNNNNNNNNNNN2", text: "" });
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await key(notes()[0], "Delete");
    expect(confirm).toHaveBeenCalled();
    expect(sentOfType(socket, "noteDelete")).toEqual([]);
    confirm.mockReturnValue(true);
    await key(notes()[0], "Delete");
    expect(sentOfType(socket, "noteDelete")).toEqual([{ type: "noteDelete", id: N1 }]);
    // An empty note goes without asking.
    confirm.mockClear();
    await key(notes()[0], "Delete");
    expect(confirm).not.toHaveBeenCalled();
    expect(notes()).toHaveLength(0);
  });

  it(`at ${MAX_NOTES_PER_ROOM} notes, Add note is disabled with a reason`, async () => {
    await withNotes(...Array.from({ length: MAX_NOTES_PER_ROOM }, (_, i) => ({ ...one, id: `N${String(i).padStart(15, "0")}` })));
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Add note"]')?.disabled).toBe(true);
    expect(document.body.textContent).toContain(`The board is full (${MAX_NOTES_PER_ROOM} notes)`);
  });

  it("disconnected: the board is read-only and Add note is disabled", async () => {
    const socket = await withNotes(one);
    await server(socket, "close");
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Add note"]')?.disabled).toBe(true);
    expect(notes()[0]?.getAttribute("aria-disabled")).toBe("true");
    await key(notes()[0], "Enter");
    expect(dialog()).toBeNull();
  });
});

describe("board layout: palette and Properties panels from md up, ribbon on phones", () => {
  const N1 = "NNNNNNNNNNNNNNN1";
  const one: Note = { id: N1, x: 40, y: 60, ...NOTE_DEFAULTS, text: "Idea one", color: "yellow", z: 0, rev: 1, authorId: sam.id };
  const viewBar = () => document.querySelector<HTMLElement>('[role="toolbar"][aria-label="View"]');
  const ribbon = () => document.querySelector<HTMLElement>('[role="toolbar"][aria-label="Board tools"]');
  const toolIds = (bar: HTMLElement | null) => [...(bar?.querySelectorAll<HTMLElement>("[data-tool]") ?? [])].map((b) => b.dataset.tool);
  const note = () => document.querySelector<HTMLElement>('[aria-roledescription="note"]');
  const palette = () => document.querySelector<HTMLElement>('aside[aria-label="Palette"]');
  const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
  // The note tiles (the Frames tile has its own reason; see the frames tests).
  const tiles = () => [...(palette()?.querySelectorAll<HTMLButtonElement>("[data-palette-item]") ?? [])].filter((t) => t.getAttribute("aria-label")?.endsWith(" note"));
  const propTitle = () => properties()?.querySelector<HTMLInputElement>('input[name="title"]') ?? null;
  async function withNotes(...list: Note[]) {
    const socket = await inRoom();
    await server(socket, { data: { type: "snapshot", notes: list } });
    return socket;
  }
  async function pointer(el: HTMLElement | null, pointerType: string) {
    await act(async () => {
      el?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType, button: 0 }));
    });
  }
  async function dblclick(el: HTMLElement | null) {
    await act(async () => {
      el?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await settle();
  }
  async function press(k: string, target: EventTarget = document.body) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    });
    await settle();
  }

  it("phone: no panels and no colour picker; one ribbon built from the registry", async () => {
    const { toolsFor } = await import("../src/canvas/tools");
    await withNotes(one);
    expect(palette()).toBeNull();
    expect(properties()).toBeNull();
    expect(viewBar()).toBeNull();
    expect(toolIds(ribbon())).toEqual(toolsFor("ribbon").map((t) => t.id));
    expect(document.querySelector('[aria-label^="Note colour"]')).toBeNull();
    expect(document.querySelector(".react-flow__minimap")).toBeNull();
  });

  it("md up: the top bar (and its menu) stacks above the side panels, below sheets", async () => {
    setWide(true);
    await inRoom();
    const z = (el: Element | null) => Number(/\bz-(\d+)\b/.exec(el?.className ?? "")?.[1] ?? 0);
    const header = document.querySelector("header");
    const panel = document.querySelector('aside[aria-label="Properties"]');
    expect(z(header)).toBeGreaterThan(z(panel));
    expect(z(header)).toBeLessThan(50);
  });

  it("md up: palette on the left, Properties on the right, view bar from the registry; no rail, ribbon or colour picker", async () => {
    setWide(true);
    const { toolsFor } = await import("../src/canvas/tools");
    await withNotes(one);
    expect(ribbon()).toBeNull();
    expect(document.querySelector('[role="toolbar"][aria-label="Tools"]')).toBeNull();
    expect(document.querySelector('[aria-label^="Note colour"]')).toBeNull();
    expect(palette()).not.toBeNull();
    expect(properties()?.querySelector("h2")?.textContent).toBe("Properties");
    expect(toolIds(viewBar())).toEqual(toolsFor("viewbar").map((t) => t.id));
    // Panels sit either side of the canvas, in that order.
    const row = palette()?.parentElement;
    expect(row?.lastElementChild).toBe(properties());
    expect(row?.querySelector('[aria-label="Board"]')).not.toBeNull();
    expect(document.querySelector(".react-flow__minimap")).not.toBeNull();
    await click(viewBar()?.querySelector<HTMLElement>('[data-tool="minimap"]') ?? undefined);
    expect(document.querySelector(".react-flow__minimap")).toBeNull();
  });

  it("Select and Hand are a two-way toggle in the view bar", async () => {
    setWide(true);
    await withNotes(one);
    const pressed = () => ["select", "hand"].filter((id) => viewBar()?.querySelector(`[data-tool="${id}"]`)?.getAttribute("aria-pressed") === "true");
    expect(pressed()).toEqual(["select"]);
    await click(viewBar()?.querySelector<HTMLElement>('[data-tool="hand"]') ?? undefined);
    expect(pressed()).toEqual(["hand"]);
    await click(viewBar()?.querySelector<HTMLElement>('[data-tool="select"]') ?? undefined);
    expect(pressed()).toEqual(["select"]);
  });

  it.each([
    ["phone", false],
    ["md up", true],
  ])("%s: adding is disabled with a reason when full or disconnected", async (_label, isWide) => {
    setWide(isWide);
    const adders = () =>
      isWide ? tiles() : [document.querySelector<HTMLButtonElement>('[aria-label="Add note"]')].filter((b) => b !== null);
    const socket = await withNotes(...Array.from({ length: MAX_NOTES_PER_ROOM }, (_, i) => ({ ...one, id: `N${String(i).padStart(15, "0")}` })));
    expect(adders().length).toBeGreaterThan(0);
    expect(adders().every((b) => b.disabled)).toBe(true);
    expect(document.body.textContent).toContain(`The board is full (${MAX_NOTES_PER_ROOM} notes)`);
    await server(socket, { data: { type: "noteDeleted", id: `N${"0".repeat(15)}` } });
    expect(adders().every((b) => !b.disabled)).toBe(true);
    await server(socket, "close");
    expect(adders().every((b) => b.disabled)).toBe(true);
    expect(adders()[0]?.title).toContain("Reconnect to add or change notes.");
    expect(document.body.textContent).toContain("Reconnect to add or change notes.");
  });

  it("the tool, selection, panel layout and viewport survive a breakpoint change", async () => {
    await withNotes(one);
    await click(ribbon()?.querySelector<HTMLElement>('[data-tool="hand"]') ?? undefined);
    await act(async () => note()?.focus());
    const flow = document.querySelector(".react-flow");
    await act(async () => setWide(true));
    await settle();
    expect(ribbon()).toBeNull();
    expect(viewBar()?.querySelector('[data-tool="hand"]')?.getAttribute("aria-pressed")).toBe("true");
    // The note focused on the phone is the one selected in Properties.
    expect(propTitle()?.value).toBe("Idea one");
    // The same canvas stays mounted, so the viewport isn't reset.
    expect(document.querySelector(".react-flow")).toBe(flow);
    await click(palette()?.querySelector<HTMLElement>('[aria-label="Collapse palette"]') ?? undefined);
    await act(async () => setWide(false));
    await settle();
    expect(palette()).toBeNull();
    expect(ribbon()?.querySelector('[data-tool="hand"]')?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => setWide(true));
    await settle();
    expect(palette()?.querySelector('[aria-label="Expand palette"]')).not.toBeNull();
    expect(propTitle()?.value).toBe("Idea one");
  });

  it("a tap on a note edits it; a mouse needs a double-click", async () => {
    await withNotes(one);
    await pointer(note(), "mouse");
    await click(note() ?? undefined);
    expect(dialog()).toBeNull();
    await dblclick(note());
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Edit note");
    await click(byText("button", "Done"));
    await pointer(note(), "touch");
    await click(note() ?? undefined);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Edit note");
  });

  it("the Hand tool stops taps from editing (every drag pans)", async () => {
    await withNotes(one);
    await click(ribbon()?.querySelector<HTMLElement>('[data-tool="hand"]') ?? undefined);
    await pointer(note(), "touch");
    await click(note() ?? undefined);
    expect(dialog()).toBeNull();
  });

  it.each([
    ["phone", false],
    ["md up", true],
  ])("regression, %s: under Hand, double-click and Enter on a note still open its editor", async (_label, isWide) => {
    setWide(isWide);
    await withNotes(one);
    const bar = () => (isWide ? viewBar() : ribbon());
    await click(bar()?.querySelector<HTMLElement>('[data-tool="hand"]') ?? undefined);
    expect(bar()?.querySelector('[data-tool="hand"]')?.getAttribute("aria-pressed")).toBe("true");
    // React Flow must still hand the note pointer events (see canvasNodes.test.ts).
    expect(note()?.closest<HTMLElement>(".react-flow__node")?.style.pointerEvents).toBe("all");
    // md up: edited in place (slice 2.9); phones: the editor sheet.
    const inline = () => document.querySelector<HTMLTextAreaElement>('textarea[data-inline="title"]');
    const editorOpen = () => (isWide ? inline() !== null && document.activeElement === inline() : dialog()?.querySelector("h2")?.textContent === "Edit note");
    await pointer(note(), "mouse");
    await dblclick(note());
    expect(editorOpen()).toBe(true);
    if (!isWide) await click(byText("button", "Done"));
    else await press("Escape", inline() ?? document.body);
    await press("Enter", note() ?? document.body);
    expect(editorOpen()).toBe(true);
  });

  it("under Select, double-click and Enter edit the note in place too", async () => {
    setWide(true);
    await withNotes(one);
    const inline = () => document.querySelector<HTMLTextAreaElement>('textarea[data-inline="title"]');
    await pointer(note(), "mouse");
    await dblclick(note());
    expect(document.activeElement).toBe(inline());
    await press("Escape", inline() ?? document.body);
    expect(inline()).toBeNull();
    await press("Enter", note() ?? document.body);
    expect(document.activeElement).toBe(inline());
  });

  it("the ribbon hides while the note editor is open, so it never sits over the keyboard", async () => {
    await withNotes(one);
    await press("Enter", note() ?? document.body);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Edit note");
    expect(ribbon()).toBeNull();
  });

  it("keyboard shortcuts: H toggles the hand, N adds a note ready to type in place, and the view bar shows the zoom", async () => {
    setWide(true);
    const socket = await withNotes(one);
    await press("h");
    expect(viewBar()?.querySelector('[data-tool="hand"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(viewBar()?.querySelector('[data-tool="zoom-reset"]')?.textContent).toMatch(/^\d+%$/);
    await press("n");
    expect((socket.sent as { type: string; color?: string }[]).find((m) => m.type === "noteAdd")?.color).toBe("yellow");
    expect(document.activeElement).toBe(document.querySelector<HTMLTextAreaElement>('textarea[data-inline="title"]'));
  });
});

describe("the palette (md up)", () => {
  const N1 = "NNNNNNNNNNNNNNN1";
  const one: Note = { id: N1, x: 40, y: 60, ...NOTE_DEFAULTS, text: "Idea one", color: "yellow", z: 0, rev: 1, authorId: sam.id };
  const palette = () => document.querySelector<HTMLElement>('aside[aria-label="Palette"]');
  const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
  const tiles = () => [...(palette()?.querySelectorAll<HTMLButtonElement>("[data-palette-item]") ?? [])];
  const search = () => palette()?.querySelector<HTMLInputElement>('input[type="search"]') ?? null;
  const separator = () => palette()?.querySelector<HTMLElement>('[role="separator"]') ?? null;
  const propTitle = () => properties()?.querySelector<HTMLInputElement>('input[name="title"]') ?? null;
  const sentOfType = (socket: FakeWebSocket, t: string) => (socket.sent as Record<string, unknown>[]).filter((m) => m.type === t);
  async function withNotes(...list: Note[]) {
    setWide(true);
    const socket = await inRoom();
    await server(socket, { data: { type: "snapshot", notes: list } });
    return socket;
  }
  async function press(k: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
    });
    await settle();
  }
  const saved = (key: string) => JSON.parse(localStorage.getItem(key) ?? "null") as unknown;

  it("shows the Notes category: one tile per colour, named for screen readers, with a token-coloured preview", async () => {
    await withNotes();
    expect(palette()?.querySelector("h3")?.textContent).toBe("Notes");
    expect(tiles().map((t) => t.getAttribute("aria-label"))).toEqual([
      "Yellow note",
      "Pink note",
      "Blue note",
      "Green note",
      "Orange note",
      "Purple note",
      // Slice frames: the Frames category follows Notes.
      "Frame",
      // Slice templates: then Templates.
      "Retro", "Start Stop Continue", "2x2 Impact and Effort", "Sprint planning",
    ]);
    expect(tiles()[1]?.querySelector('[data-preview]')?.className).toContain("bg-note-pink");
    expect(tiles()[1]?.textContent).toContain("Pink");
    // No Stencils tab until a stencil exists.
    expect(palette()?.querySelector('[role="tablist"]')).toBeNull();
    expect(palette()?.textContent).not.toMatch(/stencil/i);
  });

  it("clicking a tile adds a note of that colour at the viewport centre, selects it, and edits it in place", async () => {
    const socket = await withNotes();
    const inline = () => document.querySelector<HTMLTextAreaElement>('textarea[data-inline="title"]');
    await click(tiles().find((t) => t.getAttribute("aria-label") === "Green note"));
    const [add] = sentOfType(socket, "noteAdd");
    expect(add).toMatchObject({ color: "green", text: "" });
    expect(document.activeElement).toBe(inline());
    // Confirmed while typing: the selection and the edit follow the note to its server id.
    await server(socket, { data: { type: "noteAdded", clientRef: add?.clientRef, note: { ...one, color: "green", text: "", authorId: alex.id } } });
    expect(propTitle()).not.toBeNull();
    expect(inline()).not.toBeNull();
    await act(async () => {
      const el = inline();
      if (!el) return;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, "Fresh idea");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(propTitle()?.value).toBe("Fresh idea");
    await press("Escape", inline() ?? document.body);
    expect(sentOfType(socket, "noteEdit")).toEqual([{ type: "noteEdit", id: N1, text: "Fresh idea" }]);
    // No modal editor from md up: the Properties panel is the editor.
    expect(dialog()).toBeNull();
  });

  it("search filters tiles by label and keywords, and says when nothing matches", async () => {
    await withNotes();
    await type(search() as HTMLInputElement, "pink");
    expect(tiles().map((t) => t.getAttribute("aria-label"))).toEqual(["Pink note"]);
    await type(search() as HTMLInputElement, "zebra");
    expect(tiles()).toEqual([]);
    expect(palette()?.querySelector("h3")).toBeNull();
    expect(palette()?.textContent).toContain("No matches");
    await type(search() as HTMLInputElement, "");
    expect(tiles()).toHaveLength(11);
  });

  it("collapses to a strip with an expand button and compact tiles (as in Chalkline), from the header or with [, and remembers it", async () => {
    const socket = await withNotes();
    await click(palette()?.querySelector<HTMLElement>('[aria-label="Collapse palette"]') ?? undefined);
    expect(search()).toBeNull();
    expect(palette()?.querySelector("h3")).toBeNull();
    // Collapsing never takes adding away: the strip keeps one compact tile per colour.
    expect(tiles().map((t) => t.getAttribute("aria-label"))).toEqual(["Yellow note", "Pink note", "Blue note", "Green note", "Orange note", "Purple note", "Frame", "Retro", "Start Stop Continue", "2x2 Impact and Effort", "Sprint planning"]);
    await click(tiles()[2]);
    expect(sentOfType(socket, "noteAdd")[0]).toMatchObject({ color: "blue" });
    expect(palette()?.querySelector('[aria-label="Expand palette"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(saved("stickyard:palette-panel")).toEqual({ width: null, collapsed: true });
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    await press("[");
    expect(search()).not.toBeNull();
    expect(tiles()).toHaveLength(11);
    expect(saved("stickyard:palette-panel")).toEqual({ width: null, collapsed: false });
  });

  it("the resize handle is an accessible separator: arrow keys, Shift, Home, End and double-click to reset", async () => {
    const { PANEL_LIMITS, KEY_STEP, KEY_STEP_BIG } = await import("../src/panels/layout");
    const { min, initial } = PANEL_LIMITS.palette;
    await withNotes();
    const sep = separator();
    expect(sep?.getAttribute("aria-orientation")).toBe("vertical");
    expect(sep?.tabIndex).toBe(0);
    expect(Number(sep?.getAttribute("aria-valuenow"))).toBe(initial);
    expect(Number(sep?.getAttribute("aria-valuemin"))).toBe(min);
    const max = Number(sep?.getAttribute("aria-valuemax"));
    expect(max).toBeGreaterThan(initial);
    await press("ArrowRight", separator() ?? document.body);
    expect(Number(separator()?.getAttribute("aria-valuenow"))).toBe(initial + KEY_STEP);
    await press("ArrowLeft", separator() ?? document.body, { shiftKey: true });
    expect(Number(separator()?.getAttribute("aria-valuenow"))).toBe(initial + KEY_STEP - KEY_STEP_BIG);
    await press("Home", separator() ?? document.body);
    expect(Number(separator()?.getAttribute("aria-valuenow"))).toBe(min);
    await press("End", separator() ?? document.body);
    expect(Number(separator()?.getAttribute("aria-valuenow"))).toBe(max);
    expect(saved("stickyard:palette-panel")).toEqual({ width: max, collapsed: false });
    await act(async () => {
      separator()?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await settle();
    expect(Number(separator()?.getAttribute("aria-valuenow"))).toBe(initial);
    expect(saved("stickyard:palette-panel")).toEqual({ width: null, collapsed: false });
  });

  it("restores the saved layout, and ignores a malformed one", async () => {
    const { PANEL_LIMITS } = await import("../src/panels/layout");
    localStorage.setItem("stickyard:palette-panel", JSON.stringify({ width: PANEL_LIMITS.palette.min + 8, collapsed: false }));
    localStorage.setItem("stickyard:properties-panel", "{not json");
    await withNotes();
    expect(Number(separator()?.getAttribute("aria-valuenow"))).toBe(PANEL_LIMITS.palette.min + 8);
    const propSep = properties()?.querySelector('[role="separator"]');
    expect(Number(propSep?.getAttribute("aria-valuenow"))).toBe(PANEL_LIMITS.properties.initial);
  });
});

describe("the Properties panel (md up)", () => {
  const N1 = "NNNNNNNNNNNNNNN1";
  const N2 = "NNNNNNNNNNNNNNN2";
  const one: Note = { id: N1, x: 40, y: 60, ...NOTE_DEFAULTS, text: "Idea one\nThe details", color: "pink", z: 0, rev: 1, authorId: sam.id };
  const two: Note = { id: N2, x: 400, y: 300, ...NOTE_DEFAULTS, text: "", color: "blue", z: 0, rev: 1, authorId: "ZZZZZZZZZZZZZZZZ" };
  const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
  const notes = () => [...document.querySelectorAll<HTMLElement>('[aria-roledescription="note"]')];
  const propTitle = () => properties()?.querySelector<HTMLInputElement>('input[name="title"]') ?? null;
  const propBody = () => properties()?.querySelector<HTMLTextAreaElement>('textarea[name="body"]') ?? null;
  const sentOfType = (socket: FakeWebSocket, t: string) => (socket.sent as Record<string, unknown>[]).filter((m) => m.type === t);
  async function withNotes(...list: Note[]) {
    setWide(true);
    const socket = await inRoom();
    await server(socket, { data: { type: "snapshot", notes: list } });
    return socket;
  }
  async function press(k: string, target: EventTarget, init: KeyboardEventInit = {}) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
    });
    await settle();
  }
  async function typeBody(value: string) {
    const el = propBody();
    if (!el) throw new Error("no body");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function selectNote(i: number) {
    await act(async () => {
      notes()[i]?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
    });
    await click(notes()[i]);
  }

  it("nothing selected: a board summary", async () => {
    await withNotes(one, two);
    const text = properties()?.textContent ?? "";
    expect(text).toContain(`2 of ${MAX_NOTES_PER_ROOM}`);
    expect(text).toContain("3200 × 2000");
    expect(propTitle()).toBeNull();
  });

  it("clicking a note selects it (styled from tokens) and shows Title, Body, colour, author and Delete", async () => {
    await withNotes(one, two);
    await selectNote(0);
    expect(notes()[0]?.getAttribute("aria-current")).toBe("true");
    expect(notes()[0]?.className).toContain("sy-selected");
    expect(propTitle()?.value).toBe("Idea one");
    expect(propBody()?.value).toBe("The details");
    const swatches = [...(properties()?.querySelectorAll<HTMLButtonElement>('[aria-label="Note colour"] button') ?? [])];
    expect(swatches).toHaveLength(6);
    expect(swatches.every((b) => !b.disabled)).toBe(true);
    expect(swatches.find((b) => b.getAttribute("aria-pressed") === "true")?.getAttribute("aria-label")).toBe("Pink");
    expect(properties()?.textContent).not.toContain("arrives in a later update");
    expect(properties()?.textContent).toContain("Sam");
    expect(byText("aside button", /Delete note/)).toBeDefined();
    // Someone this page never saw.
    await selectNote(1);
    expect(properties()?.textContent).toContain("Added by someone not in the session now");
  });

  it("keyboard focus selects too, and Escape clears the selection", async () => {
    await withNotes(one, two);
    await act(async () => notes()[1]?.focus());
    expect(notes()[1]?.getAttribute("aria-current")).toBe("true");
    expect(propTitle()?.value).toBe("");
    await press("Escape", notes()[1] as HTMLElement);
    expect(notes()[1]?.getAttribute("aria-current")).toBeNull();
    expect(propTitle()).toBeNull();
  });

  it("clicking empty board space clears the selection", async () => {
    await withNotes(one, two);
    await selectNote(0);
    await click(document.querySelector<HTMLElement>(".react-flow__pane") ?? undefined);
    expect(propTitle()).toBeNull();
    expect(notes()[0]?.getAttribute("aria-current")).toBeNull();
  });

  it("edits save on Enter or when focus leaves the fields; Shift+Enter in Body is a new line", async () => {
    const socket = await withNotes(one);
    await selectNote(0);
    await type(propTitle() as HTMLInputElement, "Better idea");
    await press("Enter", propTitle() as HTMLElement);
    expect(sentOfType(socket, "noteEdit")).toEqual([{ type: "noteEdit", id: N1, text: "Better idea\nThe details" }]);
    await typeBody("The details\nand more");
    await press("Enter", propBody() as HTMLElement, { shiftKey: true });
    expect(sentOfType(socket, "noteEdit")).toHaveLength(1);
    // Moving from Body to Title doesn't save; leaving the fields does.
    await act(async () => {
      propBody()?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: propTitle() }));
    });
    expect(sentOfType(socket, "noteEdit")).toHaveLength(1);
    await act(async () => {
      propBody()?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    });
    await settle();
    expect(sentOfType(socket, "noteEdit").at(-1)).toEqual({ type: "noteEdit", id: N1, text: "Better idea\nThe details\nand more" });
  });

  it("counts characters against the cap and refuses to save past it", async () => {
    const socket = await withNotes(one);
    await selectNote(0);
    expect(properties()?.textContent).toContain(`20 / ${MAX_NOTE_TEXT}`);
    await typeBody("x".repeat(MAX_NOTE_TEXT));
    expect(properties()?.textContent).toContain(`Notes can be up to ${MAX_NOTE_TEXT} characters.`);
    await press("Enter", propBody() as HTMLElement);
    expect(sentOfType(socket, "noteEdit")).toEqual([]);
  });

  it("a remote edit while typing doesn't replace the draft; a refused edit rolls back", async () => {
    const socket = await withNotes(one);
    await selectNote(0);
    await type(propTitle() as HTMLInputElement, "Mine");
    await server(socket, { data: { type: "noteUpdated", note: { ...one, text: "Theirs", rev: 2 } } });
    expect(propTitle()?.value).toBe("Mine");
    await press("Enter", propTitle() as HTMLElement);
    expect(sentOfType(socket, "noteEdit").at(-1)).toEqual({ type: "noteEdit", id: N1, text: "Mine\nThe details" });
    await server(socket, { data: { type: "error", code: "rate_limited", message: "x", noteId: N1 } });
    expect(propTitle()?.value).toBe("Theirs");
  });

  it("renders note text as plain text, never HTML", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    await withNotes({ ...one, text: evil });
    await selectNote(0);
    expect(propTitle()?.value).toBe(evil);
    expect(properties()?.querySelector("img")).toBeNull();
  });

  it("Delete asks first when the note has text, then deletes and shows the board summary", async () => {
    const socket = await withNotes(one);
    await selectNote(0);
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    await click(byText("aside button", /Delete note/));
    expect(confirm).toHaveBeenCalled();
    expect(sentOfType(socket, "noteDelete")).toEqual([{ type: "noteDelete", id: N1 }]);
    expect(propTitle()).toBeNull();
    expect(properties()?.textContent).toContain(`0 of ${MAX_NOTES_PER_ROOM}`);
  });

  it("disconnected: everything is read-only, resize handles are hidden, and it says why", async () => {
    const socket = await withNotes(one);
    await selectNote(0);
    expect(document.querySelectorAll(".react-flow__resize-control.handle").length).toBeGreaterThanOrEqual(4);
    await server(socket, "close");
    expect(propTitle()?.disabled).toBe(true);
    expect(propBody()?.disabled).toBe(true);
    expect(byText("aside button", /Delete note/)?.hasAttribute("disabled")).toBe(true);
    const controls = [...(properties()?.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
      '[aria-label="Note colour"] button, [aria-label="Title text colour"] button, [aria-label="Body text colour"] button, [aria-label="Title text style"] button, [aria-label="Body text style"] button, [aria-label="Title alignment"] button, [aria-label="Body alignment"] button, input[name="width"], input[name="height"], select[name="fontSize"], select[name="titleFontSize"]',
    ) ?? [])];
    expect(controls.length).toBeGreaterThan(30);
    expect(controls.every((c) => c.disabled)).toBe(true);
    expect(document.querySelectorAll(".react-flow__resize-control.handle")).toHaveLength(0);
    expect(properties()?.textContent).toContain("Read only while disconnected");
  });

  it("colour swatches are live: optimistic, sent as noteEdit, rolled back when refused", async () => {
    const socket = await withNotes(one);
    await selectNote(0);
    await click(properties()?.querySelector<HTMLElement>('[aria-label="Note colour"] [aria-label="Green"]') ?? undefined);
    expect(sentOfType(socket, "noteEdit")).toEqual([{ type: "noteEdit", id: N1, color: "green" }]);
    expect(notes()[0]?.className).toContain("bg-note-green");
    expect(properties()?.querySelector("h3")?.textContent).toBe("Green note");
    await server(socket, { data: { type: "error", code: "rate_limited", message: "x", noteId: N1 } });
    expect(notes()[0]?.className).toContain("bg-note-pink");
  });

  it("Title and Body sections: each has its own size, Bold/Italic toggles (aria-pressed), alignment and text colour, each sending its field", async () => {
    const socket = await withNotes(one);
    await selectNote(0);
    const pick = async (name: string, value: string) => {
      const select = properties()?.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
      expect(select?.value).toBe("m");
      await act(async () => {
        if (!select) return;
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settle();
    };
    const control = (selector: string) => properties()?.querySelector<HTMLElement>(selector) ?? undefined;
    // Two sections, in this order, each with the same four kinds of field.
    const headings = [...(properties()?.querySelectorAll("section h3") ?? [])].map((h) => h.textContent);
    expect(headings.indexOf("Title text")).toBeGreaterThan(-1);
    expect(headings.indexOf("Body text")).toBeGreaterThan(headings.indexOf("Title text"));

    await pick("titleFontSize", "xl");
    await pick("fontSize", "s");
    expect(control('[aria-label="Title text style"] [aria-label="Bold title"]')?.getAttribute("aria-pressed")).toBe("false");
    await click(control('[aria-label="Title text style"] [aria-label="Bold title"]'));
    expect(control('[aria-label="Title text style"] [aria-label="Bold title"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(control('[aria-label="Body text style"] [aria-label="Bold body"]')?.getAttribute("aria-pressed")).toBe("false");
    await click(control('[aria-label="Body text style"] [aria-label="Italic body"]'));
    await click(control('[aria-label="Title text style"] [aria-label="Italic title"]'));
    await click(control('[aria-label="Title text colour"] [aria-label="Purple"]'));
    await click(control('[aria-label="Body text colour"] [aria-label="Blue"]'));
    await click(control('[aria-label="Title alignment"] [aria-label="Align title centre"]'));
    await click(control('[aria-label="Body alignment"] [aria-label="Align body right"]'));
    expect(control('[aria-label="Title alignment"] [aria-label="Align title centre"]')?.getAttribute("aria-checked")).toBe("true");
    expect(control('[aria-label="Title alignment"] [aria-label="Align title left"]')?.getAttribute("aria-checked")).toBe("false");
    expect(control('[aria-label="Body alignment"] [aria-label="Align body right"]')?.getAttribute("aria-checked")).toBe("true");
    expect(control('[aria-label="Title text colour"] [aria-label="Purple"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(control('[aria-label="Body text colour"] [aria-label="Purple"]')?.getAttribute("aria-pressed")).toBe("false");
    expect(sentOfType(socket, "noteEdit")).toEqual([
      { type: "noteEdit", id: N1, titleFontSize: "xl" },
      { type: "noteEdit", id: N1, fontSize: "s" },
      { type: "noteEdit", id: N1, titleBold: true },
      { type: "noteEdit", id: N1, italic: true },
      { type: "noteEdit", id: N1, titleItalic: true },
      { type: "noteEdit", id: N1, titleTextColor: "purple" },
      { type: "noteEdit", id: N1, textColor: "blue" },
      { type: "noteEdit", id: N1, titleAlign: "center" },
      { type: "noteEdit", id: N1, align: "right" },
    ]);
    // The note shows it, from token classes only, each part with its own style.
    const title = notes()[0]?.querySelector("[data-note-title]");
    const body = notes()[0]?.querySelector("[data-note-body]");
    expect(title?.textContent).toBe("Idea one");
    expect(body?.textContent).toBe("The details");
    for (const cls of ["text-note-xl", "font-bold", "italic", "text-note-text-purple", "text-center"]) expect(title?.className, cls).toContain(cls);
    for (const cls of ["text-note-s", "italic", "text-note-text-blue", "text-right"]) expect(body?.className, cls).toContain(cls);
    expect(body?.className).not.toContain("font-bold");
    expect(body?.className).not.toContain("text-note-xl");
    expect(title?.className).not.toContain("text-note-text-blue");
    // Refused: both parts go back.
    await server(socket, { data: { type: "error", code: "rate_limited", message: "x", noteId: N1 } });
    expect(notes()[0]?.querySelector("[data-note-title]")?.className).toContain("text-note-m");
    expect(notes()[0]?.querySelector("[data-note-body]")?.className).toContain("text-note-m");
  });

  it("a note with only a title has no body block; text stays plain", async () => {
    await withNotes({ ...one, text: "<b>Just a title</b>", titleAlign: "right" });
    expect(notes()[0]?.querySelector("[data-note-title]")?.textContent).toBe("<b>Just a title</b>");
    expect(notes()[0]?.querySelector("[data-note-title]")?.className).toContain("text-right");
    expect(notes()[0]?.querySelector("[data-note-body]")).toBeNull();
    expect(notes()[0]?.querySelector("b")).toBeNull();
  });

  it("Width and Height commit on Enter or blur, clamped, as one final noteResize", async () => {
    const socket = await withNotes(one);
    await selectNote(0);
    const width = properties()?.querySelector<HTMLInputElement>('input[name="width"]') as HTMLInputElement;
    const height = properties()?.querySelector<HTMLInputElement>('input[name="height"]') as HTMLInputElement;
    expect(width.value).toBe(String(NOTE_DEFAULTS.w));
    await type(width, "260");
    await press("Enter", width);
    expect(sentOfType(socket, "noteResize")).toEqual([{ type: "noteResize", id: N1, x: 40, y: 60, w: 260, h: NOTE_DEFAULTS.h, final: true }]);
    await type(height, "9999");
    await act(async () => {
      height.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await settle();
    expect(sentOfType(socket, "noteResize").at(-1)).toMatchObject({ w: 260, h: NOTE_MAX_H, final: true });
    expect(height.value).toBe(String(NOTE_MAX_H));
    // Not a number: put back, nothing sent.
    await type(width, "abc");
    await press("Enter", width);
    expect(sentOfType(socket, "noteResize")).toHaveLength(2);
    expect(width.value).toBe("260");
  });

  it("Alt+Arrow resizes the focused note by a step; plain arrows still move it", async () => {
    const socket = await withNotes(one);
    await act(async () => notes()[0]?.focus());
    await press("ArrowRight", notes()[0] as HTMLElement, { altKey: true });
    await press("ArrowDown", notes()[0] as HTMLElement, { altKey: true, shiftKey: true });
    expect(sentOfType(socket, "noteResize").at(-1)).toMatchObject({ id: N1, x: 40, y: 60, final: false });
    await act(async () => new Promise((r) => setTimeout(r, 500)));
    expect(sentOfType(socket, "noteResize").at(-1)).toEqual({ type: "noteResize", id: N1, x: 40, y: 60, w: NOTE_DEFAULTS.w + 10, h: NOTE_DEFAULTS.h + 50, final: true });
    await press("ArrowRight", notes()[0] as HTMLElement);
    expect(sentOfType(socket, "noteMove").at(-1)).toMatchObject({ id: N1, x: 50, y: 60 });
  });

  it("collapses with ] and from its header, and remembers it", async () => {
    await withNotes(one);
    await press("]", document.body);
    expect(properties()?.querySelector("h2")).toBeNull();
    expect(properties()?.querySelector('[aria-label="Expand Properties"]')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem("stickyard:properties-panel") ?? "null")).toEqual({ width: null, collapsed: true });
    await click(properties()?.querySelector<HTMLElement>('[aria-label="Expand Properties"]') ?? undefined);
    expect(properties()?.querySelector("h2")?.textContent).toBe("Properties");
    await click(properties()?.querySelector<HTMLElement>('[aria-label="Collapse Properties"]') ?? undefined);
    expect(properties()?.querySelector("h2")).toBeNull();
  });

  it("a finger tap on a note (md up) opens it in Properties, expanding a collapsed panel", async () => {
    await withNotes(one);
    await press("]", document.body);
    await act(async () => {
      notes()[0]?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", button: 0 }));
    });
    await click(notes()[0]);
    expect(document.activeElement).toBe(propTitle());
    expect(document.querySelector('textarea[data-inline="title"]')).toBeNull();
  });
});

describe("phone: add sheet and editor sheet", () => {
  const N1 = "NNNNNNNNNNNNNNN1";
  const one: Note = { id: N1, x: 40, y: 60, ...NOTE_DEFAULTS, text: "Idea one\nThe details", color: "orange", z: 0, rev: 1, authorId: sam.id };
  const sentOfType = (socket: FakeWebSocket, t: string) => (socket.sent as Record<string, unknown>[]).filter((m) => m.type === t);
  async function withNotes(...list: Note[]) {
    const socket = await inRoom();
    await server(socket, { data: { type: "snapshot", notes: list } });
    return socket;
  }

  it("Add note opens a non-modal drawer built from the same palette registry (as in Chalkline)", async () => {
    const { paletteSections, PALETTE_CATEGORIES } = await import("../src/palette/registry");
    await withNotes();
    const addButton = document.querySelector<HTMLElement>('[aria-label="Add note"]');
    await click(addButton ?? undefined);
    const drawer = dialog();
    expect(drawer?.querySelector("h2")?.textContent).toBe("Add note");
    expect(drawer?.getAttribute("aria-modal")).toBeNull();
    expect(drawer?.querySelector('input[type="search"]')).not.toBeNull();
    const labels = [...(drawer?.querySelectorAll<HTMLElement>("[data-palette-item]") ?? [])].map((t) => t.getAttribute("aria-label"));
    const expected = paletteSections(PALETTE_CATEGORIES, "add", { live: true, noteCount: 0, isHost: false }, "", "drawer").flatMap((s) => s.items.map((i) => i.label));
    expect(labels).toEqual(expected);
    // One sideways-scrolling row per category.
    expect(drawer?.querySelector("[data-palette-item]")?.parentElement?.className).toContain("overflow-x-auto");
    expect(document.querySelector('aside[aria-label="Palette"]')).toBeNull();
    // Search filters; Esc closes and focus goes back to Add note.
    await type(drawer?.querySelector<HTMLInputElement>('input[type="search"]') as HTMLInputElement, "green");
    expect([...(drawer?.querySelectorAll("[data-palette-item]") ?? [])].map((t) => t.getAttribute("aria-label"))).toEqual(["Green note"]);
    await act(async () => {
      drawer?.querySelector("h2")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(addButton);
  });

  it("the drawer's Close button closes it, and a tapped tile adds and opens the editor", async () => {
    const socket = await withNotes();
    await click(document.querySelector<HTMLElement>('[aria-label="Add note"]') ?? undefined);
    await click(dialog()?.querySelector<HTMLElement>('[aria-label="Close"]') ?? undefined);
    expect(dialog()).toBeNull();
    await click(document.querySelector<HTMLElement>('[aria-label="Add note"]') ?? undefined);
    await click(dialog()?.querySelector<HTMLElement>('[aria-label="Purple note"]') ?? undefined);
    expect(sentOfType(socket, "noteAdd")[0]).toMatchObject({ color: "purple" });
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Edit note");
  });

  it("tapping a note opens the editor sheet with Title, Body, colour, text style, size, author and Delete", async () => {
    const socket = await withNotes(one);
    const note = document.querySelector<HTMLElement>('[aria-roledescription="note"]');
    await act(async () => {
      note?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", button: 0 }));
    });
    await click(note ?? undefined);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Edit note");
    expect(dialog()?.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe("Idea one");
    expect(dialog()?.querySelector<HTMLTextAreaElement>('textarea[name="body"]')?.value).toBe("The details");
    const swatches = [...(dialog()?.querySelectorAll<HTMLButtonElement>('[aria-label="Note colour"] button') ?? [])];
    expect(swatches).toHaveLength(6);
    expect(swatches.every((b) => !b.disabled)).toBe(true);
    await click(dialog()?.querySelector<HTMLElement>('[aria-label="Note colour"] [aria-label="Blue"]') ?? undefined);
    expect(sentOfType(socket, "noteEdit").at(-1)).toEqual({ type: "noteEdit", id: N1, color: "blue" });
    await click(dialog()?.querySelector<HTMLElement>('[aria-label="Body text style"] [aria-label="Bold body"]') ?? undefined);
    expect(sentOfType(socket, "noteEdit").at(-1)).toEqual({ type: "noteEdit", id: N1, bold: true });
    await click(dialog()?.querySelector<HTMLElement>('[aria-label="Title text style"] [aria-label="Bold title"]') ?? undefined);
    expect(sentOfType(socket, "noteEdit").at(-1)).toEqual({ type: "noteEdit", id: N1, titleBold: true });
    expect(dialog()?.querySelector('input[name="width"]')).not.toBeNull();
    expect(dialog()?.querySelector('input[name="height"]')).not.toBeNull();
    expect(dialog()?.querySelector('select[name="titleFontSize"]')).not.toBeNull();
    expect(dialog()?.querySelector('select[name="fontSize"]')).not.toBeNull();
    expect(dialog()?.querySelector('[aria-label="Title text colour"]')).not.toBeNull();
    expect(dialog()?.querySelector('[aria-label="Body text colour"]')).not.toBeNull();
    expect(dialog()?.querySelector('[aria-label="Title alignment"]')).not.toBeNull();
    expect(dialog()?.querySelector('[aria-label="Body alignment"]')).not.toBeNull();
    expect(dialog()?.textContent).toContain("Sam");
    vi.stubGlobal("confirm", () => true);
    await click(byText('[role="dialog"] button', /Delete note/));
    expect(sentOfType(socket, "noteDelete")).toEqual([{ type: "noteDelete", id: N1 }]);
  });
});

describe("room error screens", () => {
  it("a malformed code shows This link isn’t valid, with a way home", async () => {
    await mount("#/room/not-a-code");
    expect(document.querySelector("main h1")?.textContent).toBe("This link isn’t valid");
    expect(byText("a", "Go to the start page")?.getAttribute("href")).toBe("#/");
    expect(dialog()).toBeNull();
  });

  it("a well-formed but unknown code shows This link isn’t valid", async () => {
    routes = (url, init) => (url.includes("/rooms/check") ? jsonResponse(404, { error: "not_found" }) : healthy(url, init));
    await mount(`#/room/${CODE}`);
    await type(input("Your name"), "Alex");
    await submit(button("Join"));
    await server(lastSocket(), "close");
    await settle();
    expect(document.querySelector("main h1")?.textContent).toBe("This link isn’t valid");
  });

  it("a full room says so", async () => {
    await mount(`#/room/${CODE}`);
    const socket = await joinAs("Alex");
    await server(socket, { data: { type: "error", code: "room_full", message: "x" } });
    expect(document.querySelector("main h1")?.textContent).toBe("This session is full");
  });

  it("a protocol mismatch asks to reload", async () => {
    await mount(`#/room/${CODE}`);
    await type(input("Your name"), "Alex");
    await submit(button("Join"));
    const socket = lastSocket();
    await server(socket, "open");
    await server(socket, { data: { type: "error", code: "version_mismatch", message: "x" } });
    expect(document.querySelector("main h1")?.textContent).toBe("Please reload");
  });
});

describe("a session the host ended (4411)", () => {
  const ENDED = "This session was ended by the host.";

  it.each([
    ["phone", false],
    ["wide", true],
  ])("%s: on sessionEnded, a page says so politely with a button to the start page; no board, no Rejoin; the token goes", async (_label, isWide) => {
    setWide(isWide);
    localStorage.setItem(`stickyard:host:${CODE.split(".")[0]}`, HOST_TOKEN);
    const socket = await inRoom();
    expect(socket.sent).toContainEqual({ type: "claimHost", token: HOST_TOKEN });
    await server(socket, { data: { type: "hostGranted" } });
    await server(socket, { data: { type: "snapshot", notes: [] } });
    await server(socket, { data: { type: "framesSnapshot", frames: [] } });
    const opened = FakeWebSocket.instances.length;
    await server(socket, { data: { type: "sessionEnded" } });
    await server(socket, { close: 4411 });
    await settle();
    const page = document.querySelector<HTMLElement>("[data-session-ended]");
    expect(page).not.toBeNull();
    expect(document.querySelector("main h1")?.textContent).toBe("Session ended");
    const status = page?.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toBe(ENDED);
    expect(button("Go to the start page")?.className).toContain("h-touch");
    expect(document.querySelector(".react-flow")).toBeNull();
    expect(button("Rejoin")).toBeUndefined();
    expect(localStorage.getItem(`stickyard:host:${CODE.split(".")[0]}`)).toBeNull();
    await act(() => new Promise((r) => setTimeout(r, 1500)));
    expect(FakeWebSocket.instances.length).toBe(opened);
  });

  it("no claimHost without a stored token, and the token is never in the page", async () => {
    const socket = await inRoom();
    expect(socket.sent.some((m) => (m as { type?: string }).type === "claimHost")).toBe(false);
    localStorage.setItem(`stickyard:host:${CODE.split(".")[0]}`, HOST_TOKEN);
    await server(socket, { data: { type: "snapshot", notes: [] } });
    expect(document.body.innerHTML).not.toContain(HOST_TOKEN);
  });
});

describe("an expired session (4410)", () => {
  const expiredPage = () => document.querySelector<HTMLElement>("[data-session-expired]");
  const EXPIRED = "This session has expired because nobody used it for 7 days. Start a new session from the start page.";

  it.each([
    ["phone", false],
    ["wide", true],
  ])("%s: on joining, a page says so politely, with a button to the start page, and no board", async (_label, isWide) => {
    setWide(isWide);
    await mount(`#/room/${CODE}`);
    await type(input("Your name"), "Alex");
    await submit(button("Join"));
    const socket = lastSocket();
    const opened = FakeWebSocket.instances.length;
    await server(socket, "open");
    await server(socket, { close: 4410 });
    await settle();
    const page = expiredPage();
    expect(page).not.toBeNull();
    expect(document.querySelector("main h1")?.textContent).toBe("Session expired");
    const status = page?.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toBe(EXPIRED);
    const home = button("Go to the start page");
    expect(home?.className).toContain("h-touch");
    expect(document.querySelector('[aria-roledescription="note"]')).toBeNull();
    expect(document.querySelector(".react-flow")).toBeNull();
    expect(button("Rejoin")).toBeUndefined();
    // No health probe, no room check, no new socket.
    const calls = fetchCalls.length;
    await act(() => new Promise((r) => setTimeout(r, 1500)));
    expect(FakeWebSocket.instances.length).toBe(opened);
    expect(fetchCalls.slice(calls).filter(([url]) => url.includes("/health") || url.includes("/rooms/check"))).toEqual([]);
    await click(home);
    expect(window.location.hash).toBe("#/");
  });

  it("on a reconnect, the board goes and the same page shows", async () => {
    setWide(true);
    const socket = await inRoom();
    await server(socket, { data: { type: "snapshot", notes: [] } });
    await server(socket, { data: { type: "framesSnapshot", frames: [] } });
    await server(socket, "close");
    await act(async () => window.dispatchEvent(new Event("offline")));
    await settle();
    await click(button("Rejoin"));
    const next = lastSocket();
    await server(next, "open");
    await server(next, { close: 4410 });
    await settle();
    expect(expiredPage()?.textContent).toContain(EXPIRED);
    expect(document.querySelector("[data-connection-status]")).toBeNull();
    expect(button("Rejoin")).toBeUndefined();
  });
});

describe("multi-select and arrange (slice 2.8, md up)", () => {
  const N1 = "NNNNNNNNNNNNNNN1";
  const N2 = "NNNNNNNNNNNNNNN2";
  const N3 = "NNNNNNNNNNNNNNN3";
  const one: Note = { id: N1, x: 40, y: 60, ...NOTE_DEFAULTS, text: "Idea one", color: "pink", z: 0, rev: 1, authorId: sam.id };
  const two: Note = { id: N2, x: 400, y: 300, ...NOTE_DEFAULTS, text: "", color: "blue", z: 0, rev: 1, authorId: sam.id };
  const three: Note = { id: N3, x: 800, y: 100, ...NOTE_DEFAULTS, text: "", color: "blue", bold: true, z: 0, rev: 1, authorId: sam.id };
  const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
  const notes = () => [...document.querySelectorAll<HTMLElement>('[aria-roledescription="note"]')];
  const selected = () => notes().filter((n) => n.getAttribute("aria-current") === "true").map((n) => n.dataset.noteId);
  const bar = () => document.querySelector<HTMLElement>('[role="toolbar"][aria-label="Board actions"]');
  const batches = (socket: FakeWebSocket) => (socket.sent as Record<string, unknown>[]).filter((m) => m.type === "noteBatch");
  async function withNotes(...list: Note[]) {
    setWide(true);
    const socket = await inRoom();
    await server(socket, { data: { type: "snapshot", notes: list } });
    // The board is loaded on demand: wait for it.
    for (let i = 0; i < 100 && notes().length < list.length; i++) await settle();
    return socket;
  }
  async function pointer(target: EventTarget, type: string, init: PointerEventInit) {
    await act(async () => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, ...init }));
    });
  }
  async function noteClick(i: number, init: MouseEventInit = {}) {
    const el = notes()[i];
    if (!el) throw new Error("no note");
    await pointer(el, "pointerdown", { shiftKey: init.shiftKey ?? false, ctrlKey: init.ctrlKey ?? false });
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    });
    await settle();
  }
  async function key(k: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
    });
    await settle();
  }

  it("Shift- or Ctrl-click toggles notes; a plain click selects just one", async () => {
    await withNotes(one, two, three);
    await noteClick(0);
    await noteClick(1, { shiftKey: true });
    expect(selected()).toEqual([N1, N2]);
    await noteClick(2, { ctrlKey: true });
    expect(selected()).toEqual([N1, N2, N3]);
    await noteClick(1, { shiftKey: true });
    expect(selected()).toEqual([N1, N3]);
    await noteClick(1);
    expect(selected()).toEqual([N2]);
  });

  it("Ctrl+A selects every note, Escape clears; neither fires while typing in a field", async () => {
    await withNotes(one, two, three);
    await key("a", document.body, { ctrlKey: true });
    expect(selected()).toEqual([N1, N2, N3]);
    await key("Escape");
    expect(selected()).toEqual([]);
    await noteClick(0);
    const title = properties()?.querySelector<HTMLInputElement>('input[name="title"]');
    await key("a", title ?? document.body, { ctrlKey: true });
    expect(selected()).toEqual([N1]);
  });

  it("a mouse drag on empty canvas draws a marquee and selects what it touches; Shift adds; a click clears", async () => {
    await withNotes(one, two, three);
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) throw new Error("no pane");
    // Board units to client pixels, through the canvas's current transform.
    const [tx, ty, zoom] = (document.querySelector(".react-flow__viewport")?.getAttribute("style") ?? "").match(/-?[\d.]+/g)?.map(Number) ?? [0, 0, 1];
    const at = (x: number, y: number) => ({ clientX: (tx ?? 0) + x * (zoom ?? 1), clientY: (ty ?? 0) + y * (zoom ?? 1) });
    // From the board's top-left to just past the second note: the first two, not the third.
    await pointer(pane, "pointerdown", at(0, 0));
    await pointer(window, "pointermove", at(600, 500));
    expect(document.querySelector("[data-marquee]")).not.toBeNull();
    await pointer(window, "pointerup", at(600, 500));
    await settle();
    expect(document.querySelector("[data-marquee]")).toBeNull();
    expect(selected()).toEqual([N1, N2]);
    // Shift adds to the selection.
    await pointer(pane, "pointerdown", { ...at(790, 90), shiftKey: true });
    await pointer(window, "pointermove", { ...at(850, 150), shiftKey: true });
    await pointer(window, "pointerup", { ...at(850, 150), shiftKey: true });
    await settle();
    expect(selected()).toEqual([N1, N2, N3]);
    // A click (no movement) on empty canvas clears it.
    await pointer(pane, "pointerdown", at(2000, 1500));
    await pointer(window, "pointerup", at(2000, 1500));
    await act(async () => pane.click());
    await settle();
    expect(selected()).toEqual([]);
  });

  it("touch on empty canvas never draws a marquee (it pans)", async () => {
    await withNotes(one, two);
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) throw new Error("no pane");
    await pointer(pane, "pointerdown", { clientX: 0, clientY: 0, pointerType: "touch" });
    await pointer(window, "pointermove", { clientX: 600, clientY: 600, pointerType: "touch" });
    expect(document.querySelector("[data-marquee]")).toBeNull();
    await pointer(window, "pointerup", { clientX: 600, clientY: 600, pointerType: "touch" });
    expect(selected()).toEqual([]);
  });

  it("the canvas has no browser context menu (right-drag pans)", async () => {
    await withNotes(one);
    const board = document.querySelector<HTMLElement>('section[aria-label="Board"]');
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      board?.querySelector(".react-flow__pane")?.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it("Properties shows N selected, Mixed for differing values, style fields disabled, and Delete (asks first)", async () => {
    const socket = await withNotes(one, two, three);
    await key("a", document.body, { ctrlKey: true });
    expect(properties()?.textContent).toContain("3 selected");
    const colour = properties()?.querySelector('[aria-label="Note colour"]');
    expect(colour?.textContent).toContain("Mixed");
    expect(colour?.querySelector('[aria-pressed="true"]')).toBeNull();
    expect(properties()?.querySelector('[aria-label="Body text style"] [aria-label="Bold body"]')?.getAttribute("aria-pressed")).toBe("mixed");
    const all = [...(properties()?.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>("section button, section select, section input") ?? [])];
    // Style and size are read-only for several; Order (slice z-order) works for all of them.
    const inOrder = (c: Element) => c.closest("section")?.querySelector("h3")?.textContent === "Order";
    const controls = all.filter((c) => !inOrder(c));
    expect(controls.length).toBeGreaterThan(20);
    expect(controls.every((c) => c.disabled)).toBe(true);
    expect(all.filter(inOrder).map((c) => c.disabled)).toEqual([false, false]);
    expect(properties()?.querySelector('input[name="title"]')).toBeNull();
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    await click(properties()?.querySelector<HTMLElement>('[aria-label="Delete 3 notes"]') ?? undefined);
    expect(confirm).toHaveBeenCalled();
    expect(batches(socket)).toEqual([
      {
        type: "noteBatch",
        final: true,
        ops: [
          { op: "delete", id: N1 },
          { op: "delete", id: N2 },
          { op: "delete", id: N3 },
        ],
      },
    ]);
    expect(notes()).toHaveLength(0);
    expect(selected()).toEqual([]);
  });

  it("the bar arranges 2+ notes: align sends one batch; distribute needs 3", async () => {
    const socket = await withNotes(one, two, three);
    await noteClick(0);
    // The bar is always there from md up; with one note the arrange commands are off, and say why.
    expect(isOff(bar()?.querySelector<HTMLButtonElement>('[aria-label="Align left edges"]'))).toBe(true);
    expect(bar()?.textContent).toContain("Select 2 or more notes to arrange.");
    await noteClick(1, { shiftKey: true });
    expect(isOff(bar()?.querySelector<HTMLButtonElement>('[aria-label="Align left edges"]'))).toBe(false);
    const distribute = bar()?.querySelector<HTMLButtonElement>('[aria-label="Distribute horizontally (equal gaps)"]');
    expect(isOff(distribute)).toBe(true);
    await click(bar()?.querySelector<HTMLElement>('[aria-label="Align left edges"]') ?? undefined);
    expect(batches(socket).at(-1)).toEqual({ type: "noteBatch", final: true, ops: [{ op: "move", id: N2, x: 40, y: 300 }] });
    expect(notes()[1]?.closest(".react-flow__node")?.getAttribute("style")).toContain("translate(40px");
    await noteClick(2, { shiftKey: true });
    expect(isOff(bar()?.querySelector<HTMLButtonElement>('[aria-label="Distribute horizontally (equal gaps)"]'))).toBe(false);
    await click(bar()?.querySelector<HTMLElement>('[aria-label="Match width to the first selected"]') ?? undefined);
    for (const label of ["Align centres horizontally", "Align right edges", "Align top edges", "Align centres vertically", "Align bottom edges", "Distribute vertically (equal gaps)", "Match height to the first selected", "Match size to the first selected"]) {
      expect(bar()?.querySelector(`[aria-label="${label}"]`), label).not.toBeNull();
    }
  });

  it("arrow keys move the whole selection; Alt+arrows don't resize several notes", async () => {
    const socket = await withNotes(one, two);
    await key("a", document.body, { ctrlKey: true });
    await key("ArrowRight", notes()[0] as HTMLElement);
    expect(batches(socket).at(-1)).toEqual({
      type: "noteBatch",
      final: false,
      ops: [
        { op: "move", id: N1, x: 50, y: 60 },
        { op: "move", id: N2, x: 410, y: 300 },
      ],
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
    expect(batches(socket).at(-1)).toMatchObject({ final: true });
    const before = (socket.sent as Record<string, unknown>[]).length;
    await key("ArrowRight", notes()[0] as HTMLElement, { altKey: true });
    expect((socket.sent as Record<string, unknown>[]).slice(before).filter((m) => m.type === "noteResize" || m.type === "noteBatch")).toEqual([]);
  });

  it("Delete on a focused note deletes the whole selection, asking first when any has text", async () => {
    const socket = await withNotes(one, two);
    await key("a", document.body, { ctrlKey: true });
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await key("Delete", notes()[1] as HTMLElement);
    expect(confirm).toHaveBeenCalled();
    expect(batches(socket)).toEqual([]);
    confirm.mockReturnValue(true);
    await key("Delete", notes()[1] as HTMLElement);
    expect(batches(socket).at(-1)).toMatchObject({ ops: [{ op: "delete", id: N1 }, { op: "delete", id: N2 }] });
  });

  const gridButton = () => [...(bar()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === "Grid");
  const stepper = (label: string) => bar()?.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`) ?? undefined;

  it("Grid lays the selection out in reading order with auto columns: moves only, unchanged notes left out", async () => {
    const socket = await withNotes(one, two, three);
    await key("a", document.body, { ctrlKey: true });
    expect(isOff(gridButton())).toBe(false);
    expect(bar()?.querySelector('[data-grid-columns]')?.textContent).toContain("Auto");
    await click(gridButton());
    // Reading order: one, three (same band), two. Three columns from the spread, anchored at one.
    const ops = batches(socket).at(-1)?.ops as unknown[];
    expect(ops).toHaveLength(2);
    expect(ops).toEqual(expect.arrayContaining([{ op: "move", id: N3, x: 224, y: 60 }, { op: "move", id: N2, x: 408, y: 60 }]));
    const before = batches(socket).length;
    await click(gridButton());
    expect(batches(socket)).toHaveLength(before);
  });

  it("the Columns stepper sets the column count (1 to the count), kept for the session", async () => {
    const socket = await withNotes(one, two, three);
    await key("a", document.body, { ctrlKey: true });
    await click(stepper("Fewer columns"));
    expect(bar()?.querySelector('[data-grid-columns]')?.textContent).toBe("2");
    await click(gridButton());
    expect(batches(socket).at(-1)?.ops).toEqual(expect.arrayContaining([{ op: "move", id: N2, x: 40, y: 244 }, { op: "move", id: N3, x: 224, y: 60 }]));
    await click(stepper("Fewer columns"));
    expect(stepper("Fewer columns")?.disabled).toBe(true);
    for (let i = 0; i < 3; i++) await click(stepper("More columns"));
    expect(bar()?.querySelector('[data-grid-columns]')?.textContent).toBe("3");
    expect(stepper("More columns")?.disabled).toBe(true);
    await key("Escape", document.body);
    await key("a", document.body, { ctrlKey: true });
    expect(bar()?.querySelector('[data-grid-columns]')?.textContent).toBe("3");
    await click(bar()?.querySelector<HTMLElement>('[aria-label="Automatic columns"]') ?? undefined);
    expect(bar()?.querySelector('[data-grid-columns]')?.textContent).toContain("Auto");
  });

  it("a grid that doesn't fit the board sends nothing and says why", async () => {
    const big = (n: number): Note => ({ ...one, id: `NNNNNNNNNNNNNNB${n}`, x: 0, y: 0, w: NOTE_MAX_W, h: NOTE_MAX_H });
    const socket = await withNotes(big(1), big(2), big(3), big(4), big(5));
    await key("a", document.body, { ctrlKey: true });
    while (stepper("Fewer columns")?.disabled === false) await click(stepper("Fewer columns"));
    await click(gridButton());
    expect(batches(socket)).toEqual([]);
    expect(document.body.textContent).toContain("too tall for the board");
  });

  it("selection is pruned when someone else deletes a selected note", async () => {
    const socket = await withNotes(one, two, three);
    await key("a", document.body, { ctrlKey: true });
    await server(socket, { data: { type: "notesBatchApplied", final: true, results: [{ type: "noteDeleted", id: N2 }] } });
    expect(selected()).toEqual([N1, N3]);
    expect(properties()?.textContent).toContain("2 selected");
  });
});

describe("selection and delete polish (md up)", () => {
  const nid = (i: number) => `NNNNNNNNNNNN${String(i).padStart(4, "0")}`;
  const make = (i: number, text = ""): Note => ({ id: nid(i), x: 40 + (i % 10) * 200, y: 60 + Math.floor(i / 10) * 90, ...NOTE_DEFAULTS, text, color: "yellow", z: i, rev: 1, authorId: sam.id });
  const notes = () => [...document.querySelectorAll<HTMLElement>('[aria-roledescription="note"]')];
  const selected = () => notes().filter((n) => n.getAttribute("aria-current") === "true").map((n) => n.dataset.noteId);
  const batches = (socket: FakeWebSocket) => (socket.sent as { type: string; ops: { op: string; id: string }[] }[]).filter((m) => m.type === "noteBatch");
  const sentOfType = (socket: FakeWebSocket, t: string) => (socket.sent as Record<string, unknown>[]).filter((m) => m.type === t);
  const statusText = () => [...document.querySelectorAll('[role="status"]')].map((s) => s.textContent).join(" ");
  async function withNotes(list: Note[]) {
    setWide(true);
    const socket = await inRoom();
    await server(socket, { data: { type: "snapshot", notes: list } });
    for (let i = 0; i < 100 && notes().length < list.length; i++) await settle();
    return socket;
  }
  async function pointer(target: EventTarget, type: string, init: PointerEventInit) {
    await act(async () => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, ...init }));
    });
  }
  /** A key press where a real keyboard sends it: the focused element (or the body). */
  async function press(k: string, init: KeyboardEventInit = {}) {
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
    });
    await settle();
  }
  const applied = (socket: FakeWebSocket, ids: readonly string[]) =>
    server(socket, { data: { type: "notesBatchApplied", final: true, results: ids.map((id) => ({ type: "noteDeleted", id })) } });

  it("Ctrl+A then Delete deletes every note (asking once, with the count) and reports it", async () => {
    const socket = await withNotes([make(0, "Idea"), make(1), make(2)]);
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    await press("a", { ctrlKey: true });
    expect(selected()).toHaveLength(3);
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    await press("Delete");
    expect(confirm.mock.calls).toEqual([["Delete 3 notes? They’re removed for everyone in the session."]]);
    expect(batches(socket).map((b) => b.ops.map((o) => o.id))).toEqual([[nid(0), nid(1), nid(2)]]);
    expect(selected()).toEqual([]);
    await applied(socket, [nid(0), nid(1), nid(2)]);
    expect(statusText()).toContain("Deleted 3 notes.");
  });

  it("no on the confirm deletes nothing, and the selection stays", async () => {
    const socket = await withNotes([make(0), make(1)]);
    await press("a", { ctrlKey: true });
    vi.stubGlobal("confirm", () => false);
    await press("Delete");
    expect(batches(socket)).toEqual([]);
    expect(selected()).toHaveLength(2);
  });

  it("after a marquee, Delete deletes the marquee's notes, never a note that had focus outside it", async () => {
    const socket = await withNotes([make(0), make(1), make(25)]);
    // Keyboard focus on the far note first (it's selected), then a marquee round the first two.
    await act(async () => notes()[2]?.focus());
    expect(selected()).toEqual([nid(25)]);
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) throw new Error("no pane");
    const [tx, ty, zoom] = (document.querySelector(".react-flow__viewport")?.getAttribute("style") ?? "").match(/-?[\d.]+/g)?.map(Number) ?? [0, 0, 1];
    const at = (x: number, y: number) => ({ clientX: (tx ?? 0) + x * (zoom ?? 1), clientY: (ty ?? 0) + y * (zoom ?? 1) });
    await pointer(pane, "pointerdown", at(0, 0));
    await pointer(window, "pointermove", at(500, 100));
    await pointer(window, "pointerup", at(500, 100));
    await settle();
    expect(selected()).toEqual([nid(0), nid(1)]);
    // A real click on the canvas focuses the app's <main>.
    await act(async () => document.querySelector<HTMLElement>("main")?.focus());
    vi.stubGlobal("confirm", () => true);
    await press("Delete");
    expect(batches(socket).map((b) => b.ops.map((o) => o.id))).toEqual([[nid(0), nid(1)]]);
    expect(sentOfType(socket, "noteDelete")).toEqual([]);
  });

  it("a focused note that isn't in the selection: Delete deletes the selection", async () => {
    const socket = await withNotes([make(0), make(1), make(2)]);
    await act(async () => notes()[0]?.focus());
    // Ctrl+A, then Ctrl-click the focused note out of the selection (focus stays on it).
    await press("a", { ctrlKey: true });
    const el = notes()[0] as HTMLElement;
    await pointer(el, "pointerdown", { ctrlKey: true });
    await act(async () => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })));
    await settle();
    expect(selected()).toEqual([nid(1), nid(2)]);
    vi.stubGlobal("confirm", () => true);
    await act(async () => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })));
    await settle();
    expect(batches(socket).map((b) => b.ops.map((o) => o.id))).toEqual([[nid(1), nid(2)]]);
    expect(sentOfType(socket, "noteDelete")).toEqual([]);
  });

  it("200 notes: one confirm, four chunks of 50 in order, and the report counts them all", async () => {
    const all = Array.from({ length: MAX_NOTES_PER_ROOM }, (_, i) => make(i));
    const socket = await withNotes(all);
    await press("a", { ctrlKey: true });
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    await press("Delete");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]).toEqual([`Delete ${MAX_NOTES_PER_ROOM} notes? They’re removed for everyone in the session.`]);
    const sent = batches(socket);
    expect(sent.map((b) => b.ops.length)).toEqual([50, 50, 50, 50]);
    expect(sent.flatMap((b) => b.ops.map((o) => o.id))).toEqual(all.map((n) => n.id));
    for (const b of sent.slice(0, 3)) await applied(socket, b.ops.map((o) => o.id));
    await server(socket, { data: { type: "error", code: "rate_limited", message: "x", noteIds: sent[3]?.ops.map((o) => o.id) } });
    expect(notes()).toHaveLength(50);
    expect(statusText()).toContain("Deleted 150 of 200 notes. 50 weren’t deleted because that was too quick");
  });

  it("disconnected: Delete (on the board or a note) asks nothing, deletes nothing, and says why", async () => {
    const socket = await withNotes([make(0, "Idea"), make(1)]);
    await press("a", { ctrlKey: true });
    await server(socket, "close");
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    await press("Delete");
    expect(confirm).not.toHaveBeenCalled();
    expect(notes()).toHaveLength(2);
    expect(statusText()).toContain("You’re not connected, so nothing was deleted.");
    await act(async () => notes()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })));
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(sentOfType(socket, "noteBatch")).toEqual([]);
  });

  it("Delete while a note is edited in place is the text's, even with notes selected before", async () => {
    const socket = await withNotes([make(0, "Idea"), make(1)]);
    await press("a", { ctrlKey: true });
    await act(async () => {
      notes()[0]?.querySelector("[data-note-title]")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    await settle();
    const area = document.querySelector<HTMLTextAreaElement>('textarea[data-inline="title"]');
    expect(area).not.toBeNull();
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    for (const k of ["Delete", "Backspace"]) {
      await act(async () => area?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));
    }
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(batches(socket)).toEqual([]);
    expect(sentOfType(socket, "noteDelete")).toEqual([]);
  });

  const badges = () => [...document.querySelectorAll<HTMLElement>(".react-flow__node [data-select-badge]")].map((b) => b.closest<HTMLElement>(".react-flow__node")?.dataset.id);
  const box = () => document.querySelector<HTMLElement>("[data-selection-box]");

  it("several selected: each has the outline and a check badge, and a dashed box surrounds them all", async () => {
    await withNotes([make(0), make(1), make(2)]);
    await act(async () => notes()[0]?.focus());
    expect(badges()).toEqual([]);
    expect(box()).toBeNull();
    expect(notes()[0]?.classList.contains("sy-selected")).toBe(true);
    await press("a", { ctrlKey: true });
    expect(notes().every((n) => n.classList.contains("sy-selected"))).toBe(true);
    expect(badges()).toEqual([nid(0), nid(1), nid(2)]);
    // Notes at x 40, 240, 440 (y 60), default size 160: the box spans 40..600 by 60..220, padded.
    expect(box()?.style.left).toBe("calc(40px - var(--sy-selection-pad))");
    expect(box()?.style.top).toBe("calc(60px - var(--sy-selection-pad))");
    expect(box()?.style.width).toBe("calc(560px + 2 * var(--sy-selection-pad))");
    expect(box()?.style.height).toBe("calc(160px + 2 * var(--sy-selection-pad))");
    await press("Escape");
    expect(badges()).toEqual([]);
    expect(box()).toBeNull();
  });

  it("Delete from a control outside the board (the top bar) does nothing", async () => {
    const socket = await withNotes([make(0), make(1)]);
    await press("a", { ctrlKey: true });
    // The app nav's controls (menu, theme), not the board actions that share the top bar since v0.15.1.
    const menu = document.querySelector<HTMLElement>('header nav[aria-label="App"] button');
    expect(menu).not.toBeNull();
    await act(async () => menu?.focus());
    vi.stubGlobal("confirm", () => true);
    await press("Delete");
    expect(batches(socket)).toEqual([]);
  });
});

describe("inline editing (slice 2.9, md up)", () => {
  const N1 = "NNNNNNNNNNNNNNN1";
  const one: Note = { id: N1, x: 40, y: 60, ...NOTE_DEFAULTS, text: "Idea one\nThe details", color: "pink", z: 0, rev: 1, authorId: sam.id };
  const notes = () => [...document.querySelectorAll<HTMLElement>('[aria-roledescription="note"]')];
  const titleArea = () => document.querySelector<HTMLTextAreaElement>('textarea[data-inline="title"]');
  const bodyArea = () => document.querySelector<HTMLTextAreaElement>('textarea[data-inline="body"]');
  const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
  const sentOfType = (socket: FakeWebSocket, t: string) => (socket.sent as Record<string, unknown>[]).filter((m) => m.type === t);
  async function withNotes(...list: Note[]) {
    setWide(true);
    const socket = await inRoom();
    await server(socket, { data: { type: "snapshot", notes: list } });
    for (let i = 0; i < 100 && notes().length < list.length; i++) await settle();
    return socket;
  }
  async function typeInto(el: HTMLTextAreaElement | null, value: string) {
    if (!el) throw new Error("no textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function key(k: string, target: EventTarget | null, init: KeyboardEventInit = {}) {
    await act(async () => {
      target?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
    });
    await settle();
  }
  async function dblclick(el: Element | null | undefined) {
    if (!el) throw new Error("nothing to double-click");
    await act(async () => {
      el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    await settle();
  }

  it("a note added from the palette is edited in place at once: caret in the title, helper text as placeholders", async () => {
    const socket = await withNotes();
    await click(document.querySelector<HTMLElement>('aside[aria-label="Palette"] [aria-label="Yellow note"]') ?? undefined);
    expect(titleArea()).not.toBeNull();
    expect(document.activeElement).toBe(titleArea());
    expect(titleArea()?.placeholder).toBe("Type a title");
    expect(bodyArea()?.placeholder).toBe("Type body");
    expect(titleArea()?.className).toContain("nodrag");
    expect(titleArea()?.className).toContain("nopan");
    expect(notes()[0]?.hasAttribute("data-editing")).toBe(true);
    // The server confirms the add; then typing and Enter, Enter: one edit with both parts.
    const add = sentOfType(socket, "noteAdd")[0];
    await server(socket, { data: { type: "noteAdded", note: { ...one, id: N1, text: "", color: "yellow", authorId: alex.id, x: Number(add?.x), y: Number(add?.y) }, clientRef: add?.clientRef } });
    await typeInto(titleArea(), "Plan");
    await key("Enter", titleArea());
    expect(document.activeElement).toBe(bodyArea());
    await typeInto(bodyArea(), "Step one");
    await key("Enter", bodyArea());
    expect(sentOfType(socket, "noteEdit")).toEqual([{ type: "noteEdit", id: N1, text: "Plan\nStep one" }]);
    expect(titleArea()).toBeNull();
    expect(notes()[0]?.querySelector("[data-note-title]")?.textContent).toBe("Plan");
  });

  it("an empty new note committed with Escape stays, with no text (placeholders are never stored)", async () => {
    const socket = await withNotes();
    await click(document.querySelector<HTMLElement>('aside[aria-label="Palette"] [aria-label="Blue note"]') ?? undefined);
    await key("Escape", titleArea());
    expect(titleArea()).toBeNull();
    expect(notes()).toHaveLength(1);
    expect(sentOfType(socket, "noteAdd")[0]).toMatchObject({ text: "" });
    expect(sentOfType(socket, "noteEdit")).toEqual([]);
    expect(notes()[0]?.textContent).not.toContain("Type");
  });

  it("double-clicking the body edits it in place with the caret in the body; the title part targets the title", async () => {
    await withNotes(one);
    await dblclick(notes()[0]?.querySelector("[data-note-body]"));
    expect(document.activeElement).toBe(bodyArea());
    expect(bodyArea()?.value).toBe("The details");
    expect(bodyArea()?.selectionStart).toBe("The details".length);
    await key("Escape", bodyArea());
    await dblclick(notes()[0]?.querySelector("[data-note-title]"));
    expect(document.activeElement).toBe(titleArea());
  });

  it("the textareas take the note's own style for each part", async () => {
    await withNotes({ ...one, titleFontSize: "xl", titleBold: true, titleAlign: "center", align: "right", italic: true, textColor: "blue" });
    await dblclick(notes()[0]?.querySelector("[data-note-title]"));
    for (const cls of ["text-note-xl", "font-bold", "text-center"]) expect(titleArea()?.className, cls).toContain(cls);
    for (const cls of ["text-note-m", "italic", "text-right", "text-note-text-blue"]) expect(bodyArea()?.className, cls).toContain(cls);
  });

  it("Enter on a focused note starts editing its title", async () => {
    await withNotes(one);
    await act(async () => notes()[0]?.focus());
    await key("Enter", notes()[0] ?? null);
    expect(document.activeElement).toBe(titleArea());
  });

  it("typing never triggers board shortcuts or note keys", async () => {
    const socket = await withNotes(one);
    await dblclick(notes()[0]?.querySelector("[data-note-title]"));
    for (const k of ["n", "h", "v", "f", "+", "-", "0", "[", "]", "Delete", "Backspace", "ArrowRight", " "]) await key(k, titleArea());
    await key("ArrowRight", titleArea(), { altKey: true });
    await key("a", titleArea(), { ctrlKey: true });
    expect(sentOfType(socket, "noteAdd")).toEqual([]);
    expect(sentOfType(socket, "noteDelete")).toEqual([]);
    expect(sentOfType(socket, "noteMove")).toEqual([]);
    expect(sentOfType(socket, "noteResize")).toEqual([]);
    expect(titleArea()).not.toBeNull();
    expect(document.querySelector('[data-tool="hand"]')?.getAttribute("aria-pressed")).toBe("false");
  });

  it("a remote edit while typing doesn't replace the draft; committing sends exactly one edit", async () => {
    const socket = await withNotes(one);
    await dblclick(notes()[0]?.querySelector("[data-note-title]"));
    await typeInto(titleArea(), "My title");
    await server(socket, { data: { type: "noteUpdated", note: { ...one, text: "Someone else\nwrote this", rev: 2 } } });
    expect(titleArea()?.value).toBe("My title");
    // Properties shows the same draft.
    expect(properties()?.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe("My title");
    await key("Escape", titleArea());
    expect(sentOfType(socket, "noteEdit")).toEqual([{ type: "noteEdit", id: N1, text: "My title\nThe details" }]);
  });

  it("nothing changed: committing sends nothing", async () => {
    const socket = await withNotes(one);
    await dblclick(notes()[0]?.querySelector("[data-note-body]"));
    await key("Enter", bodyArea());
    expect(bodyArea()).toBeNull();
    expect(sentOfType(socket, "noteEdit")).toEqual([]);
  });

  it("input stops at 280 characters across title and body", async () => {
    await withNotes({ ...one, text: `Title\n${"b".repeat(MAX_NOTE_TEXT - 6)}` });
    await dblclick(notes()[0]?.querySelector("[data-note-title]"));
    await typeInto(titleArea(), "Title!");
    expect(titleArea()?.value).toBe("Title");
  });

  it("disconnected: no inline editing", async () => {
    const socket = await withNotes(one);
    await server(socket, "close");
    await dblclick(notes()[0]?.querySelector("[data-note-title]"));
    expect(titleArea()).toBeNull();
  });
});

describe("stacking order (slice z-order)", () => {
  const N1 = "NNNNNNNNNNNNNNN1";
  const N2 = "NNNNNNNNNNNNNNN2";
  const N3 = "NNNNNNNNNNNNNNN3";
  const one: Note = { id: N1, x: 40, y: 60, ...NOTE_DEFAULTS, text: "Idea one", color: "pink", z: 0, rev: 1, authorId: sam.id };
  const two: Note = { id: N2, x: 100, y: 100, ...NOTE_DEFAULTS, text: "", color: "blue", z: 1, rev: 1, authorId: sam.id };
  const three: Note = { id: N3, x: 160, y: 140, ...NOTE_DEFAULTS, text: "", color: "green", z: 2, rev: 1, authorId: sam.id };
  const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
  const notes = () => [...document.querySelectorAll<HTMLElement>('[aria-roledescription="note"]')];
  const bar = () => document.querySelector<HTMLElement>('[role="toolbar"][aria-label="Board actions"]');
  const orders = (socket: FakeWebSocket) => (socket.sent as Record<string, unknown>[]).filter((m) => m.type === "notesOrder");
  const inside = (root: HTMLElement | null, text: string) =>
    [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent?.trim() === text);
  const zIndexOf = (noteId: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${noteId}"]`)?.style.zIndex;
  async function withNotes(wide: boolean, ...list: Note[]) {
    setWide(wide);
    const socket = await inRoom();
    await server(socket, { data: { type: "snapshot", notes: list } });
    for (let i = 0; i < 100 && notes().length < list.length; i++) await settle();
    return socket;
  }
  async function select(i: number, init: MouseEventInit = {}) {
    const el = notes()[i];
    if (!el) throw new Error("no note");
    await act(async () => {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, shiftKey: init.shiftKey ?? false }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    });
    await settle();
  }

  it("each note's z is its stacking on the canvas, and a selected note isn't raised", async () => {
    await withNotes(true, three, one, two);
    expect([zIndexOf(N1), zIndexOf(N2), zIndexOf(N3)]).toEqual(["0", "1", "2"]);
    await select(1);
    expect(zIndexOf(N1)).toBe("0");
  });

  it("Properties has an Order section for one note: Bring to front and Send to back, as visible text", async () => {
    const socket = await withNotes(true, one, two, three);
    await select(0);
    const section = [...(properties()?.querySelectorAll("section") ?? [])].find((s) => s.querySelector("h3")?.textContent === "Order");
    expect(section).toBeDefined();
    await click(inside(section ?? null, "Bring to front"));
    expect(orders(socket)).toEqual([{ type: "notesOrder", ids: [N1], action: "front" }]);
    expect(zIndexOf(N1)).toBe("3");
    await click(inside(section ?? null, "Send to back"));
    expect(orders(socket).at(-1)).toEqual({ type: "notesOrder", ids: [N1], action: "back" });
    // Disabled while disconnected.
    await server(socket, "close");
    expect(inside(properties(), "Bring to front")?.disabled).toBe(true);
    expect(inside(properties(), "Send to back")?.disabled).toBe(true);
  });

  it("several selected: the same two actions in Properties and in the selection bar, for all of them", async () => {
    const socket = await withNotes(true, one, two, three);
    await select(0);
    await select(2, { shiftKey: true });
    expect(properties()?.querySelector("h3")?.textContent).toContain("2 selected");
    const order = bar()?.querySelector<HTMLElement>('[role="group"][aria-label="Order"]');
    expect(order?.querySelector('[aria-label="Bring to front"]')).not.toBeNull();
    await click(order?.querySelector<HTMLElement>('[aria-label="Send to back"]') ?? undefined);
    expect(orders(socket).at(-1)).toEqual({ type: "notesOrder", ids: [N1, N3], action: "back" });
    await click(inside(properties(), "Bring to front"));
    expect(orders(socket).at(-1)).toEqual({ type: "notesOrder", ids: [N1, N3], action: "front" });
  });

  it("a remote reorder restacks the canvas", async () => {
    const socket = await withNotes(true, one, two, three);
    await server(socket, { data: { type: "notesOrdered", results: [{ id: N3, z: -1, rev: 2 }] } });
    expect(zIndexOf(N3)).toBe("-1");
  });

  it("phone: the editor sheet has the same two buttons for its note", async () => {
    const socket = await withNotes(false, one, two);
    const note = notes()[0];
    await act(async () => {
      note?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", button: 0 }));
    });
    await click(note);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Edit note");
    await click(inside(dialog(), "Bring to front"));
    expect(orders(socket)).toEqual([{ type: "notesOrder", ids: [N1], action: "front" }]);
    await click(inside(dialog(), "Send to back"));
    expect(orders(socket).at(-1)).toEqual({ type: "notesOrder", ids: [N1], action: "back" });
  });
});

describe("frames (slice frames, protocol v9)", () => {
  const N1 = "NNNNNNNNNNNNNNN1";
  const F1 = "FFFFFFFFFFFFFFF1";
  const inside: Note = { id: N1, x: 200, y: 200, ...NOTE_DEFAULTS, text: "Idea one", color: "yellow", z: -5, rev: 1, authorId: sam.id };
  const start: Frame = { id: F1, x: 100, y: 100, w: 640, h: 400, title: "Start", color: "neutral", ...FRAME_DEFAULTS, rev: 1, authorId: sam.id };
  const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
  const frameNode = () => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${F1}"]`);
  const noteEl = () => document.querySelector<HTMLElement>('[aria-roledescription="note"]');
  const sentOfType = (socket: FakeWebSocket, t: string) => (socket.sent as Record<string, unknown>[]).filter((m) => m.type === t);
  async function withBoard(wide = true, frames = [start], notes: Note[] = [inside]) {
    setWide(wide);
    const socket = await inRoom();
    await server(socket, { data: { type: "snapshot", notes } });
    await server(socket, { data: { type: "framesSnapshot", frames } });
    for (let i = 0; i < 100 && !(frames.length === 0 || frameNode()); i++) await settle();
    return socket;
  }
  async function press(el: Element | null | undefined, init: MouseEventInit = {}) {
    if (!el) throw new Error("nothing to press");
    await act(async () => {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    });
    await settle();
  }

  it("frames render behind every note, with the title in a header strip", async () => {
    await withBoard();
    const frameZ = Number(frameNode()?.style.zIndex);
    const noteZ = Number(document.querySelector<HTMLElement>(`.react-flow__node[data-id="${N1}"]`)?.style.zIndex);
    expect(frameZ).toBeLessThan(noteZ);
    expect(frameNode()?.querySelector<HTMLInputElement>("input[data-frame-title]")?.value).toBe("Start");
  });

  it("the frame body is click-through: a note inside it is still selectable, and the body has no pointer events", async () => {
    await withBoard();
    expect(frameNode()?.style.pointerEvents).toBe("none");
    await press(noteEl());
    expect(noteEl()?.getAttribute("aria-current")).toBe("true");
    expect(properties()?.querySelector("h3")?.textContent).toContain("note");
  });

  it("a marquee started over a frame's body selects the notes it touches", async () => {
    await withBoard();
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) throw new Error("no pane");
    const [tx, ty, zoom] = (document.querySelector(".react-flow__viewport")?.getAttribute("style") ?? "").match(/-?[\d.]+/g)?.map(Number) ?? [0, 0, 1];
    const at = (x: number, y: number) => ({ clientX: (tx ?? 0) + x * (zoom ?? 1), clientY: (ty ?? 0) + y * (zoom ?? 1) });
    const ev = (target: EventTarget, type: string, init: PointerEventInit) =>
      act(async () => {
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, ...init }));
      });
    // (150, 300) is inside the frame (100..740, 100..500) but not on the note.
    await ev(pane, "pointerdown", at(150, 300));
    await ev(window, "pointermove", at(260, 260));
    await ev(window, "pointerup", at(260, 260));
    await settle();
    expect(noteEl()?.getAttribute("aria-current")).toBe("true");
  });

  it("clicking the title bar selects the frame alone; Properties shows its fields; selecting a note deselects it", async () => {
    await withBoard();
    await press(noteEl());
    await press(frameNode()?.querySelector("[data-frame-handle='header']"));
    expect(noteEl()?.getAttribute("aria-current")).toBeNull();
    expect(properties()?.querySelector("h3")?.textContent).toBe("Frame");
    expect(properties()?.querySelector<HTMLInputElement>('input[name="frameTitle"]')?.value).toBe("Start");
    expect(properties()?.querySelectorAll('[aria-label="Frame colour"] button')).toHaveLength(7);
    expect(properties()?.querySelector('input[name="frameWidth"]')).not.toBeNull();
    expect(properties()?.querySelector('input[name="frameHeight"]')).not.toBeNull();
    expect(properties()?.textContent).toContain("Sam");
    await press(noteEl());
    expect(properties()?.querySelector("h3")?.textContent).not.toBe("Frame");
  });

  it("the title is typed in the header as a draft: a remote edit doesn't replace it, Enter sends one frameEdit", async () => {
    const socket = await withBoard();
    const input = frameNode()?.querySelector<HTMLInputElement>("input[data-frame-title]");
    if (!input) throw new Error("no title input");
    await act(async () => input.focus());
    await type(input, "Stop");
    expect(sentOfType(socket, "frameEdit")).toEqual([]);
    await server(socket, { data: { type: "frameUpdated", frame: { ...start, title: "Theirs", rev: 2 } } });
    expect(frameNode()?.querySelector<HTMLInputElement>("input[data-frame-title]")?.value).toBe("Stop");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await settle();
    expect(sentOfType(socket, "frameEdit")).toEqual([{ type: "frameEdit", id: F1, title: "Stop" }]);
  });

  it("Delete (Properties) asks first when the frame has a title or notes, and never deletes notes", async () => {
    const socket = await withBoard();
    await press(frameNode()?.querySelector("[data-frame-handle='header']"));
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    await click(properties()?.querySelector<HTMLElement>('[aria-label="Delete frame"]') ?? undefined);
    expect(confirm).toHaveBeenCalled();
    expect(sentOfType(socket, "frameDelete")).toEqual([{ type: "frameDelete", id: F1 }]);
    expect(sentOfType(socket, "noteDelete")).toEqual([]);
    expect(noteEl()).not.toBeNull();
  });

  it("the Delete key deletes the selected frame (asking first)", async () => {
    const socket = await withBoard();
    await press(frameNode()?.querySelector("[data-frame-handle='header']"));
    vi.stubGlobal("confirm", () => true);
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    });
    await settle();
    expect(sentOfType(socket, "frameDelete")).toEqual([{ type: "frameDelete", id: F1 }]);
  });

  /** A key press where a real keyboard sends it: the focused element (or the body). */
  async function key(k: string) {
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    });
    await settle();
  }
  const titleInput = () => frameNode()?.querySelector<HTMLInputElement>("input[data-frame-title]");

  it("clicking the header (the title too) selects the frame without entering the title, so Delete deletes it", async () => {
    const socket = await withBoard();
    // The title takes no presses until it's being edited: they land on the header (select, drag).
    expect(titleInput()?.className).toContain("pointer-events-none");
    await press(frameNode()?.querySelector("[data-frame-handle='header']"));
    expect(document.activeElement).not.toBe(titleInput());
    // A real click there focuses the app's <main> (happy-dom leaves the body).
    const main = document.querySelector<HTMLElement>("main");
    expect(main?.contains(document.querySelector('section[aria-label="Board"]'))).toBe(true);
    await act(async () => main?.focus());
    vi.stubGlobal("confirm", () => true);
    await key("Delete");
    expect(sentOfType(socket, "frameDelete")).toEqual([{ type: "frameDelete", id: F1 }]);
  });

  it("double-click on the header edits the title (its own presses back); Delete there is the text's", async () => {
    const socket = await withBoard();
    const header = frameNode()?.querySelector("[data-frame-handle='header']");
    await press(header);
    await act(async () => header?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
    await settle();
    expect(document.activeElement).toBe(titleInput());
    expect(titleInput()?.className).not.toContain("pointer-events-none");
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    await key("Delete");
    expect(confirm).not.toHaveBeenCalled();
    expect(sentOfType(socket, "frameDelete")).toEqual([]);
  });

  it("Enter on a selected frame edits its title; Enter there ends it with the frame still selected, then Delete deletes it", async () => {
    const socket = await withBoard();
    await press(frameNode()?.querySelector("[data-frame-handle='header']"));
    await key("Enter");
    for (let i = 0; i < 20 && document.activeElement !== titleInput(); i++) await settle();
    expect(document.activeElement).toBe(titleInput());
    await key("Enter");
    expect(document.activeElement).not.toBe(titleInput());
    expect(properties()?.querySelector("h3")?.textContent).toBe("Frame");
    vi.stubGlobal("confirm", () => true);
    await key("Delete");
    expect(sentOfType(socket, "frameDelete")).toEqual([{ type: "frameDelete", id: F1 }]);
  });

  it("a selected frame has the selection outline", async () => {
    await withBoard();
    await press(frameNode()?.querySelector("[data-frame-handle='header']"));
    expect(frameNode()?.querySelector(`[data-frame-id="${F1}"]`)?.classList.contains("sy-selected")).toBe(true);
  });

  it("the palette has a Frames tile from md up; a click adds a frame with its title ready to type", async () => {
    const socket = await withBoard(true, [], []);
    const tile = document.querySelector<HTMLElement>('aside[aria-label="Palette"] [aria-label="Frame"]');
    expect(tile).not.toBeNull();
    await click(tile ?? undefined);
    expect(sentOfType(socket, "frameAdd")).toHaveLength(1);
    expect(sentOfType(socket, "frameAdd")[0]).toMatchObject({ color: "neutral", title: "" });
    for (let i = 0; i < 20 && document.activeElement?.getAttribute("data-frame-title") === null; i++) await settle();
    expect(document.activeElement?.hasAttribute("data-frame-title")).toBe(true);
  });

  it("phones show frames, but there's no Frames tile in the add drawer and the title isn't editable", async () => {
    await withBoard(false);
    expect(frameNode()).not.toBeNull();
    expect(frameNode()?.textContent).toContain("Start");
    expect(frameNode()?.querySelector("input[data-frame-title]")).toBeNull();
    await click(document.querySelector<HTMLElement>('[aria-label="Add note"]') ?? undefined);
    expect(document.querySelector('[role="dialog"] [aria-label="Frame"]')).toBeNull();
  });

  describe("title styling (slice frame title styling, protocol v10)", () => {
    const styled: Frame = { ...start, titleFontSize: "xl", titleBold: false, titleItalic: true, titleTextColor: "blue", titleAlign: "center" };
    const header = () => frameNode()?.querySelector<HTMLElement>("[data-frame-handle='header']");
    const root = () => frameNode()?.querySelector<HTMLElement>("[data-frame-id]");
    const title = () => frameNode()?.querySelector<HTMLElement>("[data-frame-title]");
    const section = () => [...(properties()?.querySelectorAll("section") ?? [])].find((el) => el.querySelector("h3")?.textContent === "Title text");
    const selectFrame = () => press(header());

    it("Properties shows a Title text section like the note one: Size, Style, Align and Text colour, defaults pressed", async () => {
      await withBoard();
      await selectFrame();
      const s = section();
      expect(s).toBeDefined();
      expect(s?.querySelector<HTMLSelectElement>('select[name="titleFontSize"]')?.value).toBe("m");
      expect(s?.querySelector('[aria-label="Bold title"]')?.getAttribute("aria-pressed")).toBe("true");
      expect(s?.querySelector('[aria-label="Italic title"]')?.getAttribute("aria-pressed")).toBe("false");
      expect([...(s?.querySelectorAll('[aria-label="Title alignment"] [role="radio"]') ?? [])].map((r) => [r.getAttribute("aria-label"), r.getAttribute("aria-checked")])).toEqual([
        ["Align title left", "true"],
        ["Align title centre", "false"],
        ["Align title right", "false"],
      ]);
      const swatches = [...(s?.querySelectorAll<HTMLElement>('[aria-label="Title text colour"] button') ?? [])];
      expect(swatches.map((b) => b.getAttribute("aria-label"))).toEqual(["Auto", "Red", "Orange", "Green", "Blue", "Purple", "Grey"]);
      expect(swatches[0]?.getAttribute("aria-pressed")).toBe("true");
      // Swatches show the frame ink for the current theme (a token, never a value).
      expect(swatches[0]?.querySelector("span")?.style.backgroundColor).toBe("var(--sy-frame-title)");
      expect(swatches[1]?.querySelector("span")?.style.backgroundColor).toBe("var(--sy-frame-text-red)");
    });

    it("a style change is one optimistic frameEdit that reaches the header; a refusal rolls it back", async () => {
      const socket = await withBoard();
      await selectFrame();
      await click(section()?.querySelector<HTMLElement>('[aria-label="Italic title"]') ?? undefined);
      expect(sentOfType(socket, "frameEdit")).toEqual([{ type: "frameEdit", id: F1, titleItalic: true }]);
      expect(title()?.className).toContain("italic");
      await click(section()?.querySelector<HTMLElement>('[aria-label="Align title right"]') ?? undefined);
      expect(sentOfType(socket, "frameEdit").at(-1)).toEqual({ type: "frameEdit", id: F1, titleAlign: "right" });
      expect(title()?.className).toContain("text-right");
      await server(socket, { data: { type: "error", code: "rate_limited", message: "Slow down.", frameId: F1 } });
      expect(title()?.className).not.toContain("text-right");
      expect(title()?.className).toContain("text-left");
    });

    it("the header renders the stored style, and its height follows the size; the drag handle is unchanged", async () => {
      await withBoard(true, [styled]);
      const cls = title()?.className ?? "";
      for (const c of ["text-note-xl", "text-center", "font-normal", "italic"]) expect(cls).toContain(c);
      expect(cls).not.toContain("font-semibold");
      expect(header()?.style.color).toBe("var(--sy-frame-text-blue)");
      expect(root()?.style.getPropertyValue("--sy-frame-header-h")).toBe("var(--sy-frame-header-xl)");
      // The header and the side strips use the header height token; both still drag the frame.
      expect(header()?.className).toContain("h-frame-header");
      expect(header()?.className).toContain("sy-frame-handle");
      const edges = [...(frameNode()?.querySelectorAll<HTMLElement>("[data-frame-handle='edge']") ?? [])];
      expect(edges).toHaveLength(3);
      for (const e of edges) expect(e.className).toContain("sy-frame-handle");
      expect(edges.filter((e) => e.className.includes("top-frame-header"))).toHaveLength(2);
    });

    it("typing the title in a styled header is still a draft until Enter", async () => {
      const socket = await withBoard(true, [styled]);
      const input = frameNode()?.querySelector<HTMLInputElement>("input[data-frame-title]");
      if (!input) throw new Error("no title input");
      await act(async () => input.focus());
      await type(input, "Stop");
      expect(sentOfType(socket, "frameEdit")).toEqual([]);
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      await settle();
      expect(sentOfType(socket, "frameEdit")).toEqual([{ type: "frameEdit", id: F1, title: "Stop" }]);
    });

    it("phones show the styled title but can't edit it", async () => {
      await withBoard(false, [styled]);
      expect(frameNode()?.querySelector("input")).toBeNull();
      const cls = title()?.className ?? "";
      for (const c of ["text-note-xl", "text-center", "font-normal", "italic"]) expect(cls).toContain(c);
      expect(header()?.style.color).toBe("var(--sy-frame-text-blue)");
      expect(header()?.className).not.toContain("sy-frame-handle");
    });

    it("disconnected: every title style control is disabled (and dimmed)", async () => {
      const socket = await withBoard();
      await selectFrame();
      await server(socket, "close");
      const controls = [...(section()?.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select") ?? [])];
      expect(controls.length).toBe(1 + 2 + 3 + 7);
      expect(controls.every((c) => c.disabled)).toBe(true);
      expect(controls.every((c) => c.className.includes("disabled:opacity-50"))).toBe(true);
    });
  });
});

describe("templates (slice templates)", () => {
  const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
  const palette = () => document.querySelector<HTMLElement>('aside[aria-label="Palette"]');
  const sentOfType = (socket: FakeWebSocket, t: string) => (socket.sent as Record<string, unknown>[]).filter((m) => m.type === t);
  const tile = (label: string) => palette()?.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`) ?? null;
  const viewport = () => document.querySelector(".react-flow__viewport")?.getAttribute("style") ?? "";
  const frameAt = (i: number, add: Record<string, unknown>): Frame => ({
    id: `FFFFFFFFFFFFF${String(i).padStart(3, "0")}`,
    x: add.x as number,
    y: add.y as number,
    w: 640,
    h: 400,
    title: add.title as string,
    color: add.color as Frame["color"],
    ...FRAME_DEFAULTS,
    rev: 1,
    authorId: alex.id,
  });
  async function withBoard(wide = true, frames: Frame[] = []) {
    setWide(wide);
    const socket = await inRoom();
    await server(socket, { data: { type: "snapshot", notes: [] } });
    await server(socket, { data: { type: "framesSnapshot", frames } });
    await settle();
    return socket;
  }
  /** Confirms adds as they go out, until `done` or a time limit. */
  /** Answers every itemsAdd sent so far: each frame added as sent, with a server id. */
  async function serve(socket: FakeWebSocket) {
    const seen = new Set<string>();
    let n = 0;
    for (const add of sentOfType(socket, "itemsAdd")) {
      const clientRef = add.clientRef as string;
      if (seen.has(clientRef)) continue;
      seen.add(clientRef);
      const frames = (add.frames as (Record<string, unknown> & { ref: string })[]).map(({ ref, ...f }) => ({
        ref,
        frame: { ...frameAt(++n, f), ...f, rev: 1, authorId: alex.id } as Frame,
      }));
      await server(socket, { data: { type: "itemsAdded", clientRef, notes: [], frames, refused: [] } });
    }
    await settle();
  }

  it("from md up, the palette has a Templates section with one labelled tile per template, previews drawn from tokens", async () => {
    await withBoard();
    const heading = [...(palette()?.querySelectorAll("h3, h2, [role=heading]") ?? [])].map((h) => h.textContent);
    expect(heading).toContain("Templates");
    for (const label of ["Retro", "Start Stop Continue", "2x2 Impact and Effort", "Sprint planning"]) {
      const t = tile(label);
      expect(t, label).not.toBeNull();
      expect(t?.textContent).toContain(label === "2x2 Impact and Effort" ? "2x2" : label.split(" ")[0]);
      const parts = [...(t?.querySelectorAll<HTMLElement>("[data-preview='template'] [data-preview-frame]") ?? [])];
      expect(parts.length).toBeGreaterThanOrEqual(3);
      for (const p of parts) expect(p.style.backgroundColor).toMatch(/^var\(--sy-frame-[a-z]+-header\)$/);
    }
  });

  it("phones have no Templates in the add drawer", async () => {
    await withBoard(false);
    await click(document.querySelector<HTMLElement>('[aria-label="Add note"]') ?? undefined);
    expect(document.querySelector('[role="dialog"] [aria-label="Retro"]')).toBeNull();
  });

  it("a click applies the template: tiles are off while it runs, then the view fits the new frames and the first is selected", async () => {
    const socket = await withBoard();
    const before = viewport();
    await click(tile("Retro") ?? undefined);
    // Every frame at once, in one message, with its size and title style.
    expect(sentOfType(socket, "itemsAdd")).toHaveLength(1);
    expect((sentOfType(socket, "itemsAdd")[0]?.frames as unknown[])[0]).toMatchObject({ title: "Went well", titleAlign: "center", titleBold: true });
    expect(tile("Retro")?.disabled).toBe(true);
    expect(tile("Sprint planning")?.disabled).toBe(true);
    await serve(socket);
    for (let i = 0; i < 20 && tile("Retro")?.disabled; i++) await settle();
    expect(sentOfType(socket, "frameAdd")).toEqual([]);
    expect(sentOfType(socket, "frameResize")).toEqual([]);
    expect(sentOfType(socket, "frameEdit")).toEqual([]);
    expect(tile("Retro")?.disabled).toBe(false);
    expect(properties()?.querySelector("h3")?.textContent).toBe("Frame");
    expect(properties()?.querySelector<HTMLInputElement>('input[name="frameTitle"]')?.value).toBe("Went well");
    expect(viewport()).not.toBe(before);
  });

  it("with too few free frame slots, nothing is sent and the board says how many it needs and has", async () => {
    const full = Array.from({ length: 29 }, (_, i) => frameAt(500 + i, { x: 0, y: 0, title: "", color: "neutral" }));
    const socket = await withBoard(true, full);
    await click(tile("Retro") ?? undefined);
    expect(sentOfType(socket, "itemsAdd")).toEqual([]);
    expect(document.body.textContent).toContain("This template needs 3 frames, but the board has room for 1 more.");
  });

  it("disconnected: the template tiles are off like the others", async () => {
    const socket = await withBoard();
    await server(socket, "close");
    expect(tile("Retro")?.disabled).toBe(true);
    expect(tile("Yellow note")?.disabled).toBe(true);
  });
});

describe("the floating bar and Duplicate (md up)", () => {
  const nid = (i: number) => `NNNNNNNNNNNN${String(i).padStart(4, "0")}`;
  const F1 = "FFFFFFFFFFFFFFF1";
  const make = (i: number, extra: Partial<Note> = {}): Note => ({ id: nid(i), x: 40 + i * 200, y: 60, ...NOTE_DEFAULTS, text: `Idea ${i}`, color: "yellow", z: i, rev: 1, authorId: sam.id, ...extra });
  const frameOf: Frame = { id: F1, x: 100, y: 600, w: 640, h: 400, title: "Plan", color: "green", ...FRAME_DEFAULTS, titleAlign: "center", rev: 1, authorId: sam.id };
  const notes = () => [...document.querySelectorAll<HTMLElement>('[aria-roledescription="note"]')];
  const selected = () => notes().filter((n) => n.getAttribute("aria-current") === "true").map((n) => n.dataset.noteId);
  const bar = () => document.querySelector<HTMLElement>('[role="toolbar"][aria-label="Board actions"]');
  const command = (label: string) => bar()?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? undefined;
  /** Why a group's commands are off: the tooltip of the group's first command (since v0.15.1; no hint line). */
  const FIRST: Record<string, string> = { History: "Undo", Edit: "Duplicate", Order: "Bring to front", Arrange: "Align left edges" };
  const hint = (group: string) => tipOf(command(FIRST[group] ?? group));
  const sentOfType = (socket: FakeWebSocket, t: string) => (socket.sent as Record<string, unknown>[]).filter((m) => m.type === t);
  async function withBoard(list: Note[], frames: Frame[] = [], isWide = true) {
    setWide(isWide);
    const socket = await inRoom();
    await server(socket, { data: { type: "snapshot", notes: list } });
    await server(socket, { data: { type: "framesSnapshot", frames } });
    for (let i = 0; i < 100 && notes().length < list.length; i++) await settle();
    return socket;
  }
  async function select(i: number, init: MouseEventInit = {}) {
    const el = notes()[i];
    if (!el) throw new Error("no note");
    await act(async () => {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, shiftKey: init.shiftKey ?? false }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    });
    await settle();
  }
  async function press(k: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) {
    let event: KeyboardEvent | undefined;
    await act(async () => {
      event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
    });
    await settle();
    return event!;
  }

  it("is there with nothing selected: Edit, Order and Arrange groups, each command labelled, off with the reason as text", async () => {
    await withBoard([make(0)]);
    expect(bar()).not.toBeNull();
    expect([...(bar()?.querySelectorAll('[role="group"]') ?? [])].map((g) => g.getAttribute("aria-label"))).toEqual(
      expect.arrayContaining(["Edit", "Order", "Arrange"]),
    );
    for (const label of ["Duplicate", "Delete", "Bring to front", "Send to back", "Align left edges", "Match size to the first selected"]) {
      expect(command(label), label).toBeDefined();
      expect(isOff(command(label)), label).toBe(true);
    }
    // Every off command points at a tooltip saying why.
    for (const button of bar()?.querySelectorAll<HTMLButtonElement>('button[aria-disabled="true"]') ?? []) {
      const ids = button.getAttribute("aria-describedby")?.split(" ") ?? [];
      const text = ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      expect(text.trim().length, button.getAttribute("aria-label") ?? button.textContent ?? "").toBeGreaterThan(0);
    }
    expect(tipOf(command("Delete"))?.textContent).toContain("Select notes or a frame first.");
    expect(hint("Arrange")?.textContent).toContain("Select 2 or more notes to arrange.");
    // Edit and Order show their names as text too, not only icons.
    expect(command("Duplicate")?.textContent).toContain("Duplicate");
    expect(command("Bring to front")?.textContent).toContain("Bring to front");
  });

  it("lives in the top bar, between the mark and the menu, with no line of hint text (v0.15.1)", async () => {
    await withBoard([make(0)]);
    const header = document.querySelector("header");
    expect(header?.contains(bar())).toBe(true);
    const slot = header?.querySelector("[data-topbar-slot]");
    expect(slot?.contains(bar())).toBe(true);
    // In document order: the mark's link, the bar, then the app nav (menu).
    const link = header?.querySelector('a[aria-label="Stickyard, start page"]');
    const nav = header?.querySelector('nav[aria-label="App"]');
    expect(link!.compareDocumentPosition(bar()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar()!.compareDocumentPosition(nav!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar()?.querySelector("[data-bar-hint]")).toBeNull();
    // Nothing of the bar is left over the board.
    expect(document.querySelector("main [role=toolbar][aria-label='Board actions']")).toBeNull();
  });

  it("an off command explains itself in a tooltip on hover and on keyboard focus; Escape hides it; clicking it does nothing", async () => {
    const socket = await withBoard([make(0)]);
    const del = command("Delete")!;
    const tip = tipOf(del)!;
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.hidden).toBe(true);
    await act(async () => del.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toContain("Select notes or a frame first.");
    await act(async () => del.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
    expect(tip.hidden).toBe(true);
    // Off, but still focusable, so a keyboard user hears and sees why.
    expect(del.disabled).toBe(false);
    await act(async () => del.focus());
    expect(document.activeElement).toBe(del);
    expect(tip.hidden).toBe(false);
    await act(async () => del.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(tip.hidden).toBe(true);
    const sent = socket.sent.length;
    await click(del);
    expect(socket.sent.length).toBe(sent);
    // A command that's on names itself the same way.
    await select(0);
    const on = command("Delete")!;
    expect(isOff(on)).toBe(false);
    await act(async () => on.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(tipOf(on)?.textContent).toBe("Delete");
  });

  it("Arrange is one button that opens its controls (Escape or a second press closes them)", async () => {
    await withBoard([make(0), make(1)]);
    const toggle = bar()?.querySelector<HTMLButtonElement>('button[aria-label="Arrange"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    const panel = document.getElementById(toggle?.getAttribute("aria-controls") ?? "");
    expect(panel?.hidden).toBe(true);
    await click(toggle ?? undefined);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(panel?.hidden).toBe(false);
    expect(panel?.querySelector('[aria-label="Align left edges"]')).not.toBeNull();
    await act(async () => panel?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(panel?.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
    await click(toggle ?? undefined);
    await click(toggle ?? undefined);
    expect(panel?.hidden).toBe(true);
  });

  it("after using the bar, Delete and Ctrl+Z still act on the board", async () => {
    const socket = await withBoard([make(0), make(1)]);
    await select(0);
    await act(async () => command("Duplicate")?.focus());
    vi.stubGlobal("confirm", vi.fn(() => true));
    await press("Delete", command("Duplicate")!);
    expect(sentOfType(socket, "noteDelete").map((m) => m.id)).toEqual([nid(0)]);
  });

  it("has a History group first: Undo and Redo, off with the reason as text until there's something to undo", async () => {
    await withBoard([make(0)]);
    expect(bar()?.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("History");
    expect(isOff(command("Undo"))).toBe(true);
    expect(isOff(command("Redo"))).toBe(true);
    expect(hint("History")?.textContent).toContain("Nothing to undo.");
  });

  it("Undo after a delete adds the notes back (itemsAdd), shows how it went, and Redo deletes them again", async () => {
    const socket = await withBoard([make(0), make(1)]);
    await select(0);
    await select(1, { shiftKey: true });
    vi.stubGlobal("confirm", vi.fn(() => true));
    await click(command("Delete"));
    await server(socket, { data: { type: "notesBatchApplied", final: true, results: [{ type: "noteDeleted", id: nid(0) }, { type: "noteDeleted", id: nid(1) }] } });
    expect(notes()).toHaveLength(0);
    expect(isOff(command("Undo"))).toBe(false);
    await click(command("Undo"));
    const add = sentOfType(socket, "itemsAdd").at(-1)!;
    expect((add.notes as { text: string }[]).map((n) => n.text)).toEqual(["Idea 0", "Idea 1"]);
    expect(notes()).toHaveLength(2);
    expect(document.body.textContent).toContain("Restoring 0 of 2…");
    const refs = (add.notes as { ref: string }[]).map((n) => n.ref);
    await server(socket, {
      data: { type: "itemsAdded", clientRef: add.clientRef, notes: refs.map((ref, i) => ({ ref, note: { ...make(i), id: nid(20 + i), authorId: alex.id } })), frames: [], refused: [] },
    });
    expect([...document.querySelectorAll('[role="status"]')].map((el) => el.textContent).join(" ")).toContain("Restored 2 items.");
    expect(isOff(command("Redo"))).toBe(false);
    await click(command("Redo"));
    expect(sentOfType(socket, "noteBatch").at(-1)).toMatchObject({ ops: [{ op: "delete", id: nid(20) }, { op: "delete", id: nid(21) }] });
  });

  it("Ctrl+Z undoes on the board (and stops the browser's own); not in a text field", async () => {
    const socket = await withBoard([make(0)]);
    await select(0);
    await press("ArrowRight", notes()[0]!);
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
    await server(socket, { data: { type: "noteMoved", id: nid(0), x: 50, y: 60, rev: 2, final: true } });
    const title = document.querySelector<HTMLInputElement>('aside[aria-label="Properties"] input[name="title"]');
    const inField = await press("z", title ?? document.body, { ctrlKey: true });
    expect(inField.defaultPrevented).toBe(false);
    expect(sentOfType(socket, "noteBatch")).toHaveLength(0);
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    const event = await press("z", document.body, { ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(sentOfType(socket, "noteBatch").at(-1)).toMatchObject({ final: true, ops: [{ op: "move", id: nid(0), x: 40, y: 60 }] });
  });

  it("an order change: undo says it can't be undone", async () => {
    await withBoard([make(0), make(1)]);
    await select(0);
    await click(command("Send to back"));
    expect(isOff(command("Undo"))).toBe(false);
    await click(command("Undo"));
    expect(document.body.textContent).toContain("Order changes can’t be undone.");
  });

  it("Duplicate copies the selected notes (full content, offset, one itemsAdd) and selects the copies", async () => {
    const socket = await withBoard([make(0, { color: "pink", titleBold: true }), make(1, { text: "Two\nbody" }), make(2)]);
    await select(0);
    await select(1, { shiftKey: true });
    expect(isOff(command("Duplicate"))).toBe(false);
    await click(command("Duplicate"));
    const adds = sentOfType(socket, "itemsAdd");
    expect(adds).toHaveLength(1);
    const items = adds[0]!.notes as Record<string, unknown>[];
    expect(items.map((n) => n.text)).toEqual(["Idea 0", "Two\nbody"]);
    expect(items[0]).toMatchObject({ x: 40 + 24, y: 60 + 24, color: "pink", titleBold: true });
    expect(notes()).toHaveLength(5);
    expect(selected()).toHaveLength(2);
    expect(selected().every((id) => id?.startsWith("local:"))).toBe(true);
    // Confirmed: the selection follows the server ids.
    const refs = items.map((n) => n.ref as string);
    await server(socket, {
      data: {
        type: "itemsAdded",
        clientRef: adds[0]!.clientRef,
        notes: refs.map((ref, i) => ({ ref, note: { ...make(10 + i), x: 64 + i * 200, y: 84, authorId: alex.id, z: 10 + i } })),
        frames: [],
        refused: [],
      },
    });
    expect(selected()).toEqual([nid(10), nid(11)]);
  });

  it("Duplicate on a selected frame copies the frame alone and selects the copy", async () => {
    const socket = await withBoard([make(0, { x: 200, y: 700 })], [frameOf]);
    await act(async () => {
      document.querySelector<HTMLElement>(`.react-flow__node[data-id="${F1}"] .sy-frame-handle`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    await click(command("Duplicate"));
    const adds = sentOfType(socket, "itemsAdd");
    expect(adds).toHaveLength(1);
    expect(adds[0]).not.toHaveProperty("notes");
    expect(adds[0]!.frames).toEqual([expect.objectContaining({ title: "Plan", color: "green", titleAlign: "center", x: 124, y: 624, w: 640, h: 400 })]);
    expect(document.querySelectorAll(".react-flow__node-frame")).toHaveLength(2);
  });

  it("Ctrl+D duplicates the selection and stops the browser's bookmark; never inside a text field", async () => {
    const socket = await withBoard([make(0), make(1)]);
    await select(0);
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    const event = await press("d", document.body, { ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(sentOfType(socket, "itemsAdd")).toHaveLength(1);
    const title = document.querySelector<HTMLInputElement>('aside[aria-label="Properties"] input[name="title"]');
    await select(1);
    const field = document.querySelector<HTMLInputElement>('aside[aria-label="Properties"] input[name="title"]') ?? title;
    const inField = await press("d", field ?? document.body, { ctrlKey: true });
    expect(inField.defaultPrevented).toBe(false);
    expect(sentOfType(socket, "itemsAdd")).toHaveLength(1);
  });

  it("Duplicate is off with the reason while disconnected", async () => {
    const socket = await withBoard([make(0)]);
    await select(0);
    await server(socket, "close");
    expect(isOff(command("Duplicate"))).toBe(true);
    expect(hint("Edit")?.textContent).toContain("Not connected.");
  });

  it("not enough room: Duplicate is off and says how many are needed and free", async () => {
    const full = Array.from({ length: MAX_NOTES_PER_ROOM - 1 }, (_, i) => make(i, { x: (i % 15) * 200, y: Math.floor(i / 15) * 130 }));
    await withBoard(full);
    await select(0);
    await select(1, { shiftKey: true });
    expect(isOff(command("Duplicate"))).toBe(true);
    expect(hint("Edit")?.textContent).toContain("No room to duplicate 2 notes: the board has room for 1 more.");
  });

  it("Delete in the bar uses the selection's delete (asks first, then reports)", async () => {
    const socket = await withBoard([make(0), make(1), make(2)]);
    await select(0);
    await select(2, { shiftKey: true });
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    await click(command("Delete"));
    expect(confirm.mock.calls).toEqual([["Delete 2 notes? They’re removed for everyone in the session."]]);
    expect(sentOfType(socket, "noteBatch").at(-1)).toMatchObject({ ops: [{ op: "delete", id: nid(0) }, { op: "delete", id: nid(2) }] });
    expect(selected()).toEqual([]);
  });

  it("Delete in the bar on a frame asks first when it has notes, and keeps them", async () => {
    const socket = await withBoard([make(0, { x: 200, y: 700 })], [frameOf]);
    await act(async () => {
      document.querySelector<HTMLElement>(`.react-flow__node[data-id="${F1}"] .sy-frame-handle`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    await click(command("Delete"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(sentOfType(socket, "frameDelete")).toEqual([{ type: "frameDelete", id: F1 }]);
    expect(notes()).toHaveLength(1);
  });

  it("phones: no floating bar; the ribbon gets Undo and Redo (only these two), off with the reason in their tooltip", async () => {
    await withBoard([make(0)], [], false);
    expect(bar()).toBeNull();
    const ribbon = document.querySelector<HTMLElement>('[role="toolbar"][aria-label="Board tools"]');
    const undo = ribbon?.querySelector<HTMLButtonElement>('[data-tool="undo"]');
    const redo = ribbon?.querySelector<HTMLButtonElement>('[data-tool="redo"]');
    expect(undo?.getAttribute("aria-label")).toBe("Undo");
    expect(redo?.getAttribute("aria-label")).toBe("Redo");
    expect(undo?.disabled).toBe(true);
    expect(undo?.title).toContain("Nothing to undo.");
    expect(ribbon?.querySelector('[data-tool="duplicate"]')).toBeNull();
  });
});

describe("Clear board (Properties, md up)", () => {
  const nid = (i: number) => `NNNNNNNNNNNN${String(i).padStart(4, "0")}`;
  const F1 = "FFFFFFFFFFFFFFF1";
  const make = (i: number): Note => ({ id: nid(i), x: 40 + i * 200, y: 60, ...NOTE_DEFAULTS, text: `Idea ${i}`, color: "yellow", z: i, rev: 1, authorId: sam.id });
  const aFrame: Frame = { id: F1, x: 100, y: 600, w: 640, h: 400, title: "Plan", color: "green", ...FRAME_DEFAULTS, rev: 1, authorId: sam.id };
  const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
  const clear = () => [...(properties()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent?.trim() === "Clear board");
  const notes = () => [...document.querySelectorAll<HTMLElement>('[aria-roledescription="note"]')];
  const sentOfType = (socket: FakeWebSocket, t: string) => (socket.sent as Record<string, unknown>[]).filter((m) => m.type === t);
  async function withBoard(list: Note[], frames: Frame[] = [], isWide = true) {
    setWide(isWide);
    const socket = await inRoom();
    await server(socket, { data: { type: "snapshot", notes: list } });
    await server(socket, { data: { type: "framesSnapshot", frames } });
    for (let i = 0; i < 100 && notes().length < list.length; i++) await settle();
    return socket;
  }

  it("with nothing selected: a 44px destructive button; asks once with the counts, deletes notes then frames, and reports it", async () => {
    const socket = await withBoard([make(0), make(1), make(2)], [aFrame]);
    const button = clear();
    expect(button).toBeDefined();
    expect(button?.className).toContain("h-touch");
    expect(button?.className).toContain("text-status-error");
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    await click(button);
    expect(confirm.mock.calls).toEqual([["Delete 3 notes and 1 frame for everyone in this session? You can undo this until you leave or reconnect."]]);
    expect(sentOfType(socket, "noteBatch")).toEqual([{ type: "noteBatch", final: true, ops: [0, 1, 2].map((i) => ({ op: "delete", id: nid(i) })) }]);
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(sentOfType(socket, "frameDelete")).toEqual([{ type: "frameDelete", id: F1 }]);
    await server(socket, { data: { type: "notesBatchApplied", final: true, results: [0, 1, 2].map((i) => ({ type: "noteDeleted", id: nid(i) })) } });
    await server(socket, { data: { type: "frameDeleted", id: F1 } });
    const status = [...document.querySelectorAll('[role="status"]')].map((s) => s.textContent).join(" ");
    expect(status).toContain("Cleared the board: deleted 3 notes and 1 frame.");
    expect(clear()?.disabled).toBe(true);
    expect(properties()?.textContent).toContain("The board is already empty.");
  });

  it("no on the confirm: nothing is sent", async () => {
    const socket = await withBoard([make(0)]);
    vi.stubGlobal("confirm", vi.fn(() => false));
    await click(clear());
    expect(sentOfType(socket, "noteBatch")).toEqual([]);
  });

  it("off with the reason while disconnected", async () => {
    const socket = await withBoard([make(0)]);
    await server(socket, "close");
    expect(clear()?.disabled).toBe(true);
    expect(clear()?.getAttribute("aria-describedby")).toBeTruthy();
    expect(properties()?.textContent).toContain("Not connected.");
  });

  it("not there when something is selected, nor on phones", async () => {
    await withBoard([make(0)]);
    await act(async () => {
      notes()[0]?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
      notes()[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(clear()).toBeUndefined();
  });
});

describe("reconnecting (UI)", () => {
  const N1 = "NNNNNNNNNNNNNNN1";
  const N2 = "NNNNNNNNNNNNNNN2";
  const one: Note = { id: N1, x: 40, y: 60, ...NOTE_DEFAULTS, text: "Idea one", color: "pink", z: 0, rev: 1, authorId: alex.id };
  const two: Note = { id: N2, x: 400, y: 300, ...NOTE_DEFAULTS, text: "Idea two", color: "blue", z: 1, rev: 1, authorId: sam.id };
  const statusBar = () => document.querySelector<HTMLElement>("[data-connection-status]");
  const notes = () => [...document.querySelectorAll<HTMLElement>('[aria-roledescription="note"]')];
  const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
  const titleArea = () => document.querySelector<HTMLTextAreaElement>('textarea[data-inline="title"]');
  const newMe: Participant = { id: "CCCCCCCCCCCCCCCC", name: "Alex", colourIndex: 4, host: false };

  async function withNotes(isWide: boolean, ...list: Note[]) {
    setWide(isWide);
    const socket = await inRoom();
    await server(socket, { data: { type: "snapshot", notes: list } });
    await server(socket, { data: { type: "framesSnapshot", frames: [] } });
    return socket;
  }
  /** Drops the socket, makes the browser say offline, then Rejoin: the new socket, not yet answered. */
  async function dropAndRejoin(socket: FakeWebSocket) {
    await server(socket, "close");
    await act(async () => window.dispatchEvent(new Event("offline")));
    await settle();
    await click(button("Rejoin"));
    return lastSocket();
  }
  async function answer(socket: FakeWebSocket, list: Note[], you: Participant = newMe) {
    await server(socket, "open");
    await server(socket, { data: { type: "welcome", protocolVersion: PROTOCOL_VERSION } });
    await server(socket, { data: { type: "joined", you, participants: [you, sam], locked: false, timer: null } });
    await server(socket, { data: { type: "snapshot", notes: list } });
    await server(socket, { data: { type: "framesSnapshot", frames: [] } });
  }
  async function selectNote(i: number) {
    await act(async () => {
      notes()[i]?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
    });
    await click(notes()[i]);
  }
  async function dblclick(el: Element | null | undefined) {
    if (!el) throw new Error("nothing to double-click");
    await act(async () => {
      el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    });
    await settle();
  }
  async function typeInto(el: HTMLTextAreaElement | null, value: string) {
    if (!el) throw new Error("no field");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("rejoins with the stored name, with no prompt; the bar goes once the board is back", async () => {
    const socket = await withNotes(false, one, two);
    const next = await dropAndRejoin(socket);
    expect(dialog()).toBeNull();
    await answer(next, [one, two]);
    expect(next.sent).toContainEqual({ type: "join", name: "Alex" });
    expect(statusBar()).toBeNull();
    expect(notes()).toHaveLength(2);
  });

  it("the board stays visible but read-only while reconnecting", async () => {
    const socket = await withNotes(false, one, two);
    await server(socket, "close");
    expect(notes()).toHaveLength(2);
    expect(notes()[0]?.getAttribute("aria-disabled")).toBe("true");
  });

  it("the resync replaces the board; a selected note that vanished leaves the selection with no error", async () => {
    const socket = await withNotes(true, one, two);
    await selectNote(1);
    expect(properties()?.querySelector('input[name="title"]')).not.toBeNull();
    const next = await dropAndRejoin(socket);
    await answer(next, [{ ...one, text: "Changed elsewhere", rev: 1 }]);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]?.textContent).toContain("Changed elsewhere");
    expect(properties()?.querySelector('input[name="title"]')).toBeNull();
    expect(alertText()).toBe("");
  });

  it("changes that weren't confirmed are reported in one polite status", async () => {
    const socket = await withNotes(true, one, two);
    vi.stubGlobal("confirm", vi.fn(() => true));
    await selectNote(0);
    await act(async () => {
      notes()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    });
    await settle();
    expect(socket.sent).toContainEqual({ type: "noteDelete", id: N1 });
    // No answer from the relay before the drop.
    await server(socket, "close");
    const report = document.querySelector<HTMLElement>("[data-drop-report]");
    expect(report?.getAttribute("role")).toBe("status");
    expect(report?.textContent).toMatch(/may not have been saved because the connection dropped/);
  });

  it("a note being typed into keeps its draft through the drop and the resync, then commits", async () => {
    const socket = await withNotes(true, one, two);
    await dblclick(notes()[0]?.querySelector("[data-note-title]"));
    await typeInto(titleArea(), "Typing");
    await server(socket, "close");
    // Still there, read-only, with what was typed.
    expect(titleArea()?.value).toBe("Typing");
    expect(titleArea()?.readOnly).toBe(true);
    const next = await dropAndRejoin(socket);
    await answer(next, [one, two]);
    expect(titleArea()?.readOnly).toBe(false);
    expect(titleArea()?.value).toBe("Typing");
  });

  it("a draft whose note vanished is offered back as a new note", async () => {
    const socket = await withNotes(true, one, two);
    await dblclick(notes()[0]?.querySelector("[data-note-title]"));
    await typeInto(titleArea(), "Keep me");
    const next = await dropAndRejoin(socket);
    await answer(next, [two]);
    expect(titleArea()).toBeNull();
    const offer = document.querySelector<HTMLElement>("[data-orphan-draft]");
    expect(offer?.textContent).toContain("Keep me");
    await click(button("Add as a new note"));
    expect(next.sent).toContainEqual(expect.objectContaining({ type: "noteAdd", text: "Keep me" }));
    expect(document.querySelector("[data-orphan-draft]")).toBeNull();
  });

  it("your notes from before the drop are still yours (a new participant id)", async () => {
    const socket = await withNotes(true, one);
    const next = await dropAndRejoin(socket);
    await answer(next, [one]);
    await selectNote(0);
    expect(properties()?.textContent).toContain("Alex (you)");
  });

  it("room full on a reconnect says so and offers Rejoin", async () => {
    const socket = await withNotes(false, one);
    const next = await dropAndRejoin(socket);
    await server(next, "open");
    await server(next, { data: { type: "welcome", protocolVersion: PROTOCOL_VERSION } });
    await server(next, { data: { type: "error", code: "room_full", message: "Full" } });
    expect(statusBar()?.textContent).toMatch(/session is full/);
    expect(button("Rejoin")).toBeDefined();
    expect(notes()).toHaveLength(1);
  });
});

describe("presence (UI)", () => {
  const people = (n: number): Participant[] => Array.from({ length: n }, (_, i) => ({ id: `PPPPPPPPPPPPP${String(i).padStart(3, "0")}`, name: `Person ${i}`, colourIndex: i, host: false }));
  const participantsButton = () => document.querySelector<HTMLElement>('header [aria-label^="Participants"]');
  async function roomWith(list: Participant[], isWide: boolean) {
    setWide(isWide);
    await mount(`#/room/${CODE}`);
    const socket = await joinAs("Alex");
    await server(socket, { data: { type: "joined", you: alex, participants: list, locked: false, timer: null } });
    await server(socket, { data: { type: "snapshot", notes: [] } });
    return socket;
  }

  it("md and up: an avatar stack, you first, up to 3 faces then +N, naming the number of people", async () => {
    await roomWith([...people(2), alex, ...people(5).slice(2)], true);
    const button = participantsButton();
    expect(button?.getAttribute("aria-label")).toBe("Participants: 6 people in this session");
    const avatars = [...(button?.querySelectorAll<HTMLElement>("[data-avatar]") ?? [])];
    expect(avatars).toHaveLength(3);
    expect(avatars[0]?.hasAttribute("data-you")).toBe(true);
    expect(avatars.map((a) => a.textContent)).toEqual(["A", "P0", "P1"]);
    expect(button?.querySelector("[data-avatar-more]")?.textContent).toBe("+3");
    // Since v0.16.0 each face is named (role img), so a host can be marked "…, host"; the "+N" stays decorative.
    expect(avatars.map((a) => [a.getAttribute("role"), a.getAttribute("aria-label")])).toEqual([
      ["img", "Alex"],
      ["img", "Person 0"],
      ["img", "Person 1"],
    ]);
    expect(button?.querySelector("[data-avatar-more]")?.getAttribute("aria-hidden")).toBe("true");
    expect(avatars[1]?.className).toContain("border-participant-1");
    await click(button ?? undefined);
    expect(window.location.hash).toBe("#/participants");
  });

  it("phones: a compact count button that opens the same sheet", async () => {
    await roomWith([alex, sam], false);
    const button = participantsButton();
    expect(button?.getAttribute("aria-label")).toBe("Participants: 2 people in this session");
    expect(button?.querySelector("[data-avatar]")).toBeNull();
    expect(button?.textContent).toContain("2");
    await click(button ?? undefined);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Participants");
  });

  it("toasts are plain text, polite, don't take focus, and leave the ribbon and the top bar alone", async () => {
    const socket = await roomWith([alex, sam], false);
    const before = document.activeElement;
    await server(socket, { data: { type: "participant_joined", participant: { id: "CCCCCCCCCCCCCCCC", name: "<i>Kai</i>", colourIndex: 2, host: false } } });
    await act(() => new Promise((resolve) => setTimeout(resolve, 1100)));
    const region = document.querySelector<HTMLElement>("[data-presence-toasts]");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.textContent).toContain("<i>Kai</i> joined");
    expect(region?.querySelector("i")).toBeNull();
    expect(document.activeElement).toBe(before);
    // In the board's notice stack (under the top bar, above nothing at the bottom), never in the header.
    expect(region?.closest("header")).toBeNull();
    expect(region?.closest('[role="toolbar"]')).toBeNull();
    expect(region?.querySelector("button")).toBeNull();
  });
});
