// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REACTION_KEYS } from "@stickyard/shared";
import { REACTIONS, REACTION_TEXT, chipLabel } from "../src/reactions/reactions";
import { STORAGE_KEYS } from "../src/storage";
import {
  cleanupUi,
  click,
  inRoom,
  installUi,
  named,
  noteAt,
  notesShown,
  selectNote,
  server,
  setReducedMotion,
  settle,
  type FakeWebSocket,
} from "./helpers/ui";

/*
 * Reactions on notes, part 2: the UI. Chips under a note (emoji and count, mine outlined and
 * pressed), Add reaction with its picker (a popover from md up, a bottom sheet on phones), the
 * same row in the phone editor, the keyboard path, what is announced (only my own action), sealed
 * notes during a silent round (nothing at all), a locked board, an ended session, both themes.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const id = (i: number) => noteAt(i).id;
const nodeOf = (i: number) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id(i)}"]`);
const rowOf = (i: number) => nodeOf(i)?.querySelector<HTMLElement>("[data-reactions]") ?? null;
const chip = (i: number, key: string, root: ParentNode | null = rowOf(i)) => root?.querySelector<HTMLButtonElement>(`button[data-reaction="${key}"]`) ?? null;
const chipKeys = (root: ParentNode | null) => [...(root?.querySelectorAll<HTMLElement>("button[data-reaction]") ?? [])].map((b) => b.dataset.reaction);
const addButton = (root: ParentNode | null) => root?.querySelector<HTMLButtonElement>("button[data-reaction-add]") ?? null;
const picker = () => document.querySelector<HTMLElement>("[data-reaction-picker]");
const option = (key: string) => picker()?.querySelector<HTMLButtonElement>(`button[data-reaction-option="${key}"]`) ?? null;
const announcer = () => document.querySelector<HTMLElement>("[data-reaction-announcer]");
const sent = (socket: FakeWebSocket) => socket.ofType("reactionSet");

async function key(el: Element | null | undefined, k: string, mods: KeyboardEventInit = {}) {
  await act(async () => el?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods })));
  await settle();
}

/** A finger tap (pointerdown then click) on an element. */
async function tap(el: Element | null | undefined, pointerType = "touch") {
  if (!el) throw new Error("nothing to tap");
  await act(async () => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType, button: 0 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

/** Joined with notes 1 and 2: Sam's reactions on note 1 (heart 2, plus 1), mine the heart; voter granted. */
async function reacting(room: Parameters<typeof inRoom>[0] = {}) {
  const socket = await inRoom({
    notes: [noteAt(1), noteAt(2)],
    reactions: [
      { noteId: id(1), key: "heart", count: 2 },
      { noteId: id(1), key: "plus", count: 1 },
    ],
    ...room,
  });
  await server(socket, { data: { type: "voterGranted", remaining: 5, mine: [], reactions: [{ noteId: id(1), key: "heart" }] } });
  return socket;
}

beforeEach(() => installUi());
afterEach(() => cleanupUi());

describe("chips on a note", () => {
  it("one per key with a count above 0: emoji and count, named for a screen reader, mine pressed", async () => {
    await reacting();
    expect(chipKeys(rowOf(1))).toEqual(["heart", "plus"]);
    const heart = chip(1, "heart")!;
    expect(heart.getAttribute("aria-label")).toBe(chipLabel("heart", 2, true));
    expect(heart.getAttribute("aria-label")).toBe("Heart, 2, you reacted. Press to remove.");
    expect(heart.getAttribute("aria-pressed")).toBe("true");
    expect(heart.textContent).toContain(REACTIONS.heart.emoji);
    expect(heart.textContent).toContain("2");
    const plus = chip(1, "plus")!;
    expect(plus.getAttribute("aria-pressed")).toBe("false");
    expect(plus.getAttribute("aria-label")).toBe("Plus one, 1. Press to add yours.");
    // Mine differs by more than colour: an outline, marked on the element.
    expect(heart.dataset.mine).toBe("true");
    expect(plus.dataset.mine).toBeUndefined();
    // The emoji itself isn't read out: the button's name says it.
    expect(heart.querySelector("[aria-hidden='true']")?.textContent).toBe(REACTIONS.heart.emoji);
    // Keys are never shown as text.
    for (const k of REACTION_KEYS) expect(rowOf(1)?.textContent).not.toContain(k);
    expect(rowOf(2)?.querySelector("button[data-reaction]") ?? null).toBeNull();
    // The note's own name has the counts too.
    expect(notesShown()[0]?.getAttribute("aria-label")).toContain("Reactions: Heart 2, Plus one 1.");
  });

  it("sit outside the note's text, under the card, so they never cover it", async () => {
    await reacting();
    const node = nodeOf(1)!;
    const card = node.querySelector('[aria-roledescription="note"]')!;
    expect(card.contains(rowOf(1))).toBe(false);
    expect(rowOf(1)?.classList.contains("sy-reactions")).toBe(true);
    // Positioned below the note (in the CSS), and React Flow leaves presses on it alone.
    const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    const rule = css.slice(css.indexOf(".sy-reactions {"), css.indexOf("}", css.indexOf(".sy-reactions {")));
    expect(rule).toContain("position: absolute");
    expect(rule).toMatch(/top: calc\(100% \+ var\(--sy-reaction-gap\)\)/);
    for (const cls of ["nodrag", "nopan", "nowheel"]) expect(rowOf(1)?.classList.contains(cls)).toBe(true);
  });

  it("tapping a chip toggles mine (a set, never a toggle on the wire); it doesn't select or drag the note", async () => {
    const socket = await reacting();
    await tap(chip(1, "plus"));
    expect(sent(socket)).toEqual([{ type: "reactionSet", noteId: id(1), key: "plus", on: true }]);
    expect(chip(1, "plus")?.getAttribute("aria-pressed")).toBe("true");
    expect(chip(1, "plus")?.textContent).toContain("2");
    expect(notesShown()[0]?.getAttribute("aria-current")).toBeNull();
    expect(nodeOf(1)?.querySelector(".sy-selected")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(socket.ofType("noteMove")).toEqual([]);
    await click(chip(1, "heart"));
    expect(sent(socket).at(-1)).toEqual({ type: "reactionSet", noteId: id(1), key: "heart", on: false });
    expect(chip(1, "heart")?.getAttribute("aria-pressed")).toBe("false");
    expect(chip(1, "heart")?.textContent).toContain("1");
  });

  it("a chip press leaves the selection alone, and Enter on a chip is the chip's (no editor)", async () => {
    const socket = await reacting({ reactions: [{ noteId: id(2), key: "laugh", count: 1 }] });
    await selectNote(0);
    await tap(chip(2, "laugh"), "mouse");
    expect(notesShown()[0]?.getAttribute("aria-current")).toBe("true");
    expect(notesShown()[1]?.getAttribute("aria-current")).toBeNull();
    await act(async () => chip(2, "laugh")?.focus());
    await key(chip(2, "laugh"), "Enter");
    expect(document.querySelector("[data-inline]")).toBeNull();
    expect(notesShown()[1]?.getAttribute("aria-current")).toBeNull();
    expect(sent(socket)[0]).toEqual({ type: "reactionSet", noteId: id(2), key: "laugh", on: true });
  });

  it("a refusal rolls back with a short message", async () => {
    const socket = await reacting();
    await tap(chip(1, "plus"));
    await server(socket, { data: { type: "error", code: "reactor_full", message: "No.", noteId: id(1) } });
    expect(chip(1, "plus")?.getAttribute("aria-pressed")).toBe("false");
    expect(chip(1, "plus")?.textContent).toContain("1");
    expect(document.body.textContent).toContain("You’ve used all your reactions");
  });

  it("only my own action is announced, politely; other people's never are", async () => {
    const socket = await reacting();
    expect(announcer()?.getAttribute("aria-live")).toBe("polite");
    expect(announcer()?.textContent).toBe("");
    await server(socket, { data: { type: "reactionCount", noteId: id(2), key: "laugh", count: 1 } });
    expect(announcer()?.textContent).toBe("");
    await tap(chip(1, "plus"));
    expect(announcer()?.textContent).toBe("You reacted with Plus one.");
    await server(socket, { data: { type: "reactionCount", noteId: id(1), key: "heart", count: 3 } });
    expect(announcer()?.textContent).toBe("You reacted with Plus one.");
  });

  it("pops when mine changes, but not with reduced motion", async () => {
    await reacting();
    await tap(chip(1, "plus"));
    expect(chip(1, "plus")?.classList.contains("sy-reaction-pop")).toBe(true);
    setReducedMotion(true);
    await settle();
    await tap(chip(1, "plus"));
    await tap(chip(1, "plus"));
    expect(chip(1, "plus")?.classList.contains("sy-reaction-pop")).toBe(false);
  });

  it("render in light and in dark from tokens only", async () => {
    for (const theme of ["light", "dark"]) {
      localStorage.setItem(STORAGE_KEYS.theme, theme);
      await reacting();
      expect(document.documentElement.dataset.theme).toBe(theme);
      const heart = chip(1, "heart")!;
      expect(heart.className).toMatch(/sy-reaction-chip/);
      // No inline colours: the chip's look is index.css on tokens.
      expect(heart.getAttribute("style") ?? "").not.toMatch(/#|rgb|hsl/);
      await cleanupUi();
      installUi();
    }
  });
});

describe("Add reaction", () => {
  it("only on the selected note; a popover from md up with the six emoji; choosing one sets it and closes; focus returns", async () => {
    const socket = await reacting();
    expect(addButton(rowOf(2))).toBeNull();
    await selectNote(1);
    const add = addButton(rowOf(2))!;
    expect(add.getAttribute("aria-label")).toBe(REACTION_TEXT.add);
    expect(add.getAttribute("aria-haspopup")).toBe("dialog");
    await act(async () => add.focus());
    await click(add);
    expect(picker()?.dataset.variant).toBe("popover");
    expect(add.getAttribute("aria-expanded")).toBe("true");
    expect([...picker()!.querySelectorAll<HTMLElement>("button[data-reaction-option]")].map((b) => b.getAttribute("aria-label"))).toEqual(
      REACTION_KEYS.map((k) => REACTIONS[k].name),
    );
    expect(document.activeElement).toBe(option("thumbs_up"));
    await click(option("celebrate"));
    expect(picker()).toBeNull();
    expect(sent(socket).at(-1)).toEqual({ type: "reactionSet", noteId: id(2), key: "celebrate", on: true });
    expect(chip(2, "celebrate")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(addButton(rowOf(2)));
  });

  it("Esc closes the picker and focus goes back to Add reaction; Tab stays inside", async () => {
    await reacting();
    await selectNote(1);
    const add = addButton(rowOf(2))!;
    await act(async () => add.focus());
    await click(add);
    expect(picker()).not.toBeNull();
    await key(document.activeElement, "Tab", { shiftKey: true });
    expect(picker()?.contains(document.activeElement)).toBe(true);
    await key(document.activeElement, "Escape");
    expect(picker()).toBeNull();
    expect(document.activeElement).toBe(add);
    // Esc closed the picker only: the note is still selected.
    expect(notesShown()[1]?.getAttribute("aria-current")).toBe("true");
  });

  it("choosing a reaction that's already mine leaves it on", async () => {
    const socket = await reacting();
    await selectNote(0);
    await click(addButton(rowOf(1)));
    expect(option("heart")?.getAttribute("aria-pressed")).toBe("true");
    await click(option("heart"));
    expect(sent(socket)).toEqual([]);
    expect(chip(1, "heart")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("no new global shortcut: R on a focused note does nothing", async () => {
    const socket = await reacting();
    await selectNote(0);
    await key(notesShown()[0], "r");
    expect(picker()).toBeNull();
    expect(sent(socket)).toEqual([]);
  });
});

describe("phones", () => {
  it("the editor sheet has the same row, in the same order; the picker is a bottom sheet over it", async () => {
    const socket = await reacting({ isWide: false });
    expect(chipKeys(rowOf(1))).toEqual(["heart", "plus"]);
    await tap(notesShown()[0]);
    const editor = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const section = editor.querySelector<HTMLElement>("[data-reactions-section]")!;
    expect(chipKeys(section)).toEqual(chipKeys(rowOf(1)));
    expect(chip(1, "heart", section)?.getAttribute("aria-pressed")).toBe("true");
    const add = addButton(section)!;
    await act(async () => add.focus());
    await click(add);
    expect(picker()?.dataset.variant).toBe("sheet");
    expect(picker()?.getAttribute("aria-modal")).toBe("true");
    await key(document.activeElement, "Escape");
    expect(picker()).toBeNull();
    // Esc closed the picker alone; the editor is still open and focus is back on Add reaction.
    expect(document.querySelector('[role="dialog"]')).toBe(editor);
    expect(document.activeElement).toBe(add);
    await click(add);
    await click(option("thinking"));
    expect(sent(socket).at(-1)).toEqual({ type: "reactionSet", noteId: id(1), key: "thinking", on: true });
    expect(chipKeys(section)).toEqual(["heart", "thinking", "plus"]);
  });
});

describe("a silent round", () => {
  it("my sealed note has no chips, no Add reaction and nothing in the accessible tree; at the reveal it behaves normally", async () => {
    const sealed = noteAt(3, { authorId: "AAAAAAAAAAAAAAAA" });
    const socket = await inRoom({ notes: [noteAt(1), sealed], silent: { active: true, count: 1 }, mine: [sealed.id] });
    await server(socket, { data: { type: "voterGranted", remaining: 5, mine: [] } });
    await selectNote(1);
    const node = nodeOf(3)!;
    expect(node.querySelector("[data-reactions], [data-reaction], [data-reaction-add], [data-reaction-summary]")).toBeNull();
    expect(named(REACTION_TEXT.add)).toBeUndefined();
    expect(notesShown()[1]?.getAttribute("aria-label")).not.toMatch(/reaction/i);
    // Revealed: Add reaction is there on the selected note.
    await server(socket, { data: { type: "notesRevealed", notes: [sealed], final: true } });
    await server(socket, { data: { type: "silentChanged", active: false, count: 0 } });
    expect(addButton(rowOf(3))).not.toBeNull();
  });

  it("phones: the editor for my sealed note has no reactions section", async () => {
    const sealed = noteAt(3, { authorId: "AAAAAAAAAAAAAAAA" });
    await inRoom({ isWide: false, notes: [sealed], silent: { active: true, count: 1 }, mine: [sealed.id] });
    await tap(notesShown()[0]);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector("[data-reactions-section]")).toBeNull();
  });
});

describe("the lock and the end", () => {
  it("a locked board still takes reactions", async () => {
    const socket = await reacting({ locked: true });
    await tap(chip(1, "plus"));
    expect(sent(socket)).toEqual([{ type: "reactionSet", noteId: id(1), key: "plus", on: true }]);
  });

  it("an ended session shows no reactions", async () => {
    const socket = await reacting();
    await server(socket, { data: { type: "sessionEnded" } });
    expect(document.querySelector("[data-reactions], [data-reaction]")).toBeNull();
  });
});
