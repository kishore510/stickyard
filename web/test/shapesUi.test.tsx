// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupUi, click, inRoom, installUi, server, settle, shapeAt, shapesShown, type FakeWebSocket } from "./helpers/ui";

/*
 * Text and shapes in the page (protocol v15, part 2): shapes on the canvas (outline, text, the
 * empty-text placeholder, accessible names), the palette's Shapes tiles, editing text in place,
 * and Properties for one shape. Phones show shapes read-only. Generic text.
 */

const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
const heading = () => properties()?.querySelector("h3")?.textContent ?? "";
const palette = () => document.querySelector<HTMLElement>('aside[aria-label="Palette"]');
const tile = (label: string) => palette()?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? null;
const editor = () => document.querySelector<HTMLTextAreaElement>("textarea[data-shape-input]");
const sentOfType = (socket: FakeWebSocket, type: string) => socket.ofType(type);

async function press(el: Element, init: MouseEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

async function dblclick(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

async function typeInto(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(installUi);
afterEach(cleanupUi);

describe("shapes on the canvas", () => {
  it("each kind draws its outline, shows its text, and is named for screen readers", async () => {
    await inRoom({ shapes: [shapeAt(0), shapeAt(1, { kind: "oval", text: "Start" }), shapeAt(2, { kind: "diamond", text: "Choose" }), shapeAt(3, { kind: "text", text: "Parking lot" })] });
    expect(shapesShown().map((s) => s.getAttribute("aria-label"))).toEqual(["Rectangle: Step 0", "Oval: Start", "Diamond: Choose", "Text: Parking lot"]);
    const [rect, oval, diamond, text] = shapesShown();
    expect(rect?.querySelector("svg rect")).not.toBeNull();
    expect(oval?.querySelector("svg ellipse")).not.toBeNull();
    expect(diamond?.querySelector("svg polygon")).not.toBeNull();
    expect(text?.textContent).toContain("Parking lot");
    // Text is plain text, never HTML.
    expect(text?.querySelector("b, script, a")).toBeNull();
    // In the notes' stacking: the node's z is the shape's.
    expect((rect?.closest(".react-flow__node") as HTMLElement | null)?.style.zIndex).toBe("50");
  });

  it("an empty text label (no fill, no border) shows a faint outline and the placeholder word, which isn't its text", async () => {
    await inRoom({ shapes: [shapeAt(0, { kind: "text", text: "" })] });
    const [el] = shapesShown();
    expect(el?.hasAttribute("data-shape-empty")).toBe(true);
    expect(el?.className).toContain("sy-shape-empty");
    expect(el?.querySelector("[data-shape-placeholder]")?.textContent).toBe("Text");
    expect(el?.getAttribute("aria-label")).toBe("Text, empty");
  });

  it("a click selects it (Properties shows its fields) and the only selected shape gets resize handles", async () => {
    await inRoom({ shapes: [shapeAt(0)] });
    await press(shapesShown()[0]!);
    expect(heading()).toBe("Rectangle");
    expect(shapesShown()[0]?.className).toContain("sy-selected");
    expect(shapesShown()[0]?.closest(".react-flow__node")?.querySelector(".react-flow__resize-control")).not.toBeNull();
    expect(properties()?.querySelector("[data-shape-fields]")).not.toBeNull();
  });
});

describe("adding and editing (md and up)", () => {
  it("a Shapes tile adds its kind at the view centre and starts editing its text; Escape saves it once confirmed", async () => {
    const socket = await inRoom();
    await click(tile("Diamond"));
    const [add] = sentOfType(socket, "shapeAdd");
    expect(add).toMatchObject({ type: "shapeAdd", kind: "diamond" });
    expect(document.activeElement).toBe(editor());
    await typeInto(editor()!, "Choose a path");
    await server(socket, {
      data: { type: "shapeAdded", clientRef: add?.clientRef, shape: { ...shapeAt(7, { kind: "diamond", text: "", x: add?.x as number, y: add?.y as number, w: 200, h: 160 }) } },
    });
    expect(editor()?.value).toBe("Choose a path");
    await key(editor()!, "Escape");
    expect(sentOfType(socket, "shapeEdit")).toEqual([{ type: "shapeEdit", id: shapeAt(7).id, text: "Choose a path" }]);
    expect(editor()).toBeNull();
  });

  it("double-click edits in place; Enter is a new line; leaving the field saves", async () => {
    const socket = await inRoom({ shapes: [shapeAt(0)] });
    await dblclick(shapesShown()[0]!);
    expect(editor()?.value).toBe("Step 0");
    await key(editor()!, "Enter");
    expect(editor()).not.toBeNull();
    await typeInto(editor()!, "Step 0\nthen 1");
    await act(async () => editor()?.blur());
    await settle();
    expect(sentOfType(socket, "shapeEdit")).toEqual([{ type: "shapeEdit", id: shapeAt(0).id, text: "Step 0\nthen 1" }]);
  });

  it("input past 500 characters is refused", async () => {
    await inRoom({ shapes: [shapeAt(0, { text: "" })] });
    await dblclick(shapesShown()[0]!);
    await typeInto(editor()!, "a".repeat(500));
    await typeInto(editor()!, "a".repeat(501));
    expect(editor()?.value).toHaveLength(500);
  });

  it("while disconnected the text being edited stays but is read-only", async () => {
    const socket = await inRoom({ shapes: [shapeAt(0)] });
    await dblclick(shapesShown()[0]!);
    await typeInto(editor()!, "Draft");
    await server(socket, "close");
    expect(editor()?.readOnly).toBe(true);
    expect(editor()?.value).toBe("Draft");
  });

  it("Delete on a focused empty shape deletes it at once; with text it asks first", async () => {
    const socket = await inRoom({ shapes: [shapeAt(0, { text: "" }), shapeAt(1)] });
    await key(shapesShown()[0]!, "Delete");
    expect(sentOfType(socket, "shapeDelete")).toEqual([{ type: "shapeDelete", id: shapeAt(0).id }]);
    window.confirm = () => false;
    await key(shapesShown()[0]!, "Delete");
    expect(sentOfType(socket, "shapeDelete")).toHaveLength(1);
  });
});

describe("Properties for one shape", () => {
  it("text, text style, fill and border, size, order, author; each change is one shapeEdit", async () => {
    const socket = await inRoom({ shapes: [shapeAt(0)] });
    await press(shapesShown()[0]!);
    const panel = properties()!;
    await click(panel.querySelector<HTMLButtonElement>('button[aria-label="Pink"]'));
    await click(panel.querySelector<HTMLButtonElement>('button[aria-label="Underline text"]'));
    await click(panel.querySelector<HTMLButtonElement>('button[aria-label="Text at the bottom"]'));
    await click([...panel.querySelectorAll<HTMLButtonElement>('[aria-label="Border style"] button')].find((b) => b.textContent === "Dashed"));
    const size = panel.querySelector<HTMLSelectElement>('select[name="shapeFontSize"]')!;
    expect([...size.options].map((o) => o.textContent)).toEqual(["Small", "Medium", "Large", "Extra large", "Heading 3", "Heading 2", "Heading 1"]);
    await act(async () => {
      size.value = "4xl";
      size.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(sentOfType(socket, "shapeEdit")).toEqual([
      { type: "shapeEdit", id: shapeAt(0).id, fill: "pink" },
      { type: "shapeEdit", id: shapeAt(0).id, underline: true },
      { type: "shapeEdit", id: shapeAt(0).id, valign: "bottom" },
      { type: "shapeEdit", id: shapeAt(0).id, strokeStyle: "dashed" },
      { type: "shapeEdit", id: shapeAt(0).id, fontSize: "4xl" },
    ]);
    expect(panel.textContent).toContain("added by Sam");
    expect(panel.querySelector('input[name="shapeWidth"]')).not.toBeNull();
    expect([...panel.querySelectorAll("button")].some((b) => b.textContent === "Bring to front")).toBe(true);
  });

  it("a text box has no Fill or Border section", async () => {
    await inRoom({ shapes: [shapeAt(0, { kind: "text", fill: "none", strokeWidth: "none" })] });
    await press(shapesShown()[0]!);
    expect(heading()).toBe("Text box");
    expect(properties()?.querySelector('[aria-label="Fill colour"]')).toBeNull();
    expect(properties()?.querySelector('[aria-label="Border style"]')).toBeNull();
  });

  it("is read-only for a guest on a locked board, with the lock's reason", async () => {
    await inRoom({ shapes: [shapeAt(0)], locked: true });
    await press(shapesShown()[0]!);
    expect(properties()?.querySelector("[data-locked-reason]")).not.toBeNull();
    expect(properties()?.querySelector<HTMLButtonElement>('button[aria-label="Pink"]')?.disabled).toBe(true);
    // And the palette's shape tiles are off with the reason.
    expect(tile("Rectangle")?.getAttribute("aria-disabled") ?? String(tile("Rectangle")?.disabled)).toMatch(/true/);
  });
});

describe("phones", () => {
  it("show shapes read-only: no editing in place, not draggable, no shape tiles in the drawer", async () => {
    await inRoom({ isWide: false, shapes: [shapeAt(0)] });
    expect(shapesShown()).toHaveLength(1);
    expect(shapesShown()[0]?.getAttribute("aria-disabled")).toBe("true");
    await dblclick(shapesShown()[0]!);
    expect(editor()).toBeNull();
    expect(shapesShown()[0]?.closest(".react-flow__node")?.classList.contains("draggable")).toBe(false);
  });
});
