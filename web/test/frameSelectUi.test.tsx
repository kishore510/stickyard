// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
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
