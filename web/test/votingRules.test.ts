import { describe, expect, it } from "vitest";
import { VOTE_BUDGET_DEFAULT, VOTE_BUDGET_MAX, VOTE_BUDGET_MIN } from "@stickyard/shared";
import {
  BUDGET,
  HOST_VOTE_HINTS,
  HOST_VOTE_TEXT,
  hostVoteReasons,
  noteTitle,
  resultRows,
  stepBudget,
  totalsOf,
  validBudget,
  VOTE_HINTS,
  VOTE_TEXT,
  reasonLines, stripText, voteAnnouncement, voteKey, voteLabel, voteReasons, type AnnounceState, type VoteButtonState } from "../src/voting/voting";

/*
 * Dot voting UI, part 1 (pure rules): the strip's text, what is announced (start, reaching 0,
 * stop; never per dot), why the vote buttons are off, and the D / Shift+D keys.
 */

const open = { state: "open", budget: 5, round: 1 } as const;
const ready: VoteButtonState = { voting: open, live: true, confirmed: true, isVoter: true, votersFull: false, remaining: 3, mine: 1 };

describe("the strip", () => {
  it("says how many dots are left of the budget while open", () => {
    expect(stripText(open, 3)).toBe("Voting is open — you have 3 of 5 dots left.");
    expect(stripText(open, 0)).toBe("Voting is open — you have 0 of 5 dots left.");
    expect(stripText({ state: "open", budget: 1, round: 1 }, 1)).toBe("Voting is open — you have 1 of 1 dot left.");
  });

  it("says results are on the notes once closed, and is gone while off", () => {
    expect(stripText({ ...open, state: "closed" }, 2)).toBe("Voting has ended — results are shown on the notes.");
    expect(stripText({ ...open, state: "off" }, 5)).toBeNull();
  });
});

describe("announcements", () => {
  const at = (state: AnnounceState["state"], remaining: number, round = 1, budget = 5): AnnounceState => ({ state, round, budget, remaining });

  it("start, reaching zero and stop, once each", () => {
    expect(voteAnnouncement(at("off", 5, 0), at("open", 5))).toBe(VOTE_TEXT.started(5));
    expect(voteAnnouncement(at("open", 1), at("open", 0))).toBe(VOTE_TEXT.none);
    expect(voteAnnouncement(at("open", 0), at("closed", 0))).toBe(VOTE_TEXT.ended);
    // A new round while one was open (or closed) is a start.
    expect(voteAnnouncement(at("open", 2, 1), at("open", 3, 2, 3))).toBe(VOTE_TEXT.started(3));
    expect(voteAnnouncement(at("closed", 0, 1), at("open", 5, 2))).toBe(VOTE_TEXT.started(5));
  });

  it("nothing per dot, nothing on joining, nothing when cleared, nothing staying at zero", () => {
    expect(voteAnnouncement(at("open", 5), at("open", 4))).toBeNull();
    expect(voteAnnouncement(at("open", 3), at("open", 4))).toBeNull();
    expect(voteAnnouncement(at("open", 0), at("open", 0))).toBeNull();
    expect(voteAnnouncement(null, at("open", 5))).toBeNull();
    expect(voteAnnouncement(null, at("closed", 5))).toBeNull();
    expect(voteAnnouncement(at("closed", 2), at("off", 5))).toBeNull();
    expect(voteAnnouncement(at("open", 2), at("off", 5))).toBeNull();
    expect(voteAnnouncement(at("closed", 2), at("closed", 2))).toBeNull();
  });
});

describe("vote buttons: on, or off with the reason", () => {
  it("both on with dots left and some of mine on the note", () => {
    expect(voteReasons(ready)).toEqual({ add: null, remove: null });
  });

  it.each<[string, Partial<VoteButtonState>, string]>([
    ["voting not open", { voting: { ...open, state: "off" } }, VOTE_HINTS.notOpen],
    ["voting closed", { voting: { ...open, state: "closed" } }, VOTE_HINTS.notOpen],
    ["disconnected", { live: false }, VOTE_HINTS.offline],
    ["note unconfirmed", { confirmed: false }, VOTE_HINTS.unsaved],
    ["voter not granted yet", { isVoter: false }, VOTE_HINTS.joining],
    ["this vote is full", { isVoter: false, votersFull: true }, VOTE_HINTS.full],
  ])("%s: both off", (_, change, reason) => {
    expect(voteReasons({ ...ready, ...change })).toEqual({ add: reason, remove: reason });
  });

  it("the texts asked for", () => {
    expect(VOTE_HINTS.noDots).toBe("You have no dots left.");
    expect(VOTE_HINTS.unsaved).toBe("Wait until the note is saved.");
    expect(VOTE_HINTS.joining).toBe("Joining the vote…");
    expect(VOTE_HINTS.full).toBe("This vote is full.");
  });

  it("no dots left: only Add is off; nothing on the note: only Remove is off", () => {
    expect(voteReasons({ ...ready, remaining: 0 })).toEqual({ add: VOTE_HINTS.noDots, remove: null });
    expect(voteReasons({ ...ready, mine: 0 })).toEqual({ add: null, remove: VOTE_HINTS.nothing });
    expect(voteReasons({ ...ready, mine: 0, remaining: 0 })).toEqual({ add: VOTE_HINTS.noDots, remove: VOTE_HINTS.nothing });
    expect(voteReasons({ ...ready, mine: VOTE_BUDGET_MAX, remaining: 0, voting: { ...open, budget: VOTE_BUDGET_MAX } }).add).toBe(VOTE_HINTS.noDots);
  });

  it("the board lock is not a reason (decided): there's no lock input at all", () => {
    expect(Object.keys(ready)).not.toContain("locked");
  });

  it("reason lines: each different reason once", () => {
    expect(reasonLines({ add: null, remove: null })).toEqual([]);
    expect(reasonLines({ add: VOTE_HINTS.offline, remove: VOTE_HINTS.offline })).toEqual([VOTE_HINTS.offline]);
    expect(reasonLines({ add: VOTE_HINTS.noDots, remove: VOTE_HINTS.nothing })).toEqual([VOTE_HINTS.noDots, VOTE_HINTS.nothing]);
  });
});

describe("keys on a focused note", () => {
  const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
    voteKey({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });

  it("D adds a dot, Shift+D takes one off (not + or -: those zoom)", () => {
    expect(key("d")).toBe("add");
    expect(key("D", { shiftKey: true })).toBe("remove");
    expect(key("+")).toBeNull();
    expect(key("-")).toBeNull();
  });

  it("Ctrl/Cmd/Alt+D are someone else's (Ctrl+D duplicates)", () => {
    expect(key("d", { ctrlKey: true })).toBeNull();
    expect(key("d", { metaKey: true })).toBeNull();
    expect(key("d", { altKey: true })).toBeNull();
  });
});

describe("screen reader label", () => {
  it("names my dots and the total", () => {
    expect(voteLabel({ mine: 0, total: null, top: false })).toBe("");
    expect(voteLabel({ mine: 2, total: null, top: false })).toBe("Your dots: 2.");
    expect(voteLabel({ mine: 1, total: 7, top: true })).toBe("Your dots: 1. Total: 7, top voted.");
  });
});

/* ── Part 2: host controls and results ─────────────────────────── */

describe("host controls", () => {
  it("budget: whole dots from 1 to 20 (the relay's bounds), default 5; the stepper stays inside", () => {
    expect(BUDGET).toEqual({ min: VOTE_BUDGET_MIN, max: VOTE_BUDGET_MAX, default: VOTE_BUDGET_DEFAULT });
    expect(BUDGET).toEqual({ min: 1, max: 20, default: 5 });
    for (const ok of [1, 5, 20]) expect(validBudget(ok)).toBe(true);
    for (const bad of [0, 21, 2.5, -1, Number.NaN]) expect(validBudget(bad)).toBe(false);
    expect(stepBudget(1, -1)).toBe(1);
    expect(stepBudget(20, 1)).toBe(20);
    expect(stepBudget(5, 1)).toBe(6);
  });

  it("reasons: whatever blocks End session (offline, a run) blocks them all; Stop needs an open round, Clear needs one", () => {
    expect(hostVoteReasons({ blocked: null, state: "off" })).toEqual({ start: null, stop: HOST_VOTE_HINTS.notOpen, clear: HOST_VOTE_HINTS.nothing });
    expect(hostVoteReasons({ blocked: null, state: "open" })).toEqual({ start: null, stop: null, clear: null });
    expect(hostVoteReasons({ blocked: null, state: "closed" })).toEqual({ start: null, stop: HOST_VOTE_HINTS.notOpen, clear: null });
    expect(hostVoteReasons({ blocked: "Not connected.", state: "open" })).toEqual({ start: "Not connected.", stop: "Not connected.", clear: "Not connected." });
  });

  it("the confirms say what happens", () => {
    expect(HOST_VOTE_TEXT.confirmStop).toBe("End voting and show results to everyone?");
    expect(HOST_VOTE_TEXT.startNote).toMatch(/clears the previous round/);
  });
});

describe("results", () => {
  const notes = [
    { id: "a", text: "Alpha\nbody" },
    { id: "b", text: "Beta" },
    { id: "c", text: "" },
    { id: "d", text: "  \nOnly a body" },
  ];

  it("sorted by total, most first; ties keep the relay's order (note creation order)", () => {
    const rows = resultRows(
      [
        { noteId: "a", count: 2 },
        { noteId: "b", count: 5 },
        { noteId: "c", count: 2 },
        { noteId: "d", count: 5 },
      ],
      notes,
    );
    expect(rows.map((r) => r.noteId)).toEqual(["b", "d", "a", "c"]);
  });

  it("titles are the first line, plain; empty ones are Untitled note", () => {
    const rows = resultRows([{ noteId: "a", count: 1 }, { noteId: "c", count: 1 }, { noteId: "d", count: 1 }], notes);
    expect(rows.map((r) => r.title)).toEqual(["Alpha", VOTE_TEXT.untitled, VOTE_TEXT.untitled]);
    expect(noteTitle("<b>hi</b>")).toBe("<b>hi</b>");
  });

  it("Top voted: every note tied for first", () => {
    const rows = resultRows([{ noteId: "a", count: 3 }, { noteId: "b", count: 3 }, { noteId: "c", count: 1 }], notes);
    expect(rows.filter((r) => r.top).map((r) => r.noteId)).toEqual(["a", "b"]);
  });

  it("notes that are gone and zero totals are left out; nothing cast = empty", () => {
    expect(resultRows([{ noteId: "x", count: 4 }, { noteId: "a", count: 0 }], notes)).toEqual([]);
    expect(resultRows([], notes)).toEqual([]);
    expect(VOTE_TEXT.noResults).toBe("No votes were cast.");
  });

  it("totals by note and the highest, for the badges", () => {
    const results = [{ noteId: "a", count: 3 }, { noteId: "b", count: 1 }];
    const t = totalsOf(results);
    expect(t.byId.get("a")).toBe(3);
    expect(t.most).toBe(3);
    expect(totalsOf(results)).toBe(t);
    expect(totalsOf([]).most).toBe(0);
  });
});
