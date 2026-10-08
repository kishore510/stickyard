// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SEALED_PER_WRITER } from "@stickyard/shared";
import { SILENT_HINTS, SILENT_TEXT, SILENT_UI, confirmRevealText, confirmStartText } from "../src/silent/silent";
import { NOTICES } from "../src/rooms/session";
import { alex, boardBar, button, cleanupUi, click, frameAt, inRoom, installUi, isOff, named, noteAt, server, setReducedMotion, settle } from "./helpers/ui";

/*
 * Silent brainstorm, part 3 (UI): the strip, the host's Start and Reveal (with their confirms and
 * pending state), the "Only you can see this" marker on my hidden notes, the honest note count,
 * the frame grip off with the reason, and the reveal (strip gone, one announcement).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACTIVE = (count: number) => ({ active: true, count });
const OPEN = { state: "open", budget: 5, round: 1 } as const;
const strip = () => document.querySelector<HTMLElement>("[data-silent-strip]");
const votingStrip = () => document.querySelector<HTMLElement>("[data-voting-strip]");
const announcer = () => document.querySelector<HTMLElement>("[data-silent-announcer]");
const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
const hostIn = (root: ParentNode | null | undefined) => root?.querySelector<HTMLElement>("[data-host-silent]") ?? null;
const sessionSheet = () => document.querySelector<HTMLElement>('[role="dialog"] section[aria-labelledby="session-heading"]');
const nodeOf = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
const markerOf = (id: string) => nodeOf(id)?.querySelector<HTMLElement>("[data-sealed-marker]") ?? null;
const cardOf = (id: string) => nodeOf(id)?.querySelector<HTMLElement>('[aria-roledescription="note"]') ?? null;
const reasonOf = (el: Element | null | undefined) =>
  (el?.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((ref) => document.getElementById(ref)?.textContent ?? "")
    .join(" ");
const mineNote = (i: number) => noteAt(i, { authorId: alex.id });

/** The host's silent controls from md up: the Silent brainstorm button in the bar's Session group opens them. */
async function hostControls() {
  await click(named(SILENT_UI.heading, boardBar() ?? document));
  return hostIn(boardBar());
}

beforeEach(() => installUi());
afterEach(() => cleanupUi());

describe("the strip", () => {
  it("absent with no round; while one runs, what's happening and the numbers (a guest)", async () => {
    const socket = await inRoom({ notes: [noteAt(1)] });
    expect(strip()).toBeNull();
    await server(socket, { data: { type: "silentChanged", active: true, count: 0 } });
    expect(strip()?.textContent).toContain(SILENT_UI.strip);
    expect(strip()?.textContent).toContain("You’ve written 0. 0 notes written in total.");
    // Counts follow silentChanged (others' notes) and my own adds.
    await server(socket, { data: { type: "silentChanged", active: true, count: 3 } });
    expect(strip()?.textContent).toContain("You’ve written 0. 3 notes written in total.");
  });

  it("the host sees the same strip", async () => {
    await inRoom({ host: true, notes: [mineNote(1)], silent: ACTIVE(4), mine: [mineNote(1).id] });
    expect(strip()?.textContent).toContain("You’ve written 1. 4 notes written in total.");
  });

  it("near my cap it says how many I have left", async () => {
    const ids = Array.from({ length: MAX_SEALED_PER_WRITER - 3 }, (_, i) =>
      noteAt(i, { id: `S${String(i).padStart(15, "0")}`, x: 40 + (i % 10) * 220, y: 60 + Math.floor(i / 10) * 220, authorId: alex.id }),
    );
    await inRoom({ notes: ids, silent: ACTIVE(ids.length), mine: ids.map((n) => n.id) });
    expect(strip()?.textContent).toContain("3 left.");
  }, 20_000);

  it("phones (360 px): the same strip", async () => {
    await inRoom({ isWide: false, silent: ACTIVE(2), mine: [] });
    expect(strip()?.textContent).toContain(SILENT_UI.strip);
    expect(strip()?.textContent).toContain("You’ve written 0. 2 notes written in total.");
  });

  it("with voting open too, both strips show, voting first, then silent", async () => {
    await inRoom({ notes: [noteAt(1)], voting: OPEN, silent: ACTIVE(0), mine: [] });
    const v = votingStrip();
    const s = strip();
    expect(v).not.toBeNull();
    expect(s).not.toBeNull();
    expect(v!.compareDocumentPosition(s!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("announces the start once, politely; plain text, no animation (reduced motion or not)", async () => {
    setReducedMotion(true);
    const socket = await inRoom({ notes: [noteAt(1)] });
    expect(announcer()?.getAttribute("aria-live")).toBe("polite");
    expect(announcer()?.textContent).toBe("");
    await server(socket, { data: { type: "silentChanged", active: true, count: 0 } });
    expect(announcer()?.textContent).toBe(SILENT_UI.started);
    expect(strip()?.getAttribute("aria-live")).toBeNull();
    expect(strip()?.className).not.toMatch(/animate|transition/);
  });

  it("End session during a round: the strip goes with the board", async () => {
    const socket = await inRoom({ silent: ACTIVE(2), mine: [] });
    expect(strip()).not.toBeNull();
    await server(socket, { data: { type: "sessionEnded" } });
    expect(strip()).toBeNull();
  });
});

describe("the host's Start and Reveal", () => {
  it("guests never see them, md and up or on phones", async () => {
    await inRoom({ notes: [noteAt(1)] });
    expect(named(SILENT_UI.heading, boardBar() ?? document)).toBeUndefined();
    expect(hostIn(document)).toBeNull();
    await cleanupUi();
    installUi();
    await inRoom({ isWide: false });
    await click(document.querySelector<HTMLElement>('header [aria-label^="Participants"]'));
    expect(hostIn(document)).toBeNull();
  });

  it("Start: one confirm with the facts; cancel sends nothing; confirm sends silentStart, then waits for the relay", async () => {
    const socket = await inRoom({ host: true, notes: [noteAt(1)] });
    const host = await hostControls();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await click(button(SILENT_UI.start, host ?? undefined));
    expect(confirm.mock.calls).toEqual([[confirmStartText({ locked: false, votingOpen: false })]]);
    expect(socket.ofType("silentStart")).toEqual([]);
    confirm.mockReturnValue(true);
    await click(button(SILENT_UI.start, host ?? undefined));
    expect(socket.ofType("silentStart")).toEqual([{ type: "silentStart" }]);
    // Pending: both off with the reason until the relay answers.
    const start = button(SILENT_UI.start, hostIn(boardBar()) ?? undefined);
    expect(isOff(start)).toBe(true);
    expect(reasonOf(start)).toBe(SILENT_HINTS.waiting);
    await server(socket, { data: { type: "silentChanged", active: true, count: 0 } });
    const after = hostIn(boardBar());
    expect(reasonOf(button(SILENT_UI.start, after ?? undefined))).toBe(SILENT_HINTS.running);
    expect(isOff(button(SILENT_UI.reveal, after ?? undefined))).toBe(false);
  });

  it("Start's confirm says the lock stops guests, and that an open vote stays open; starting during a vote is allowed (the relay allows it)", async () => {
    await inRoom({ host: true, locked: true, voting: OPEN, notes: [noteAt(1)] });
    const host = await hostControls();
    expect(isOff(button(SILENT_UI.start, host ?? undefined))).toBe(false);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await click(button(SILENT_UI.start, host ?? undefined));
    expect(confirm.mock.calls).toEqual([[confirmStartText({ locked: true, votingOpen: true })]]);
  });

  it("Reveal: one confirm with the number hidden; confirm sends silentReveal", async () => {
    const socket = await inRoom({ host: true, silent: ACTIVE(7), mine: [] });
    const host = await hostControls();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await click(button(SILENT_UI.reveal, host ?? undefined));
    expect(confirm.mock.calls).toEqual([[confirmRevealText(7)]]);
    expect(socket.ofType("silentReveal")).toEqual([]);
    confirm.mockReturnValue(true);
    await click(button(SILENT_UI.reveal, host ?? undefined));
    expect(socket.ofType("silentReveal")).toEqual([{ type: "silentReveal" }]);
  });

  it("off with visible reasons: Reveal with no round; both offline", async () => {
    const socket = await inRoom({ host: true });
    const host = await hostControls();
    const reveal = button(SILENT_UI.reveal, host ?? undefined);
    expect(isOff(reveal)).toBe(true);
    expect(reasonOf(reveal)).toBe(SILENT_HINTS.none);
    expect(host?.textContent).toContain(SILENT_HINTS.none);
    await server(socket, "close");
    const offline = hostIn(boardBar());
    expect(reasonOf(button(SILENT_UI.start, offline ?? undefined))).toBe(SILENT_HINTS.offline);
  });

  it("a refusal: the pending state ends and the existing plain message shows", async () => {
    const socket = await inRoom({ host: true });
    const host = await hostControls();
    vi.stubGlobal("confirm", vi.fn(() => true));
    await click(button(SILENT_UI.start, host ?? undefined));
    await server(socket, { data: { type: "error", code: "not_host", message: "No." } });
    expect(document.body.textContent).toContain(NOTICES.notHost);
    expect(isOff(button(SILENT_UI.start, hostIn(boardBar()) ?? undefined))).toBe(false);
  });

  it("44 px buttons: the touch-target class", async () => {
    await inRoom({ host: true });
    const host = await hostControls();
    for (const label of [SILENT_UI.start, SILENT_UI.reveal]) expect(button(label, host ?? undefined)?.className).toMatch(/min-h-touch|h-touch/);
  });

  it("phones: in the Session section of the Participants sheet", async () => {
    const socket = await inRoom({ host: true, isWide: false });
    await click(document.querySelector<HTMLElement>('header [aria-label^="Participants"]'));
    const host = hostIn(sessionSheet());
    expect(host).not.toBeNull();
    vi.stubGlobal("confirm", vi.fn(() => true));
    await click(button(SILENT_UI.start, host ?? undefined));
    expect(socket.ofType("silentStart")).toEqual([{ type: "silentStart" }]);
  });
});

describe("my hidden notes are marked", () => {
  it("“Only you can see this” on my sealed notes only (icon and text, in the accessible name); gone after the reveal", async () => {
    const socket = await inRoom({ notes: [noteAt(1), mineNote(2)], silent: ACTIVE(1), mine: [mineNote(2).id] });
    expect(markerOf(noteAt(1).id)).toBeNull();
    const marker = markerOf(mineNote(2).id);
    expect(marker).not.toBeNull();
    expect(marker?.querySelector("svg")).not.toBeNull();
    expect(marker?.textContent).toContain("Only you");
    expect(cardOf(mineNote(2).id)?.getAttribute("aria-label")).toContain(SILENT_UI.marker);
    expect(cardOf(noteAt(1).id)?.getAttribute("aria-label")).not.toContain(SILENT_UI.marker);
    await server(socket, { data: { type: "notesRevealed", notes: [mineNote(2)], final: true } });
    await server(socket, { data: { type: "silentChanged", active: false, count: 0 } });
    expect(markerOf(mineNote(2).id)).toBeNull();
    expect(cardOf(mineNote(2).id)?.getAttribute("aria-label")).not.toContain(SILENT_UI.marker);
  });

  it("Properties says the same for a selected sealed note of mine, not for others", async () => {
    await inRoom({ notes: [noteAt(1), mineNote(2)], silent: ACTIVE(1), mine: [mineNote(2).id] });
    await click(cardOf(mineNote(2).id));
    expect(properties()?.querySelector("[data-sealed-line]")?.textContent).toBe(SILENT_UI.sealedLine);
    await click(cardOf(noteAt(1).id));
    expect(properties()?.querySelector("[data-sealed-line]")).toBeNull();
  });
});

describe("the note count in Properties", () => {
  it("while a round runs: the notes I can see, the hidden ones, and the honest total", async () => {
    await inRoom({ notes: [noteAt(1), noteAt(3), mineNote(2)], silent: ACTIVE(5), mine: [mineNote(2).id] });
    expect(properties()?.textContent).toContain("3 notes you can see, 4 hidden: 7 of 200 notes");
  });

  it("no hidden notes of others: M = 0", async () => {
    await inRoom({ notes: [mineNote(2)], silent: ACTIVE(1), mine: [mineNote(2).id] });
    expect(properties()?.textContent).toContain("1 note you can see, 0 hidden: 1 of 200 notes");
  });

  it("a round with no notes of mine", async () => {
    await inRoom({ notes: [noteAt(1)], silent: ACTIVE(2), mine: [] });
    expect(properties()?.textContent).toContain("1 note you can see, 2 hidden: 3 of 200 notes");
  });

  it("no round: as before", async () => {
    await inRoom({ notes: [noteAt(1)] });
    expect(properties()?.textContent).toContain("1 of 200 notes");
    expect(properties()?.textContent).not.toContain("hidden");
  });
});

describe("frames during a round", () => {
  it("the grip looks off, with the reason on hover and for assistive tech; the drag is still refused", async () => {
    const socket = await inRoom({ frames: [frameAt(0)], silent: ACTIVE(0), mine: [] });
    const frame = document.querySelector<HTMLElement>("[data-frame-id]");
    const header = frame?.querySelector<HTMLElement>("[data-frame-handle='header']");
    expect(header?.hasAttribute("data-move-off")).toBe(true);
    expect(header?.getAttribute("title")).toBe(SILENT_TEXT.on);
    expect(header?.className).toContain("cursor-not-allowed");
    expect(reasonOf(frame)).toContain(SILENT_TEXT.on);
    await server(socket, { data: { type: "silentChanged", active: false, count: 0 } });
    const after = document.querySelector<HTMLElement>("[data-frame-id] [data-frame-handle='header']");
    expect(after?.hasAttribute("data-move-off")).toBe(false);
    expect(after?.getAttribute("title")).toBeNull();
  });
});

describe("votes during a round (voting open when it starts)", () => {
  it("notes everyone sees keep their vote controls; my hidden notes have none", async () => {
    const socket = await inRoom({ notes: [noteAt(1), mineNote(2)], voting: OPEN });
    await server(socket, { data: { type: "voterGranted", remaining: 5, mine: [] } });
    await server(socket, { data: { type: "silentChanged", active: true, count: 0 } });
    await server(socket, { data: { type: "noteAdded", note: mineNote(3) } });
    await settle();
    await click(cardOf(noteAt(1).id));
    expect(document.querySelector("[data-vote-controls]")).not.toBeNull();
    await click(cardOf(mineNote(3).id));
    expect(document.querySelector("[data-vote-controls]")).toBeNull();
  });
});

describe("the reveal", () => {
  it("the strip goes, one polite announcement with the count, no repeat for a late chunk; nothing moves the view", async () => {
    const socket = await inRoom({ host: true, notes: [mineNote(1)], silent: ACTIVE(3), mine: [mineNote(1).id] });
    const transform = () => document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform;
    const before = transform();
    await server(socket, { data: { type: "notesRevealed", notes: [mineNote(1), noteAt(2)], final: false } });
    await server(socket, { data: { type: "notesRevealed", notes: [noteAt(3)], final: true } });
    await server(socket, { data: { type: "silentChanged", active: false, count: 0 } });
    expect(strip()).toBeNull();
    expect(announcer()?.textContent).toBe("3 notes revealed.");
    expect(document.querySelectorAll('[aria-roledescription="note"]')).toHaveLength(3);
    await server(socket, { data: { type: "notesRevealed", notes: [noteAt(3)], final: true } });
    expect(announcer()?.textContent).toBe("3 notes revealed.");
    expect(document.querySelectorAll('[aria-roledescription="note"]')).toHaveLength(3);
    expect(transform()).toBe(before);
  });

  it("a revealed note out of view: one line with Fit to notes, and the view doesn't move by itself", async () => {
    const socket = await inRoom({ notes: [noteAt(1)], silent: ACTIVE(1), mine: [] });
    const transform = () => document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform;
    const before = transform();
    const far = noteAt(9, { x: 6000, y: 3700 });
    await server(socket, { data: { type: "notesRevealed", notes: [far], final: true } });
    await server(socket, { data: { type: "silentChanged", active: false, count: 0 } });
    await settle();
    const line = document.querySelector<HTMLElement>('[data-view-notice="revealed"]');
    expect(line?.textContent).toContain(SILENT_UI.outside);
    expect(transform()).toBe(before);
    await click(button(SILENT_UI.fit, line ?? undefined));
    expect(document.querySelector('[data-view-notice="revealed"]')).toBeNull();
  });

  it("a reveal that brings nothing new to this page (only my own notes): no Fit line", async () => {
    const socket = await inRoom({ notes: [mineNote(1)], silent: ACTIVE(1), mine: [mineNote(1).id] });
    await server(socket, { data: { type: "notesRevealed", notes: [mineNote(1)], final: true } });
    await server(socket, { data: { type: "silentChanged", active: false, count: 0 } });
    await settle();
    expect(document.querySelector('[data-view-notice="revealed"]')).toBeNull();
    expect(announcer()?.textContent).toBe("1 note revealed.");
  });
});
