// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTE_DEFAULTS } from "@stickyard/shared";
import { BUILTIN_STENCILS } from "../src/stencils/builtins";
import { STENCIL_TEXT } from "../src/stencils/rules";
import { LOCK_TEXT } from "../src/facilitation/lock";
import { SILENT_TEXT } from "../src/silent/silent";
import { boardBar, cleanupUi, click, inRoom, installUi, named, noteAt, notesShown, settle } from "./helpers/ui";

/*
 * Stencils part 3 in the page: the palette's Stencils tab (md and up) with the built-ins and the
 * ones saved in this browser, Save as stencil from a selection (its dialog says what's kept and
 * where), Rename, Delete and Delete all, storage blocked, a malformed saved entry, the lock and
 * the silent round. Names and text are only ever text.
 */

const HOSTILE = "<img src=x onerror=alert(1)>";
const KEY = "stickyard:stencils";
const palette = () => document.querySelector<HTMLElement>('aside[aria-label="Palette"]');
const tab = (label: string) => [...(palette()?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])].find((t) => t.textContent === label);
const tile = (label: string) => palette()?.querySelector<HTMLButtonElement>(`button[data-palette-item][aria-label="${label}"]`) ?? null;
const saved = (name: string) => ({
  id: "saved1",
  name,
  notes: [{ ref: "n1", x: 0, y: 0, w: 160, h: 160, text: HOSTILE, ...NOTE_DEFAULTS, color: "yellow" }],
  shapes: [],
  frames: [],
  arrows: [],
  groups: [],
});

async function setValue(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openStencils() {
  await click(tab("Stencils"));
}

beforeEach(installUi);
afterEach(cleanupUi);

describe("the Stencils tab", () => {
  it("lists the built-ins; a click places one through itemsAdd", async () => {
    const socket = await inRoom();
    await openStencils();
    for (const s of BUILTIN_STENCILS) expect(tile(s.name), s.name).not.toBeNull();
    const cluster = BUILTIN_STENCILS.find((s) => s.id === "note-cluster")!;
    await click(tile(cluster.name));
    const add = socket.ofType("itemsAdd")[0] as { notes?: unknown[] } | undefined;
    expect(add?.notes).toHaveLength(cluster.notes.length);
  });

  it("lists stencils saved in this browser by name, as text; Rename, Delete and Delete all work", async () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 1, stencils: [saved(HOSTILE), { ...saved("Second"), id: "saved2" }] }));
    await inRoom();
    await openStencils();
    expect(tile(HOSTILE)).not.toBeNull();
    expect(palette()!.querySelector("img")).toBeNull();
    const manage = palette()!.querySelector<HTMLElement>("[data-stencil-manager]")!;
    expect(manage.textContent).toContain(HOSTILE);
    vi.spyOn(window, "prompt").mockReturnValue("Renamed");
    await click(named(`Rename ${HOSTILE}`, manage));
    expect(JSON.parse(localStorage.getItem(KEY)!).stencils[0].name).toBe("Renamed");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await click(named("Delete Second", palette()!.querySelector<HTMLElement>("[data-stencil-manager]")!));
    expect(JSON.parse(localStorage.getItem(KEY)!).stencils.map((s: { id: string }) => s.id)).toEqual(["saved1"]);
    await click(named("Delete all saved stencils", palette()!));
    expect(JSON.parse(localStorage.getItem(KEY)!).stencils).toEqual([]);
  });

  it("a malformed saved entry is left out and the tab says so", async () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 1, stencils: [saved("Fine"), { id: "x", name: 7 }] }));
    await inRoom();
    await openStencils();
    expect(tile("Fine")).not.toBeNull();
    expect(palette()!.textContent).toContain(STENCIL_TEXT.malformed(1));
  });

  it("with storage blocked the tab says so and the built-ins still work", async () => {
    await inRoom();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await openStencils();
    expect(palette()!.textContent).toContain(STENCIL_TEXT.blocked);
    expect(tile(BUILTIN_STENCILS[0]!.name)?.disabled).toBe(false);
  });

  it("a guest on a locked board, and everyone in a silent round: stencil tiles are off with the reason", async () => {
    await inRoom({ locked: true });
    await openStencils();
    const t = tile(BUILTIN_STENCILS[0]!.name)!;
    expect(t.disabled).toBe(true);
    expect(t.title).toContain(LOCK_TEXT.reason);
  });

  it("a silent round turns them off for the host too", async () => {
    await inRoom({ host: true, silent: { active: true, count: 0 } });
    await openStencils();
    expect(tile(BUILTIN_STENCILS[0]!.name)?.title).toContain(SILENT_TEXT.on);
  });
});

describe("Save as stencil", () => {
  it("from a selection: the dialog says what is kept and where; the name (40 characters) is saved as text", async () => {
    await inRoom({ notes: [noteAt(0), noteAt(1, { text: HOSTILE })] });
    for (const [i, n] of notesShown().entries()) {
      await act(async () => {
        n.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, shiftKey: i > 0 }));
        n.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: i > 0 }));
      });
      await settle();
    }
    await click(named("Save as stencil", boardBar()!) ?? named("Save as stencil"));
    const dialog = document.querySelector<HTMLElement>("[data-stencil-save]")!;
    expect(dialog.textContent).toContain("Includes the text of the selected items. Saved in this browser only.");
    const input = dialog.querySelector<HTMLInputElement>("input")!;
    expect(input.maxLength).toBe(40);
    await setValue(input, HOSTILE);
    await click([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Save"));
    const stored = JSON.parse(localStorage.getItem(KEY)!) as { stencils: { name: string; notes: { text: string }[] }[] };
    expect(stored.stencils[0]?.name).toBe(HOSTILE);
    expect(stored.stencils[0]?.notes.map((n) => n.text)).toContain(HOSTILE);
    await openStencils();
    expect(tile(HOSTILE)).not.toBeNull();
    expect(document.querySelector("img[src='x']")).toBeNull();
  });
});
