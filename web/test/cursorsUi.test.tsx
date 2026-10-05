// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, memo, type FunctionComponent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Participant } from "@stickyard/shared";
import { alex, cleanupUi, click, inRoom, installUi, noteAt, sam, server, settle, type FakeWebSocket } from "./helpers/ui";

/*
 * Live cursors in the page (v0.19.0): sending from the board (md and up, mouse or hovering pen),
 * drawing others' pointers in a layer of their own, and the two switches in Participants.
 */

const renders = vi.hoisted(() => ({ notes: 0 }));
vi.mock("../src/notes/NoteCard", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/notes/NoteCard")>();
  const original = mod.NoteNode as unknown as { type: FunctionComponent<Record<string, unknown>>; compare?: (a: object, b: object) => boolean };
  const Counted = memo((props: Record<string, unknown>) => {
    renders.notes++;
    return createElement(original.type, props);
  }, original.compare ?? undefined);
  return { ...mod, NoteNode: Counted };
});

beforeEach(installUi);
afterEach(cleanupUi);

const board = () => document.querySelector<HTMLElement>('section[aria-label="Board"]')!;
const marks = () => [...document.querySelectorAll<HTMLElement>("[data-cursor]")];

async function pointer(type: string, init: { x?: number; y?: number; pointerType?: string; buttons?: number } = {}, target: EventTarget = board()) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: init.x ?? 200, clientY: init.y ?? 150, pointerType: init.pointerType ?? "mouse", buttons: init.buttons ?? 0 }));
  });
}
/** Lets the 100 ms throttle pass. */
const tick = () => act(() => new Promise((r) => setTimeout(r, 120)));

async function cursorFrom(socket: FakeWebSocket, p: Participant, x = 300, y = 200) {
  await server(socket, { data: { type: "cursorMoved", id: p.id, x, y } });
}

describe("sending", () => {
  it("a mouse moving over the board sends cursor (whole board units), throttled", async () => {
    const socket = await inRoom();
    await pointer("pointermove", { x: 200, y: 150 });
    await pointer("pointermove", { x: 210, y: 160 });
    expect(socket.ofType("cursor")).toHaveLength(1);
    await tick();
    const sent = socket.ofType("cursor");
    expect(sent).toHaveLength(2);
    for (const m of sent) {
      expect(Number.isInteger(m.x)).toBe(true);
      expect(Number.isInteger(m.y)).toBe(true);
    }
  });

  it("touch never sends, and a pen only while hovering (a tap never sends)", async () => {
    const socket = await inRoom();
    await pointer("pointermove", { pointerType: "touch", buttons: 1 });
    await pointer("pointermove", { pointerType: "touch", x: 260 });
    await pointer("pointermove", { pointerType: "pen", buttons: 1, x: 280 });
    expect(socket.ofType("cursor")).toEqual([]);
    await pointer("pointermove", { pointerType: "pen", buttons: 0, x: 300 });
    expect(socket.ofType("cursor")).toHaveLength(1);
  });

  it("phones never send, whatever the pointer", async () => {
    const socket = await inRoom({ isWide: false });
    await pointer("pointermove", { pointerType: "mouse" });
    await pointer("pointermove", { pointerType: "pen" });
    expect(socket.ofType("cursor")).toEqual([]);
  });

  it("nobody else here: nothing is sent", async () => {
    const socket = await inRoom({ others: [] });
    await pointer("pointermove");
    expect(socket.ofType("cursor")).toEqual([]);
  });

  it("cursorLeft when the pointer leaves the board area and when the window loses focus", async () => {
    const socket = await inRoom();
    await pointer("pointermove");
    await pointer("pointerleave");
    expect(socket.ofType("cursorLeft")).toHaveLength(1);
    await pointer("pointermove", { x: 260 });
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(socket.ofType("cursorLeft")).toHaveLength(2);
    // Leaving again with nothing shown sends nothing more.
    await pointer("pointerleave");
    expect(socket.ofType("cursorLeft")).toHaveLength(2);
  });

  it("Share my cursor off (remembered): nothing is sent", async () => {
    localStorage.setItem("stickyard:share-cursor", "off");
    const socket = await inRoom();
    await pointer("pointermove");
    expect(socket.ofType("cursor")).toEqual([]);
  });
});

describe("drawing", () => {
  it("others' cursors in their colour, with their name as plain text; decorative only", async () => {
    const evil: Participant = { id: "EEEEEEEEEEEEEEEE", name: "<img src=x>", colourIndex: 2, host: false };
    const socket = await inRoom({ others: [sam, evil] });
    await cursorFrom(socket, sam);
    await cursorFrom(socket, evil, 500, 400);
    const shown = marks();
    expect(shown).toHaveLength(2);
    const samMark = shown.find((m) => m.textContent === "Sam")!;
    expect(samMark).toBeDefined();
    expect(samMark.querySelector("[data-cursor-label]")?.className).toMatch(/bg-participant-2/);
    expect(document.querySelector("img")).toBeNull();
    expect(shown.some((m) => m.textContent === "<img src=x>")).toBe(true);
    const layer = document.querySelector<HTMLElement>("[data-cursor-layer]")!;
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.className).toMatch(/pointer-events-none/);
    // Counter-scaled so it keeps its screen size at any zoom.
    expect(samMark.style.transform).toMatch(/translate\(.+\) scale\(.+\)/);
  });

  it("never my own cursor, never an unknown participant's", async () => {
    const socket = await inRoom();
    await cursorFrom(socket, alex);
    await server(socket, { data: { type: "cursorMoved", id: "ZZZZZZZZZZZZZZZZ", x: 1, y: 1 } });
    expect(marks()).toEqual([]);
  });

  it("removed on cursorGone and when they leave", async () => {
    const socket = await inRoom();
    await cursorFrom(socket, sam);
    expect(marks()).toHaveLength(1);
    await server(socket, { data: { type: "cursorGone", id: sam.id } });
    expect(marks()).toEqual([]);
    await cursorFrom(socket, sam);
    await server(socket, { data: { type: "participant_left", id: sam.id } });
    expect(marks()).toEqual([]);
  });

  it("cleared when the connection drops", async () => {
    const socket = await inRoom();
    await cursorFrom(socket, sam);
    await server(socket, "close");
    expect(marks()).toEqual([]);
  });

  it("moving cursors never re-render note cards", async () => {
    const socket = await inRoom({ notes: [noteAt(1), noteAt(2), noteAt(3)] });
    await settle();
    const before = renders.notes;
    expect(before).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) await cursorFrom(socket, sam, 100 + i * 10, 100);
    await server(socket, { data: { type: "cursorGone", id: sam.id } });
    expect(renders.notes).toBe(before);
  });

  it("phones draw others' cursors too, with the smaller label", async () => {
    const socket = await inRoom({ isWide: false });
    await cursorFrom(socket, sam);
    expect(marks()).toHaveLength(1);
    expect(marks()[0]!.hasAttribute("data-compact")).toBe(true);
  });

  it("motion comes from tokens (0 under reduced motion), and idle cursors fade", () => {
    const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");
    const rule = css.slice(css.indexOf(".sy-cursor {"));
    expect(rule.slice(0, rule.indexOf("}"))).toMatch(/transition:[^;]*var\(--sy-duration-cursor\)/);
    expect(css).toMatch(/\.sy-cursor-idle\s*\{[^}]*opacity:\s*0/);
    expect(css).toMatch(/opacity var\(--sy-cursor-fade\)/);
  });
});

describe("the switches in Participants", () => {
  const toggle = (label: string) =>
    [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][role="switch"]')].find((el) => el.closest("label")?.textContent?.includes(label));

  async function openParticipants() {
    await click(document.querySelector<HTMLElement>('header [aria-label^="Participants"]') ?? undefined);
  }

  it("both are on by default; turning Show off hides cursors and is remembered", async () => {
    const socket = await inRoom();
    await cursorFrom(socket, sam);
    await openParticipants();
    const show = toggle("Show other people’s cursors")!;
    const share = toggle("Share my cursor")!;
    expect(show.checked).toBe(true);
    expect(share.checked).toBe(true);
    await click(show);
    expect(localStorage.getItem("stickyard:show-cursors")).toBe("off");
    expect(marks()).toEqual([]);
    // Still received (the relay keeps sending), just not drawn.
    await cursorFrom(socket, sam, 400, 300);
    expect(marks()).toEqual([]);
    await click(show);
    expect(marks()).toHaveLength(1);
  });

  it("turning Share off sends cursorLeft for a shown cursor, then nothing; remembered", async () => {
    const socket = await inRoom();
    await pointer("pointermove");
    expect(socket.ofType("cursor")).toHaveLength(1);
    await openParticipants();
    await click(toggle("Share my cursor"));
    expect(localStorage.getItem("stickyard:share-cursor")).toBe("off");
    expect(socket.ofType("cursorLeft")).toHaveLength(1);
    await tick();
    await pointer("pointermove", { x: 400 }, board());
    expect(socket.ofType("cursor")).toHaveLength(1);
  });

  it("a stored Show off draws nothing from the start", async () => {
    localStorage.setItem("stickyard:show-cursors", "off");
    const socket = await inRoom();
    await cursorFrom(socket, sam);
    expect(marks()).toEqual([]);
  });
});
