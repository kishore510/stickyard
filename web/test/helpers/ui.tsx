import { FRAME_DEFAULTS, NOTE_DEFAULTS, PROTOCOL_VERSION, shapeDefaults, type Frame, type Note, type Participant, type Shape, type ShapeKind } from "@stickyard/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

/*
 * Rendering the app for real with a fake WebSocket and fetch (the same approach as
 * roomsUi.test.tsx, shared here for newer UI test files). Call `installUi()` in beforeEach and
 * `cleanupUi()` in afterEach.
 */

export const CODE = `${"a".repeat(22)}.${"B".repeat(22)}`;
export const ROOM_ID = CODE.split(".")[0]!;
/** A fake host token (43 base64url characters), never a real one. */
export const HOST_TOKEN = "fakeHostToken".padEnd(43, "x");
export const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0, host: false };
export const sam: Participant = { id: "BBBBBBBBBBBBBBBB", name: "Sam", colourIndex: 1, host: false };

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
  }
  ofType(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

export const lastSocket = () => {
  const s = FakeWebSocket.instances.at(-1);
  if (!s) throw new Error("no socket");
  return s;
};

export async function server(socket: FakeWebSocket, event: "open" | "close" | { close: number } | { data: unknown }) {
  await act(async () => {
    if (event === "open") socket.onopen?.();
    else if (event === "close") socket.onclose?.({ code: 1006 });
    else if ("close" in event) socket.onclose?.({ code: event.close });
    else socket.onmessage?.({ data: JSON.stringify(event.data) });
  });
}

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const healthy = (url: string) => (url.endsWith("/health") ? jsonResponse(200, { ok: true, protocolVersion: PROTOCOL_VERSION }) : jsonResponse(404, {}));

let root: Root | undefined;
let wide = false;
const mediaListeners = new Set<() => void>();
let reducedMotion = false;

/** Phone layout by default; true = every min-width query matches (a 1280px window). */
export function setWide(value: boolean) {
  wide = value;
  for (const listener of mediaListeners) listener();
}

export function setReducedMotion(value: boolean) {
  reducedMotion = value;
  for (const listener of mediaListeners) listener();
}

const fakeMatchMedia = (query: string) => ({
  get matches() {
    if (query.includes("prefers-reduced-motion")) return reducedMotion;
    return wide && query.includes("min-width");
  },
  media: query,
  addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
  removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
});

export function installUi() {
  localStorage.clear();
  sessionStorage.clear();
  FakeWebSocket.instances = [];
  wide = false;
  reducedMotion = false;
  mediaListeners.clear();
  vi.stubGlobal("matchMedia", fakeMatchMedia);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", (url: string) => Promise.resolve(healthy(url)));
}

export async function cleanupUi() {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

export const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

export async function mount(hash = "#/") {
  window.history.replaceState(null, "", `/${hash}`);
  vi.resetModules();
  const { App } = await import("../../src/App");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<App />));
  await settle();
}

export const byText = (selector: string, text: string | RegExp, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLElement>(selector)].find((el) => (typeof text === "string" ? el.textContent?.trim() === text : text.test(el.textContent ?? "")));
export const button = (text: string | RegExp, root: ParentNode = document) => byText("button", text, root);
/** A button by its accessible name (aria-label), anywhere or inside `root`. */
export const named = (label: string, root: ParentNode = document) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? undefined;

export function input(label: string) {
  const l = byText("label", label);
  const id = l?.getAttribute("for");
  const el = id ? document.getElementById(id) : l?.querySelector("input");
  if (!(el instanceof HTMLInputElement)) throw new Error(`no input labelled ${label}`);
  return el;
}

export async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function click(el: HTMLElement | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => el.click());
  await settle();
}

export async function submit(el: HTMLElement | null | undefined) {
  const form = el?.closest("form");
  if (!form) throw new Error("no form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

/**
 * Opens the room and joins as Alex: `host` stores the room's token first (so the page claims host)
 * and answers hostGranted. Returns the socket after the snapshots.
 */
export async function inRoom({
  host = false,
  isWide = true,
  locked = false,
  timer = null,
  others = [sam],
  notes = [],
  frames = [],
  shapes = [],
  voting = { state: "off", budget: 5, round: 0 },
}: { host?: boolean; isWide?: boolean; locked?: boolean; timer?: unknown; others?: Participant[]; notes?: Note[]; frames?: Frame[]; shapes?: Shape[]; voting?: unknown } = {}) {
  setWide(isWide);
  if (host) localStorage.setItem(`stickyard:host:${ROOM_ID}`, HOST_TOKEN);
  await mount(`#/room/${CODE}`);
  await type(input("Your name"), "Alex");
  await submit(button("Join"));
  const socket = lastSocket();
  await server(socket, "open");
  await server(socket, { data: { type: "welcome", protocolVersion: PROTOCOL_VERSION } });
  await server(socket, { data: { type: "joined", you: alex, participants: [alex, ...others], locked, timer, voting, silent: { active: false, count: 0 } } });
  if (host) await server(socket, { data: { type: "hostGranted" } });
  await server(socket, { data: { type: "snapshot", notes } });
  await server(socket, { data: { type: "framesSnapshot", frames } });
  await server(socket, { data: { type: "shapesSnapshot", shapes } });
  for (
    let i = 0;
    i < 40 &&
    (!document.querySelector(".react-flow") ||
      document.querySelectorAll('[aria-roledescription="note"]').length < notes.length ||
      document.querySelectorAll("[data-frame-id]").length < frames.length ||
      document.querySelectorAll("[data-shape-id]").length < shapes.length);
    i++
  )
    await settle();
  return socket;
}

/** Visible text and announcements of the timer chip, and its live region. */
export const chip = () => document.querySelector<HTMLElement>("[data-timer-chip]");
export const timerAnnouncer = () => document.querySelector<HTMLElement>("[data-timer-announcer]");

/** A note by Sam at a spot (ids 16 characters, like the relay's). */
export const noteAt = (i: number, extra: Partial<Note> = {}): Note => ({
  id: `NNNNNNNNNNNNNNN${i}`,
  x: 40 + i * 220,
  y: 60,
  ...NOTE_DEFAULTS,
  text: `Idea ${i}`,
  color: "yellow",
  z: i,
  rev: 1,
  authorId: sam.id,
  ...extra,
});

/** A frame by Sam at a spot (ids 16 characters, like the relay's); titles are generic. */
export const frameAt = (i: number, extra: Partial<Frame> = {}): Frame => ({
  id: `FFFFFFFFFFFFFFF${i}`,
  x: 40 + i * 700,
  y: 400,
  w: 640,
  h: 400,
  title: ["To do", "Doing", "Done"][i % 3]!,
  color: "neutral",
  ...FRAME_DEFAULTS,
  rev: 1,
  authorId: sam.id,
  ...extra,
});

/** A shape by Sam (protocol v15) at a spot, a rectangle unless said; ids 16 characters, like the relay's. */
export const shapeAt = (i: number, extra: Partial<Shape> = {}): Shape => {
  const kind: ShapeKind = extra.kind ?? "rect";
  return { id: `SSSSSSSSSSSSSSS${i}`, kind, x: 60 + i * 260, y: 900, ...shapeDefaults(kind), text: `Step ${i}`, z: 50 + i, rev: 1, authorId: sam.id, ...extra };
};
export const shapesShown = () => [...document.querySelectorAll<HTMLElement>('[aria-roledescription="shape"]')];

export const notesShown = () => [...document.querySelectorAll<HTMLElement>('[aria-roledescription="note"]')];
export const boardBar = () => document.querySelector<HTMLElement>('header [role="toolbar"][aria-label="Board actions"]');
/** The tooltip a bar command points at (its name, or why it's off). */
export const tipOf = (el: Element | null | undefined) => {
  const id = el?.getAttribute("aria-describedby");
  return id ? document.getElementById(id) : null;
};
export const isOff = (el: Element | null | undefined) => el?.getAttribute("aria-disabled") === "true" || (el as HTMLButtonElement | null | undefined)?.disabled === true;

/** Selects a note with a mouse press and click, as a person would. */
export async function selectNote(i: number) {
  const el = notesShown()[i];
  if (!el) throw new Error("no note");
  await act(async () => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}
