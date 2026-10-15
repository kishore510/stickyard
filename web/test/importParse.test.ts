// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { BOARD_HEIGHT, BOARD_WIDTH, MAX_NOTE_TEXT, MAX_NOTES_PER_ROOM, NOTE_DEFAULTS, cleanNoteText, utf8Length } from "@stickyard/shared";
import { BOARD_FILE_FORMAT, boardFileText, buildBoardFile, type BoardFile } from "../src/export/boardFile";
import { IMPORT_MAX_BYTES, IMPORT_TEXT, importCounts, importRoomFails, parseBoardFile, parseTextImport, type ImportContent } from "../src/importer/parse";
import { EMPTY_BOARD, applySnapshot } from "../src/notes/board";
import { applyShapesSnapshot } from "../src/shapes/board";
import { applyFramesSnapshot } from "../src/frames/board";
import { applyConnectorsSnapshot } from "../src/connectors/board";
import { applyGroupsSnapshot } from "../src/groups/board";
import { connector, frame, group, nid, note, shape, sid } from "./helpers/fakeRelay";

/*
 * Import, part 2 of Export on phones and Import (v0.40.0, web only): a board file or plain text
 * read as untrusted data. Validated with the stencil item schemas, size-capped, unknown or newer
 * formats refused calmly, ids, authors, votes and reactions ignored, every text cleaned as typed
 * text is, nothing evaluated, fetched or rendered. Text: one note per line.
 */

const HOSTILE = '<img src=x onerror=alert(1)> [x](javascript:alert(1)) https://example.test/a.png';

const valid = (extra: Partial<BoardFile> & Record<string, unknown> = {}): Record<string, unknown> => ({
  format: BOARD_FILE_FORMAT,
  formatVersion: 1,
  notes: [
    { ref: "n1", x: 0, y: 0, text: "One", ...NOTE_DEFAULTS, color: "yellow" },
    { ref: "n2", x: 200, y: 0, text: "Two", ...NOTE_DEFAULTS, color: "blue" },
  ],
  shapes: [],
  frames: [],
  arrows: [{ start: { ref: "n1", anchor: "right" }, end: { ref: "n2", anchor: "left" }, route: "straight", dash: "solid", width: "medium", ink: "neutral", startHead: "none", endHead: "arrow" }],
  groups: [{ label: "Pair", color: "blue", members: ["n1", "n2"] }],
  stack: ["n2", "n1"],
  ...extra,
});
const json = (v: unknown) => JSON.stringify(v);
const ok = (r: ReturnType<typeof parseBoardFile>): ImportContent => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.content;
};
const refusal = (r: ReturnType<typeof parseBoardFile>) => (r.ok ? null : r.reason);

describe("reading a board file", () => {
  it("accepts a valid file, keeping items, arrows, groups and the stacking order", () => {
    const c = ok(parseBoardFile(json(valid())));
    expect(importCounts(c)).toEqual({ notes: 2, shapes: 0, frames: 0, arrows: 1, groups: 1 });
    expect(c.notes.map((n) => n.text)).toEqual(["One", "Two"]);
    expect(c.stack).toEqual(["n2", "n1"]);
    expect(c.arrows[0]).toMatchObject({ start: { ref: "n1" }, end: { ref: "n2" } });
  });

  it("reads back what Export board file writes", () => {
    let board = applySnapshot(EMPTY_BOARD, [note(1, { x: 500, y: 500, z: 3 }), note(2, { x: 800, y: 500, z: 1 })]);
    board = applyShapesSnapshot(board, [shape(1, { x: 500, y: 800, z: 2 })]);
    board = applyFramesSnapshot(board, [frame(1, { x: 400, y: 400 })]);
    board = applyConnectorsSnapshot(board, [connector(1, { item: nid(1), anchor: "right" }, { item: sid(1), anchor: "auto" })]);
    board = applyGroupsSnapshot(board, [group(1, [nid(1), nid(2)], { label: "G" })]);
    const file = buildBoardFile(board)!;
    const c = ok(parseBoardFile(boardFileText(file)));
    const { format: _, formatVersion: __, ...items } = file;
    expect(c).toMatchObject(items);
  });

  it("a missing stack means notes, then shapes; missing lists are empty", () => {
    const raw = valid();
    delete raw.stack;
    delete raw.arrows;
    delete raw.groups;
    const c = ok(parseBoardFile(json(raw)));
    expect(c.stack).toEqual(["n1", "n2"]);
    expect(c.arrows).toEqual([]);
  });

  it.each([
    ["no format", { ...valid(), format: undefined }],
    ["another format", valid({ format: "excalidraw" as never })],
    ["a stencil list", { version: 1, stencils: [] }],
    ["a version that isn't a whole number", valid({ formatVersion: 1.5 as never })],
    ["a version as a string", valid({ formatVersion: "1" as never })],
  ])("refuses %s as not a board file", (_, raw) => {
    expect(refusal(parseBoardFile(json(raw)))).toBe(IMPORT_TEXT.notBoardFile);
  });

  it("refuses a newer format version calmly", () => {
    expect(refusal(parseBoardFile(json(valid({ formatVersion: 2 as never }))))).toBe(IMPORT_TEXT.newer);
  });

  it.each([
    ["not JSON", "{ format: stickyard-board"],
    ["JSON that isn't an object", "[1,2,3]"],
    ["null", "null"],
    ["an empty file", ""],
  ])("refuses %s", (_, text) => {
    expect(refusal(parseBoardFile(text))).toBe(IMPORT_TEXT.notBoardFile);
  });

  it.each([
    ["a bad colour key", valid({ notes: [{ ref: "n1", x: 0, y: 0, text: "x", ...NOTE_DEFAULTS, color: "red; background:url(x)" }] as never, arrows: [], groups: [], stack: undefined as never })],
    ["an arrow to an unknown ref", valid({ arrows: [{ ...(valid().arrows as never[])[0]!, end: { ref: "nope", anchor: "auto" } }] as never })],
    ["a group of one", valid({ groups: [{ label: "", color: "blue", members: ["n1"] }] as never })],
    ["a duplicate ref", valid({ notes: [(valid().notes as never[])[0]!, { ...(valid().notes as Record<string, unknown>[])[1]!, ref: "n1" }] as never })],
    ["a coordinate that isn't a number", valid({ notes: [{ ...(valid().notes as Record<string, unknown>[])[0]!, x: "0" }] as never, arrows: [], groups: [], stack: ["n1"] })],
    ["an unknown key in a note", valid({ notes: [{ ...(valid().notes as Record<string, unknown>[])[0]!, onclick: "alert(1)" }, (valid().notes as never[])[1]!] as never })],
    ["a stack naming something else", valid({ stack: ["n1", "zz"] })],
    ["a stack missing an item", valid({ stack: ["n1"] })],
    ["a stack that isn't a list", valid({ stack: "n1,n2" as never })],
    ["a list that isn't a list", valid({ notes: { n1: {} } as never })],
  ])("refuses %s as unreadable", (_, raw) => {
    expect(refusal(parseBoardFile(json(raw)))).toBe(IMPORT_TEXT.malformed);
  });

  it("ignores ids, revs, z, authors, votes, reactions and ranks anywhere they appear", () => {
    const extra = { id: "note00000000001", rev: 9, z: 4, authorId: "AAAAAAAAAAAAAAAA", votes: 3, dots: 2, reactions: { heart: 4 }, rank: 1 };
    const raw = valid({
      id: "room-ish",
      roomCode: "secret",
      notes: (valid().notes as Record<string, unknown>[]).map((n) => ({ ...n, ...extra })) as never,
      arrows: (valid().arrows as Record<string, unknown>[]).map((a) => ({ ...a, id: "conn1", rev: 1, authorId: "A" })) as never,
      groups: (valid().groups as Record<string, unknown>[]).map((g) => ({ ...g, id: "grp1", rev: 2 })) as never,
    });
    const c = ok(parseBoardFile(json(raw)));
    const text = JSON.stringify(c);
    for (const key of ['"id"', '"rev"', '"z"', '"authorId"', '"votes"', '"dots"', '"reactions"', '"rank"', "secret", "roomCode"]) expect(text).not.toContain(key);
  });

  it("hostile strings stay plain text, cleaned as typed text is; nothing is followed", () => {
    const raw = valid({
      notes: [
        { ref: "n1", x: 0, y: 0, text: `  ${HOSTILE}\u0007‮​  `, ...NOTE_DEFAULTS, color: "yellow" },
        { ref: "n2", x: 200, y: 0, text: "Two", ...NOTE_DEFAULTS, color: "blue" },
      ] as never,
      groups: [{ label: `${HOSTILE}\u0000`, color: "blue", members: ["n1", "n2"] }] as never,
    });
    const c = ok(parseBoardFile(json(raw)));
    expect(c.notes[0]!.text).toBe(cleanNoteText(`  ${HOSTILE}\u0007‮​  `));
    expect(c.notes[0]!.text).toContain("<img src=x");
    expect(c.notes[0]!.text).not.toMatch(/[\u0000-\u001F‮​]/);
    expect(c.groups[0]!.label.startsWith("<img")).toBe(true);
    // A key named like a prototype is just an unknown key.
    expect(refusal(parseBoardFile('{"format":"stickyard-board","formatVersion":1,"notes":[{"__proto__":{"x":1}}]}'))).toBe(IMPORT_TEXT.malformed);
  });

  it("cuts text to its cap, as typing does", () => {
    const raw = valid({ notes: [{ ref: "n1", x: 0, y: 0, text: "é".repeat(400), ...NOTE_DEFAULTS, color: "yellow" }] as never, arrows: [], groups: [], stack: ["n1"] });
    expect([...ok(parseBoardFile(json(raw))).notes[0]!.text]).toHaveLength(MAX_NOTE_TEXT);
  });

  it("refuses a file over the size cap without parsing it", () => {
    const big = json(valid({ padding: "x".repeat(IMPORT_MAX_BYTES) } as never));
    expect(utf8Length(big)).toBeGreaterThan(IMPORT_MAX_BYTES);
    expect(refusal(parseBoardFile(big))).toBe(IMPORT_TEXT.tooLarge);
  });

  it("refuses more items than any board holds, saying which", () => {
    const notes = Array.from({ length: MAX_NOTES_PER_ROOM + 1 }, (_, i) => ({ ref: `n${i + 1}`, x: 0, y: 0, text: "", ...NOTE_DEFAULTS, color: "yellow" }));
    expect(refusal(parseBoardFile(json(valid({ notes: notes as never, arrows: [], groups: [], stack: undefined as never }))))).toBe(IMPORT_TEXT.tooMany("notes", MAX_NOTES_PER_ROOM + 1));
    const arrows = Array.from({ length: 5000 }, () => (valid().arrows as never[])[0]!);
    expect(refusal(parseBoardFile(json(valid({ arrows: arrows as never }))))).toBe(IMPORT_TEXT.tooMany("arrows", 5000));
  });

  it("refuses content bigger than the board", () => {
    const raw = valid({ notes: [{ ref: "n1", x: 0, y: 0, text: "a", ...NOTE_DEFAULTS, color: "yellow" }, { ref: "n2", x: BOARD_WIDTH, y: 0, text: "b", ...NOTE_DEFAULTS, color: "yellow" }] as never });
    expect(refusal(parseBoardFile(json(raw)))).toBe(IMPORT_TEXT.biggerThanBoard);
    const tall = valid({ notes: [{ ref: "n1", x: 0, y: -10, text: "a", ...NOTE_DEFAULTS, color: "yellow" }, { ref: "n2", x: 0, y: BOARD_HEIGHT - 100, text: "b", ...NOTE_DEFAULTS, color: "yellow" }] as never });
    expect(refusal(parseBoardFile(json(tall)))).toBe(IMPORT_TEXT.biggerThanBoard);
  });

  it("keeps the layout of a file that doesn't start at 0, 0 (moved to the top-left)", () => {
    const raw = valid({ notes: [{ ref: "n1", x: -300, y: 50, text: "a", ...NOTE_DEFAULTS, color: "yellow" }, { ref: "n2", x: -100, y: 150, text: "b", ...NOTE_DEFAULTS, color: "yellow" }] as never });
    const c = ok(parseBoardFile(json(raw)));
    expect(c.notes.map((n) => [n.x, n.y])).toEqual([
      [0, 0],
      [200, 100],
    ]);
  });

  it("an empty board file has nothing to import", () => {
    expect(refusal(parseBoardFile(json(valid({ notes: [], arrows: [], groups: [], stack: [] }))))).toBe(IMPORT_TEXT.empty);
  });

  it("the largest board Stickyard can hold fits under the cap", () => {
    const longest = "😀".repeat(MAX_NOTE_TEXT);
    const notes = Array.from({ length: MAX_NOTES_PER_ROOM }, (_, i) => note(i + 1, { text: longest, x: (i % 20) * 300, y: Math.floor(i / 20) * 300 }));
    const shapes = Array.from({ length: 50 }, (_, i) => shape(i + 1, { text: "😀".repeat(500), x: (i % 20) * 300, y: 3200 }));
    const frames = Array.from({ length: 30 }, (_, i) => frame(i + 1, { title: "😀".repeat(60), x: (i % 9) * 700, y: Math.floor(i / 9) * 450 }));
    const arrows = Array.from({ length: 100 }, (_, i) => connector(i + 1, { x: 10.123456789, y: 10.987654321 + i }, { x: 90.5555555, y: 10.333333 + i }, { route: "elbow" }));
    const groups = Array.from({ length: 30 }, (_, i) => group(i + 1, [nid(2 * i + 1), nid(2 * i + 2)], { label: "😀".repeat(40) }));
    let board = applySnapshot(EMPTY_BOARD, notes);
    board = applyShapesSnapshot(board, shapes);
    board = applyFramesSnapshot(board, frames);
    board = applyConnectorsSnapshot(board, arrows);
    board = applyGroupsSnapshot(board, groups);
    const text = boardFileText(buildBoardFile(board)!);
    expect(utf8Length(text)).toBeLessThan(IMPORT_MAX_BYTES);
    expect(parseBoardFile(text).ok).toBe(true);
  });
});

describe("reading plain text", () => {
  it("one note per line, trimmed, blank lines dropped, default colour, in a grid from 0, 0", () => {
    const c = ok(parseTextImport("  First  \r\n\n   \nSecond\rThird Fourth\n"));
    expect(c.notes.map((n) => n.text)).toEqual(["First", "Second", "Third", "Fourth"]);
    expect(c.notes.every((n) => n.color === "yellow" && n.w === NOTE_DEFAULTS.w && n.h === NOTE_DEFAULTS.h)).toBe(true);
    expect(c.notes[0]).toMatchObject({ x: 0, y: 0 });
    // Four notes: two columns.
    expect(new Set(c.notes.map((n) => n.x)).size).toBe(2);
    expect(new Set(c.notes.map((n) => n.y)).size).toBe(2);
    expect(c.stack).toEqual(c.notes.map((n) => n.ref));
    expect(importCounts(c)).toEqual({ notes: 4, shapes: 0, frames: 0, arrows: 0, groups: 0 });
  });

  it("cleans each line exactly like typed note text, emoji kept", () => {
    const lines = ["Ship it 🚀👩🏽‍💻", "tab\there", "bell\u0007 and ‮reversed‬", "zero​width", HOSTILE];
    const c = ok(parseTextImport(lines.join("\n")));
    expect(c.notes.map((n) => n.text)).toEqual(lines.map((l) => cleanNoteText(l)));
    expect(c.notes[0]!.text).toBe("Ship it 🚀👩🏽‍💻");
  });

  it("a very long line is cut to the note cap, and counted", () => {
    const c = ok(parseTextImport(`${"x".repeat(1000)}\nshort`));
    expect([...c.notes[0]!.text]).toHaveLength(MAX_NOTE_TEXT);
    expect(c.cut).toBe(1);
  });

  it("only blank lines or control characters: nothing to import", () => {
    expect(refusal(parseTextImport("\n \n\t\n\u0007​\n"))).toBe(IMPORT_TEXT.emptyText);
  });

  it("more lines than any board holds is refused, saying how many", () => {
    const text = Array.from({ length: MAX_NOTES_PER_ROOM + 5 }, (_, i) => `Line ${i}`).join("\n");
    expect(refusal(parseTextImport(text))).toBe(IMPORT_TEXT.tooMany("notes", MAX_NOTES_PER_ROOM + 5));
  });

  it("text over the size cap is refused", () => {
    expect(refusal(parseTextImport("a\n".repeat(IMPORT_MAX_BYTES)))).toBe(IMPORT_TEXT.tooLarge);
  });
});

describe("room on the board", () => {
  const c = ok(parseTextImport(Array.from({ length: 12 }, (_, i) => `Idea ${i}`).join("\n")));
  it("lists everything that wouldn't fit", () => {
    expect(importRoomFails(c, { notes: 195, shapes: 0, frames: 0, arrows: 0, groups: 0 })).toEqual([["notes", 12, 5]]);
    expect(importRoomFails(c, { notes: 0, shapes: 0, frames: 0, arrows: 0, groups: 0 })).toEqual([]);
    expect(IMPORT_TEXT.noRoom([["notes", 12, 5]])).toBe("This import needs 12 notes, but the board has room for 5 more (at most 200). Nothing was added.");
  });
});
