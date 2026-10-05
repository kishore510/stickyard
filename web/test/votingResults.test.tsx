// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_VOTE_HINTS, HOST_VOTE_TEXT, VOTE_TEXT } from "../src/voting/voting";
import { CLEAR_HINTS } from "../src/properties/clearBoard";
import { boardBar, button, cleanupUi, click, inRoom, installUi, isOff, named, noteAt, server, settle } from "./helpers/ui";

/*
 * Dot voting UI, part 2: the host's controls (Start with a budget, Stop and reveal, Clear votes)
 * and the results (total badges, Top voted, the Results list in Properties and on phones).
 * Anonymous: nothing shows who voted.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPEN = { state: "open", budget: 5, round: 1 } as const;
const CLOSED = { ...OPEN, state: "closed" } as const;
const id = (i: number) => noteAt(i).id;
const nodeOf = (i: number) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id(i)}"]`);
const totalOf = (i: number) => nodeOf(i)?.querySelector<HTMLElement>("[data-vote-total]") ?? null;
const topOf = (i: number) => nodeOf(i)?.querySelector<HTMLElement>("[data-top-voted]") ?? null;
const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const hostIn = (root: ParentNode | null | undefined) => root?.querySelector<HTMLElement>("[data-host-voting]") ?? null;
const resultsIn = (root: ParentNode | null | undefined) => root?.querySelector<HTMLElement>("[data-results]") ?? null;
const rows = (root: ParentNode | null | undefined) => [...(root?.querySelectorAll<HTMLElement>("[data-result-row]") ?? [])];
const strip = () => document.querySelector<HTMLElement>("[data-voting-strip]");
const announcer = () => document.querySelector<HTMLElement>("[data-vote-announcer]");
const sessionSheet = () => document.querySelector<HTMLElement>('[role="dialog"] section[aria-labelledby="session-heading"]');
const reasonOf = (el: Element | null | undefined) =>
  (el?.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((ref) => document.getElementById(ref)?.textContent ?? "")
    .join(" ");

/** The host's voting controls from md up: the Voting button in the bar's Session group opens them. */
async function hostControls() {
  await click(named("Voting", boardBar() ?? document));
  return hostIn(boardBar());
}

/** Five notes; a closed round with these totals (votesRevealed). */
async function closedWith(totals: { noteId: string; count: number }[], room: Parameters<typeof inRoom>[0] = {}) {
  const socket = await inRoom({ notes: [1, 2, 3, 4, 5].map((i) => noteAt(i, { text: `Idea ${i}\nmore` })), ...room });
  await server(socket, { data: { type: "votingChanged", voting: OPEN } });
  await server(socket, { data: { type: "votingChanged", voting: CLOSED } });
  await server(socket, { data: { type: "votesRevealed", round: 1, totals } });
  return socket;
}

beforeEach(() => installUi());
afterEach(() => cleanupUi());

describe("host controls: only the host has them", () => {
  it("a guest has no Voting controls in the bar or on phones", async () => {
    await inRoom({ notes: [noteAt(1)] });
    expect(named("Voting", boardBar() ?? document)).toBeUndefined();
    expect(hostIn(document)).toBeNull();
  });

  it("the host has them in the Session group (md and up)", async () => {
    await inRoom({ host: true });
    const host = await hostControls();
    expect(host).not.toBeNull();
    expect(button(HOST_VOTE_TEXT.start, host ?? undefined)).toBeDefined();
    expect(host?.textContent).toContain(HOST_VOTE_TEXT.startNote);
  });

  it("phones: in the Session section of the Participants sheet, for the host only", async () => {
    const socket = await inRoom({ host: true, isWide: false });
    await click(document.querySelector<HTMLElement>('header [aria-label^="Participants"]'));
    const host = hostIn(sessionSheet());
    expect(host).not.toBeNull();
    await click(button(HOST_VOTE_TEXT.start, host ?? undefined));
    expect(socket.ofType("voteStart")).toEqual([{ type: "voteStart", budget: 5 }]);
  });

  it("phones: a guest's Participants sheet has none", async () => {
    await inRoom({ isWide: false });
    await click(document.querySelector<HTMLElement>('header [aria-label^="Participants"]'));
    expect(dialog()).not.toBeNull();
    expect(hostIn(dialog())).toBeNull();
  });
});

describe("Start voting and its budget", () => {
  it("a stepper from 1 to 20, default 5; Start sends that budget", async () => {
    const socket = await inRoom({ host: true });
    const host = await hostControls();
    const value = () => host?.querySelector("[data-vote-budget]")?.textContent;
    expect(value()).toBe("5");
    for (let i = 0; i < 6; i++) await click(named("Fewer dots", host ?? document));
    expect(value()).toBe("1");
    expect(isOff(named("Fewer dots", host ?? document))).toBe(true);
    for (let i = 0; i < 25; i++) await click(named("More dots", host ?? document));
    expect(value()).toBe("20");
    expect(isOff(named("More dots", host ?? document))).toBe(true);
    await click(button(HOST_VOTE_TEXT.start, host ?? undefined));
    expect(socket.ofType("voteStart")).toEqual([{ type: "voteStart", budget: 20 }]);
  });

  it("while a round is open it's Start a new round, which asks first (it clears this round's dots)", async () => {
    const socket = await inRoom({ host: true, voting: OPEN });
    const host = await hostControls();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await click(button(HOST_VOTE_TEXT.restart, host ?? undefined));
    expect(confirm).toHaveBeenCalledWith(HOST_VOTE_TEXT.confirmRestart);
    expect(socket.ofType("voteStart")).toEqual([]);
    confirm.mockReturnValue(true);
    await click(button(HOST_VOTE_TEXT.restart, host ?? undefined));
    expect(socket.ofType("voteStart")).toHaveLength(1);
  });
});

describe("Stop and reveal, Clear votes", () => {
  it("Stop asks once with the effect; cancelling sends nothing", async () => {
    const socket = await inRoom({ host: true, voting: OPEN });
    const host = await hostControls();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await click(button(HOST_VOTE_TEXT.stop, host ?? undefined));
    expect(confirm.mock.calls).toEqual([["End voting and show results to everyone?"]]);
    expect(socket.ofType("voteStop")).toEqual([]);
    confirm.mockReturnValue(true);
    await click(button(HOST_VOTE_TEXT.stop, host ?? undefined));
    expect(socket.ofType("voteStop")).toEqual([{ type: "voteStop" }]);
  });

  it("Clear votes asks first, then voteClear", async () => {
    const socket = await inRoom({ host: true, voting: CLOSED });
    const host = await hostControls();
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    await click(button(HOST_VOTE_TEXT.clear, host ?? undefined));
    expect(confirm).toHaveBeenCalledWith(HOST_VOTE_TEXT.confirmClear);
    expect(socket.ofType("voteClear")).toEqual([{ type: "voteClear" }]);
  });

  it("off with the reason when there's nothing to do: Stop while not open, Clear while off", async () => {
    await inRoom({ host: true });
    const host = await hostControls();
    const stop = button(HOST_VOTE_TEXT.stop, host ?? undefined);
    const clear = button(HOST_VOTE_TEXT.clear, host ?? undefined);
    expect(isOff(stop)).toBe(true);
    expect(reasonOf(stop)).toContain(HOST_VOTE_HINTS.notOpen);
    expect(isOff(clear)).toBe(true);
    expect(reasonOf(clear)).toContain(HOST_VOTE_HINTS.nothing);
  });

  it("everything is off with the reason while disconnected", async () => {
    const socket = await inRoom({ host: true, voting: OPEN });
    const host = await hostControls();
    await server(socket, "close");
    for (const label of [HOST_VOTE_TEXT.restart, HOST_VOTE_TEXT.stop, HOST_VOTE_TEXT.clear]) {
      const b = button(label, hostIn(document) ?? undefined);
      expect(isOff(b), label).toBe(true);
      expect(reasonOf(b), label).toContain("Not connected.");
    }
    expect(host).not.toBeNull();
  });

  it("everything is off while the board is being cleared", async () => {
    const socket = await inRoom({ host: true, voting: OPEN, notes: [noteAt(1)] });
    vi.stubGlobal("confirm", () => true);
    await click(button(/Clear board/, properties() ?? document));
    expect(socket.ofType("noteBatch").length + socket.ofType("noteDelete").length).toBeGreaterThan(0);
    const host = await hostControls();
    const stop = button(HOST_VOTE_TEXT.stop, host ?? undefined);
    expect(isOff(stop)).toBe(true);
    expect(reasonOf(stop)).toContain(CLEAR_HINTS.clearing);
    await click(stop);
    expect(socket.ofType("voteStop")).toEqual([]);
  });

  it("the host doesn't see how many have voted (the relay doesn't say)", async () => {
    await inRoom({ host: true, voting: OPEN });
    const host = await hostControls();
    expect(host?.textContent).not.toMatch(/\d+ (people|voters|voted)/);
  });
});

describe("results on the notes", () => {
  it("a total badge on every note with votes, apart from my dots; Top voted on all tied for first", async () => {
    const socket = await closedWith([
      { noteId: id(1), count: 4 },
      { noteId: id(2), count: 1 },
      { noteId: id(3), count: 4 },
    ]);
    expect(totalOf(1)?.textContent).toContain("Total 4");
    expect(totalOf(2)?.textContent).toContain("Total 1");
    expect(totalOf(4)).toBeNull();
    expect(topOf(1)?.textContent).toContain("Top voted");
    expect(topOf(3)?.textContent).toContain("Top voted");
    expect(topOf(2)).toBeNull();
    // My own dots stay a different badge.
    await server(socket, { data: { type: "voterGranted", remaining: 3, mine: [{ noteId: id(2), count: 2 }] } });
    const node = nodeOf(2);
    expect(node?.querySelector("[data-my-dots]")?.textContent).toContain("2");
    expect(node?.querySelector("[data-vote-total]")?.textContent).toContain("Total 1");
    expect(document.querySelector('[aria-roledescription="note"]')?.getAttribute("aria-label")).toContain("Total: 4, top voted.");
  });

  it("a new round clears totals and markers; Clear votes leaves no badges", async () => {
    const socket = await closedWith([{ noteId: id(1), count: 2 }]);
    await server(socket, { data: { type: "votingChanged", voting: { ...OPEN, round: 2 } } });
    expect(totalOf(1)).toBeNull();
    expect(topOf(1)).toBeNull();
    await server(socket, { data: { type: "votingChanged", voting: { ...OPEN, round: 2, state: "closed" } } });
    await server(socket, { data: { type: "votesRevealed", round: 2, totals: [{ noteId: id(2), count: 1 }] } });
    expect(totalOf(2)).not.toBeNull();
    await server(socket, { data: { type: "votingChanged", voting: { ...OPEN, round: 2, state: "off" } } });
    expect(document.querySelectorAll("[data-vote-badges]")).toHaveLength(0);
    expect(strip()).toBeNull();
  });

  it("a late joiner sees the results the relay sends with the snapshots", async () => {
    const socket = await inRoom({ notes: [noteAt(1), noteAt(2)], voting: CLOSED });
    await server(socket, { data: { type: "votesRevealed", round: 1, totals: [{ noteId: id(2), count: 3 }] } });
    expect(totalOf(2)?.textContent).toContain("Total 3");
    expect(strip()?.textContent).toContain(VOTE_TEXT.closed);
    expect(rows(resultsIn(properties()))).toHaveLength(1);
  });

  it("the end is announced to everyone, the host too", async () => {
    const socket = await inRoom({ host: true, voting: OPEN });
    await server(socket, { data: { type: "votingChanged", voting: CLOSED } });
    expect(announcer()?.textContent).toBe(VOTE_TEXT.ended);
  });
});

describe("the Results list", () => {
  it("in Properties with nothing selected: sorted by total, ties in order, title and total, Top voted in text", async () => {
    await closedWith([
      { noteId: id(1), count: 2 },
      { noteId: id(2), count: 5 },
      { noteId: id(3), count: 2 },
      { noteId: id(4), count: 5 },
    ]);
    const list = resultsIn(properties());
    expect(list?.querySelector("h3, h4")?.textContent).toBe("Results");
    const r = rows(list);
    expect(r.map((row) => row.querySelector("[data-result-title]")?.textContent)).toEqual(["Idea 2", "Idea 4", "Idea 1", "Idea 3"]);
    expect(r.map((row) => row.querySelector("[data-result-count]")?.textContent)).toEqual(["5 dots", "5 dots", "2 dots", "2 dots"]);
    expect(r.map((row) => row.querySelector("[data-result-top]")?.textContent ?? null)).toEqual(["Top voted", "Top voted", null, null]);
    // Titles truncate (one line), and are plain text.
    expect(r[0]?.querySelector("[data-result-title]")?.className).toContain("truncate");
  });

  it("note text stays plain text", async () => {
    const socket = await inRoom({ notes: [noteAt(1, { text: "<img src=x onerror=alert(1)>" })], voting: CLOSED });
    await server(socket, { data: { type: "votesRevealed", round: 1, totals: [{ noteId: id(1), count: 1 }] } });
    const title = rows(resultsIn(properties()))[0]?.querySelector("[data-result-title]");
    expect(title?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(resultsIn(properties())?.querySelector("img")).toBeNull();
  });

  it("a row selects its note (and moves the view to it)", async () => {
    await closedWith([{ noteId: id(3), count: 2 }]);
    await click(rows(resultsIn(properties()))[0]);
    expect(nodeOf(3)?.querySelector('[aria-roledescription="note"]')?.className).toContain("sy-selected");
    expect(properties()?.querySelector("h3")?.textContent).toMatch(/note$/);
  });

  it("empty: No votes were cast.", async () => {
    await closedWith([]);
    expect(resultsIn(properties())?.textContent).toContain("No votes were cast.");
    expect(rows(resultsIn(properties()))).toEqual([]);
  });

  it("nothing about who voted, anywhere", async () => {
    await closedWith([{ noteId: id(1), count: 2 }], { host: true });
    expect(resultsIn(properties())?.textContent).not.toMatch(/Sam|Alex|by /);
  });

  it("phones: Show results on the strip opens Results; a row selects the note and closes it", async () => {
    await closedWith([{ noteId: id(1), count: 1 }, { noteId: id(2), count: 3 }], { isWide: false });
    await click(button(VOTE_TEXT.showResults, strip() ?? undefined));
    expect(dialog()?.textContent).toContain("Results");
    const list = resultsIn(dialog());
    expect(rows(list).map((r) => r.querySelector("[data-result-title]")?.textContent)).toEqual(["Idea 2", "Idea 1"]);
    await click(rows(list)[0]);
    await settle();
    expect(resultsIn(dialog())).toBeNull();
    expect(nodeOf(2)?.querySelector('[aria-roledescription="note"]')?.className).toContain("sy-selected");
  });

  it("md and up: Show results clears the selection so Properties shows the list", async () => {
    await closedWith([{ noteId: id(1), count: 1 }]);
    await act(async () => {
      const el = document.querySelectorAll<HTMLElement>('[aria-roledescription="note"]')[1];
      el?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(resultsIn(properties())).toBeNull();
    await click(button(VOTE_TEXT.showResults, strip() ?? undefined));
    expect(resultsIn(properties())).not.toBeNull();
  });
});
