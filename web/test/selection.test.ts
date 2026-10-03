import { describe, expect, it } from "vitest";
import { MAX_NOTE_TEXT, NOTE_DEFAULTS, NOTE_DEFAULT_H, NOTE_DEFAULT_W, type Note } from "@stickyard/shared";
import {
  EMPTY_SELECTION,
  clearSelection,
  isSelected,
  onlySelected,
  pruneSelection,
  renameInSelection,
  marqueeSelection,
  orderedIds,
  selectAll,
  selectOnly,
  toggleSelected,
} from "../src/canvas/selection";
import { useBoardUi } from "../src/canvas/uiStore";
import { noteSize } from "../src/notes/size";
import { joinTitleBody, splitTitleBody } from "../src/notes/titleBody";

/* Groundwork for later slices: selection is a set of note ids, and note size has one lookup. */

describe("selection (a set of note ids)", () => {
  it("starts empty", () => {
    expect(EMPTY_SELECTION.size).toBe(0);
    expect(onlySelected(EMPTY_SELECTION)).toBeNull();
  });

  it("selectOnly replaces the selection with one id (the same set if already just that)", () => {
    const a = selectOnly(EMPTY_SELECTION, "a");
    expect([...a]).toEqual(["a"]);
    expect(selectOnly(a, "a")).toBe(a);
    expect([...selectOnly(a, "b")]).toEqual(["b"]);
    expect(onlySelected(a)).toBe("a");
  });

  it("toggle adds or removes one id, leaving the others", () => {
    const ab = toggleSelected(selectOnly(EMPTY_SELECTION, "a"), "b");
    expect([...ab].sort()).toEqual(["a", "b"]);
    expect(onlySelected(ab)).toBeNull();
    expect([...toggleSelected(ab, "a")]).toEqual(["b"]);
  });

  it("clear empties it (the same set if already empty)", () => {
    expect(clearSelection(selectOnly(EMPTY_SELECTION, "a")).size).toBe(0);
    expect(clearSelection(EMPTY_SELECTION)).toBe(EMPTY_SELECTION);
  });

  it("isSelected", () => {
    const a = selectOnly(EMPTY_SELECTION, "a");
    expect(isSelected(a, "a")).toBe(true);
    expect(isSelected(a, "b")).toBe(false);
  });

  it("never mutates the set it was given", () => {
    const a = selectOnly(EMPTY_SELECTION, "a");
    toggleSelected(a, "b");
    clearSelection(a);
    selectOnly(a, "c");
    expect([...a]).toEqual(["a"]);
  });

  it("drops ids of notes that are gone, and follows a note to its server id", () => {
    const ab = toggleSelected(selectOnly(EMPTY_SELECTION, "a"), "local:x");
    expect([...pruneSelection(ab, (id) => id === "a")]).toEqual(["a"]);
    expect(pruneSelection(ab, () => true)).toBe(ab);
    expect([...renameInSelection(ab, "local:x", "N1")].sort()).toEqual(["N1", "a"]);
    expect(renameInSelection(ab, "missing", "N2")).toBe(ab);
  });
});

describe("note size lookup", () => {
  it("is the note's own size (v4); new notes are the default size", () => {
    const note: Note = { id: "N1", x: 1, y: 2, ...NOTE_DEFAULTS, text: "", color: "yellow", rev: 1, authorId: "A" };
    expect(noteSize(note)).toEqual({ width: NOTE_DEFAULT_W, height: NOTE_DEFAULT_H });
    expect(noteSize({ ...note, w: 300, h: 120 })).toEqual({ width: 300, height: 120 });
  });
});

describe("title and body", () => {
  it("the first line is the title and the rest is the body", () => {
    expect(splitTitleBody("Idea\nmore\nlines")).toEqual({ title: "Idea", body: "more\nlines" });
    expect(splitTitleBody("Just a title")).toEqual({ title: "Just a title", body: "" });
    expect(splitTitleBody("")).toEqual({ title: "", body: "" });
    expect(splitTitleBody("\nbody only")).toEqual({ title: "", body: "body only" });
  });

  it("joining puts a line break between them, and none when the body is empty", () => {
    expect(joinTitleBody("Idea", "more")).toBe("Idea\nmore");
    expect(joinTitleBody("Idea", "")).toBe("Idea");
    expect(joinTitleBody("", "")).toBe("");
    expect(joinTitleBody("", "body")).toBe("\nbody");
  });

  it.each([
    ["empty", ""],
    ["a single line", "One line"],
    ["several lines", "Title\nline 2\n\nline 4"],
    ["a blank line after the title", "Title\n\nbody"],
    ["body only", "\nbody"],
    [`exactly ${MAX_NOTE_TEXT} characters`, `${"t".repeat(100)}\n${"b".repeat(MAX_NOTE_TEXT - 101)}`],
    [`${MAX_NOTE_TEXT} characters on one line`, "x".repeat(MAX_NOTE_TEXT)],
  ])("round-trips %s", (_label, text) => {
    const { title, body } = splitTitleBody(text);
    expect(joinTitleBody(title, body)).toBe(text);
  });
});

describe("multi-select (slice 2.8)", () => {
  const notes = [
    { id: "a", x: 0, y: 0, w: 100, h: 100 },
    { id: "b", x: 200, y: 0, w: 100, h: 100 },
    { id: "c", x: 0, y: 300, w: 100, h: 100 },
  ];

  it("a marquee selects every note it touches (partly is enough), in board order", () => {
    expect([...marqueeSelection(notes, { x: 50, y: 50, width: 200, height: 10 }, EMPTY_SELECTION, false)]).toEqual(["a", "b"]);
    expect([...marqueeSelection(notes, { x: 101, y: 101, width: 50, height: 50 }, EMPTY_SELECTION, false)]).toEqual([]);
  });

  it("a marquee replaces the selection, or with Shift adds to what was selected when it started", () => {
    const base = selectOnly(EMPTY_SELECTION, "c");
    const box = { x: 250, y: 50, width: 10, height: 10 };
    expect([...marqueeSelection(notes, box, base, false)]).toEqual(["b"]);
    expect([...marqueeSelection(notes, box, base, true)]).toEqual(["c", "b"]);
  });

  it("a marquee drawn right-to-left or bottom-to-top (negative size) works the same", () => {
    expect([...marqueeSelection(notes, { x: 250, y: 60, width: -200, height: -10 }, EMPTY_SELECTION, false)]).toEqual(["a", "b"]);
  });

  it("returns the same set when nothing changed", () => {
    const sel = marqueeSelection(notes, { x: 0, y: 0, width: 10, height: 10 }, EMPTY_SELECTION, false);
    expect(marqueeSelection(notes, { x: 1, y: 1, width: 10, height: 10 }, EMPTY_SELECTION, false, sel)).toBe(sel);
  });

  it("selectAll takes every id; orderedIds keeps the selection's own order (the first is the reference)", () => {
    expect([...selectAll(["a", "b", "c"])]).toEqual(["a", "b", "c"]);
    const sel = toggleSelected(selectOnly(EMPTY_SELECTION, "c"), "a");
    expect(orderedIds(sel)).toEqual(["c", "a"]);
  });

  it("the store toggles, sets and selects all; pruning keeps only notes that still exist", () => {
    const ui = useBoardUi.getState();
    ui.resetRoom();
    ui.select("a");
    useBoardUi.getState().toggle("b");
    expect([...useBoardUi.getState().selection]).toEqual(["a", "b"]);
    useBoardUi.getState().toggle("a");
    expect([...useBoardUi.getState().selection]).toEqual(["b"]);
    useBoardUi.getState().selectAll(["a", "b", "c"]);
    expect(useBoardUi.getState().selection.size).toBe(3);
    useBoardUi.getState().pruneSelected((id) => id !== "b");
    expect([...useBoardUi.getState().selection]).toEqual(["a", "c"]);
    useBoardUi.getState().setSelection(new Set(["c"]));
    expect([...useBoardUi.getState().selection]).toEqual(["c"]);
    useBoardUi.getState().resetRoom();
  });
});
