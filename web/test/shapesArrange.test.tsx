// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHAPE_MIN_H, SHAPE_MIN_W } from "@stickyard/shared";
import { align, grid, matchSize, mixedClamp } from "../src/canvas/arrange";
import { ARRANGE_HINTS } from "../src/canvas/frameSelect";
import { CLEAR_FRAME_STEP_MS } from "../src/rooms/session";
import { nid, note, room, shape, sid } from "./helpers/fakeRelay";
import { boardBar, cleanupUi, click, frameAt, inRoom, installUi, noteAt, settle, shapeAt, shapesShown } from "./helpers/ui";

/*
 * Text and shapes, part 4: Align, Distribute, Grid and Match size on notes and shapes together
 * (each clamped to its own limits, one history step), and Properties for several shapes (text
 * style, fill and border for all, paced, one undo step). Generic fixtures.
 */

const placed = (id: string, x: number, y: number, w: number, h: number) => ({ id, x, y, w, h });

describe("arrange on notes and shapes (pure)", () => {
  it("aligns a mix; each item is clamped to its own kind's limits", () => {
    const shapes = new Set(["s1"]);
    const rects = [placed("n1", 100, 100, 160, 160), placed("s1", 500, 300, 200, 40)];
    expect([...align(rects, "top", mixedClamp(shapes))]).toEqual([["s1", { x: 500, y: 100, w: 200, h: 40 }]]);
    // Match size to a short shape: the note can't go below its own minimum; the shape can.
    const short = [placed("s1", 0, 0, 200, SHAPE_MIN_H), placed("n1", 300, 0, 160, 160)];
    expect(matchSize(short, "height", mixedClamp(shapes)).get("n1")).toEqual({ x: 300, y: 0, w: 160, h: 96 });
    const small = [placed("n1", 0, 0, 160, 160), placed("s1", 300, 0, SHAPE_MIN_W, SHAPE_MIN_H)];
    expect(matchSize(small, "both", mixedClamp(shapes)).get("s1")).toEqual({ x: 300, y: 0, w: 160, h: 160 });
    expect(grid(rects, 2, 24, mixedClamp(shapes)).reason).toBeNull();
  });
});

describe("the session", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("applyRects sends notes in a noteBatch and shapes in a shapeBatch, as one undo step", () => {
    const t = room([note(1, { x: 0, y: 0 })], [], {}, undefined, [shape(1, { x: 500, y: 300 })]);
    t.session.applyRects([
      { id: nid(1), x: 0, y: 300, w: 160, h: 160 },
      { id: sid(1), x: 500, y: 300, w: 300, h: 200 },
    ]);
    expect(t.sent("noteBatch").at(-1)).toEqual({ type: "noteBatch", ops: [{ op: "move", id: nid(1), x: 0, y: 300 }], final: true });
    expect(t.sent("shapeBatch").at(-1)).toEqual({ type: "shapeBatch", ops: [{ op: "resize", id: sid(1), x: 500, y: 300, w: 300, h: 200 }], final: true });
    t.session.undo();
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 0, y: 0 });
    expect(t.relay.shapes.get(sid(1))).toMatchObject({ w: 200, h: 120 });
  });

  it("editShapes sends one shapeEdit per changed shape, paced, and is one undo step", () => {
    const t = room([], [], {}, undefined, [shape(1), shape(2, { fill: "pink" }), shape(3)]);
    expect(t.session.editShapes([sid(1), sid(2), sid(3)], { fill: "pink", underline: true })).toBe(true);
    expect(t.sent("shapeEdit")).toHaveLength(1);
    vi.advanceTimersByTime(CLEAR_FRAME_STEP_MS * 3);
    expect(t.sent("shapeEdit")).toEqual([
      { type: "shapeEdit", id: sid(1), fill: "pink", underline: true },
      { type: "shapeEdit", id: sid(2), underline: true },
      { type: "shapeEdit", id: sid(3), fill: "pink", underline: true },
    ]);
    t.session.undo();
    vi.advanceTimersByTime(CLEAR_FRAME_STEP_MS * 3);
    expect([1, 2, 3].map((i) => t.relay.shapes.get(sid(i))?.fill)).toEqual(["neutral", "pink", "neutral"]);
    expect([1, 2, 3].every((i) => t.relay.shapes.get(sid(i))?.underline === false)).toBe(true);
    // Text is never edited for several at once.
    t.session.editShapes([sid(1)], { text: "No" });
    expect(t.relay.shapes.get(sid(1))?.text).toBe("Step 1");
  });
});

beforeEach(installUi);
afterEach(cleanupUi);

const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
const heading = () => properties()?.querySelector("h3")?.textContent ?? "";
const command = (label: string) => boardBar()?.querySelector<HTMLElement>(`button[aria-label="${label}"]`) ?? null;
async function key(k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

describe("in the page (md and up)", () => {
  it("Align on a note and a shape moves both, in their own batches", async () => {
    const socket = await inRoom({ notes: [noteAt(0)], shapes: [shapeAt(0)] });
    await key("a", { ctrlKey: true });
    await click(command("Align left edges"));
    expect(socket.ofType("shapeBatch").at(-1)).toEqual({ type: "shapeBatch", ops: [{ op: "move", id: shapeAt(0).id, x: 40, y: 900 }], final: true });
    expect(socket.ofType("noteBatch")).toEqual([]);
  });

  it("with frames in the mix, arrange is off and says why as text", async () => {
    await inRoom({ frames: [frameAt(0)], shapes: [shapeAt(0)] });
    await key("a", { ctrlKey: true });
    expect(command("Align left edges")?.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector("[data-arrange-reason]")?.textContent).toBe(ARRANGE_HINTS.mixed);
  });

  it("two shapes: Properties changes fill and text style for both; text and size are shared-only", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await inRoom({ shapes: [shapeAt(0), shapeAt(1, { kind: "oval", text: "Other" })] });
    await key("a", { ctrlKey: true });
    expect(heading()).toBe("2 shapes selected");
    const panel = properties()!;
    expect(panel.querySelector("[data-shapes-fields]")).not.toBeNull();
    const text = panel.querySelector<HTMLTextAreaElement>('textarea[name="shapeText"]');
    expect(text?.disabled).toBe(true);
    expect(text?.placeholder).toBe("Mixed");
    expect(panel.querySelector<HTMLInputElement>('input[name="shapeWidth"]')?.disabled).toBe(true);
    await click(panel.querySelector<HTMLButtonElement>('button[aria-label="Green fill"]'));
    await act(async () => {
      vi.advanceTimersByTime(CLEAR_FRAME_STEP_MS * 3);
    });
    await settle();
    vi.useRealTimers();
    expect(socket.ofType("shapeEdit")).toEqual([
      { type: "shapeEdit", id: shapeAt(0).id, fill: "green" },
      { type: "shapeEdit", id: shapeAt(1).id, fill: "green" },
    ]);
    expect(shapesShown()).toHaveLength(2);
  });
});
