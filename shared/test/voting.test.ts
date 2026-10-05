import { describe, expect, it } from "vitest";
import {
  BOARD_WRITES,
  HOST_ONLY,
  MAX_MESSAGE_BYTES,
  MAX_NAME_LENGTH,
  MAX_NOTES_PER_ROOM,
  MAX_PARTICIPANTS,
  MAX_SERVER_MESSAGE_BYTES,
  MAX_VOTERS_PER_ROUND,
  PROTOCOL_VERSION,
  TIMER_MAX_MS,
  VOTER_KEY_MAX_LENGTH,
  VOTER_KEY_MIN_LENGTH,
  VOTE_BUDGET_DEFAULT,
  VOTE_BUDGET_MAX,
  VOTE_BUDGET_MIN,
  VOTING_STATES,
  clientMessageSchema,
  encodeMessage,
  serverMessageSchema,
  utf8Length,
} from "../src";

/* Protocol v13 (dot voting, relay and plumbing). */

const ID = "AAAAAAAAAAAAAAAA";
const noteId = (i: number) => `note${String(i).padStart(12, "0")}`;
const KEY = "k".repeat(22);
const ok = (m: unknown) => clientMessageSchema.safeParse(m).success;
const serverOk = (m: unknown) => serverMessageSchema.safeParse(m).success;
const VOTE_TYPES = ["claimVoter", "voteSet", "voteStart", "voteStop", "voteClear"] as const;

describe("protocol v13", () => {
  it("is version 13", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(13);
  });

  it("budget 1 to 20, default 5; at most 40 voters a round; keys of 22 to 64 characters", () => {
    expect([VOTE_BUDGET_MIN, VOTE_BUDGET_MAX, VOTE_BUDGET_DEFAULT]).toEqual([1, 20, 5]);
    expect(MAX_VOTERS_PER_ROUND).toBe(40);
    expect([VOTER_KEY_MIN_LENGTH, VOTER_KEY_MAX_LENGTH]).toEqual([22, 64]);
    expect(VOTING_STATES).toEqual(["off", "open", "closed"]);
  });

  it("vote messages are classified: none changes the board; start, stop and clear are host-only", () => {
    for (const t of VOTE_TYPES) expect(BOARD_WRITES[t]).toBe(false);
    expect(HOST_ONLY).toEqual(expect.arrayContaining(["voteStart", "voteStop", "voteClear"]));
    expect(HOST_ONLY).not.toContain("voteSet");
    expect(HOST_ONLY).not.toContain("claimVoter");
  });

  it("claimVoter: a base64url key of 22 to 64 characters, strict", () => {
    expect(ok({ type: "claimVoter", key: KEY })).toBe(true);
    expect(ok({ type: "claimVoter", key: "A_-9".repeat(16) })).toBe(true);
    expect(ok({ type: "claimVoter", key: "k".repeat(21) })).toBe(false);
    expect(ok({ type: "claimVoter", key: "k".repeat(65) })).toBe(false);
    expect(ok({ type: "claimVoter", key: `${"k".repeat(21)}=` })).toBe(false);
    expect(ok({ type: "claimVoter", key: `${"k".repeat(21)}+` })).toBe(false);
    expect(ok({ type: "claimVoter", key: KEY, voterId: "x".repeat(43) })).toBe(false);
    expect(ok({ type: "claimVoter" })).toBe(false);
  });

  it("voteSet: a note id and a whole count 0 to 20, strict (no voter, no round)", () => {
    expect(ok({ type: "voteSet", noteId: ID, count: 0 })).toBe(true);
    expect(ok({ type: "voteSet", noteId: ID, count: VOTE_BUDGET_MAX })).toBe(true);
    expect(ok({ type: "voteSet", noteId: ID, count: VOTE_BUDGET_MAX + 1 })).toBe(false);
    expect(ok({ type: "voteSet", noteId: ID, count: -1 })).toBe(false);
    expect(ok({ type: "voteSet", noteId: ID, count: 1.5 })).toBe(false);
    expect(ok({ type: "voteSet", noteId: "short", count: 1 })).toBe(false);
    expect(ok({ type: "voteSet", noteId: ID, count: 1, voterId: "x".repeat(43) })).toBe(false);
    expect(ok({ type: "voteSet", noteId: ID, count: 1, round: 2 })).toBe(false);
  });

  it("voteStart: budget 1 to 20 (outside is refused, not clamped); stop and clear take nothing", () => {
    for (const budget of [VOTE_BUDGET_MIN, 5, VOTE_BUDGET_MAX]) expect(ok({ type: "voteStart", budget })).toBe(true);
    for (const budget of [0, VOTE_BUDGET_MAX + 1, 2.5, -1, "5"]) expect(ok({ type: "voteStart", budget })).toBe(false);
    expect(ok({ type: "voteStart" })).toBe(false);
    expect(ok({ type: "voteStart", budget: 5, round: 3 })).toBe(false);
    expect(ok({ type: "voteStop" })).toBe(true);
    expect(ok({ type: "voteStop", round: 1 })).toBe(false);
    expect(ok({ type: "voteClear" })).toBe(true);
    expect(ok({ type: "voteClear", all: true })).toBe(false);
  });

  it("server messages parse; none of them has a field for a voter", () => {
    const voting = { state: "open", budget: 5, round: 1 };
    const me = { id: ID, name: "Alex", colourIndex: 0, host: false };
    for (const m of [
      { type: "voterGranted", remaining: 5, mine: [] },
      { type: "voterGranted", remaining: 2, mine: [{ noteId: ID, count: 3 }] },
      { type: "votingChanged", voting },
      { type: "votingChanged", voting: { state: "off", budget: 5, round: 0 } },
      { type: "voteConfirmed", noteId: ID, count: 2, remaining: 3 },
      { type: "votesRevealed", round: 1, totals: [{ noteId: ID, count: 7 }] },
      { type: "votesRevealed", round: 1, totals: [] },
      { type: "joined", you: me, participants: [me], locked: false, timer: null, voting },
      ...(["voters_full", "over_budget", "voting_closed", "no_voter"] as const).map((code) => ({ type: "error", code, message: "No.", noteId: ID })),
    ]) {
      expect(serverOk(m), JSON.stringify(m)).toBe(true);
    }
    // Strict: a voter id can't ride along on any of them.
    expect(serverOk({ type: "voteConfirmed", noteId: ID, count: 2, remaining: 3, voterId: "x" })).toBe(false);
    expect(serverOk({ type: "votesRevealed", round: 1, totals: [{ noteId: ID, count: 7, voters: ["x"] }] })).toBe(false);
    expect(serverOk({ type: "voterGranted", remaining: 5, mine: [], voterId: "x" })).toBe(false);
    // Totals are non-zero; joined must carry the voting state; states and budgets are checked.
    expect(serverOk({ type: "votesRevealed", round: 1, totals: [{ noteId: ID, count: 0 }] })).toBe(false);
    expect(serverOk({ type: "joined", you: me, participants: [me], locked: false, timer: null })).toBe(false);
    expect(serverOk({ type: "votingChanged", voting: { state: "paused", budget: 5, round: 1 } })).toBe(false);
    expect(serverOk({ type: "votingChanged", voting: { state: "open", budget: 21, round: 1 } })).toBe(false);
    expect(serverOk({ type: "voteConfirmed", noteId: ID, count: 2, remaining: -1 })).toBe(false);
  });

  it("the largest joined (20 hosts with 24-emoji names, a timer and the voting state at their widest) stays under 8 KiB", () => {
    const people = Array.from({ length: MAX_PARTICIPANTS }, (_, i) => ({ id: ID, name: "😀".repeat(MAX_NAME_LENGTH), colourIndex: i, host: true }));
    const big = Number.MAX_SAFE_INTEGER;
    const raw = encodeMessage({
      type: "joined",
      you: people[0]!,
      participants: people,
      locked: true,
      timer: { startedAt: big, durationMs: TIMER_MAX_MS, serverNow: big },
      voting: { state: "closed", budget: VOTE_BUDGET_MAX, round: big },
    });
    expect(serverOk(JSON.parse(raw))).toBe(true);
    expect(utf8Length(raw)).toBeLessThan(8 * 1024);
  });

  it("the largest votesRevealed (every note of a full room, 40 voters x 20 dots on each) fits the server cap with room to spare", () => {
    const totals = Array.from({ length: MAX_NOTES_PER_ROOM }, (_, i) => ({ noteId: noteId(i), count: MAX_VOTERS_PER_ROUND * VOTE_BUDGET_MAX }));
    const raw = encodeMessage({ type: "votesRevealed", round: Number.MAX_SAFE_INTEGER, totals });
    expect(serverOk(JSON.parse(raw))).toBe(true);
    expect(utf8Length(raw)).toBeLessThan(16 * 1024);
    expect(utf8Length(raw)).toBeLessThan(MAX_SERVER_MESSAGE_BYTES);
  });

  it("the largest voterGranted (20 notes, one dot each) and every vote message a client sends are small", () => {
    const mine = Array.from({ length: VOTE_BUDGET_MAX }, (_, i) => ({ noteId: noteId(i), count: 1 }));
    const granted = encodeMessage({ type: "voterGranted", remaining: 0, mine });
    expect(serverOk(JSON.parse(granted))).toBe(true);
    expect(utf8Length(granted)).toBeLessThan(2 * 1024);
    expect(serverOk({ type: "voterGranted", remaining: 0, mine: [...mine, { noteId: ID, count: 1 }] })).toBe(false);
    expect(utf8Length(JSON.stringify({ type: "claimVoter", key: "k".repeat(VOTER_KEY_MAX_LENGTH) }))).toBeLessThan(MAX_MESSAGE_BYTES);
  });
});
