import { describe, expect, it } from "vitest";
import { VOTE_BUDGET_MAX } from "@stickyard/shared";
import { VOTE_HINTS, VOTE_TEXT, reasonLines, stripText, voteAnnouncement, voteKey, voteLabel, voteReasons, type AnnounceState, type VoteButtonState } from "../src/voting/voting";

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
