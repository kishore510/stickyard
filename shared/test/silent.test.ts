import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  BOARD_WRITES,
  HOST_ONLY,
  ITEM_REFUSALS,
  MAX_BATCH_ENTRIES,
  MAX_NAME_LENGTH,
  MAX_NOTES_PER_ROOM,
  MAX_NOTE_TEXT,
  MAX_PARTICIPANTS,
  MAX_SEALED_PER_WRITER,
  MAX_SERVER_MESSAGE_BYTES,
  NOTE_ALIGNS,
  NOTE_COLORS,
  NOTE_FONT_SIZES,
  NOTE_MAX_H,
  NOTE_MAX_W,
  NOTE_TEXT_COLORS,
  NOTE_Z_LIMIT,
  PROTOCOL_VERSION,
  REVEAL_CHUNK_MAX_BYTES,
  REVEAL_CHUNK_NOTES,
  SERVER_MESSAGES,
  TIMER_MAX_MS,
  VOTE_BUDGET_MAX,
  VOTER_KEY_MAX_LENGTH,
  clientMessageSchema,
  encodeMessage,
  serverMessageSchema,
  utf8Length,
  type Note,
} from "../src";

/*
 * Silent brainstorm, protocol v17 (part 1: relay and shared). The host starts a silent round;
 * notes added while it runs are sealed (only their writer sees them) until the host reveals them.
 * A page names its writer with the room's client key in `join`.
 */

const ID = "AAAAAAAAAAAAAAAA";
const KEY = "k".repeat(22);
const clientOk = (m: unknown) => clientMessageSchema.safeParse(m).success;
const serverOk = (m: unknown) => serverMessageSchema.safeParse(m).success;
const longest = <T extends string>(keys: readonly T[]) => [...keys].sort((a, b) => b.length - a.length)[0]!;
const pad = (prefix: string, i: number) => `${prefix}${String(i).padStart(16 - prefix.length, "0")}`;

/** The largest note on the wire (the snapshot tests' worst note). */
const worstNote = (i: number): Note => ({
  id: pad("note", i),
  x: BOARD_WIDTH - NOTE_MAX_W,
  y: BOARD_HEIGHT - NOTE_MAX_H,
  w: NOTE_MAX_W,
  h: NOTE_MAX_H,
  text: "\ud800".repeat(MAX_NOTE_TEXT),
  color: longest(NOTE_COLORS),
  fontSize: longest(NOTE_FONT_SIZES),
  bold: false,
  italic: false,
  textColor: longest(NOTE_TEXT_COLORS),
  align: longest(NOTE_ALIGNS),
  titleAlign: longest(NOTE_ALIGNS),
  titleFontSize: longest(NOTE_FONT_SIZES),
  titleBold: false,
  titleItalic: false,
  titleTextColor: longest(NOTE_TEXT_COLORS),
  z: -NOTE_Z_LIMIT,
  rev: Number.MAX_SAFE_INTEGER,
  authorId: ID,
});

describe("protocol v17", () => {
  it("is version 17", () => {
    expect(PROTOCOL_VERSION).toBe(17);
  });

  it("silentStart and silentReveal are strict, host-only and don't count as board writes (a locked board can start one)", () => {
    expect(clientOk({ type: "silentStart" })).toBe(true);
    expect(clientOk({ type: "silentReveal" })).toBe(true);
    expect(clientOk({ type: "silentStart", round: 2 })).toBe(false);
    expect(clientOk({ type: "silentReveal", notes: [] })).toBe(false);
    expect(HOST_ONLY).toEqual(expect.arrayContaining(["silentStart", "silentReveal"]));
    expect(BOARD_WRITES.silentStart).toBe(false);
    expect(BOARD_WRITES.silentReveal).toBe(false);
  });

  it("join may carry the room's client key (the voter key's format); nothing else names a writer", () => {
    expect(clientOk({ type: "join", name: "Sam" })).toBe(true);
    expect(clientOk({ type: "join", name: "Sam", key: KEY })).toBe(true);
    expect(clientOk({ type: "join", name: "Sam", key: "k".repeat(VOTER_KEY_MAX_LENGTH) })).toBe(true);
    expect(clientOk({ type: "join", name: "Sam", key: "short" })).toBe(false);
    expect(clientOk({ type: "join", name: "Sam", key: `${"k".repeat(21)}=` })).toBe(false);
    expect(clientOk({ type: "join", name: "Sam", key: 42 })).toBe(false);
    // A claimed writer id is stripped, never read (join stays non-strict, like before).
    const parsed = clientMessageSchema.safeParse({ type: "join", name: "Sam", writerId: "x".repeat(43) });
    expect(parsed.success && !("writerId" in parsed.data)).toBe(true);
    // Strict note messages can't name a writer or a seal either.
    expect(clientOk({ type: "noteAdd", clientRef: "r1", x: 0, y: 0, color: "yellow", text: "", sealed: true })).toBe(false);
    expect(clientOk({ type: "noteAdd", clientRef: "r1", x: 0, y: 0, color: "yellow", text: "", writer: "x" })).toBe(false);
  });

  it("server messages: silentChanged carries only active and the count; notesRevealed carries 1 to 50 notes and final", () => {
    expect(serverOk({ type: "silentChanged", active: true, count: 0 })).toBe(true);
    expect(serverOk({ type: "silentChanged", active: false, count: MAX_NOTES_PER_ROOM })).toBe(true);
    expect(serverOk({ type: "silentChanged", active: true, count: MAX_NOTES_PER_ROOM + 1 })).toBe(false);
    expect(serverOk({ type: "silentChanged", active: true, count: -1 })).toBe(false);
    expect(serverOk({ type: "silentChanged", active: true, count: 1, writers: 1 })).toBe(false);
    expect(serverOk({ type: "silentChanged", active: true, count: 1, mine: 1 })).toBe(false);
    expect(serverOk({ type: "notesRevealed", notes: [worstNote(0)], final: true })).toBe(true);
    expect(serverOk({ type: "notesRevealed", notes: [], final: true })).toBe(false);
    expect(serverOk({ type: "notesRevealed", notes: Array.from({ length: REVEAL_CHUNK_NOTES + 1 }, (_, i) => worstNote(i)), final: true })).toBe(false);
    expect(serverOk({ type: "notesRevealed", notes: [worstNote(0)] })).toBe(false);
    expect(serverOk({ type: "notesRevealed", notes: [{ ...worstNote(0), writer: "x" }], final: true })).toBe(true);
    // A note never carries a writer or a seal on the wire: unknown keys are stripped by the note schema.
    const parsed = serverMessageSchema.safeParse({ type: "noteAdded", note: { ...worstNote(0), writer: "x", sealed: true } });
    expect(parsed.success && parsed.data.type === "noteAdded" && !("writer" in parsed.data.note) && !("sealed" in parsed.data.note)).toBe(true);
  });

  it("joined carries the silent state", () => {
    const me = { id: ID, name: "Alex", colourIndex: 0, host: false };
    const base = { type: "joined", you: me, participants: [me], locked: false, timer: null, voting: { state: "off", budget: 5, round: 0 } };
    expect(serverOk({ ...base, silent: { active: false, count: 0 } })).toBe(true);
    expect(serverOk({ ...base, silent: { active: true, count: 12 } })).toBe(true);
    expect(serverOk(base)).toBe(false);
    expect(serverOk({ ...base, silent: { active: true, count: 1, round: 1 } })).toBe(false);
  });

  it("new error codes and item refusals", () => {
    for (const code of ["silent_active", "no_writer", "sealed_full"]) {
      expect(serverOk({ type: "error", code, message: "No." })).toBe(true);
    }
    expect(ITEM_REFUSALS).toEqual(expect.arrayContaining(["no_writer", "sealed_full"]));
    expect(MAX_SEALED_PER_WRITER).toBe(40);
    expect(MAX_SEALED_PER_WRITER).toBeLessThanOrEqual(MAX_NOTES_PER_ROOM);
  });
});

describe("server message registry", () => {
  it("classifies every server message type (carriesNoteContent), and nothing else", () => {
    const types = serverMessageSchema.options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(SERVER_MESSAGES).sort()).toEqual(types);
    for (const t of types) expect(typeof SERVER_MESSAGES[t as keyof typeof SERVER_MESSAGES].carriesNoteContent).toBe("boolean");
  });

  it("marks every message that can carry a note's id, text, place, size, colour or author", () => {
    const carrying = Object.entries(SERVER_MESSAGES)
      .filter(([, v]) => v.carriesNoteContent)
      .map(([k]) => k)
      .sort();
    expect(carrying).toEqual(
      [
        "error",
        "snapshot",
        "noteAdded",
        "noteUpdated",
        "noteMoved",
        "noteResized",
        "noteDeleted",
        "notesBatchApplied",
        "notesOrdered",
        "frameMoved",
        "itemsAdded",
        "voterGranted",
        "voteConfirmed",
        "votesRevealed",
        "notesRevealed",
      ].sort(),
    );
    expect(SERVER_MESSAGES.silentChanged.carriesNoteContent).toBe(false);
    expect(SERVER_MESSAGES.joined.carriesNoteContent).toBe(false);
  });
});

describe("sizes", () => {
  it(`the largest notesRevealed chunk (${REVEAL_CHUNK_NOTES} notes at their largest, lone-surrogate text, maxed revs) stays under 128 KiB`, () => {
    expect(REVEAL_CHUNK_NOTES).toBe(MAX_BATCH_ENTRIES);
    expect(REVEAL_CHUNK_MAX_BYTES).toBe(128 * 1024);
    const raw = encodeMessage({ type: "notesRevealed", notes: Array.from({ length: REVEAL_CHUNK_NOTES }, (_, i) => worstNote(i)), final: false });
    expect(serverOk(JSON.parse(raw))).toBe(true);
    const bytes = utf8Length(raw);
    expect(bytes).toBeLessThan(REVEAL_CHUNK_MAX_BYTES);
    expect(bytes).toBeLessThan(MAX_SERVER_MESSAGE_BYTES);
    // Recorded in docs/LIMITS.md.
    expect(bytes).toBe(101_098);
  });

  it("silentChanged is tiny, and the largest joined with the silent state still stays under 8 KiB", () => {
    expect(utf8Length(encodeMessage({ type: "silentChanged", active: true, count: MAX_NOTES_PER_ROOM }))).toBeLessThan(64);
    const people = Array.from({ length: MAX_PARTICIPANTS }, (_, i) => ({ id: ID, name: "😀".repeat(MAX_NAME_LENGTH), colourIndex: i, host: true }));
    const big = Number.MAX_SAFE_INTEGER;
    const raw = encodeMessage({
      type: "joined",
      you: people[0]!,
      participants: people,
      locked: true,
      timer: { startedAt: big, durationMs: TIMER_MAX_MS, serverNow: big },
      voting: { state: "closed", budget: VOTE_BUDGET_MAX, round: big },
      silent: { active: true, count: MAX_NOTES_PER_ROOM },
    });
    expect(serverOk(JSON.parse(raw))).toBe(true);
    expect(utf8Length(raw)).toBeLessThan(8 * 1024);
  });

  it("a join with the longest key is small", () => {
    expect(utf8Length(JSON.stringify({ type: "join", name: "😀".repeat(MAX_NAME_LENGTH), key: "k".repeat(VOTER_KEY_MAX_LENGTH) }))).toBeLessThan(256);
  });
});
