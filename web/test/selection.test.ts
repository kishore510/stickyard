import { describe, expect, it } from "vitest";
import { MAX_NOTE_TEXT, NOTE_SIZE, type Note } from "@stickyard/shared";
import {
  EMPTY_SELECTION,
  clearSelection,
  isSelected,
  onlySelected,
  pruneSelection,
  renameInSelection,
  selectOnly,
  toggleSelected,
} from "../src/canvas/selection";
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
  it("returns the default size for every note today", () => {
    const note: Note = { id: "N1", x: 1, y: 2, text: "", color: "yellow", rev: 1, authorId: "A" };
    expect(noteSize(note)).toEqual({ width: NOTE_SIZE, height: NOTE_SIZE });
    expect(noteSize({ ...note, id: "N2", x: 900 })).toEqual({ width: NOTE_SIZE, height: NOTE_SIZE });
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
