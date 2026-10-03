// @vitest-environment happy-dom
import { MAX_NOTES_PER_ROOM, PROTOCOL_VERSION, type Note, type Participant } from "@stickyard/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Starting, joining and using a room, rendered for real. `fetch` and `WebSocket` are
 * replaced by fakes the tests drive by hand.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = `${"a".repeat(22)}.${"B".repeat(22)}`;
const PASSCODE = "test-passcode-in-the-ui";
const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0 };
const sam: Participant = { id: "BBBBBBBBBBBBBBBB", name: "Sam", colourIndex: 9 };

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
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
const lastSocket = () => {
  const s = FakeWebSocket.instances.at(-1);
  if (!s) throw new Error("no socket");
  return s;
};
async function server(socket: FakeWebSocket, event: "open" | "close" | { data: unknown }) {
  await act(async () => {
    if (event === "open") socket.onopen?.();
    else if (event === "close") socket.onclose?.();
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
  it("creates a room, goes to it, clears the passcode, and stores nothing", async () => {
    routes = (url, init) =>
      url.endsWith("/rooms") && init?.method === "POST" ? jsonResponse(200, { code: CODE }) : healthy(url, init);
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

    expect(storageSnapshot()).toBe(before);
    expect(storageSnapshot()).not.toContain(PASSCODE);
    for (const call of setItem.mock.calls) expect(JSON.stringify(call)).not.toContain(PASSCODE);
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
    await server(socket, { data: { type: "joined", you: alex, participants: [alex] } });
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
  await server(socket, { data: { type: "joined", you: alex, participants: [alex, sam] } });
  return socket;
}

describe("the room", () => {
  it("lists participants with a colour dot from the token palette, and always the name", async () => {
    await inRoom();
    const people = [...document.querySelectorAll('[aria-labelledby="people-heading"] li')];
    expect(people.map((li) => li.textContent?.replace(" (you)", ""))).toEqual(["Alex", "Sam"]);
    expect(people[0]?.textContent).toContain("(you)");
    expect(people[0]?.querySelector('[aria-hidden="true"]')?.className).toContain("bg-participant-1");
    // colourIndex 9 → 9 % 8 = 1 → the second palette colour.
    expect(people[1]?.querySelector('[aria-hidden="true"]')?.className).toContain("bg-participant-2");
  });

  it("sends a message with Send and shows echoes", async () => {
    const socket = await inRoom();
    await type(input("Message"), "Hello all");
    await submit(button("Send"));
    expect(socket.sent.at(-1)).toEqual({ type: "say", text: "Hello all" });
    expect(input("Message").value).toBe("");
    await server(socket, { data: { type: "echo", from: alex.id, text: "Hello all" } });
    const list = document.querySelector('[aria-label="Messages"]');
    expect(list?.textContent).toContain("Alex");
    expect(list?.textContent).toContain("Hello all");
  });

  it("renders echoed text and names as plain text, never HTML", async () => {
    const socket = await inRoom();
    const evil = '<img src=x onerror="alert(1)"><b>bold</b>';
    await server(socket, { data: { type: "participant_joined", participant: { id: "CCCCCCCCCCCCCCCC", name: "<i>Kai</i>", colourIndex: 2 } } });
    await server(socket, { data: { type: "echo", from: "CCCCCCCCCCCCCCCC", text: evil } });
    const list = document.querySelector('[aria-label="Messages"]');
    expect(list?.textContent).toContain(evil);
    expect(list?.textContent).toContain("<i>Kai</i>");
    expect(document.querySelector("img")).toBeNull();
    expect(list?.querySelector("b, i")).toBeNull();
  });

  it("announces joins and leaves in a live region", async () => {
    const socket = await inRoom();
    const live = () => [...document.querySelectorAll('[aria-live="polite"]')].map((e) => e.textContent).join(" ");
    await server(socket, { data: { type: "participant_joined", participant: { id: "CCCCCCCCCCCCCCCC", name: "Kai", colourIndex: 2 } } });
    expect(live()).toContain("Kai joined");
    await server(socket, { data: { type: "participant_left", id: sam.id } });
    expect(live()).toContain("Sam left");
  });

  it("Copy link copies the page's own room link", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await inRoom();
    await click(button("Copy link"));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/#/room/${CODE}`);
  });

  it("Leave closes the socket and goes home", async () => {
    const socket = await inRoom();
    await click(button("Leave"));
    expect(socket.closed).toBe(true);
    expect(window.location.hash).toBe("#/");
  });

  it("a dropped connection says so and offers to rejoin", async () => {
    const socket = await inRoom();
    await server(socket, "close");
    expect(alertText()).toMatch(/connection lost/i);
    await click(button("Rejoin"));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("opening Help keeps you in the room, and closing it returns to the room", async () => {
    const socket = await inRoom();
    await click(document.querySelector<HTMLElement>('[aria-label^="Menu"]') ?? undefined);
    await click(byText('[role="menuitem"]', "Help"));
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Help");
    expect(socket.closed).toBe(false);
    expect(document.querySelector('[aria-labelledby="people-heading"]')).not.toBeNull();
  });
});

describe("the board", () => {
  const N1 = "NNNNNNNNNNNNNNN1";
  const one: Note = { id: N1, x: 40, y: 60, text: "Idea one", color: "yellow", rev: 1, authorId: sam.id };
  const notes = () => [...document.querySelectorAll<HTMLElement>('[aria-roledescription="note"]')];
  const sentOfType = (socket: FakeWebSocket, type: string) =>
    (socket.sent as Record<string, unknown>[]).filter((m) => m.type === type);
  const textarea = () => dialog()?.querySelector("textarea") ?? null;
  async function typeArea(value: string) {
    const el = textarea();
    if (!el) throw new Error("no editor");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
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
    expect(notes()[0]?.style.transform).toBe("translate(40px, 60px)");
  });

  it("Add note sends noteAdd with the chosen colour and opens the editor; Enter saves", async () => {
    const socket = await withNotes();
    await click(document.querySelector<HTMLElement>('[role="radio"][aria-label="Blue"]') ?? undefined);
    await click(document.querySelector<HTMLElement>('[aria-label="Add note"]') ?? undefined);
    const [add] = sentOfType(socket, "noteAdd");
    expect(add).toMatchObject({ color: "blue", text: "" });
    expect(notes()).toHaveLength(1);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Edit note");
    await server(socket, {
      data: { type: "noteAdded", clientRef: add?.clientRef, note: { ...one, color: "blue", text: "", authorId: alex.id } },
    });
    await typeArea("Idea one");
    await key(textarea(), "Enter");
    await settle();
    expect(sentOfType(socket, "noteEdit")).toEqual([{ type: "noteEdit", id: N1, text: "Idea one" }]);
    expect(dialog()).toBeNull();
    expect(notes()[0]?.textContent).toBe("Idea one");
  });

  it("Shift+Enter doesn't save (it's a new line)", async () => {
    const socket = await withNotes(one);
    await key(notes()[0], "Enter");
    await typeArea("Idea one\nmore");
    await key(textarea(), "Enter", { shiftKey: true });
    expect(dialog()).not.toBeNull();
    expect(sentOfType(socket, "noteEdit")).toEqual([]);
  });

  it("a remote edit while typing doesn't replace the draft", async () => {
    const socket = await withNotes(one);
    await key(notes()[0], "Enter");
    await typeArea("My draft");
    await server(socket, { data: { type: "noteUpdated", note: { ...one, text: "Remote text", rev: 2 } } });
    expect(textarea()?.value).toBe("My draft");
    await click(byText("button", "Done"));
    expect(sentOfType(socket, "noteEdit").at(-1)).toEqual({ type: "noteEdit", id: N1, text: "My draft" });
  });

  it("arrow keys move a note, then commit the position", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await withNotes(one);
    await key(notes()[0], "ArrowRight");
    await key(notes()[0], "ArrowDown", { shiftKey: true });
    expect(notes()[0]?.style.transform).toBe("translate(50px, 110px)");
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
