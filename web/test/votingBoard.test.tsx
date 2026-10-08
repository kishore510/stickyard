// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@stickyard/shared";
import { NOTICES } from "../src/rooms/session";
import { LOCK_TEXT } from "../src/facilitation/lock";
import { VOTE_HINTS, VOTE_TEXT } from "../src/voting/voting";
import {
  alex,
  boardBar,
  button,
  cleanupUi,
  click,
  inRoom,
  installUi,
  isOff,
  lastSocket,
  named,
  noteAt,
  notesShown,
  sam,
  selectNote,
  server,
  settle,
  tipOf,
  type FakeWebSocket,
} from "./helpers/ui";

/*
 * Dot voting UI, part 1: voting for everyone. The strip under the top bar, my dots on the
 * notes, the − / + controls on the selected note (and in Properties and the phone editor
 * sheet), reasons when they're off, optimistic votes rolled back with a notice, voting on a
 * locked board, undo never touching votes, phones, and what's announced.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPEN = { state: "open", budget: 5, round: 1 } as const;
const id = (i: number) => noteAt(i).id;
const strip = () => document.querySelector<HTMLElement>("[data-voting-strip]");
const announcer = () => document.querySelector<HTMLElement>("[data-vote-announcer]");
const nodeOf = (i: number) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id(i)}"]`);
const myDots = (i: number) => nodeOf(i)?.querySelector<HTMLElement>("[data-my-dots]") ?? null;
const controls = () => document.querySelector<HTMLElement>("[data-vote-controls]");
const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
const votesIn = (root: ParentNode | null | undefined) => root?.querySelector<HTMLElement>("[data-votes-section]") ?? null;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const add = (root: ParentNode | null | undefined) => named(VOTE_TEXT.add, root ?? document);
const remove = (root: ParentNode | null | undefined) => named(VOTE_TEXT.remove, root ?? document);
/** The reason text a vote button points at (aria-describedby), visible next to it. */
const reasonOf = (el: Element | null | undefined) =>
  (el?.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((ref) => document.getElementById(ref)?.textContent ?? "")
    .join(" ");

/** Joined, voter granted (unless `granted` is false), and a round open. */
async function voting({ granted = true, budget = 5, mine = [] as { noteId: string; count: number }[], ...room }: Omit<NonNullable<Parameters<typeof inRoom>[0]>, "mine"> & { granted?: boolean; budget?: number; mine?: { noteId: string; count: number }[] } = {}) {
  const socket = await inRoom({ notes: [noteAt(1), noteAt(2)], ...room });
  await server(socket, { data: { type: "votingChanged", voting: { ...OPEN, budget } } });
  if (granted) await server(socket, { data: { type: "voterGranted", remaining: budget - mine.reduce((s, v) => s + v.count, 0), mine } });
  return socket;
}

async function key(el: Element | null | undefined, k: string, mods: KeyboardEventInit = {}) {
  await act(async () => el?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods })));
  await settle();
}

/** A finger tap on a note (phones: opens the editor sheet when the board can be edited). */
async function tap(i: number) {
  const el = notesShown()[i];
  await act(async () => {
    el?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch", button: 0 }));
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

beforeEach(() => installUi());
afterEach(() => cleanupUi());

describe("the voting strip", () => {
  it("isn't there while voting is off; open: dots left of the budget; closed: results on the notes", async () => {
    const socket = await inRoom({ notes: [noteAt(1)] });
    expect(strip()).toBeNull();
    await server(socket, { data: { type: "votingChanged", voting: OPEN } });
    await server(socket, { data: { type: "voterGranted", remaining: 5, mine: [] } });
    expect(strip()?.textContent).toContain("Voting is open — you have 5 of 5 dots left.");
    await server(socket, { data: { type: "voterGranted", remaining: 3, mine: [{ noteId: id(1), count: 2 }] } });
    expect(strip()?.textContent).toContain("Voting is open — you have 3 of 5 dots left.");
    await server(socket, { data: { type: "votingChanged", voting: { ...OPEN, state: "closed" } } });
    expect(strip()?.textContent).toContain("Voting has ended — results are shown on the notes.");
    await server(socket, { data: { type: "votingChanged", voting: { ...OPEN, state: "off" } } });
    expect(strip()).toBeNull();
  });

  it("has no dismiss and isn't a live region itself (no per-dot announcements)", async () => {
    await voting();
    expect(strip()?.querySelector('[aria-label="Dismiss"], [aria-label="Close"]')).toBeNull();
    expect(strip()?.getAttribute("aria-live")).toBeNull();
    expect(strip()?.getAttribute("role")).toBeNull();
    expect(strip()?.closest("[aria-live]")).toBeNull();
  });

  it("shows on phones too", async () => {
    await voting({ isWide: false });
    expect(strip()?.textContent).toContain("5 of 5 dots left");
  });

  it("stacks under the lock banner for a guest on a locked board", async () => {
    await voting({ locked: true });
    const banner = document.querySelector("[data-lock-banner]");
    expect(banner).not.toBeNull();
    expect(strip()).not.toBeNull();
    expect(banner!.compareDocumentPosition(strip()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("announcements: start, reaching zero, stop; never per dot", () => {
  it("one polite region, always in the page", async () => {
    const socket = await inRoom({ notes: [noteAt(1), noteAt(2)] });
    expect(announcer()?.getAttribute("aria-live")).toBe("polite");
    expect(announcer()?.textContent).toBe("");
    await server(socket, { data: { type: "votingChanged", voting: { ...OPEN, budget: 2 } } });
    await server(socket, { data: { type: "voterGranted", remaining: 2, mine: [] } });
    expect(announcer()?.textContent).toBe(VOTE_TEXT.started(2));
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(announcer()?.textContent ?? ""));
    observer.observe(announcer()!, { childList: true, characterData: true, subtree: true });
    await selectNote(0);
    await click(add(controls()));
    await server(socket, { data: { type: "voteConfirmed", noteId: id(1), count: 1, remaining: 1 } });
    // One dot of two: nothing new said.
    expect(announcer()?.textContent).toBe(VOTE_TEXT.started(2));
    await click(add(controls()));
    await server(socket, { data: { type: "voteConfirmed", noteId: id(1), count: 2, remaining: 0 } });
    expect(announcer()?.textContent).toBe(VOTE_TEXT.none);
    await click(remove(controls()));
    await server(socket, { data: { type: "voteConfirmed", noteId: id(1), count: 1, remaining: 1 } });
    expect(announcer()?.textContent).toBe(VOTE_TEXT.none);
    await server(socket, { data: { type: "votingChanged", voting: { ...OPEN, budget: 2, state: "closed" } } });
    expect(announcer()?.textContent).toBe(VOTE_TEXT.ended);
    observer.disconnect();
    expect(seen.filter((t, i) => t !== seen[i - 1])).toEqual([VOTE_TEXT.none, VOTE_TEXT.ended]);
  });

  it("joining while a round is open says nothing (the strip is there to read)", async () => {
    await inRoom({ notes: [noteAt(1)], voting: OPEN });
    expect(announcer()?.textContent).toBe("");
  });
});

describe("my dots on the notes", () => {
  it("a badge with a dot icon and the number on each note I voted on, outside the note's text", async () => {
    await voting({ mine: [{ noteId: id(1), count: 2 }] });
    expect(myDots(1)?.textContent).toContain("2");
    expect(myDots(1)?.querySelector("svg")).not.toBeNull();
    expect(myDots(2)).toBeNull();
    expect(myDots(1)?.closest("[data-note-text]")).toBeNull();
    expect(notesShown()[0]?.contains(myDots(1)!)).toBe(false);
    // Not by colour alone, and named for screen readers on the note itself.
    expect(notesShown()[0]?.getAttribute("aria-label")).toContain("Your dots: 2.");
  });

  it("doesn't collide with the select tick, and both show on a selected note", async () => {
    await voting({ mine: [{ noteId: id(1), count: 1 }, { noteId: id(2), count: 1 }] });
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true })));
    await settle();
    expect(nodeOf(1)?.querySelector("[data-select-badge]")).not.toBeNull();
    expect(myDots(1)).not.toBeNull();
    expect(myDots(1)?.className).not.toContain("sy-select-badge");
  });

  it("deleted notes lose their badge and the dots come back", async () => {
    const socket = await voting({ mine: [{ noteId: id(1), count: 2 }] });
    expect(strip()?.textContent).toContain("3 of 5");
    await server(socket, { data: { type: "noteDeleted", id: id(1) } });
    expect(myDots(1)).toBeNull();
    expect(strip()?.textContent).toContain("5 of 5");
  });

  it("a new round clears them", async () => {
    const socket = await voting({ mine: [{ noteId: id(1), count: 2 }] });
    await server(socket, { data: { type: "votingChanged", voting: { ...OPEN, round: 2, budget: 3 } } });
    expect(myDots(1)).toBeNull();
    expect(strip()?.textContent).toContain("3 of 3");
  });
});

describe("the − and + controls on the selected note", () => {
  it("only while voting is open, for the one selected note; labelled; on the page, not in the note's text", async () => {
    const socket = await inRoom({ notes: [noteAt(1), noteAt(2)] });
    await selectNote(0);
    expect(controls()).toBeNull();
    await server(socket, { data: { type: "votingChanged", voting: OPEN } });
    await server(socket, { data: { type: "voterGranted", remaining: 5, mine: [] } });
    expect(controls()).not.toBeNull();
    expect(add(controls())).toBeDefined();
    expect(remove(controls())).toBeDefined();
    expect(notesShown()[0]?.contains(controls()!)).toBe(false);
    // The canvas leaves presses on them alone (no drag, no pan).
    expect(controls()?.className).toMatch(/nodrag/);
    expect(controls()?.className).toMatch(/nopan/);
    await click(document.querySelector<HTMLElement>(".react-flow__pane"));
    expect(controls()).toBeNull();
  });

  it("Add then Remove: optimistic, shown at once, one voteSet each", async () => {
    const socket = await voting();
    await selectNote(0);
    await click(add(controls()));
    expect(socket.ofType("voteSet")).toEqual([{ type: "voteSet", noteId: id(1), count: 1 }]);
    expect(myDots(1)?.textContent).toContain("1");
    expect(controls()?.querySelector("[data-vote-count]")?.textContent).toContain("1");
    expect(strip()?.textContent).toContain("4 of 5");
    await server(socket, { data: { type: "voteConfirmed", noteId: id(1), count: 1, remaining: 4 } });
    await click(add(controls()));
    await server(socket, { data: { type: "voteConfirmed", noteId: id(1), count: 2, remaining: 3 } });
    await click(remove(controls()));
    expect(socket.ofType("voteSet").at(-1)).toEqual({ type: "voteSet", noteId: id(1), count: 1 });
    expect(myDots(1)?.textContent).toContain("1");
  });

  it("D adds a dot and Shift+D takes one off on a focused note; + still zooms", async () => {
    const socket = await voting();
    await key(notesShown()[0], "d");
    expect(socket.ofType("voteSet")).toEqual([{ type: "voteSet", noteId: id(1), count: 1 }]);
    await server(socket, { data: { type: "voteConfirmed", noteId: id(1), count: 1, remaining: 4 } });
    await key(notesShown()[0], "D", { shiftKey: true });
    expect(socket.ofType("voteSet").at(-1)).toEqual({ type: "voteSet", noteId: id(1), count: 0 });
    await key(notesShown()[0], "+");
    expect(socket.ofType("voteSet")).toHaveLength(2);
  });
});

describe("off with a visible reason", () => {
  async function selected(setup: (socket: FakeWebSocket) => Promise<void>, options: Parameters<typeof voting>[0] = {}) {
    const socket = await voting(options);
    await selectNote(0);
    await setup(socket);
    return socket;
  }

  it("voter not granted yet: Joining the vote…", async () => {
    await selected(async () => {}, { granted: false });
    for (const b of [add(controls()), remove(controls())]) {
      expect(isOff(b)).toBe(true);
      expect(reasonOf(b)).toContain(VOTE_HINTS.joining);
    }
  });

  it("this vote is full", async () => {
    await selected(async (s) => server(s, { data: { type: "error", code: "voters_full", message: "Full." } }), { granted: false });
    expect(isOff(add(controls()))).toBe(true);
    expect(reasonOf(add(controls()))).toContain("This vote is full.");
  });

  it("nothing to remove, then no dots left", async () => {
    const socket = await selected(async () => {}, { budget: 1 });
    expect(isOff(add(controls()))).toBe(false);
    expect(isOff(remove(controls()))).toBe(true);
    expect(reasonOf(remove(controls()))).toContain(VOTE_HINTS.nothing);
    await click(add(controls()));
    await server(socket, { data: { type: "voteConfirmed", noteId: id(1), count: 1, remaining: 0 } });
    expect(isOff(add(controls()))).toBe(true);
    expect(reasonOf(add(controls()))).toContain("You have no dots left.");
    expect(isOff(remove(controls()))).toBe(false);
    // Off means the press does nothing.
    await click(add(controls()));
    expect(socket.ofType("voteSet")).toHaveLength(1);
  });

  it("disconnected", async () => {
    await selected(async (s) => server(s, "close"));
    expect(isOff(add(controls()))).toBe(true);
    expect(reasonOf(add(controls()))).toContain(VOTE_HINTS.offline);
  });

  it("note not saved yet", async () => {
    const socket = await voting();
    await click(document.querySelector<HTMLElement>('aside[aria-label="Palette"] [data-palette-item="note-yellow"]'));
    // Out of the inline edit, still selected and unsaved.
    await key(document.querySelector('textarea[data-inline="title"]'), "Escape");
    expect(socket.ofType("noteAdd")).toHaveLength(1);
    expect(isOff(add(controls()))).toBe(true);
    expect(reasonOf(add(controls()))).toContain("Wait until the note is saved.");
  });

  it("voting not open (closed): Properties' Votes says so", async () => {
    const socket = await voting({ mine: [{ noteId: id(1), count: 1 }] });
    await selectNote(0);
    await server(socket, { data: { type: "votingChanged", voting: { ...OPEN, state: "closed" } } });
    expect(controls()).toBeNull();
    const section = votesIn(properties());
    expect(isOff(add(section))).toBe(true);
    expect(reasonOf(add(section))).toContain(VOTE_HINTS.notOpen);
  });
});

describe("refusals roll the vote back with one notice", () => {
  it.each([
    ["over_budget", NOTICES.overBudget],
    ["voting_closed", NOTICES.votingClosed],
    ["no_voter", NOTICES.noVoter],
    ["voters_full", NOTICES.votersFull],
    ["rate_limited", NOTICES.tooQuick],
  ])("%s", async (code, notice) => {
    const socket = await voting();
    await selectNote(0);
    await click(add(controls()));
    expect(myDots(1)?.textContent).toContain("1");
    await server(socket, { data: { type: "error", code, message: "No.", noteId: id(1) } });
    expect(myDots(1)).toBeNull();
    expect(strip()?.textContent).toContain("5 of 5");
    expect(document.body.textContent).toContain(notice);
  });
});

describe("a locked board still takes votes (decided)", () => {
  it("a guest votes from the note controls and Properties while editing is off", async () => {
    const socket = await voting({ locked: true });
    await selectNote(0);
    expect(isOff(add(controls()))).toBe(false);
    await click(add(controls()));
    expect(socket.ofType("voteSet")).toHaveLength(1);
    const section = votesIn(properties());
    expect(isOff(add(section))).toBe(false);
    expect(properties()?.textContent).toContain(LOCK_TEXT.reason);
    await click(add(section));
    expect(socket.ofType("voteSet").at(-1)).toEqual({ type: "voteSet", noteId: id(1), count: 2 });
  });
});

describe("undo never touches votes", () => {
  it("Undo stays off after voting, and Ctrl+Z sends nothing and keeps my dots", async () => {
    const socket = await voting();
    await selectNote(0);
    await click(add(controls()));
    await server(socket, { data: { type: "voteConfirmed", noteId: id(1), count: 1, remaining: 4 } });
    const undo = named("Undo", boardBar() ?? document);
    expect(isOff(undo)).toBe(true);
    expect(tipOf(undo)?.textContent).not.toBe("Undo");
    const sent = socket.sent.length;
    await key(notesShown()[0], "z", { ctrlKey: true });
    await key(document.querySelector("main"), "z", { ctrlKey: true });
    expect(socket.sent.length).toBe(sent);
    expect(myDots(1)?.textContent).toContain("1");
  });
});

describe("Properties (one note selected)", () => {
  it("a Votes section with the count and the same buttons", async () => {
    const socket = await voting({ mine: [{ noteId: id(1), count: 2 }] });
    await selectNote(0);
    const section = votesIn(properties());
    expect(section?.querySelector("h3, h4")?.textContent).toBe("Votes");
    expect(section?.querySelector("[data-vote-count]")?.textContent).toContain("2");
    await click(add(section));
    expect(socket.ofType("voteSet")).toEqual([{ type: "voteSet", noteId: id(1), count: 3 }]);
    await click(remove(section));
    expect(socket.ofType("voteSet").at(-1)).toEqual({ type: "voteSet", noteId: id(1), count: 2 });
  });

  it("no Votes section while voting is off", async () => {
    await inRoom({ notes: [noteAt(1)] });
    await selectNote(0);
    expect(votesIn(properties())).toBeNull();
  });
});

describe("phones", () => {
  it("tap a note: the editor sheet has Votes; the strip and badge show", async () => {
    const socket = await voting({ isWide: false });
    await tap(0);
    const section = votesIn(dialog());
    expect(section).not.toBeNull();
    for (const b of [add(section), remove(section)]) expect(b?.className).toMatch(/size-touch|min-h-touch/);
    await click(add(section));
    expect(socket.ofType("voteSet")).toEqual([{ type: "voteSet", noteId: id(1), count: 1 }]);
    expect(section?.querySelector("[data-vote-count]")?.textContent).toContain("1");
    expect(strip()?.textContent).toContain("4 of 5");
    expect(myDots(1)?.textContent).toContain("1");
  });

  it("on a locked board (no editor sheet), the selected note's controls still vote", async () => {
    const socket = await voting({ isWide: false, locked: true });
    await tap(0);
    expect(dialog()).toBeNull();
    await click(add(controls()));
    expect(socket.ofType("voteSet")).toHaveLength(1);
  });

  it("controls are 44px targets", async () => {
    await voting({ isWide: false, locked: true });
    await tap(0);
    for (const b of [add(controls()), remove(controls())]) expect(b?.className).toMatch(/size-touch/);
  });
});

describe("reconnecting", () => {
  it("the reclaim after a reconnect brings my dots back", async () => {
    const socket = await voting({ isWide: true });
    await selectNote(0);
    await click(add(controls()));
    await server(socket, { data: { type: "voteConfirmed", noteId: id(1), count: 1, remaining: 4 } });
    await server(socket, "close");
    await act(async () => window.dispatchEvent(new Event("offline")));
    await settle();
    await click(button("Rejoin"));
    const next = lastSocket();
    await server(next, "open");
    await server(next, { data: { type: "welcome", protocolVersion: PROTOCOL_VERSION } });
    const me = { ...alex, id: "CCCCCCCCCCCCCCCC" };
    await server(next, { data: { type: "joined", you: me, participants: [me, sam], locked: false, timer: null, voting: OPEN, silent: { active: false, count: 0 } } });
    await server(next, { data: { type: "snapshot", notes: [noteAt(1), noteAt(2)] } });
    await server(next, { data: { type: "framesSnapshot", frames: [] } });
    expect(next.ofType("claimVoter")).toHaveLength(1);
    await server(next, { data: { type: "voterGranted", remaining: 4, mine: [{ noteId: id(1), count: 1 }] } });
    expect(myDots(1)?.textContent).toContain("1");
    expect(strip()?.textContent).toContain("4 of 5");
    vi.restoreAllMocks();
  });
});
