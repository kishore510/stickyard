// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_NOTES_PER_ROOM, NOTE_DEFAULTS } from "@stickyard/shared";
import { BOARD_FILE_FORMAT } from "../src/export/boardFile";
import { IMPORT_MAX_BYTES, IMPORT_TEXT } from "../src/importer/parse";
import { LOCK_TEXT } from "../src/facilitation/lock";
import { SILENT_TEXT } from "../src/silent/silent";
import { NOTE_TOOL_REASONS } from "../src/canvas/tools";
import { byText, cleanupUi, click, inRoom, installUi, isOff, noteAt, server, settle } from "./helpers/ui";

/*
 * Import (v0.40.0, part 2): from Properties (md and up) and the menu (every width, phones too), a
 * sheet to choose a board file or type, paste or choose text, a preview with the counts, then
 * Place or Cancel. Off with the reason as text on a locked board (guests), during a silent round
 * and while disconnected; Place off with what wouldn't fit. A placement is announced politely.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => installUi());
afterEach(() => cleanupUi());

const sheet = () => document.querySelector<HTMLElement>("[data-import-sheet]");
const q = <T extends HTMLElement>(sel: string) => sheet()?.querySelector<T>(sel) ?? null;
const openButton = () => document.querySelector<HTMLButtonElement>('aside[aria-label="Properties"] [data-import-open]');
const status = () => q<HTMLElement>("[data-import-status]");
const preview = () => q<HTMLElement>("[data-import-preview]");
const place = () => q<HTMLButtonElement>("[data-import-place]");
const cancel = () => q<HTMLButtonElement>("[data-import-cancel]");
const announcer = () => document.querySelector<HTMLElement>("[data-import-announcer]");
const reasonOf = (el: Element | null) => document.getElementById(el?.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
const itemsAdds = (socket: { sent: unknown[] }) => (socket.sent as { type?: string }[]).filter((m) => m.type === "itemsAdd");

const fileText = JSON.stringify({
  format: BOARD_FILE_FORMAT,
  formatVersion: 1,
  notes: [
    { ref: "n1", x: 0, y: 0, text: "From a file", ...NOTE_DEFAULTS, color: "pink" },
    { ref: "n2", x: 200, y: 0, text: "Second", ...NOTE_DEFAULTS, color: "blue" },
  ],
  shapes: [],
  frames: [{ ref: "f1", x: 0, y: 300, w: 640, h: 400, title: "Area", color: "neutral", titleFontSize: "m", titleBold: true, titleItalic: false, titleTextColor: "auto", titleAlign: "left" }],
  arrows: [],
  groups: [{ label: "Pair", color: "blue", members: ["n1", "n2"] }],
  stack: ["n1", "n2"],
});

async function choose(selector: string, file: File) {
  const input = q<HTMLInputElement>(selector);
  if (!input) throw new Error(`no ${selector}`);
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  for (let i = 0; i < 20 && !preview() && !status()?.textContent; i++) await settle();
}

async function fill(text: string) {
  const area = q<HTMLTextAreaElement>("[data-import-text]");
  if (!area) throw new Error("no text box");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openFromMenu() {
  await click(document.querySelector<HTMLElement>('header button[aria-label^="Menu"]'));
  await click(byText('[role="menuitem"]', "Import"));
}

describe("Import from Properties", () => {
  it("opens a sheet with a board file and a text source", async () => {
    await inRoom();
    expect(openButton()?.className).toContain("h-touch");
    await click(openButton());
    expect(sheet()?.closest('[role="dialog"]')).not.toBeNull();
    expect(q("[data-import-file]")?.getAttribute("accept")).toContain(".json");
    expect(q("[data-import-txt]")?.getAttribute("accept")).toContain(".txt");
    expect(q("[data-import-text]")?.getAttribute("aria-label") ?? document.querySelector(`label[for="${q("[data-import-text]")?.id}"]`)?.textContent).toBeTruthy();
    expect(status()?.getAttribute("aria-live")).toBe("polite");
  });

  it("a board file: preview with counts, then Place adds it and says so politely", async () => {
    const socket = await inRoom();
    await click(openButton());
    await choose("[data-import-file]", new File([fileText], "board.json", { type: "application/json" }));
    expect(preview()?.textContent).toContain("2 notes");
    expect(preview()?.textContent).toContain("1 frame");
    expect(preview()?.textContent).toContain("1 group");
    expect(itemsAdds(socket)).toHaveLength(0);
    expect(place()?.className).toContain("h-touch");
    await click(place());
    await settle();
    expect(itemsAdds(socket)).toHaveLength(1);
    expect(sheet()).toBeNull();
    expect(announcer()?.getAttribute("aria-live")).toBe("polite");
    expect(announcer()?.textContent).toBe(IMPORT_TEXT.placed({ notes: 2, shapes: 0, frames: 1, arrows: 0, groups: 1 }));
  });

  it("Cancel sends nothing and goes back", async () => {
    const socket = await inRoom();
    await click(openButton());
    await choose("[data-import-file]", new File([fileText], "board.json", { type: "application/json" }));
    await click(cancel());
    expect(preview()).toBeNull();
    expect(itemsAdds(socket)).toHaveLength(0);
  });

  it("a file that isn't a board file, or is too big, gets a calm reason and no preview", async () => {
    await inRoom();
    await click(openButton());
    await choose("[data-import-file]", new File(['{"format":"something-else","formatVersion":1}'], "x.json"));
    expect(preview()).toBeNull();
    expect(status()?.textContent).toBe(IMPORT_TEXT.notBoardFile);
    const huge = new File(["{}"], "huge.json");
    Object.defineProperty(huge, "size", { value: IMPORT_MAX_BYTES + 1 });
    await choose("[data-import-file]", huge);
    expect(status()?.textContent).toBe(IMPORT_TEXT.tooLarge);
  });

  it("pasted text: one note per line, previewed, then placed", async () => {
    const socket = await inRoom();
    await click(openButton());
    await fill("Alpha\n\n  Beta  \nGamma");
    await click(q("[data-import-preview-text]"));
    expect(preview()?.textContent).toContain("3 notes");
    await click(place());
    await settle();
    const sent = itemsAdds(socket)[0] as { notes: { text: string }[] };
    expect(sent.notes.map((n) => n.text)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("a .txt file is read the same way", async () => {
    await inRoom();
    await click(openButton());
    await choose("[data-import-txt]", new File(["one\ntwo\n"], "notes.txt", { type: "text/plain" }));
    expect(preview()?.textContent).toContain("2 notes");
  });

  it("Place is off, saying what wouldn't fit, when the board hasn't room; nothing is sent", async () => {
    const socket = await inRoom({ notes: Array.from({ length: MAX_NOTES_PER_ROOM - 1 }, (_, i) => noteAt(i + 1)) });
    await click(openButton());
    await fill("a\nb\nc");
    await click(q("[data-import-preview-text]"));
    expect(isOff(place())).toBe(true);
    expect(reasonOf(place())).toBe(IMPORT_TEXT.noRoom([["notes", 3, 1]]));
    await click(place());
    expect(itemsAdds(socket)).toHaveLength(0);
  });

  it("is off for a guest on a locked board, during a silent round and while disconnected, saying why", async () => {
    await inRoom({ locked: true });
    expect(isOff(openButton())).toBe(true);
    expect(reasonOf(openButton())).toBe(LOCK_TEXT.reason);
    await cleanupUi();
    installUi();
    await inRoom({ silent: { active: true, count: 0 } });
    expect(reasonOf(openButton())).toBe(SILENT_TEXT.on);
    await cleanupUi();
    installUi();
    const socket = await inRoom();
    await server(socket, "close");
    expect(isOff(openButton())).toBe(true);
    expect(reasonOf(openButton())).toBe(NOTE_TOOL_REASONS.disconnected);
  });
});

describe("Import on phones", () => {
  it("opens from the menu; the preview's Place and Cancel are 44px targets", async () => {
    const socket = await inRoom({ isWide: false });
    await openFromMenu();
    expect(sheet()).not.toBeNull();
    await fill("Phone note");
    await click(q("[data-import-preview-text]"));
    expect(place()?.className).toContain("h-touch");
    expect(cancel()?.className).toContain("h-touch");
    await click(place());
    await settle();
    expect(itemsAdds(socket)).toHaveLength(1);
  });

  it("is off on a locked board for a guest, with the reason shown", async () => {
    await inRoom({ isWide: false, locked: true });
    await openFromMenu();
    const reason = q<HTMLElement>("[data-import-reason]");
    expect(reason?.textContent).toBe(LOCK_TEXT.reason);
    await fill("x");
    expect(isOff(q("[data-import-preview-text]"))).toBe(true);
  });
});
