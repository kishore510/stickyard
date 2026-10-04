// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTICES } from "../src/rooms/session";
import { END_SESSION_CONFIRM, LOCK_TEXT } from "../src/facilitation/lock";
import { alex, boardBar, button, cleanupUi, click, inRoom, installUi, isOff, named, noteAt, notesShown, sam, selectNote, server, settle, tipOf } from "./helpers/ui";

/*
 * Facilitation UI, part 2: the lock (host toggle, guest banner and reasons), host markers and
 * End session. Courtesy UI: the relay is the authority (board_locked rollbacks still work).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const banner = () => document.querySelector<HTMLElement>("[data-lock-banner]");
const announcer = () => document.querySelector<HTMLElement>("[data-lock-announcer]");
const palette = () => document.querySelector<HTMLElement>('aside[aria-label="Palette"]');
const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
const lockButton = () => boardBar()?.querySelector<HTMLButtonElement>("button[data-lock-toggle]") ?? null;
const sessionSheet = () => document.querySelector<HTMLElement>('[role="dialog"] section[aria-labelledby="session-heading"]');

beforeEach(() => installUi());
afterEach(() => cleanupUi());

describe("the lock toggle (host, md and up)", () => {
  it("sits in a Session group at the end of the bar, labelled; pending until the relay answers; then Unlock with a Locked marker", async () => {
    const socket = await inRoom({ host: true });
    const group = boardBar()?.querySelector('[role="group"][aria-label="Session"]');
    expect(group).not.toBeNull();
    expect(lockButton()?.textContent).toContain("Lock board");
    await click(lockButton());
    expect(socket.ofType("lockSet")).toEqual([{ type: "lockSet", locked: true }]);
    // Not optimistic: it says it's waiting and can't be pressed again.
    expect(lockButton()?.textContent).toContain("Locking…");
    expect(isOff(lockButton())).toBe(true);
    await click(lockButton());
    expect(socket.ofType("lockSet")).toHaveLength(1);
    await server(socket, { data: { type: "lockChanged", locked: true } });
    expect(lockButton()?.textContent).toContain("Unlock board");
    expect(boardBar()?.querySelector("[data-locked-indicator]")?.textContent).toBe("Locked");
    // The host keeps editing and sees no banner.
    expect(banner()).toBeNull();
    expect(palette()?.querySelector<HTMLButtonElement>('[data-palette-item="note-yellow"]')?.disabled).toBe(false);
    await click(lockButton());
    expect(socket.ofType("lockSet").at(-1)).toEqual({ type: "lockSet", locked: false });
    await server(socket, { data: { type: "lockChanged", locked: false } });
    expect(lockButton()?.textContent).toContain("Lock board");
  });

  it("is off with the reason while disconnected", async () => {
    const socket = await inRoom({ host: true });
    await server(socket, "close");
    expect(isOff(lockButton())).toBe(true);
    expect(tipOf(lockButton())?.textContent).toBe("Not connected.");
  });

  it("a guest has no lock control at all", async () => {
    await inRoom();
    expect(lockButton()).toBeNull();
    expect(boardBar()?.querySelector('[role="group"][aria-label="Session"]')).toBeNull();
  });
});

describe("a guest while locked", () => {
  it("sees a calm banner (announced), and every control is off with the reason", async () => {
    const socket = await inRoom({ notes: [noteAt(1), noteAt(2)] });
    await server(socket, { data: { type: "lockChanged", locked: true } });
    expect(banner()?.textContent).toBe(LOCK_TEXT.banner);
    expect(banner()?.querySelector("button")).toBeNull();
    expect(announcer()?.getAttribute("aria-live")).toBe("polite");
    expect(announcer()?.textContent).toBe(LOCK_TEXT.banner);
    // The banner says it once: no second "can't add notes" notice under it.
    expect([...document.querySelectorAll("main p")].filter((p) => p.textContent === LOCK_TEXT.reason && !p.closest("aside"))).toEqual([]);
    // Palette tiles.
    const tile = palette()?.querySelector<HTMLButtonElement>('[data-palette-item="note-yellow"]');
    expect(tile?.disabled).toBe(true);
    expect(tile?.title).toContain(LOCK_TEXT.reason);
    // Bar commands (with a note selected).
    await selectNote(0);
    for (const label of ["Duplicate", "Delete", "Bring to front", "Send to back", "Undo", "Redo"]) {
      expect(isOff(named(label, boardBar() ?? document)), label).toBe(true);
      expect(tipOf(named(label, boardBar() ?? document))?.textContent, label).toBe(LOCK_TEXT.reason);
    }
    // Properties: the note's fields are read-only and say why.
    expect(properties()?.textContent).toContain(LOCK_TEXT.reason);
    // No inline editing.
    await act(async () => notesShown()[0]?.querySelector("[data-note-title]")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
    await settle();
    expect(document.querySelector('textarea[data-inline="title"]')).toBeNull();
    // Nothing went out.
    expect(socket.ofType("noteEdit")).toEqual([]);
  });

  it("Clear board is off with the reason", async () => {
    const socket = await inRoom({ notes: [noteAt(1)] });
    await server(socket, { data: { type: "lockChanged", locked: true } });
    const clear = button(/Clear board/, properties() ?? document);
    expect(isOff(clear)).toBe(true);
    expect(properties()?.textContent).toContain(LOCK_TEXT.reason);
  });

  it("unlocking: the banner goes, controls come back, and it's announced", async () => {
    const socket = await inRoom({ locked: true, notes: [noteAt(1)] });
    expect(banner()).not.toBeNull();
    await server(socket, { data: { type: "lockChanged", locked: false } });
    expect(banner()).toBeNull();
    expect(announcer()?.textContent).toBe(LOCK_TEXT.unlocked);
    expect(palette()?.querySelector<HTMLButtonElement>('[data-palette-item="note-yellow"]')?.disabled).toBe(false);
  });

  it("a change that slips through anyway (a stale page) is rolled back with the calm notice", async () => {
    const socket = await inRoom({ notes: [noteAt(1)] });
    await selectNote(0);
    const before = notesShown()[0]?.closest(".react-flow__node")?.getAttribute("style");
    await act(async () => notesShown()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    await settle();
    const moved = socket.sent.filter((m) => m.type === "noteMove" || m.type === "noteBatch");
    expect(moved.length).toBeGreaterThan(0);
    await server(socket, { data: { type: "error", code: "board_locked", message: "Locked.", noteId: noteAt(1).id } });
    expect(notesShown()[0]?.closest(".react-flow__node")?.getAttribute("style")).toBe(before);
    expect(document.body.textContent).toContain(NOTICES.locked);
  });
});

describe("host markers", () => {
  it("the Participants sheet says Host in text next to hosts", async () => {
    const socket = await inRoom();
    await server(socket, { data: { type: "participantUpdated", participant: { ...sam, host: true } } });
    await click(document.querySelector<HTMLElement>('header [aria-label^="Participants"]'));
    const items = [...document.querySelectorAll<HTMLElement>('[role="dialog"] li')];
    const samItem = items.find((li) => li.textContent?.includes("Sam"));
    expect(samItem?.querySelector("[data-host-badge]")?.textContent).toBe("Host");
    const alexItem = items.find((li) => li.textContent?.includes("Alex"));
    expect(alexItem?.querySelector("[data-host-badge]")).toBeNull();
  });

  it("the avatar stack names a host with a suffix; names stay plain text", async () => {
    const socket = await inRoom({ others: [{ ...sam, name: "<b>Sam</b>" }] });
    await server(socket, { data: { type: "participantUpdated", participant: { ...sam, name: "<b>Sam</b>", host: true } } });
    const faces = [...document.querySelectorAll<HTMLElement>("[data-avatar]")];
    expect(faces.map((f) => f.getAttribute("aria-label"))).toEqual(["Alex", "<b>Sam</b>, host"]);
    expect(document.querySelector("header b")).toBeNull();
  });

  it("you as host are marked too", async () => {
    await inRoom({ host: true });
    expect(document.querySelector<HTMLElement>("[data-avatar][data-you]")?.getAttribute("aria-label")).toBe(`${alex.name}, host`);
  });
});

describe("End session", () => {
  const endButton = () => button(/End session/, properties() ?? document);

  it("the host has it next to Clear board (nothing selected); one confirm with the effect; then endSession", async () => {
    const socket = await inRoom({ host: true });
    expect(endButton()).toBeDefined();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await click(endButton());
    expect(confirm).toHaveBeenCalledWith(END_SESSION_CONFIRM);
    expect(END_SESSION_CONFIRM).toBe("End this session for everyone? The board is deleted and can’t be restored.");
    expect(socket.ofType("endSession")).toEqual([]);
    confirm.mockReturnValue(true);
    await click(endButton());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(socket.ofType("endSession")).toEqual([{ type: "endSession" }]);
  });

  it("a guest has no End session", async () => {
    await inRoom();
    expect(endButton()).toBeUndefined();
  });

  it("is off with the reason while disconnected", async () => {
    const socket = await inRoom({ host: true });
    await server(socket, "close");
    expect(isOff(endButton())).toBe(true);
    expect(properties()?.textContent).toContain("Not connected.");
  });

  it("is off while the board is being cleared", async () => {
    const socket = await inRoom({ host: true, notes: [noteAt(1)] });
    vi.stubGlobal("confirm", () => true);
    await click(button(/Clear board/, properties() ?? document));
    expect(socket.ofType("noteBatch")).toHaveLength(1);
    expect(isOff(endButton())).toBe(true);
    expect(properties()?.textContent).toContain("The board is being cleared.");
  });

  it("after sessionEnded, the host sees the ended page too and the host key is gone", async () => {
    const socket = await inRoom({ host: true });
    await server(socket, { data: { type: "sessionEnded" } });
    await settle();
    expect(document.querySelector("[data-session-ended]")).not.toBeNull();
    expect(localStorage.getItem(`stickyard:host:${"a".repeat(22)}`)).toBeNull();
  });
});

describe("phones: the Session section", () => {
  it("the host gets Lock board and End session in the Participants sheet", async () => {
    const socket = await inRoom({ host: true, isWide: false });
    await click(document.querySelector<HTMLElement>('header [aria-label^="Participants"]'));
    vi.stubGlobal("confirm", () => true);
    await click(button(/Lock board/, sessionSheet() ?? document));
    expect(socket.ofType("lockSet")).toEqual([{ type: "lockSet", locked: true }]);
    await click(button(/End session/, sessionSheet() ?? document));
    expect(socket.ofType("endSession")).toEqual([{ type: "endSession" }]);
  });

  it("a guest on a phone sees the banner while locked", async () => {
    await inRoom({ isWide: false, locked: true });
    expect(banner()?.textContent).toBe(LOCK_TEXT.banner);
  });
});
