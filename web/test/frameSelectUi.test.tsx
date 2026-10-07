// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupUi, frameAt, inRoom, installUi, noteAt, notesShown, selectNote, settle } from "./helpers/ui";

/*
 * Frame multi-select in the page (md and up): Shift/Ctrl/Cmd-click on a frame's header toggles
 * it, Ctrl+A takes every note and frame, selected frames get the outline and the tick badge, and
 * Properties sums up a mixed selection.
 */

const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
const heading = () => properties()?.querySelector("h3")?.textContent ?? "";
const frameEl = (i: number) => document.querySelectorAll<HTMLElement>("[data-frame-id]")[i];
const header = (i: number) => frameEl(i)?.querySelector<HTMLElement>("[data-frame-handle='header']") ?? null;

async function clickHeader(i: number, init: MouseEventInit = {}) {
  const el = header(i);
  if (!el) throw new Error("no header");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

async function key(k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

beforeEach(installUi);
afterEach(cleanupUi);

describe("selecting frames with notes (md and up)", () => {
  it("Shift-click on a frame header adds it to a note selection; Ctrl-click toggles it off; a plain click selects just it", async () => {
    await inRoom({ notes: [noteAt(0)], frames: [frameAt(0), frameAt(1)] });
    await selectNote(0);
    await clickHeader(0, { shiftKey: true });
    expect(heading()).toBe("1 note, 1 frame selected");
    expect(frameEl(0)?.className).toContain("sy-selected");
    await clickHeader(1, { metaKey: true });
    expect(heading()).toBe("1 note, 2 frames selected");
    await clickHeader(0, { ctrlKey: true });
    expect(heading()).toBe("1 note, 1 frame selected");
    await clickHeader(0);
    expect(heading()).toBe("Frame");
    expect(notesShown()[0]?.getAttribute("aria-current")).toBeNull();
  });

  it("2+ items: selected frames get the tick badge too, and the dashed box goes round notes and frames", async () => {
    await inRoom({ notes: [noteAt(0)], frames: [frameAt(0)] });
    await selectNote(0);
    expect(frameEl(0)?.parentElement?.querySelector("[data-select-badge]")).toBeNull();
    await clickHeader(0, { shiftKey: true });
    const node = frameEl(0)?.closest(".react-flow__node");
    expect(node?.querySelector("[data-select-badge]")).not.toBeNull();
    const box = document.querySelector<HTMLElement>("[data-selection-box]");
    expect(box).not.toBeNull();
    // From the note's top-left (40, 60) to the frame's bottom-right (680, 800).
    expect(box?.style.left).toContain("40px");
    expect(box?.style.top).toContain("60px");
    expect(box?.style.width).toContain("640px");
    expect(box?.style.height).toContain("740px");
  });

  it("Ctrl+A selects every note and frame; Properties sums it up with Delete", async () => {
    await inRoom({ notes: [noteAt(0), noteAt(1), noteAt(2)], frames: [frameAt(0), frameAt(1)] });
    await key("a", { ctrlKey: true });
    expect(heading()).toBe("3 notes, 2 frames selected");
    expect(properties()?.querySelector('button[aria-label="Delete 3 notes and 2 frames"]')).not.toBeNull();
    expect(document.querySelectorAll(".react-flow__node-frame [data-select-badge]")).toHaveLength(2);
    await key("Escape");
    expect(heading()).toBe("Board");
  });

  it("two frames alone: the summary says so", async () => {
    await inRoom({ frames: [frameAt(0), frameAt(1)] });
    await clickHeader(0);
    await clickHeader(1, { shiftKey: true });
    expect(heading()).toBe("2 frames selected");
  });

  it("phones: frames aren't selectable, so Ctrl+A and clicks change nothing for them", async () => {
    await inRoom({ isWide: false, frames: [frameAt(0)] });
    await clickHeader(0, { shiftKey: true }).catch(() => undefined);
    expect(frameEl(0)?.className).not.toContain("sy-selected");
  });
});

describe("deleting and moving a selection with frames (md and up)", () => {
  it("Delete after Ctrl+A asks once with the counts, then deletes the notes in a batch and the frames one by one", async () => {
    const ask = vi.fn(() => true);
    vi.stubGlobal("confirm", ask);
    // Note 0 (40, 60) isn't inside the frame; note 1 sits inside frame 0 (40..680, 400..800).
    const socket = await inRoom({ notes: [noteAt(0), noteAt(1, { x: 100, y: 500 })], frames: [frameAt(0)] });
    await key("a", { ctrlKey: true });
    await key("Delete");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith("Delete 2 notes and 1 frame? They’re removed for everyone in the session.");
    expect(socket.ofType("noteBatch")).toEqual([{ type: "noteBatch", ops: [{ op: "delete", id: noteAt(0).id }, { op: "delete", id: noteAt(1).id }], final: true }]);
    expect(socket.ofType("frameDelete")).toEqual([{ type: "frameDelete", id: frameAt(0).id }]);
    expect(heading()).toBe("Board");
  });

  it("the confirmation counts the unselected notes inside the frames that stay", async () => {
    const ask = vi.fn(() => false);
    vi.stubGlobal("confirm", ask);
    const socket = await inRoom({ notes: [noteAt(0), noteAt(1, { x: 100, y: 500 })], frames: [frameAt(0), frameAt(1)] });
    await clickHeader(0);
    await clickHeader(1, { shiftKey: true });
    await key("Delete");
    expect(ask).toHaveBeenCalledWith("Delete 2 frames? They’re removed for everyone in the session. 1 note inside the frames isn’t selected and stays on the board.");
    expect(socket.ofType("frameDelete")).toEqual([]);
    expect(heading()).toBe("2 frames selected");
  });

  it("arrow keys move selected frames with the notes inside, committed shortly after the last press", async () => {
    const socket = await inRoom({ notes: [noteAt(0), noteAt(1, { x: 100, y: 500 })], frames: [frameAt(0), frameAt(1)] });
    await clickHeader(0);
    await clickHeader(1, { shiftKey: true });
    await key("ArrowRight");
    await key("ArrowDown", { shiftKey: true });
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
    const final = socket.ofType("frameMove").filter((m) => m.final);
    expect(final).toEqual([
      { type: "frameMove", id: frameAt(0).id, x: 50, y: 450, final: true, noteIds: [noteAt(1).id] },
      { type: "frameMove", id: frameAt(1).id, x: 750, y: 450, final: true },
    ]);
  });
});

describe("arrange, Properties and Duplicate for frames (md and up)", () => {
  const bar = () => document.querySelector<HTMLElement>('header [role="toolbar"][aria-label="Board actions"]');
  const barButton = (label: string) => bar()?.querySelector<HTMLElement>(`[aria-label="${label}"]`) ?? null;

  it("two frames: Colour applies to both (one frameEdit each), Title shows Mixed and is off, Width/Height point to Match size", async () => {
    const socket = await inRoom({ frames: [frameAt(0), frameAt(1, { color: "blue" })] });
    await clickHeader(0);
    await clickHeader(1, { shiftKey: true });
    const title = properties()?.querySelector<HTMLInputElement>('input[name="frameTitle"]');
    expect(title?.disabled).toBe(true);
    expect(title?.placeholder).toBe("Mixed");
    expect(properties()?.querySelector<HTMLInputElement>('input[name="frameWidth"]')?.disabled).toBe(true);
    expect(properties()?.querySelector("[data-frames-size-hint]")?.textContent).toContain("Use Match size");
    const green = properties()?.querySelector<HTMLElement>('[aria-label="Frame colour"] button[aria-label="Green"]');
    await act(async () => green?.click());
    await act(() => new Promise((resolve) => setTimeout(resolve, 120)));
    expect(socket.ofType("frameEdit")).toEqual([
      { type: "frameEdit", id: frameAt(0).id, color: "green" },
      { type: "frameEdit", id: frameAt(1).id, color: "green" },
    ]);
  });

  it("a mix of notes and frames: arrange is off with the reason shown as text; Order still acts on the notes", async () => {
    await inRoom({ notes: [noteAt(0)], frames: [frameAt(0)] });
    await selectNote(0);
    await clickHeader(0, { shiftKey: true });
    expect(document.querySelector("[data-arrange-reason]")?.textContent).toBe("Arrange works on notes and shapes, or on frames, not both. Select only notes and shapes, or only frames.");
    expect(barButton("Align left edges")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("frames only: Order is off with the reason; Duplicate copies frames and notes together in one itemsAdd", async () => {
    const socket = await inRoom({ notes: [noteAt(0)], frames: [frameAt(0), frameAt(1)] });
    await clickHeader(0);
    await clickHeader(1, { shiftKey: true });
    const front = barButton("Bring to front");
    expect(front?.getAttribute("aria-disabled")).toBe("true");
    const tip = document.getElementById(front?.getAttribute("aria-describedby") ?? "");
    expect(tip?.textContent).toBe("Frames always sit behind notes.");
    await key("a", { ctrlKey: true });
    await key("d", { ctrlKey: true });
    const add = socket.ofType("itemsAdd")[0];
    expect((add?.frames as unknown[]).length).toBe(2);
    expect((add?.notes as unknown[]).length).toBe(1);
    expect(heading()).toBe("1 note, 2 frames selected");
  });
});

