// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_FRAME_TITLE, MAX_SHAPE_TEXT } from "@stickyard/shared";
import { EMOJI, EMOJI_FULL } from "../src/emoji/emoji";
import { cleanupUi, click, frameAt, inRoom, installUi, noteAt, notesShown, selectNote, settle, shapeAt, shapesShown } from "./helpers/ui";

/*
 * The emoji picker (v0.21.0, part 5): a button beside text being edited in place (notes and
 * shapes) and beside the Properties text fields (note title and body, shape text, frame title).
 * It inserts at the caret, keeps editing going (nothing is saved until the edit is), respects
 * the caps, and is keyboard operable. Generic text.
 */

const picker = () => document.querySelector<HTMLElement>("[data-emoji-picker]");
const emojiButtons = () => [...(picker()?.querySelectorAll<HTMLButtonElement>("button[data-emoji]") ?? [])];
const emojiButton = (name: string) => picker()?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`) ?? null;
const trigger = (label: string, root: ParentNode = document) => root.querySelector<HTMLButtonElement>(`button[data-emoji-trigger][aria-label="${label}"]`);
const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]')!;

async function dblclick(el: Element) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 }));
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function key(el: Element | null, k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

/** Moves focus as a press would, with relatedTarget, so blur handlers see where it went. */
async function focusMove(to: HTMLElement | null) {
  await act(async () => to?.focus());
  await settle();
}

async function caretAt(el: HTMLTextAreaElement | HTMLInputElement | null, at: number) {
  await act(async () => {
    el?.focus();
    el?.setSelectionRange(at, at);
  });
}

async function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function open(button: HTMLButtonElement | null) {
  await focusMove(button);
  await click(button);
}

beforeEach(installUi);
afterEach(cleanupUi);

describe("editing a note in place", () => {
  it("the button opens a labelled grid of 44px emoji; one inserts at the caret and editing carries on", async () => {
    const socket = await inRoom({ notes: [noteAt(0, { text: "Ship it" })] });
    await dblclick(notesShown()[0]!);
    const title = document.querySelector<HTMLTextAreaElement>('textarea[data-inline="title"]')!;
    await caretAt(title, 4);
    const button = trigger("Insert emoji");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    await open(button);
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(picker()?.getAttribute("role")).toBe("group");
    expect(picker()?.getAttribute("aria-label")).toBe("Emoji");
    expect(emojiButtons()).toHaveLength(EMOJI.length);
    expect(emojiButtons().every((b) => b.className.includes("size-touch"))).toBe(true);
    // Focus goes to the first emoji; the edit is still open.
    expect(document.activeElement).toBe(emojiButtons()[0]);
    expect(document.querySelector('textarea[data-inline="title"]')).not.toBeNull();
    await focusMove(emojiButton("Rocket"));
    await click(emojiButton("Rocket"));
    expect(picker()).toBeNull();
    const again = document.querySelector<HTMLTextAreaElement>('textarea[data-inline="title"]')!;
    expect(again.value).toBe("Ship🚀 it");
    expect(document.activeElement).toBe(again);
    expect(again.selectionStart).toBe(6);
    // Nothing is saved until the edit is.
    expect(socket.ofType("noteEdit")).toEqual([]);
    await key(again, "Escape");
    expect(socket.ofType("noteEdit")).toEqual([{ type: "noteEdit", id: noteAt(0).id, text: "Ship🚀 it" }]);
  });

  it("inserts into the part last edited (the body)", async () => {
    await inRoom({ notes: [noteAt(0, { text: "Title\nBody" })] });
    await dblclick(notesShown()[0]!);
    const body = document.querySelector<HTMLTextAreaElement>('textarea[data-inline="body"]')!;
    await caretAt(body, 4);
    await open(trigger("Insert emoji"));
    await focusMove(emojiButton("Check mark"));
    await click(emojiButton("Check mark"));
    expect(document.querySelector<HTMLTextAreaElement>('textarea[data-inline="body"]')?.value).toBe("Body✅");
    expect(document.querySelector<HTMLTextAreaElement>('textarea[data-inline="title"]')?.value).toBe("Title");
  });

  it("keyboard: arrows and Home/End move between emoji; Escape closes and returns to the text", async () => {
    await inRoom({ notes: [noteAt(0)] });
    await dblclick(notesShown()[0]!);
    await open(trigger("Insert emoji"));
    const first = emojiButtons()[0]!;
    expect(first.tabIndex).toBe(0);
    expect(emojiButtons()[1]?.tabIndex).toBe(-1);
    await key(first, "ArrowRight");
    expect(document.activeElement).toBe(emojiButtons()[1]);
    expect(emojiButtons()[1]?.tabIndex).toBe(0);
    await key(document.activeElement, "End");
    expect(document.activeElement).toBe(emojiButtons().at(-1));
    await key(document.activeElement, "Home");
    expect(document.activeElement).toBe(first);
    await key(document.activeElement, "Escape");
    expect(picker()).toBeNull();
    // Still editing, back in the text.
    expect(document.activeElement).toBe(document.querySelector('textarea[data-inline="title"]'));
  });

  it("at the 280-character cap nothing is inserted and the picker says why", async () => {
    await inRoom({ notes: [noteAt(0, { text: `T\n${"x".repeat(278)}` })] });
    await dblclick(notesShown()[0]!);
    await open(trigger("Insert emoji"));
    await focusMove(emojiButton("Star"));
    await click(emojiButton("Star"));
    expect(picker()?.querySelector("[data-emoji-full]")?.textContent).toBe(EMOJI_FULL);
    expect(document.querySelector<HTMLTextAreaElement>('textarea[data-inline="title"]')?.value).toBe("T");
  });
});

describe("editing a shape in place", () => {
  it("inserts at the caret; the shape's 500 cap holds", async () => {
    const socket = await inRoom({ shapes: [shapeAt(0, { text: "Go" }), shapeAt(1, { text: "a".repeat(MAX_SHAPE_TEXT) })] });
    await dblclick(shapesShown()[0]!);
    const input = document.querySelector<HTMLTextAreaElement>("textarea[data-shape-input]")!;
    await caretAt(input, 2);
    await open(trigger("Insert emoji"));
    await focusMove(emojiButton("Party popper"));
    await click(emojiButton("Party popper"));
    expect(document.querySelector<HTMLTextAreaElement>("textarea[data-shape-input]")?.value).toBe("Go🎉");
    expect(socket.ofType("shapeEdit")).toEqual([]);
    await key(document.querySelector("textarea[data-shape-input]"), "Escape");
    expect(socket.ofType("shapeEdit")).toEqual([{ type: "shapeEdit", id: shapeAt(0).id, text: "Go🎉" }]);
    await dblclick(shapesShown()[1]!);
    await open(trigger("Insert emoji"));
    await focusMove(emojiButton("Fire"));
    await click(emojiButton("Fire"));
    expect(picker()?.querySelector("[data-emoji-full]")).not.toBeNull();
    expect(document.querySelector<HTMLTextAreaElement>("textarea[data-shape-input]")?.value).toHaveLength(MAX_SHAPE_TEXT);
  });
});

describe("Properties text fields", () => {
  it("note Title and Body each have a button; it inserts at the caret into that field", async () => {
    await inRoom({ notes: [noteAt(0, { text: "Plan\nSteps" })] });
    await selectNote(0);
    const panel = properties();
    const body = panel.querySelector<HTMLTextAreaElement>('textarea[name="body"]')!;
    await caretAt(body, 0);
    await open(trigger("Insert emoji in body", panel));
    await focusMove(emojiButton("Pushpin"));
    await click(emojiButton("Pushpin"));
    expect(panel.querySelector<HTMLTextAreaElement>('textarea[name="body"]')?.value).toBe("📌Steps");
    expect(trigger("Insert emoji in title", panel)).not.toBeNull();
  });

  it("frame Title: inserts, and the 60-character title cap holds", async () => {
    await inRoom({ frames: [frameAt(0, { title: "Done" })] });
    const header = document.querySelector<HTMLElement>("[data-frame-id] .sy-frame-handle");
    await act(async () => {
      header?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 }));
      header?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle();
    const panel = properties();
    const title = panel.querySelector<HTMLInputElement>('input[name="frameTitle"]')!;
    await caretAt(title, 4);
    await open(trigger("Insert emoji in title", panel));
    await focusMove(emojiButton("Thumbs up"));
    await click(emojiButton("Thumbs up"));
    expect(panel.querySelector<HTMLInputElement>('input[name="frameTitle"]')?.value).toBe("Done👍");
    await typeInto(panel.querySelector<HTMLInputElement>('input[name="frameTitle"]')!, "d".repeat(MAX_FRAME_TITLE));
    await open(trigger("Insert emoji in title", panel));
    await focusMove(emojiButton("Thumbs up"));
    await click(emojiButton("Thumbs up"));
    expect(picker()?.querySelector("[data-emoji-full]")).not.toBeNull();
    expect(panel.querySelector<HTMLInputElement>('input[name="frameTitle"]')?.value).toBe("d".repeat(MAX_FRAME_TITLE));
  });

  it("shape Text has one; it's off while the board is read-only", async () => {
    await inRoom({ shapes: [shapeAt(0, { text: "Go" })], locked: true });
    await act(async () => {
      shapesShown()[0]?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 }));
      shapesShown()[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(trigger("Insert emoji in text", properties())?.disabled).toBe(true);
  });
});
