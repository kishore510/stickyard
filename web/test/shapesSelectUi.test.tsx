// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boardBar, cleanupUi, click, frameAt, inRoom, installUi, isOff, noteAt, notesShown, selectNote, settle, shapeAt, shapesShown, tipOf } from "./helpers/ui";
import { LOCK_TEXT } from "../src/facilitation/lock";

/*
 * Text and shapes, part 3, in the page (md and up): shapes in selections with notes and frames
 * (Shift/Ctrl-click, Ctrl+A, the marquee), the selection's look, Delete, Duplicate, Order and
 * arrow keys on a mix, and the lock. Generic text.
 */

const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
const heading = () => properties()?.querySelector("h3")?.textContent ?? "";
const command = (label: string) => boardBar()?.querySelector<HTMLElement>(`button[aria-label="${label}"]`) ?? null;

async function press(el: Element, init: MouseEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 }));
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

async function pointer(target: EventTarget, type: string, init: PointerEventInit) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, ...init }));
  });
}

beforeEach(installUi);
afterEach(cleanupUi);

describe("selecting shapes with notes and frames", () => {
  it("Shift-click adds a shape to a note selection; the summary, ticks and dashed box include it; Ctrl-click takes it out", async () => {
    await inRoom({ notes: [noteAt(0)], shapes: [shapeAt(0)] });
    await selectNote(0);
    await press(shapesShown()[0]!, { shiftKey: true });
    expect(heading()).toBe("1 note, 1 shape selected");
    expect(shapesShown()[0]?.className).toContain("sy-selected");
    expect(shapesShown()[0]?.closest(".react-flow__node")?.querySelector("[data-select-badge]")).not.toBeNull();
    expect(document.querySelector("[data-selection-box]")).not.toBeNull();
    await press(shapesShown()[0]!, { ctrlKey: true });
    expect(heading()).toBe("Yellow note");
  });

  it("Ctrl+A selects every note, frame and shape", async () => {
    await inRoom({ notes: [noteAt(0)], frames: [frameAt(0)], shapes: [shapeAt(0), shapeAt(1, { kind: "text" })] });
    await key("a", document.body, { ctrlKey: true });
    expect(heading()).toBe("1 note, 1 frame, 2 shapes selected");
    expect(properties()?.querySelector('button[aria-label="Delete 1 note, 1 frame and 2 shapes"]')).not.toBeNull();
  });

  it("a marquee takes the shapes it touches (partial overlap), like notes", async () => {
    await inRoom({ shapes: [shapeAt(0), shapeAt(1), shapeAt(2)] });
    const pane = document.querySelector<HTMLElement>(".react-flow__pane")!;
    const [tx, ty, zoom] = (document.querySelector(".react-flow__viewport")?.getAttribute("style") ?? "").match(/-?[\d.]+/g)?.map(Number) ?? [0, 0, 1];
    const at = (x: number, y: number) => ({ clientX: (tx ?? 0) + x * (zoom ?? 1), clientY: (ty ?? 0) + y * (zoom ?? 1) });
    // Shapes 0 and 1 sit at x 60 and 320 (200 wide); the box ends inside shape 1.
    await pointer(pane, "pointerdown", at(0, 850));
    await pointer(window, "pointermove", at(400, 950));
    await pointer(window, "pointerup", at(400, 950));
    await settle();
    expect(heading()).toBe("2 shapes selected");
  });
});

describe("acting on a mix", () => {
  it("Delete asks once with the counts, then deletes notes and shapes together", async () => {
    const socket = await inRoom({ notes: [noteAt(0)], shapes: [shapeAt(0)] });
    const ask = vi.fn((_message?: string) => true);
    window.confirm = ask;
    await key("a", document.body, { ctrlKey: true });
    await key("Delete");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[0]).toMatch(/^Delete 1 note and 1 shape\?/);
    expect(socket.ofType("noteBatch")).toEqual([{ type: "noteBatch", ops: [{ op: "delete", id: noteAt(0).id }], final: true }]);
    expect(socket.ofType("shapeBatch")).toEqual([{ type: "shapeBatch", ops: [{ op: "delete", id: shapeAt(0).id }], final: true }]);
  });

  it("Delete with one shape selected (focus on the page) deletes it, asking first when it has text", async () => {
    const socket = await inRoom({ shapes: [shapeAt(0)] });
    await press(shapesShown()[0]!);
    window.confirm = () => true;
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    await key("Delete");
    expect(socket.ofType("shapeDelete")).toEqual([{ type: "shapeDelete", id: shapeAt(0).id }]);
  });

  it("Duplicate (Ctrl+D) copies shapes with notes and selects the copies", async () => {
    const socket = await inRoom({ notes: [noteAt(0)], shapes: [shapeAt(0, { fill: "blue" })] });
    await key("a", document.body, { ctrlKey: true });
    await key("d", document.body, { ctrlKey: true });
    const [add] = socket.ofType("itemsAdd");
    expect(add?.shapes).toMatchObject([{ kind: "rect", fill: "blue", text: "Step 0" }]);
    expect(add?.notes).toHaveLength(1);
    expect(heading()).toBe("1 note, 1 shape selected");
    expect(shapesShown()).toHaveLength(2);
  });

  it("Order works on a shape alone, and on notes and shapes together", async () => {
    const socket = await inRoom({ notes: [noteAt(0)], shapes: [shapeAt(0)] });
    await press(shapesShown()[0]!);
    // Below xl the Order commands sit in the Arrange panel; they're bar commands either way.
    const front = command("Bring to front");
    expect(isOff(front)).toBe(false);
    await click(front);
    expect(socket.ofType("notesOrder").at(-1)).toEqual({ type: "notesOrder", ids: [shapeAt(0).id], action: "front" });
    await key("a", document.body, { ctrlKey: true });
    await click(command("Send to back"));
    expect(socket.ofType("notesOrder").at(-1)).toMatchObject({ action: "back" });
    expect((socket.ofType("notesOrder").at(-1)?.ids as string[]).sort()).toEqual([noteAt(0).id, shapeAt(0).id].sort());
  });

  it("arrow keys on a focused shape that's part of a mix move the whole selection (one final move each kind)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await inRoom({ notes: [noteAt(0)], shapes: [shapeAt(0)] });
    await key("a", document.body, { ctrlKey: true });
    await key("ArrowRight", shapesShown()[0]!);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await settle();
    vi.useRealTimers();
    expect(socket.ofType("noteBatch").filter((m) => m.final)).toEqual([{ type: "noteBatch", ops: [{ op: "move", id: noteAt(0).id, x: 50, y: 60 }], final: true }]);
    expect(socket.ofType("shapeBatch").filter((m) => m.final)).toEqual([{ type: "shapeBatch", ops: [{ op: "move", id: shapeAt(0).id, x: 70, y: 900 }], final: true }]);
  });

  it("Alt+arrow keys resize one focused shape (live, then final), within the shape limits", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await inRoom({ shapes: [shapeAt(0)] });
    await key("ArrowRight", shapesShown()[0]!, { altKey: true });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await settle();
    vi.useRealTimers();
    expect(socket.ofType("shapeResize").at(-1)).toEqual({ type: "shapeResize", id: shapeAt(0).id, x: 60, y: 900, w: 210, h: 120, final: true });
  });

  it("shapes sit in front of frames on the canvas (frames stay behind everything)", async () => {
    const socket = await inRoom({ frames: [frameAt(0)], shapes: [shapeAt(0, { x: 100, y: 500 })] });
    expect(notesShown()).toHaveLength(0);
    // The drag itself is React Flow's; the session's carry is covered in shapesIntegration.test.ts. Here: the frame's
    // node and the shape's node are both on the canvas, the shape in front of the frame.
    const frameZ = Number((document.querySelector("[data-frame-id]")?.closest(".react-flow__node") as HTMLElement | null)?.style.zIndex);
    const shapeZ = Number((shapesShown()[0]?.closest(".react-flow__node") as HTMLElement | null)?.style.zIndex);
    expect(shapeZ).toBeGreaterThan(frameZ);
    expect(socket.ofType("frameMove")).toEqual([]);
  });
});

describe("the lock", () => {
  it("a guest on a locked board can select shapes but every shape command is off with the lock's reason", async () => {
    const socket = await inRoom({ shapes: [shapeAt(0)], locked: true });
    await press(shapesShown()[0]!);
    expect(heading()).toBe("Rectangle");
    expect(isOff(command("Delete"))).toBe(true);
    expect(tipOf(command("Delete"))?.textContent).toBe(LOCK_TEXT.reason);
    expect(isOff(command("Duplicate"))).toBe(true);
    await key("Delete", shapesShown()[0]!);
    await key("ArrowRight", shapesShown()[0]!);
    expect(socket.ofType("shapeDelete")).toEqual([]);
    expect(socket.ofType("shapeMove")).toEqual([]);
    expect(shapesShown()[0]?.getAttribute("aria-disabled")).toBe("true");
  });
});
