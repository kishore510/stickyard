// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Participant } from "@stickyard/shared";
import { cleanupUi, inRoom, installUi, noteAt, notesShown, sam, selectNote, server, settle, tipOf, type FakeWebSocket } from "./helpers/ui";

/*
 * Navigation in the page (v0.24.0): Zoom to selection in the view bar (off with a visible reason
 * while nothing is selected, S on the keyboard) and Participants' Go to (a person's last known
 * pointer; off with a reason until one is seen; a polite "Moved to ..." line after a jump).
 */

beforeEach(installUi);
afterEach(cleanupUi);

const zoomButton = () => document.querySelector<HTMLButtonElement>('[role="toolbar"][aria-label="View"] [data-tool="zoom-selection"]');
const goTo = (id: string) => document.querySelector<HTMLButtonElement>(`[data-goto="${id}"]`);
const viewNotice = () => document.querySelector<HTMLElement>("[data-view-notice]");

async function openParticipants() {
  const opener = document.querySelector<HTMLElement>('header [aria-label^="Participants"]');
  if (!opener) throw new Error("no Participants button");
  await act(async () => opener.click());
  await settle();
  expect(window.location.hash).toBe("#/participants");
}

async function cursorFrom(socket: FakeWebSocket, p: Participant, x = 1200, y = 900) {
  await server(socket, { data: { type: "cursorMoved", id: p.id, x, y } });
}

describe("Zoom to selection", () => {
  it("is in the view bar, off with a visible reason while nothing is selected, on once something is", async () => {
    await inRoom({ notes: [noteAt(0), noteAt(1)] });
    const b = zoomButton();
    expect(b).not.toBeNull();
    expect(b?.getAttribute("aria-label")).toBe("Zoom to selection");
    expect(b?.getAttribute("aria-disabled")).toBe("true");
    // Focusable, and the tooltip (shown on focus) gives the reason.
    await act(async () => b?.focus());
    expect(tipOf(b)?.hidden).toBe(false);
    expect(tipOf(b)?.textContent).toContain("Select notes, frames or shapes to zoom to them.");
    await selectNote(0);
    expect(zoomButton()?.getAttribute("aria-disabled")).toBeNull();
    expect(tipOf(zoomButton())?.textContent).toBe("Zoom to selection (S)");
  });

  it("phones don't have it (no view bar)", async () => {
    await inRoom({ isWide: false, notes: [noteAt(0)] });
    expect(document.querySelector('[data-tool="zoom-selection"]')).toBeNull();
  });
});

describe("Go to a person", () => {
  it("off with the reason until their pointer is seen; never for me", async () => {
    await inRoom();
    await openParticipants();
    const b = goTo(sam.id);
    expect(b).not.toBeNull();
    expect(b?.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(b?.getAttribute("aria-describedby") ?? "")?.textContent).toBe("No pointer position seen yet.");
    expect(document.querySelectorAll("[data-goto]")).toHaveLength(1);
  });

  it("on after a pointer is seen, also once it faded and went (cursorGone), and with Show cursors off", async () => {
    localStorage.setItem("stickyard:show-cursors", "off");
    const socket = await inRoom();
    await cursorFrom(socket, sam);
    await server(socket, { data: { type: "cursorGone", id: sam.id } });
    await openParticipants();
    expect(goTo(sam.id)?.getAttribute("aria-disabled")).toBeNull();
    // No pointer is drawn (Show is off), but the position is still known.
    expect(document.querySelector("[data-cursor]")).toBeNull();
  });

  it("a jump closes the sheet and says where it went, politely, with the name as plain text", async () => {
    const evil: Participant = { id: "EEEEEEEEEEEEEEEE", name: "<b>Robin Longname</b>!!", colourIndex: 2, host: false };
    const socket = await inRoom({ others: [sam, evil] });
    await cursorFrom(socket, evil);
    await openParticipants();
    const b = goTo(evil.id);
    // Truncated to 16 characters (NAME_MAX_SHOWN), as text.
    expect(b?.getAttribute("aria-label")).toBe("Go to <b>Robin Longna…’s pointer");
    await act(async () => b?.click());
    await settle();
    await settle();
    expect(window.location.hash).toMatch(/^#\/room\//);
    const status = viewNotice()?.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toBe("Moved to <b>Robin Longna…’s pointer.");
    expect(document.querySelector("b")).toBeNull();
  });

  it("is cleared when they leave (no button) and when the connection drops", async () => {
    const socket = await inRoom({ others: [sam] });
    await cursorFrom(socket, sam);
    await server(socket, { data: { type: "participant_left", id: sam.id } });
    await server(socket, { data: { type: "participant_joined", participant: sam } });
    await openParticipants();
    expect(goTo(sam.id)?.getAttribute("aria-disabled")).toBe("true");
  });

  it("works on phones too (they receive pointers)", async () => {
    const socket = await inRoom({ isWide: false });
    await cursorFrom(socket, sam);
    await openParticipants();
    expect(goTo(sam.id)?.getAttribute("aria-disabled")).toBeNull();
    expect(notesShown()).toHaveLength(0);
  });

  it("writes nothing to browser storage", async () => {
    const socket = await inRoom();
    const set = vi.spyOn(Storage.prototype, "setItem");
    await cursorFrom(socket, sam);
    await openParticipants();
    await act(async () => goTo(sam.id)?.click());
    await settle();
    expect(set).not.toHaveBeenCalled();
  });
});
