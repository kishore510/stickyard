// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLEAR_FRAME_STEP_MS, ITEMS_STEP_MS } from "../src/rooms/session";
import { fid, frame, nid, note, room, shape, sid } from "./helpers/fakeRelay";
import { deleteKeyTarget } from "../src/canvas/deleteKey";
import { cleanupUi, frameAt, inRoom, installUi, noteAt, notesShown, settle, shapeAt, shapesShown, type FakeWebSocket } from "./helpers/ui";

/*
 * Ctrl+A then Delete takes everything that can be put on the board (notes, frames, shapes; a
 * template is frames), wherever focus is on the board or its side panels: on the page, on a
 * focused note or shape, on a palette tile (after dragging one onto the board) or in Properties.
 * One confirm, then everything goes. Generic text.
 */

const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
const palette = () => document.querySelector<HTMLElement>('aside[aria-label="Palette"]');
const heading = () => properties()?.querySelector("h3")?.textContent ?? "";

async function key(k: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

const everything = {
  notes: [noteAt(0), noteAt(1, { x: 100, y: 500 })],
  frames: [frameAt(0), frameAt(1)],
  shapes: [shapeAt(0), shapeAt(1, { kind: "text", text: "" })],
};

/** Everything named in one confirm, then deleted: notes and shapes in batches, frames one by one. */
async function expectAllDeleted(socket: FakeWebSocket, ask: ReturnType<typeof vi.fn>) {
  await act(() => new Promise((resolve) => setTimeout(resolve, CLEAR_FRAME_STEP_MS * 4)));
  await settle();
  expect(ask).toHaveBeenCalledTimes(1);
  expect(ask.mock.calls[0]?.[0]).toMatch(/^Delete 2 notes, 2 frames and 2 shapes\?/);
  expect(socket.ofType("noteBatch").flatMap((m) => (m.ops as { id: string }[]).map((o) => o.id)).sort()).toEqual([noteAt(0).id, noteAt(1).id].sort());
  expect(socket.ofType("shapeBatch").flatMap((m) => (m.ops as { id: string }[]).map((o) => o.id)).sort()).toEqual([shapeAt(0).id, shapeAt(1).id].sort());
  expect(socket.ofType("frameDelete").map((m) => m.id).sort()).toEqual([frameAt(0).id, frameAt(1).id].sort());
  // Nothing else deleted twice, nothing sent one by one.
  expect(socket.ofType("noteDelete")).toEqual([]);
  expect(socket.ofType("shapeDelete")).toEqual([]);
  expect(heading()).toBe("Board");
}

beforeEach(installUi);
afterEach(async () => {
  vi.useRealTimers();
  await cleanupUi();
});

/** In a room (frame deletes are paced in real time: CLEAR_FRAME_STEP_MS each). */
async function start(options: Parameters<typeof inRoom>[0]) {
  return inRoom(options);
}

describe("Ctrl+A selects every object on the board", () => {
  it("notes, frames and shapes (a template's frames too)", async () => {
    await start(everything);
    await key("a", document.body, { ctrlKey: true });
    expect(heading()).toBe("2 notes, 2 frames, 2 shapes selected");
  });

  it("from a focused note, a focused shape or a palette tile as well", async () => {
    await start(everything);
    for (const from of [() => notesShown()[0], () => shapesShown()[0], () => palette()?.querySelector("button")]) {
      await key("Escape");
      const el = from()!;
      await act(async () => (el as HTMLElement).focus());
      await key("a", el, { ctrlKey: true });
      expect(heading()).toBe("2 notes, 2 frames, 2 shapes selected");
    }
  });

  it("Cmd+A on a Mac too", async () => {
    await start(everything);
    await key("a", document.body, { metaKey: true });
    expect(heading()).toBe("2 notes, 2 frames, 2 shapes selected");
  });
});

describe("then Delete deletes all of it", () => {
  it("with focus on the page", async () => {
    const ask = vi.fn((_m?: string) => true);
    window.confirm = ask;
    const socket = await start(everything);
    await key("a", document.body, { ctrlKey: true });
    await key("Delete");
    await expectAllDeleted(socket, ask);
  });

  it("with focus on a note (its own Delete takes the whole selection, frames and shapes included)", async () => {
    const ask = vi.fn((_m?: string) => true);
    window.confirm = ask;
    const socket = await start(everything);
    const note = notesShown()[0]!;
    await act(async () => note.focus());
    await key("a", note, { ctrlKey: true });
    await key("Delete", note);
    await expectAllDeleted(socket, ask);
  });

  it("with focus on a shape (Backspace too)", async () => {
    const ask = vi.fn((_m?: string) => true);
    window.confirm = ask;
    const socket = await start(everything);
    const shape = shapesShown()[0]!;
    await act(async () => shape.focus());
    await key("a", shape, { ctrlKey: true });
    await key("Backspace", shape);
    await expectAllDeleted(socket, ask);
  });

  it("with focus on a palette tile (as after dragging one onto the board)", async () => {
    const ask = vi.fn((_m?: string) => true);
    window.confirm = ask;
    const socket = await start(everything);
    const tile = palette()!.querySelector<HTMLElement>("[data-palette-item]")!;
    await act(async () => tile.focus());
    await key("a", tile, { ctrlKey: true });
    await key("Delete", tile);
    await expectAllDeleted(socket, ask);
  });

  it("with focus on a button in Properties", async () => {
    const ask = vi.fn((_m?: string) => true);
    window.confirm = ask;
    const socket = await start(everything);
    await key("a", document.body, { ctrlKey: true });
    const button = properties()!.querySelector<HTMLElement>("button")!;
    await act(async () => button.focus());
    await key("Delete", button);
    await expectAllDeleted(socket, ask);
  });

  it("No in the confirm deletes nothing and keeps the selection", async () => {
    window.confirm = () => false;
    const socket = await start(everything);
    await key("a", document.body, { ctrlKey: true });
    await key("Delete");
    expect([...socket.ofType("noteBatch"), ...socket.ofType("shapeBatch"), ...socket.ofType("frameDelete")]).toEqual([]);
    expect(heading()).toBe("2 notes, 2 frames, 2 shapes selected");
  });
});

describe("one Undo brings everything back (session)", () => {
  it("notes, frames and shapes deleted together are restored by one undo", () => {
    vi.useFakeTimers();
    const t = room([note(1), note(2)], [frame(1), frame(2)], {}, undefined, [shape(1), shape(2)]);
    expect(t.session.deleteSelection([nid(1), nid(2)], [fid(1), fid(2)], [sid(1), sid(2)])).toBe(true);
    vi.advanceTimersByTime(CLEAR_FRAME_STEP_MS * 4);
    expect([t.relay.notes.size, t.relay.frames.size, t.relay.shapes.size]).toEqual([0, 0, 0]);
    t.session.undo();
    vi.advanceTimersByTime(ITEMS_STEP_MS * 5);
    expect([t.relay.notes.size, t.relay.frames.size, t.relay.shapes.size]).toEqual([2, 2, 2]);
  });
});

describe("a lone item selected by Ctrl+A", () => {
  it("a board with one frame: Ctrl+A then Delete deletes the frame (asking, as it has a title)", async () => {
    const ask = vi.fn((_m?: string) => true);
    window.confirm = ask;
    const socket = await start({ frames: [frameAt(0)] });
    await key("a", document.body, { ctrlKey: true });
    await key("Delete");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(socket.ofType("frameDelete")).toEqual([{ type: "frameDelete", id: frameAt(0).id }]);
  });

  it("a board with one shape: Ctrl+A then Delete deletes it", async () => {
    window.confirm = () => true;
    const socket = await start({ shapes: [shapeAt(0)] });
    await key("a", document.body, { ctrlKey: true });
    await key("Delete");
    expect(socket.ofType("shapeDelete")).toEqual([{ type: "shapeDelete", id: shapeAt(0).id }]);
  });
});

describe("the Delete key's scope (pure)", () => {
  const ev = (target: EventTarget | null) => ({ key: "Delete", target, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false });
  it("the side panels (Palette, Properties) count as the board; other controls don't", () => {
    const board = document.createElement("section");
    const side = document.createElement("aside");
    side.setAttribute("data-side-panel", "");
    const tile = document.createElement("button");
    side.append(tile);
    const field = document.createElement("input");
    side.append(field);
    const other = document.createElement("button");
    document.body.append(board, side, other);
    const state = { multi: true, selection: 2, frameSelected: false, frames: 1, shapes: 1, modal: false, board };
    expect(deleteKeyTarget(ev(tile), state)).toBe("selection");
    expect(deleteKeyTarget(ev(field), state)).toBeNull();
    expect(deleteKeyTarget(ev(other), state)).toBeNull();
  });
});
