import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROOM_ENDED_CLOSE_CODE, ROOM_EXPIRED_CLOSE_CODE } from "@stickyard/shared";
import type { ConnectionEnv } from "../src/connection/reconnect";
import { NOTICES, type SessionOptions } from "../src/rooms/session";
import { STORAGE_KEYS, readKey, voterKeyKey, writeKey, type KeyValueStore } from "../src/storage";
import { VOTER_KEY_BYTES, forgetVoterKey, newVoterKey, voterKeyFor } from "../src/voting/voterKey";
import { nid, note, room } from "./helpers/fakeRelay";

/*
 * Protocol v13 plumbing (web, no visible voting UI yet): a random voter key per room on this
 * device, sent only in claimVoter after every join and reconnect; the voting state, my votes,
 * dots left and the results in RoomView; optimistic votes with rollback; host commands.
 */

const KEY = "fakeVoterKey00000000AA";
const LIVE_ENV = { online: () => true, hidden: () => false, listen: () => () => {} } as ConnectionEnv;

function memoryStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

/** A session whose device has a voter key (and Alex is host unless said otherwise), in a room with notes 1 to 3. */
function voting(extra: Partial<SessionOptions> = {}, host = true) {
  let key: string | null = KEY;
  const forgetVoter = vi.fn(() => {
    key = null;
  });
  const t = room([note(1), note(2), note(3)], [], {
    voterKey: () => key,
    forgetVoterKey: forgetVoter,
    ...(host ? { hostToken: () => "fakeHostToken".padEnd(43, "x") } : {}),
    ...extra,
  });
  return { ...t, forgetVoter };
}

/** As `voting`, with a round open (budget 5 unless given). */
function open(budget = 5, extra: Partial<SessionOptions> = {}) {
  const t = voting(extra);
  expect(t.session.startVote(budget)).toBe(true);
  expect(t.view().voting).toMatchObject({ state: "open", budget });
  return t;
}

const votes = (map: ReadonlyMap<string, number>) => Object.fromEntries(map);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("voter key", () => {
  it("lives under stickyard:voter:<room id>", () => {
    expect(voterKeyKey("abc")).toBe("stickyard:voter:abc");
    expect(voterKeyKey("abc").startsWith(STORAGE_KEYS.voterKeyPrefix)).toBe(true);
    expect(voterKeyKey("abc")).not.toBe(voterKeyKey("abd"));
  });

  it("is 128 random bits from crypto.getRandomValues, base64url (22 characters)", () => {
    expect(VOTER_KEY_BYTES).toBe(16);
    const spy = vi.spyOn(crypto, "getRandomValues");
    const key = newVoterKey();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0]![0] as Uint8Array).length).toBe(16);
    spy.mockRestore();
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newVoterKey()).not.toBe(key);
  });

  it("is made once per room and kept; another room gets its own; forgetting removes it", () => {
    const store = memoryStore();
    const a = voterKeyFor("room-a", store);
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(readKey(voterKeyKey("room-a"), store)).toBe(a);
    expect(voterKeyFor("room-a", store)).toBe(a);
    const b = voterKeyFor("room-b", store);
    expect(b).not.toBe(a);
    forgetVoterKey("room-a", store);
    expect(readKey(voterKeyKey("room-a"), store)).toBeNull();
    expect(readKey(voterKeyKey("room-b"), store)).toBe(b);
    expect(voterKeyFor("room-a", store)).not.toBe(a);
  });

  it("a stored value that isn't a key is replaced", () => {
    const store = memoryStore();
    writeKey(voterKeyKey("r"), "not a key!", store);
    expect(voterKeyFor("r", store)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("never throws: with storage missing or blocked a key is still made (just not kept)", () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(voterKeyFor("r", broken)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(voterKeyFor("r", undefined)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(() => forgetVoterKey("r", broken)).not.toThrow();
  });
});

describe("claiming a voter", () => {
  it("sends claimVoter right after joined (after claimHost), and takes voterGranted", () => {
    const t = voting();
    const sent = t.relay.received.map((m) => m.type);
    expect(sent.indexOf("claimVoter")).toBeGreaterThan(sent.indexOf("join"));
    expect(sent.indexOf("claimVoter")).toBeGreaterThan(sent.indexOf("claimHost"));
    expect(t.sent("claimVoter")).toEqual([{ type: "claimVoter", key: KEY }]);
    expect(t.view()).toMatchObject({ isVoter: true, remaining: 5, voting: { state: "off", budget: 5, round: 0 }, results: null });
    expect(votes(t.view().myVotes)).toEqual({});
  });

  it("sends nothing without a key", () => {
    const t = room([note(1)], [], { voterKey: () => null });
    expect(t.sent("claimVoter")).toEqual([]);
    expect(t.view().isVoter).toBe(false);
  });

  it("claims again after a reconnect, and the relay's `mine` replaces what this page had", async () => {
    const t = open(5, { env: LIVE_ENV, random: () => 0.5 });
    expect(t.session.voteSet(nid(1), 2)).toBe(true);
    // Another tab of the same voter puts a dot on note 3 meanwhile (the relay stores it).
    t.relay.votes.get(KEY)!.set(nid(3), 1);
    t.relay.drop();
    expect(t.view().isVoter).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    t.relay.open();
    expect(t.view().status).toBe("joined");
    expect(t.sent("claimVoter")).toHaveLength(2);
    expect(votes(t.view().myVotes)).toEqual({ [nid(1)]: 2, [nid(3)]: 1 });
    expect(t.view()).toMatchObject({ isVoter: true, remaining: 2 });
  });

  it("the key leaves the page only in claimVoter", async () => {
    const t = open(5, { env: LIVE_ENV, random: () => 0.5 });
    t.session.voteSet(nid(1), 1);
    t.session.say("hello");
    t.relay.drop();
    await vi.advanceTimersByTimeAsync(1000);
    t.relay.open();
    const carrying = t.relay.received.filter((m) => JSON.stringify(m).includes(KEY));
    expect(carrying.length).toBeGreaterThan(0);
    expect(carrying.every((m) => m.type === "claimVoter")).toBe(true);
    expect(JSON.stringify(t.view())).not.toContain(KEY);
  });

  it("the key is forgotten when the session expires (4410) or ends (4411, sessionEnded)", () => {
    const a = voting();
    a.relay.closeWith(ROOM_EXPIRED_CLOSE_CODE);
    expect(a.forgetVoter).toHaveBeenCalled();
    expect(a.view()).toMatchObject({ status: "expired", isVoter: false, results: null, voting: { state: "off" } });
    const b = voting();
    b.relay.emit({ type: "sessionEnded" });
    expect(b.forgetVoter).toHaveBeenCalled();
    const c = voting();
    c.relay.closeWith(ROOM_ENDED_CLOSE_CODE);
    expect(c.forgetVoter).toHaveBeenCalled();
  });
});

describe("voting state", () => {
  it("joined's voting is the starting state", () => {
    const t = voting();
    expect(t.view().voting).toEqual({ state: "off", budget: 5, round: 0 });
  });

  it("a new round clears my votes and the results; dots left = the new budget", () => {
    const t = open();
    t.session.voteSet(nid(1), 2);
    t.session.stopVote();
    expect(t.view().results).toEqual([{ noteId: nid(1), count: 2 }]);
    expect(t.session.startVote(3)).toBe(true);
    expect(t.view()).toMatchObject({ voting: { state: "open", budget: 3, round: 2 }, remaining: 3, results: null });
    expect(votes(t.view().myVotes)).toEqual({});
  });

  it("closing keeps my votes and shows the totals; clearing turns it off and empties everything", () => {
    const t = open();
    t.session.voteSet(nid(2), 3);
    expect(t.view().results).toBeNull();
    t.session.stopVote();
    expect(t.view()).toMatchObject({ voting: { state: "closed" }, results: [{ noteId: nid(2), count: 3 }], remaining: 2 });
    expect(votes(t.view().myVotes)).toEqual({ [nid(2)]: 3 });
    t.session.clearVotes();
    expect(t.view()).toMatchObject({ voting: { state: "off", round: 1 }, results: null, remaining: 5 });
    expect(votes(t.view().myVotes)).toEqual({});
  });

  it("results are only taken while closed", () => {
    const t = open();
    t.relay.emit({ type: "votesRevealed", round: 1, totals: [{ noteId: nid(1), count: 4 }] });
    expect(t.view().results).toBeNull();
  });

  it("a late joiner gets the results with the snapshots when voting is closed", () => {
    const t = room([note(1), note(2)], [], {}, (relay) => {
      relay.voting = { state: "closed", budget: 5, round: 4 };
      relay.votes.set("someoneElse0000000000A", new Map([[nid(2), 3]]));
    });
    expect(t.view()).toMatchObject({ voting: { state: "closed", round: 4 }, results: [{ noteId: nid(2), count: 3 }] });
  });

  it("host commands: startVote, stopVote, clearVotes send their messages; bad budgets and guests send nothing", () => {
    const t = voting();
    expect(t.session.startVote(0)).toBe(false);
    expect(t.session.startVote(21)).toBe(false);
    expect(t.session.startVote(2.5)).toBe(false);
    expect(t.sent("voteStart")).toEqual([]);
    expect(t.session.startVote(20)).toBe(true);
    expect(t.session.stopVote()).toBe(true);
    expect(t.session.clearVotes()).toBe(true);
    expect(t.relay.received.filter((m) => String(m.type).startsWith("vote")).map((m) => m.type)).toEqual(["voteStart", "voteStop", "voteClear"]);
    const guest = voting({}, false);
    expect(guest.session.startVote(5)).toBe(false);
    expect(guest.session.stopVote()).toBe(false);
    expect(guest.session.clearVotes()).toBe(false);
    expect(guest.relay.received.filter((m) => String(m.type).startsWith("vote"))).toEqual([]);
  });
});

describe("voteSet", () => {
  it("is optimistic: shown at once, confirmed by voteConfirmed", () => {
    const t = open();
    t.relay.paused = true;
    expect(t.session.voteSet(nid(1), 2)).toBe(true);
    expect(votes(t.view().myVotes)).toEqual({ [nid(1)]: 2 });
    expect(t.view().remaining).toBe(3);
    t.relay.resume();
    expect(votes(t.view().myVotes)).toEqual({ [nid(1)]: 2 });
    expect(t.view().remaining).toBe(3);
    expect(t.sent("voteSet")).toEqual([{ type: "voteSet", noteId: nid(1), count: 2 }]);
    // Taking them off.
    expect(t.session.voteSet(nid(1), 0)).toBe(true);
    expect(votes(t.view().myVotes)).toEqual({});
    expect(t.view().remaining).toBe(5);
  });

  it("the same count again sends nothing", () => {
    const t = open();
    t.session.voteSet(nid(1), 2);
    expect(t.session.voteSet(nid(1), 2)).toBe(true);
    expect(t.sent("voteSet")).toHaveLength(1);
  });

  it.each([
    ["over_budget", NOTICES.overBudget],
    ["voting_closed", NOTICES.votingClosed],
    ["no_voter", NOTICES.noVoter],
    ["voters_full", NOTICES.votersFull],
    ["rate_limited", NOTICES.tooQuick],
  ])("a %s refusal rolls the vote back with one calm notice; the board is untouched", (code, notice) => {
    const t = open();
    t.session.voteSet(nid(1), 1);
    const board = t.view().board;
    t.relay.refuseVote = code;
    expect(t.session.voteSet(nid(1), 3)).toBe(true);
    expect(votes(t.view().myVotes)).toEqual({ [nid(1)]: 1 });
    expect(t.view().remaining).toBe(4);
    expect(t.view().noteNotice).toBe(notice);
    expect(t.view().board).toBe(board);
  });

  it("refused here, with nothing sent: disconnected, voting not open, no voter yet, over my dots, an unknown note", () => {
    const off = voting();
    expect(off.session.voteSet(nid(1), 1)).toBe(false);
    expect(off.view().noteNotice).toBe(NOTICES.votingClosed);

    const t = open(3);
    expect(t.session.voteSet(nid(1), 2)).toBe(true);
    expect(t.session.voteSet(nid(2), 2)).toBe(false);
    expect(t.view().noteNotice).toBe(NOTICES.overBudget);
    expect(t.session.voteSet(nid(9), 1)).toBe(false);
    expect(t.session.voteSet(nid(2), -1)).toBe(false);
    expect(t.session.voteSet(nid(2), 1.5)).toBe(false);
    expect(t.sent("voteSet")).toHaveLength(1);

    const noKey = room([note(1)], [], { voterKey: () => null, hostToken: () => "fakeHostToken".padEnd(43, "x") });
    noKey.session.startVote(5);
    expect(noKey.session.voteSet(nid(1), 1)).toBe(false);
    expect(noKey.view().noteNotice).toBe(NOTICES.noVoter);
    expect(noKey.sent("voteSet")).toEqual([]);
  });

  it("disconnected: refused with a notice, nothing sent", () => {
    const t = open(5, { env: LIVE_ENV, random: () => 0.5 });
    t.relay.drop();
    expect(t.session.voteSet(nid(1), 1)).toBe(false);
    expect(t.view().noteNotice).toBe(NOTICES.voteOffline);
    expect(t.sent("voteSet")).toEqual([]);
  });

  it("a vote waiting for the relay is dropped with the connection (the reclaim resyncs)", async () => {
    const t = open(5, { env: LIVE_ENV, random: () => 0.5 });
    t.relay.paused = true;
    t.session.voteSet(nid(1), 2);
    t.relay.drop();
    expect(votes(t.view().myVotes)).toEqual({});
    t.relay.paused = false;
    await vi.advanceTimersByTimeAsync(1000);
    t.relay.open();
    expect(votes(t.view().myVotes)).toEqual({});
    expect(t.view().remaining).toBe(5);
  });

  it("is never recorded by undo: Undo stays as it was and sends nothing", () => {
    const t = open();
    const before = t.view().history;
    t.session.voteSet(nid(1), 2);
    t.session.voteSet(nid(2), 1);
    expect(t.view().history).toEqual(before);
    const sent = t.relay.received.length;
    t.session.undo();
    expect(t.relay.received.length).toBe(sent);
    expect(votes(t.view().myVotes)).toEqual({ [nid(1)]: 2, [nid(2)]: 1 });
  });
});

describe("deleted notes", () => {
  it("drop out of my votes (dots back) and of the results", () => {
    const t = open();
    t.session.voteSet(nid(1), 2);
    t.session.voteSet(nid(2), 1);
    t.relay.notes.delete(nid(1));
    t.relay.emit({ type: "noteDeleted", id: nid(1) });
    expect(votes(t.view().myVotes)).toEqual({ [nid(2)]: 1 });
    expect(t.view().remaining).toBe(4);
    t.session.stopVote();
    expect(t.view().results).toEqual([{ noteId: nid(2), count: 1 }]);
    t.relay.notes.delete(nid(2));
    t.relay.emit({ type: "notesBatchApplied", results: [{ type: "noteDeleted", id: nid(2) }], final: true });
    expect(t.view().results).toEqual([]);
    expect(votes(t.view().myVotes)).toEqual({});
    expect(t.view().remaining).toBe(5);
  });

  it("a vote for a note I delete is dropped too", () => {
    const t = open();
    t.session.voteSet(nid(3), 2);
    t.session.deleteNote(nid(3));
    expect(votes(t.view().myVotes)).toEqual({});
    expect(t.view().remaining).toBe(5);
  });
});

describe("voting UI support (v0.18.0, web only)", () => {
  it("votersFull: a claim refused with voters_full is in the view, and cleared by a later grant", () => {
    const t = voting({}, false);
    expect(t.view().votersFull).toBe(false);
    t.relay.emit({ type: "error", code: "voters_full", message: "Full." });
    expect(t.view()).toMatchObject({ votersFull: true, isVoter: false });
    t.relay.emit({ type: "voterGranted", remaining: 5, mine: [] });
    expect(t.view()).toMatchObject({ votersFull: false, isVoter: true });
  });

  it("a vote refused with voters_full marks the round full too", () => {
    const t = open();
    t.relay.refuseVote = "voters_full";
    t.session.voteSet(nid(1), 1);
    expect(t.view().votersFull).toBe(true);
  });

  it("a page left without a voter claims again when a new round starts", () => {
    const t = voting();
    const claims = t.sent("claimVoter").length;
    t.relay.emit({ type: "error", code: "voters_full", message: "Full." });
    t.session.startVote(5);
    expect(t.sent("claimVoter")).toHaveLength(claims + 1);
    expect(t.view()).toMatchObject({ isVoter: true, votersFull: false });
    // A voter already granted doesn't claim again.
    t.session.startVote(3);
    expect(t.sent("claimVoter")).toHaveLength(claims + 1);
  });

  it("host commands are refused (nothing sent) while a run is going, like End session", () => {
    const t = voting();
    t.relay.paused = true;
    expect(t.session.duplicateNotes([nid(1)])).not.toBeNull();
    expect(t.view().adding).toBe(true);
    expect(t.session.startVote(5)).toBe(false);
    expect(t.session.stopVote()).toBe(false);
    expect(t.session.clearVotes()).toBe(false);
    expect(t.relay.received.filter((m) => String(m.type).startsWith("vote"))).toEqual([]);
  });
});
