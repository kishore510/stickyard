import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REACTION_KEYS, ROOM_ENDED_CLOSE_CODE, type ReactionKey } from "@stickyard/shared";
import type { ConnectionEnv } from "../src/connection/reconnect";
import type { SessionOptions } from "../src/rooms/session";
import {
  REACTIONS,
  REACTION_FULL_ZOOM,
  REACTION_NOTICES,
  REACTION_SUMMARY_ZOOM,
  chipLabel,
  chipsOf,
  countsFromSnapshot,
  isReactionKey,
  keepNotes,
  mineFromGrant,
  reactionAnnouncement,
  reactionMode,
  reactionsLabel,
  shownReactions,
  withCount,
  withMine,
  type MyReactions,
  type ReactionCounts,
} from "../src/reactions/reactions";
import { nid, note, room } from "./helpers/fakeRelay";

/*
 * Reactions on notes, part 2 (web only, on the protocol v20 plumbing): the store's pure rules
 * (counts per note and key, my own set per note and key), and the session: claiming a voter on
 * every join, optimistic sets reconciled by the relay's replies, each refusal rolled back with a
 * calm notice, and the resync after a reconnect. Fixtures are generic (Alex, Sam, fake keys).
 */

const KEY = "fakeVoterKey00000000AA";
const LIVE_ENV = { online: () => true, hidden: () => false, listen: () => () => {} } as ConnectionEnv;

const known = (...ids: string[]) => (id: string) => ids.includes(id);
const plain = (counts: ReactionCounts) => Object.fromEntries([...counts].map(([id, keys]) => [id, Object.fromEntries(keys)]));
const mineOf = (mine: MyReactions) => Object.fromEntries([...mine].map(([id, keys]) => [id, [...keys].sort()]));

/** A session with a voter key, in a room with notes 1 to 3 (Sam's); voterGranted already in. */
function reacting(extra: Partial<SessionOptions> = {}, setup?: Parameters<typeof room>[3]) {
  let key: string | null = KEY;
  return room([note(1), note(2), note(3)], [], { voterKey: () => key, forgetVoterKey: () => void (key = null), ...extra }, setup);
}
const count = (t: ReturnType<typeof reacting>, id: string, key: ReactionKey) => t.view().reactionCounts.get(id)?.get(key) ?? 0;
const isMine = (t: ReturnType<typeof reacting>, id: string, key: ReactionKey) => t.view().myReactions.get(id)?.has(key) ?? false;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the key-to-emoji map", () => {
  it("has one emoji and one name for every key, in the relay's order, and nothing else", () => {
    expect(Object.keys(REACTIONS)).toEqual([...REACTION_KEYS]);
    for (const key of REACTION_KEYS) {
      expect(REACTIONS[key].emoji.length).toBeGreaterThan(0);
      expect(REACTIONS[key].name).toMatch(/^[A-Z][a-z]+( [a-z]+)?$/);
      // A key is never what's shown.
      expect(REACTIONS[key].name).not.toContain("_");
      expect(REACTIONS[key].emoji).not.toContain(key);
    }
  });

  it("knows only the six keys (nothing from Object.prototype)", () => {
    for (const key of REACTION_KEYS) expect(isReactionKey(key)).toBe(true);
    for (const key of ["rocket", "", "THUMBS_UP", "__proto__", "constructor", "toString"]) expect(isReactionKey(key)).toBe(false);
  });
});

describe("the store's rules", () => {
  it("a snapshot replaces every count; it never merges", () => {
    const first = countsFromSnapshot([{ noteId: nid(1), key: "heart", count: 2 }], known(nid(1), nid(2)));
    expect(plain(first)).toEqual({ [nid(1)]: { heart: 2 } });
    const second = countsFromSnapshot([{ noteId: nid(2), key: "laugh", count: 1 }], known(nid(1), nid(2)));
    expect(plain(second)).toEqual({ [nid(2)]: { laugh: 1 } });
  });

  it("a snapshot skips unknown notes, unknown keys and counts below 1", () => {
    const counts = countsFromSnapshot(
      [
        { noteId: nid(1), key: "heart", count: 2 },
        { noteId: nid(9), key: "heart", count: 4 },
        { noteId: nid(1), key: "rocket", count: 3 },
        { noteId: nid(1), key: "laugh", count: 0 },
        { noteId: nid(1), key: "plus", count: -2 },
      ],
      known(nid(1)),
    );
    expect(plain(counts)).toEqual({ [nid(1)]: { heart: 2 } });
  });

  it("a single count update changes one entry; 0 removes it; never below 0; other notes keep their maps", () => {
    const start = countsFromSnapshot(
      [
        { noteId: nid(1), key: "heart", count: 2 },
        { noteId: nid(2), key: "laugh", count: 1 },
      ],
      known(nid(1), nid(2)),
    );
    const up = withCount(start, nid(1), "thumbs_up", 3);
    expect(plain(up)).toEqual({ [nid(1)]: { heart: 2, thumbs_up: 3 }, [nid(2)]: { laugh: 1 } });
    expect(up.get(nid(2))).toBe(start.get(nid(2)));
    expect(plain(withCount(up, nid(2), "laugh", 0))).toEqual({ [nid(1)]: { heart: 2, thumbs_up: 3 } });
    expect(plain(withCount(up, nid(2), "laugh", -5))).toEqual({ [nid(1)]: { heart: 2, thumbs_up: 3 } });
    // Nothing changed: the same object (notes don't re-render).
    expect(withCount(up, nid(1), "heart", 2)).toBe(up);
    expect(withCount(up, nid(1), "rocket", 2)).toBe(up);
  });

  it("my set comes from voterGranted and changes one entry at a time; unknown keys and notes are ignored", () => {
    const mine = mineFromGrant(
      [
        { noteId: nid(1), key: "heart" },
        { noteId: nid(1), key: "plus" },
        { noteId: nid(9), key: "heart" },
        { noteId: nid(2), key: "rocket" },
      ],
      known(nid(1), nid(2)),
    );
    expect(mineOf(mine)).toEqual({ [nid(1)]: ["heart", "plus"] });
    expect(mineOf(withMine(mine, nid(2), "laugh", true))).toEqual({ [nid(1)]: ["heart", "plus"], [nid(2)]: ["laugh"] });
    expect(mineOf(withMine(mine, nid(1), "heart", false))).toEqual({ [nid(1)]: ["plus"] });
    expect(mineOf(withMine(withMine(mine, nid(1), "heart", false), nid(1), "plus", false))).toEqual({});
    expect(withMine(mine, nid(1), "heart", true)).toBe(mine);
    expect(withMine(mine, nid(1), "rocket", true)).toBe(mine);
  });

  it("notes that are gone drop out of counts and my set", () => {
    const counts = countsFromSnapshot([{ noteId: nid(1), key: "heart", count: 2 }, { noteId: nid(2), key: "heart", count: 1 }], known(nid(1), nid(2)));
    expect(plain(keepNotes(counts, known(nid(2))))).toEqual({ [nid(2)]: { heart: 1 } });
    expect(keepNotes(counts, known(nid(1), nid(2)))).toBe(counts);
  });

  it("what's shown: my waiting sets on top of the relay's word, counts never below 0", () => {
    const counts = countsFromSnapshot([{ noteId: nid(1), key: "heart", count: 1 }], known(nid(1), nid(2)));
    const mine = mineFromGrant([{ noteId: nid(1), key: "heart" }], known(nid(1)));
    const none = shownReactions(counts, mine, new Map());
    expect(none.counts).toBe(counts);
    expect(none.mine).toBe(mine);
    const waiting = shownReactions(
      counts,
      mine,
      new Map([
        [nid(1), [{ key: "heart" as const, on: false }]],
        [nid(2), [{ key: "laugh" as const, on: true }]],
      ]),
    );
    expect(plain(waiting.counts)).toEqual({ [nid(2)]: { laugh: 1 } });
    expect(mineOf(waiting.mine)).toEqual({ [nid(2)]: ["laugh"] });
    // Off, though the relay's count is already 0 (another tab took it off): still 0.
    const odd = shownReactions(new Map(), mine, new Map([[nid(1), [{ key: "heart" as const, on: false }]]]));
    expect(plain(odd.counts)).toEqual({});
    // The last waiting set for a key wins.
    const twice = shownReactions(new Map(), new Map(), new Map([[nid(2), [{ key: "plus" as const, on: true }, { key: "plus" as const, on: false }]]]));
    expect(plain(twice.counts)).toEqual({});
  });

  it("chips: keys with a count above 0, in the fixed order, mine marked", () => {
    const counts = new Map<ReactionKey, number>([
      ["plus", 1],
      ["heart", 2],
      ["laugh", 0],
    ]);
    expect(chipsOf(counts, new Set(["plus"]))).toEqual([
      { key: "heart", count: 2, mine: false },
      { key: "plus", count: 1, mine: true },
    ]);
    expect(chipsOf(undefined, undefined)).toEqual([]);
  });
});

describe("words", () => {
  it("chip names say the reaction, the count, whether it's mine and what pressing does", () => {
    expect(chipLabel("thumbs_up", 3, true)).toBe("Thumbs up, 3, you reacted. Press to remove.");
    expect(chipLabel("heart", 1, false)).toBe("Heart, 1. Press to add yours.");
  });

  it("the note's name gets the counts; nothing when there are none", () => {
    expect(reactionsLabel([{ key: "thumbs_up", count: 3, mine: true }, { key: "heart", count: 1, mine: false }])).toBe("Reactions: Thumbs up 3, Heart 1.");
    expect(reactionsLabel([])).toBe("");
  });

  it("my own action is announced; nobody else's", () => {
    expect(reactionAnnouncement("heart", true)).toBe("You reacted with Heart.");
    expect(reactionAnnouncement("heart", false)).toBe("You removed your Heart reaction.");
  });

  it("each refusal has a short, calm message that never says reload", () => {
    for (const code of ["no_voter", "reactions_full", "reactor_full", "rate_limited", "unknown_note", "offline"] as const) {
      expect(REACTION_NOTICES[code].length).toBeGreaterThan(10);
      expect(REACTION_NOTICES[code].length).toBeLessThan(90);
      expect(REACTION_NOTICES[code]).not.toMatch(/reload|error|!/i);
    }
  });

  it("low zoom collapses the chips: full, then a summary, then nothing", () => {
    expect(REACTION_SUMMARY_ZOOM).toBeLessThan(REACTION_FULL_ZOOM);
    expect(reactionMode(1)).toBe("full");
    expect(reactionMode(REACTION_FULL_ZOOM)).toBe("full");
    expect(reactionMode(REACTION_FULL_ZOOM - 0.01)).toBe("summary");
    expect(reactionMode(REACTION_SUMMARY_ZOOM)).toBe("summary");
    expect(reactionMode(REACTION_SUMMARY_ZOOM - 0.01)).toBe("none");
  });
});

describe("the session", () => {
  it("claims a voter on every join, with voting off (reactions work in any session)", async () => {
    const t = reacting({ env: LIVE_ENV, random: () => 0.5 });
    expect(t.view().voting.state).toBe("off");
    expect(t.sent("claimVoter")).toEqual([{ type: "claimVoter", key: KEY }]);
    expect(t.view().isVoter).toBe(true);
    t.relay.drop();
    await vi.advanceTimersByTimeAsync(1000);
    t.relay.open();
    expect(t.sent("claimVoter")).toHaveLength(2);
  });

  it("takes the join's counts and my set from voterGranted", () => {
    const t = reacting({}, (relay) => {
      relay.reactions.set(KEY, new Map([[nid(1), new Set(["heart"])]]));
      relay.reactions.set("sam", new Map([[nid(1), new Set(["heart", "plus"])]]));
    });
    expect(plain(t.view().reactionCounts)).toEqual({ [nid(1)]: { heart: 2, plus: 1 } });
    expect(mineOf(t.view().myReactions)).toEqual({ [nid(1)]: ["heart"] });
  });

  it("reactionsSnapshot replaces; reactionCount and reactionMine update one entry; unknown notes are ignored", () => {
    const t = reacting();
    t.relay.emit({ type: "reactionsSnapshot", counts: [{ noteId: nid(1), key: "heart", count: 2 }] });
    t.relay.emit({ type: "reactionsSnapshot", counts: [{ noteId: nid(2), key: "laugh", count: 1 }] });
    expect(plain(t.view().reactionCounts)).toEqual({ [nid(2)]: { laugh: 1 } });
    t.relay.emit({ type: "reactionCount", noteId: nid(3), key: "plus", count: 4 });
    t.relay.emit({ type: "reactionCount", noteId: nid(9), key: "plus", count: 4 });
    t.relay.emit({ type: "reactionMine", noteId: nid(9), key: "plus", on: true });
    expect(plain(t.view().reactionCounts)).toEqual({ [nid(2)]: { laugh: 1 }, [nid(3)]: { plus: 4 } });
    expect(mineOf(t.view().myReactions)).toEqual({});
    t.relay.emit({ type: "reactionCount", noteId: nid(3), key: "plus", count: 0 });
    expect(plain(t.view().reactionCounts)).toEqual({ [nid(2)]: { laugh: 1 } });
  });

  it("is optimistic: shown at once, sent as a set (never a toggle), then confirmed without counting twice", () => {
    const t = reacting();
    t.relay.samReact(nid(1), "heart", true);
    t.relay.paused = true;
    expect(t.session.reactionSet(nid(1), "heart", true)).toBe(true);
    expect(count(t, nid(1), "heart")).toBe(2);
    expect(isMine(t, nid(1), "heart")).toBe(true);
    expect(t.sent("reactionSet")).toEqual([{ type: "reactionSet", noteId: nid(1), key: "heart", on: true }]);
    const before = t.views.length;
    t.relay.resume();
    // Through reactionCount and then reactionMine: never 3.
    expect(t.views.slice(before).map((v) => v.reactionCounts.get(nid(1))?.get("heart"))).not.toContain(3);
    expect(count(t, nid(1), "heart")).toBe(2);
    expect(isMine(t, nid(1), "heart")).toBe(true);
    // Off again.
    expect(t.session.reactionSet(nid(1), "heart", false)).toBe(true);
    expect(count(t, nid(1), "heart")).toBe(1);
    expect(isMine(t, nid(1), "heart")).toBe(false);
    expect(t.sent("reactionSet").at(-1)).toEqual({ type: "reactionSet", noteId: nid(1), key: "heart", on: false });
  });

  it("the same state again sends nothing", () => {
    const t = reacting();
    t.session.reactionSet(nid(1), "plus", true);
    expect(t.session.reactionSet(nid(1), "plus", true)).toBe(true);
    expect(t.sent("reactionSet")).toHaveLength(1);
  });

  it("someone else's reaction while mine waits is counted once mine is answered", () => {
    const t = reacting();
    t.relay.paused = true;
    t.session.reactionSet(nid(1), "laugh", true);
    t.relay.paused = false;
    t.relay.samReact(nid(1), "laugh", true);
    t.relay.resume();
    expect(count(t, nid(1), "laugh")).toBe(2);
    expect(isMine(t, nid(1), "laugh")).toBe(true);
  });

  for (const code of ["no_voter", "reactions_full", "reactor_full", "rate_limited", "unknown_note"] as const) {
    it(`${code}: rolled back with a calm notice; the board is untouched`, () => {
      const t = reacting();
      t.relay.samReact(nid(2), "celebrate", true);
      const board = t.view().board;
      t.relay.refuseReaction = code;
      expect(t.session.reactionSet(nid(2), "celebrate", true)).toBe(true);
      expect(isMine(t, nid(2), "celebrate")).toBe(false);
      expect(count(t, nid(2), "celebrate")).toBe(1);
      expect(t.view().noteNotice).toBe(REACTION_NOTICES[code]);
      expect(t.view().board.notes.map((n) => n.note)).toEqual(board.notes.map((n) => n.note));
    });
  }

  it("a refusal rolls back only the oldest waiting set on that note", () => {
    const t = reacting();
    t.relay.paused = true;
    t.session.reactionSet(nid(1), "heart", true);
    t.session.reactionSet(nid(1), "plus", true);
    t.relay.refuseReaction = "reactor_full";
    t.relay.resume();
    expect(mineOf(t.view().myReactions)).toEqual({ [nid(1)]: ["plus"] });
    expect(plain(t.view().reactionCounts)).toEqual({ [nid(1)]: { plus: 1 } });
  });

  it("refused here with nothing sent: offline (with a notice), a sealed note, an unsaved note, an unknown key", async () => {
    const t = reacting({ env: LIVE_ENV, random: () => 0.5 });
    expect(t.session.reactionSet(nid(1), "rocket" as ReactionKey, true)).toBe(false);
    expect(t.session.reactionSet(nid(9), "heart", true)).toBe(false);
    t.relay.emit({ type: "silentChanged", active: true, count: 1 });
    t.relay.emit({ type: "noteAdded", note: note(5) });
    expect(t.view().mySealed.has(nid(5))).toBe(true);
    expect(t.session.reactionSet(nid(5), "heart", true)).toBe(false);
    t.relay.drop();
    expect(t.session.reactionSet(nid(1), "heart", true)).toBe(false);
    expect(t.view().noteNotice).toBe(REACTION_NOTICES.offline);
    expect(t.sent("reactionSet")).toEqual([]);
  });

  it("without a voter (the claim was refused): a notice, nothing sent", () => {
    const t = reacting({}, (relay) => {
      relay.refuseClaim = true;
    });
    expect(t.view().isVoter).toBe(false);
    expect(t.session.reactionSet(nid(1), "heart", true)).toBe(false);
    expect(t.view().noteNotice).toBe(REACTION_NOTICES.no_voter);
    expect(t.sent("reactionSet")).toEqual([]);
  });

  it("a locked board still takes reactions", () => {
    const t = reacting();
    t.relay.emit({ type: "lockChanged", locked: true });
    expect(t.session.reactionSet(nid(1), "thinking", true)).toBe(true);
    expect(count(t, nid(1), "thinking")).toBe(1);
  });

  it("votes and reactions are independent: a new round leaves reactions alone", () => {
    const t = reacting({ hostToken: () => "fakeHostToken".padEnd(43, "x") });
    t.session.reactionSet(nid(1), "heart", true);
    t.session.startVote(5);
    t.session.clearVotes();
    expect(count(t, nid(1), "heart")).toBe(1);
    expect(isMine(t, nid(1), "heart")).toBe(true);
  });

  it("a deleted note's reactions go (counts and mine)", () => {
    const t = reacting();
    t.session.reactionSet(nid(1), "heart", true);
    t.relay.samReact(nid(2), "plus", true);
    t.relay.emit({ type: "noteDeleted", id: nid(1) });
    expect(plain(t.view().reactionCounts)).toEqual({ [nid(2)]: { plus: 1 } });
    expect(mineOf(t.view().myReactions)).toEqual({});
  });

  it("a waiting set is dropped with the connection; the reconnect resyncs from the snapshot and voterGranted", async () => {
    const t = reacting({ env: LIVE_ENV, random: () => 0.5 });
    t.session.reactionSet(nid(1), "heart", true);
    t.relay.paused = true;
    t.session.reactionSet(nid(2), "laugh", true);
    t.relay.drop();
    expect(isMine(t, nid(2), "laugh")).toBe(false);
    t.relay.paused = false;
    // While away: Sam reacts, and my other tab takes my heart off.
    t.relay.reactions.set("sam", new Map([[nid(3), new Set(["celebrate"])]]));
    t.relay.reactions.get(KEY)!.get(nid(1))!.delete("heart");
    await vi.advanceTimersByTimeAsync(1000);
    t.relay.open();
    expect(t.view().status).toBe("joined");
    expect(plain(t.view().reactionCounts)).toEqual({ [nid(3)]: { celebrate: 1 } });
    expect(mineOf(t.view().myReactions)).toEqual({});
  });

  it("an ended session forgets every reaction", () => {
    const t = reacting();
    t.session.reactionSet(nid(1), "heart", true);
    t.relay.closeWith(ROOM_ENDED_CLOSE_CODE);
    expect(t.view().reactionCounts.size).toBe(0);
    expect(t.view().myReactions.size).toBe(0);
  });

  it("nothing about reactions is ever logged", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const t = reacting();
    t.session.reactionSet(nid(1), "heart", true);
    t.relay.refuseReaction = "reactor_full";
    t.session.reactionSet(nid(2), "heart", true);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
