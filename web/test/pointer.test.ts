import { describe, expect, it } from "vitest";
import { dragSelection, noteClick, paneGesture } from "../src/canvas/pointer";
import { EMPTY_SELECTION, selectOnly, toggleSelected } from "../src/canvas/selection";

/*
 * Slice 2.8: what a press does, decided by pointer type (never screen size or user agent).
 * Mouse: left-drag on empty canvas draws a marquee, right- and middle-drag pan. Touch and pen:
 * a drag on empty canvas pans. Hand or Space: every drag pans.
 */

const press = (pointerType: string, button: number, extra: Partial<Parameters<typeof paneGesture>[0]> = {}) =>
  paneGesture({ pointerType, button, tool: "select", spaceHeld: false, ...extra });

describe("paneGesture", () => {
  it("mouse: left draws a marquee, middle and right pan", () => {
    expect(press("mouse", 0)).toBe("marquee");
    expect(press("mouse", 1)).toBe("pan");
    expect(press("mouse", 2)).toBe("pan");
  });

  it("mouse with Hand or Space held: left pans too", () => {
    expect(press("mouse", 0, { tool: "hand" })).toBe("pan");
    expect(press("mouse", 0, { spaceHeld: true })).toBe("pan");
    expect(press("mouse", 2, { tool: "hand" })).toBe("pan");
  });

  it("touch and pen pan with one finger or the tip, never a marquee", () => {
    expect(press("touch", 0)).toBe("pan");
    expect(press("pen", 0)).toBe("pan");
    expect(press("touch", 0, { tool: "hand" })).toBe("pan");
  });

  it("other buttons (back, forward) and unknown pointers are left alone; an empty type counts as mouse", () => {
    expect(press("mouse", 3)).toBe("ignore");
    expect(press("mouse", 4)).toBe("ignore");
    expect(press("", 0)).toBe("marquee");
    expect(press("pen", 5)).toBe("ignore");
  });
});

describe("noteClick", () => {
  it("Shift, Ctrl or Cmd toggles; a plain click selects just that note", () => {
    expect(noteClick({ shiftKey: true, ctrlKey: false, metaKey: false })).toBe("toggle");
    expect(noteClick({ shiftKey: false, ctrlKey: true, metaKey: false })).toBe("toggle");
    expect(noteClick({ shiftKey: false, ctrlKey: false, metaKey: true })).toBe("toggle");
    expect(noteClick({ shiftKey: false, ctrlKey: false, metaKey: false })).toBe("only");
  });
});

describe("dragSelection", () => {
  const two = toggleSelected(selectOnly(EMPTY_SELECTION, "a"), "b");

  it("dragging a selected note moves the whole selection (the same set)", () => {
    expect(dragSelection(two, "b")).toBe(two);
  });

  it("dragging an unselected note selects only it", () => {
    expect([...dragSelection(two, "c")]).toEqual(["c"]);
    expect([...dragSelection(EMPTY_SELECTION, "c")]).toEqual(["c"]);
  });
});
