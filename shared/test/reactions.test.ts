import { describe, expect, it } from "vitest";
import {
  BOARD_WRITES,
  HOST_ONLY,
  MAX_NOTES_PER_ROOM,
  MAX_REACTIONS_PER_REACTOR,
  MAX_REACTIONS_PER_ROOM,
  MAX_SERVER_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  REACTION_KEYS,
  SERVER_MESSAGES,
  VOTE_BUDGET_MAX,
  clientMessageSchema,
  encodeMessage,
  errorCodeSchema,
  serverMessageSchema,
  utf8Length,
} from "../src";

/* Protocol v20 (reactions on notes, part 1: relay and shared). Generic fixtures only. */

const ID = "AAAAAAAAAAAAAAAA";
const noteId = (i: number) => `note${String(i).padStart(12, "0")}`;
const ok = (m: unknown) => clientMessageSchema.safeParse(m).success;
const serverOk = (m: unknown) => serverMessageSchema.safeParse(m).success;
const SERVER_TYPES = ["reactionCount", "reactionMine", "reactionsSnapshot"] as const;

describe("protocol v20", () => {
  it("is version 20", () => {
    expect(PROTOCOL_VERSION).toBe(20);
  });

  it("six fixed reaction keys, never raw emoji", () => {
    expect(REACTION_KEYS).toEqual(["thumbs_up", "heart", "laugh", "celebrate", "thinking", "plus"]);
  });

  it("caps: a room's reaction rows and one reactor's, the reactor's well inside the room's", () => {
    expect(MAX_REACTIONS_PER_ROOM).toBe(2000);
    expect(MAX_REACTIONS_PER_REACTOR).toBe(100);
    expect(MAX_REACTIONS_PER_REACTOR * 20).toBeLessThanOrEqual(MAX_REACTIONS_PER_ROOM);
  });

  it("reactionSet doesn't change the board (a locked board takes it) and isn't host-only", () => {
    expect(BOARD_WRITES.reactionSet).toBe(false);
    expect(HOST_ONLY).not.toContain("reactionSet");
  });

  it("every reaction message the relay sends is note-carrying, so the sealed filter sees it", () => {
    for (const t of SERVER_TYPES) expect(SERVER_MESSAGES[t].carriesNoteContent).toBe(true);
  });

  it("new error codes: unknown_note, reactions_full (the room's cap), reactor_full (one reactor's)", () => {
    for (const code of ["unknown_note", "reactions_full", "reactor_full"]) expect(errorCodeSchema.safeParse(code).success).toBe(true);
  });
});

describe("reactionSet", () => {
  it("accepts each of the six keys, on or off", () => {
    for (const key of REACTION_KEYS) {
      expect(ok({ type: "reactionSet", noteId: ID, key, on: true })).toBe(true);
      expect(ok({ type: "reactionSet", noteId: ID, key, on: false })).toBe(true);
    }
  });

  it("rejects any other key: raw emoji, other names, case changes, empty, numbers", () => {
    for (const key of ["👍", "❤️", "thumbsup", "THUMBS_UP", "Heart", "fire", "", " heart", "heart ", 0, null]) {
      expect(ok({ type: "reactionSet", noteId: ID, key, on: true })).toBe(false);
    }
  });

  it("rejects long, short or malformed note ids", () => {
    expect(ok({ type: "reactionSet", noteId: `${ID}A`, key: "heart", on: true })).toBe(false);
    expect(ok({ type: "reactionSet", noteId: "A".repeat(4000), key: "heart", on: true })).toBe(false);
    expect(ok({ type: "reactionSet", noteId: "short", key: "heart", on: true })).toBe(false);
    expect(ok({ type: "reactionSet", noteId: "AAAAAAAAAAAAAAA=", key: "heart", on: true })).toBe(false);
  });

  it("is strict: extra fields (a claimed reactor, a count, a participant) are refused", () => {
    expect(ok({ type: "reactionSet", noteId: ID, key: "heart", on: true, reactorId: "x".repeat(43) })).toBe(false);
    expect(ok({ type: "reactionSet", noteId: ID, key: "heart", on: true, count: 5 })).toBe(false);
    expect(ok({ type: "reactionSet", noteId: ID, key: "heart", on: true, from: ID })).toBe(false);
  });

  it("is an idempotent set, not a toggle: `on` is required and boolean", () => {
    expect(ok({ type: "reactionSet", noteId: ID, key: "heart" })).toBe(false);
    for (const on of [1, 0, "true", null]) expect(ok({ type: "reactionSet", noteId: ID, key: "heart", on })).toBe(false);
  });
});

describe("server messages", () => {
  it("reactionCount: a note, a key and a count (0 allowed), strict: never who", () => {
    expect(serverOk({ type: "reactionCount", noteId: ID, key: "plus", count: 0 })).toBe(true);
    expect(serverOk({ type: "reactionCount", noteId: ID, key: "plus", count: MAX_REACTIONS_PER_ROOM })).toBe(true);
    expect(serverOk({ type: "reactionCount", noteId: ID, key: "plus", count: MAX_REACTIONS_PER_ROOM + 1 })).toBe(false);
    expect(serverOk({ type: "reactionCount", noteId: ID, key: "plus", count: -1 })).toBe(false);
    expect(serverOk({ type: "reactionCount", noteId: ID, key: "fire", count: 1 })).toBe(false);
    expect(serverOk({ type: "reactionCount", noteId: ID, key: "plus", count: 1, from: ID })).toBe(false);
    expect(serverOk({ type: "reactionCount", noteId: ID, key: "plus", count: 1, reactors: [ID] })).toBe(false);
  });

  it("reactionMine: my own on/off for a note and key, strict", () => {
    expect(serverOk({ type: "reactionMine", noteId: ID, key: "heart", on: true })).toBe(true);
    expect(serverOk({ type: "reactionMine", noteId: ID, key: "heart", on: false })).toBe(true);
    expect(serverOk({ type: "reactionMine", noteId: ID, key: "heart", on: true, reactorId: "x".repeat(43) })).toBe(false);
  });

  it("reactionsSnapshot: non-zero counts per note and key, strict entries", () => {
    expect(serverOk({ type: "reactionsSnapshot", counts: [] })).toBe(true);
    expect(serverOk({ type: "reactionsSnapshot", counts: [{ noteId: ID, key: "laugh", count: 3 }] })).toBe(true);
    expect(serverOk({ type: "reactionsSnapshot", counts: [{ noteId: ID, key: "laugh", count: 0 }] })).toBe(false);
    expect(serverOk({ type: "reactionsSnapshot", counts: [{ noteId: ID, key: "laugh", count: 3, who: [ID] }] })).toBe(false);
    expect(serverOk({ type: "reactionsSnapshot", counts: [], mine: [] })).toBe(false);
  });

  it("voterGranted may carry my own reactions (note and key only), at most one reactor's cap", () => {
    const mine = { noteId: ID, key: "thinking" };
    expect(serverOk({ type: "voterGranted", remaining: 5, mine: [] })).toBe(true);
    expect(serverOk({ type: "voterGranted", remaining: 5, mine: [], reactions: [mine] })).toBe(true);
    expect(serverOk({ type: "voterGranted", remaining: 5, mine: [], reactions: [{ ...mine, reactorId: "x".repeat(43) }] })).toBe(false);
    const full = Array.from({ length: MAX_REACTIONS_PER_REACTOR + 1 }, (_, i) => ({ noteId: noteId(i), key: "plus" }));
    expect(serverOk({ type: "voterGranted", remaining: 5, mine: [], reactions: full })).toBe(false);
  });

  it("the largest reactionsSnapshot (every note, every key, room-cap counts) is far under the server cap", () => {
    const counts = Array.from({ length: MAX_NOTES_PER_ROOM }, (_, i) => REACTION_KEYS.map((key) => ({ noteId: noteId(i), key, count: MAX_REACTIONS_PER_ROOM }))).flat();
    const message = { type: "reactionsSnapshot", counts };
    expect(serverOk(message)).toBe(true);
    const bytes = utf8Length(encodeMessage(serverMessageSchema.parse(message)));
    expect(bytes).toBeLessThan(96 * 1024);
    expect(bytes).toBeLessThan(MAX_SERVER_MESSAGE_BYTES);
  });

  it("the largest voterGranted with reactions stays small", () => {
    const reactions = Array.from({ length: MAX_REACTIONS_PER_REACTOR }, (_, i) => ({ noteId: noteId(i), key: "thumbs_up" }));
    const votes = Array.from({ length: VOTE_BUDGET_MAX }, (_, i) => ({ noteId: noteId(i), count: 1 }));
    const message = serverMessageSchema.parse({ type: "voterGranted", remaining: 0, mine: votes, reactions });
    expect(utf8Length(encodeMessage(message))).toBeLessThan(8 * 1024);
  });
});
