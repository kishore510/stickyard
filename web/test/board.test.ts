import { describe, expect, it } from "vitest";
import { NOTE_DEFAULTS, type Note } from "@stickyard/shared";
import {
  EMPTY_BOARD,
  addLocal,
  applyAdded,
  applyDeleted,
  applyMoved,
  applySnapshot,
  applyUpdated,
  deleteLocal,
  editLocal,
  findNote,
  localId,
  moveLocal,
  rejectAdd,
  rollback,
  setDraft,
  setDragging,
  type Board,
} from "../src/notes/board";

/* The board state: server notes plus optimistic local changes. Fixtures are generic. */

const ME = "AAAAAAAAAAAAAAAA";
const OTHER = "BBBBBBBBBBBBBBBB";
const N1 = "NNNNNNNNNNNNNNN1";
const N2 = "NNNNNNNNNNNNNNN2";
const one: Note = { id: N1, x: 100, y: 100, ...NOTE_DEFAULTS, text: "Idea one", color: "yellow", rev: 1, authorId: ME };
const two: Note = { id: N2, x: 400, y: 300, ...NOTE_DEFAULTS, text: "Needs follow-up", color: "pink", rev: 4, authorId: OTHER };

const withNotes = (...notes: Note[]): Board => applySnapshot(EMPTY_BOARD, notes);
const shown = (board: Board, id: string) => findNote(board, id)?.note;

describe("snapshot", () => {
  it("replaces the board, in order, all confirmed", () => {
    const board = applySnapshot(addLocal(EMPTY_BOARD, { clientRef: "r", x: 0, y: 0, color: "blue", text: "", authorId: ME }), [one, two]);
    expect(board.notes.map((n) => n.note)).toEqual([one, two]);
    expect(board.notes.every((n) => n.confirmed !== null && !n.dragging && n.draft === null)).toBe(true);
  });
});

describe("optimistic add", () => {
  const local = () => addLocal(withNotes(one), { clientRef: "ref-1", x: 10, y: 20, color: "green", text: "Idea two", authorId: ME });

  it("shows the note at once with a temporary id, unconfirmed", () => {
    const board = local();
    const entry = findNote(board, localId("ref-1"));
    expect(entry?.note).toMatchObject({ x: 10, y: 20, color: "green", text: "Idea two" });
    expect(entry?.confirmed).toBeNull();
    expect(entry?.clientRef).toBe("ref-1");
  });

  it("swaps in the server note on noteAdded with the same clientRef, keeping its place", () => {
    const server: Note = { id: N2, x: 10, y: 20, ...NOTE_DEFAULTS, text: "Idea two", color: "green", rev: 1, authorId: ME };
    const board = applyAdded(local(), server, "ref-1");
    expect(findNote(board, localId("ref-1"))).toBeUndefined();
    expect(board.notes.map((n) => n.note.id)).toEqual([N1, N2]);
    expect(findNote(board, N2)?.confirmed).toEqual(server);
    expect(findNote(board, N2)?.clientRef).toBeNull();
  });

  it("keeps a draft started on the temporary note across the swap", () => {
    const drafted = setDraft(local(), localId("ref-1"), "Typing…");
    const board = applyAdded(drafted, { ...two, id: N2 }, "ref-1");
    expect(findNote(board, N2)?.draft).toBe("Typing…");
  });

  it("someone else's noteAdded is appended", () => {
    const board = applyAdded(withNotes(one), two);
    expect(board.notes.map((n) => n.note)).toEqual([one, two]);
  });

  it("a duplicate noteAdded doesn't duplicate the note", () => {
    const board = applyAdded(withNotes(one, two), two);
    expect(board.notes).toHaveLength(2);
  });

  it("rolls back when the add is rejected", () => {
    const board = rejectAdd(local(), "ref-1");
    expect(board.notes.map((n) => n.note)).toEqual([one]);
  });

  it("rejecting an unknown clientRef changes nothing", () => {
    const before = local();
    expect(rejectAdd(before, "nope")).toBe(before);
  });
});

describe("rev-based stale rejection", () => {
  it("ignores a noteUpdated older than the one held", () => {
    const board = withNotes(two); // rev 4
    expect(applyUpdated(board, { ...two, text: "Old", rev: 3 })).toBe(board);
    expect(shown(applyUpdated(board, { ...two, text: "New", rev: 5 }), N2)?.text).toBe("New");
  });

  it("ignores a noteMoved older than the one held", () => {
    const board = withNotes(two);
    expect(applyMoved(board, { id: N2, x: 1, y: 1, rev: 3, final: true })).toBe(board);
  });

  it("accepts a non-final move at the current rev (drags don't bump rev)", () => {
    const board = applyMoved(withNotes(two), { id: N2, x: 50, y: 60, rev: 4, final: false });
    expect(shown(board, N2)).toMatchObject({ x: 50, y: 60 });
    // Non-final positions aren't confirmed; a rollback goes back to the last committed place.
    expect(findNote(board, N2)?.confirmed).toMatchObject({ x: 400, y: 300 });
  });

  it("a final move is confirmed with its rev", () => {
    const board = applyMoved(withNotes(two), { id: N2, x: 50, y: 60, rev: 5, final: true });
    expect(findNote(board, N2)?.confirmed).toMatchObject({ x: 50, y: 60, rev: 5 });
  });
});

describe("local edits and moves", () => {
  it("an edit shows at once and is confirmed by the server echo", () => {
    let board = editLocal(withNotes(one), N1, "Needs follow-up");
    expect(shown(board, N1)?.text).toBe("Needs follow-up");
    expect(findNote(board, N1)?.confirmed?.text).toBe("Idea one");
    board = applyUpdated(board, { ...one, text: "Needs follow-up", rev: 2 });
    expect(findNote(board, N1)?.confirmed).toMatchObject({ text: "Needs follow-up", rev: 2 });
  });

  it("a rejected edit rolls back to the confirmed note", () => {
    const board = rollback(editLocal(withNotes(one), N1, "Needs follow-up"), N1);
    expect(shown(board, N1)).toEqual(one);
  });

  it("a rejected move rolls back and stops dragging", () => {
    const board = rollback(moveLocal(setDragging(withNotes(one), N1, true), N1, 999, 999), N1);
    expect(shown(board, N1)).toEqual(one);
    expect(findNote(board, N1)?.dragging).toBe(false);
  });

  it("moves are clamped to the board", () => {
    const board = moveLocal(withNotes(one), N1, -50, 1e9);
    expect(shown(board, N1)?.x).toBe(0);
    expect(shown(board, N1)?.y).toBeLessThan(1e9);
  });

  it("while dragging, remote positions don't move the note, but are confirmed", () => {
    let board = moveLocal(setDragging(withNotes(one), N1, true), N1, 300, 300);
    board = applyMoved(board, { id: N1, x: 5, y: 5, rev: 2, final: true });
    expect(shown(board, N1)).toMatchObject({ x: 300, y: 300, rev: 2 });
    expect(findNote(board, N1)?.confirmed).toMatchObject({ x: 5, y: 5, rev: 2 });
  });

  it("while dragging, a remote text update still shows", () => {
    let board = moveLocal(setDragging(withNotes(one), N1, true), N1, 300, 300);
    board = applyUpdated(board, { ...one, text: "Needs follow-up", rev: 2 });
    expect(shown(board, N1)).toMatchObject({ x: 300, y: 300, text: "Needs follow-up" });
  });
});

describe("drafts are not clobbered", () => {
  it("a remote update during a local draft keeps the draft; the commit then wins locally", () => {
    let board = setDraft(withNotes(one), N1, "My draft");
    board = applyUpdated(board, { ...one, text: "Remote text", rev: 2 });
    expect(findNote(board, N1)?.draft).toBe("My draft");
    expect(shown(board, N1)?.text).toBe("Remote text");
    board = editLocal(board, N1, "My draft");
    expect(findNote(board, N1)?.draft).toBeNull();
    expect(shown(board, N1)?.text).toBe("My draft");
  });

  it("clearing a draft (cancel) leaves the note as the server has it", () => {
    let board = setDraft(withNotes(one), N1, "My draft");
    board = setDraft(board, N1, null);
    expect(findNote(board, N1)).toMatchObject({ draft: null, note: one });
  });
});

describe("deletes", () => {
  it("a local delete hides the note at once and can be rolled back", () => {
    let board = deleteLocal(withNotes(one, two), N1);
    expect(board.notes.map((n) => n.note.id)).toEqual([N2]);
    board = rollback(board, N1);
    expect(board.notes.map((n) => n.note.id)).toEqual([N1, N2]);
  });

  it("noteDeleted confirms a local delete, so it can't come back", () => {
    let board = applyDeleted(deleteLocal(withNotes(one), N1), N1);
    board = rollback(board, N1);
    expect(board.notes).toEqual([]);
    expect(board.removed).toEqual([]);
  });

  it("a remote delete during a drag drops the note, and later drag moves are no-ops", () => {
    let board = moveLocal(setDragging(withNotes(one, two), N1, true), N1, 200, 200);
    board = applyDeleted(board, N1);
    expect(findNote(board, N1)).toBeUndefined();
    expect(moveLocal(board, N1, 210, 210)).toBe(board);
    expect(setDragging(board, N1, false)).toBe(board);
  });

  it("a remote delete during a draft drops the note", () => {
    const board = applyDeleted(setDraft(withNotes(one), N1, "My draft"), N1);
    expect(board.notes).toEqual([]);
  });

  it("an update for a note deleted locally doesn't bring it back", () => {
    const board = applyUpdated(deleteLocal(withNotes(one), N1), { ...one, text: "Remote text", rev: 2 });
    expect(board.notes).toEqual([]);
  });

  it("deleting an unknown id changes nothing", () => {
    const board = withNotes(one);
    expect(applyDeleted(board, N2)).toBe(board);
    expect(deleteLocal(board, N2)).toBe(board);
  });
});
