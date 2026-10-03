import { clampNotePosition, type Note, type NoteColor } from "@stickyard/shared";

/*
 * The board as this page sees it: the server's notes plus optimistic local changes.
 * Pure functions (no I/O), each returning a new Board, or the same one when nothing changed.
 *
 * Rules (protocol v3, last-write-wins):
 * - `confirmed` is the last state the server sent; `note` is what's shown (confirmed plus
 *   local changes). A rejected change rolls `note` back to `confirmed`.
 * - A server update whose rev is lower than the confirmed rev is stale and ignored.
 * - A local draft (text being typed) is kept apart from `note`, so remote updates never clobber it.
 * - While a note is being dragged here, remote positions are confirmed but not shown.
 */

export interface BoardNote {
  /** What's shown. */
  note: Note;
  /** The server's latest version; null while an add hasn't been confirmed. */
  confirmed: Note | null;
  /** Set while an add is waiting for its server id. */
  clientRef: string | null;
  /** Text being edited here and not yet committed. */
  draft: string | null;
  dragging: boolean;
}

export interface Board {
  /** In creation order (later notes sit on top). */
  notes: BoardNote[];
  /** Deleted here, waiting for the server to confirm; restored (at `index`) if it refuses. */
  removed: (BoardNote & { index: number })[];
}

export const EMPTY_BOARD: Board = { notes: [], removed: [] };

/** The id a note has until the server assigns one. Never sent to the server. */
export const localId = (clientRef: string) => `local:${clientRef}`;
export const isLocalId = (id: string) => id.startsWith("local:");

export function findNote(board: Board, id: string): BoardNote | undefined {
  return board.notes.find((n) => n.note.id === id);
}

const confirmedEntry = (note: Note): BoardNote => ({
  note,
  confirmed: note,
  clientRef: null,
  draft: null,
  dragging: false,
});

/** Applies `change` to the note with `id`; the same board if there's none. */
function patch(board: Board, id: string, change: (entry: BoardNote) => BoardNote): Board {
  const index = board.notes.findIndex((n) => n.note.id === id);
  const entry = board.notes[index];
  if (!entry) return board;
  const notes = [...board.notes];
  notes[index] = change(entry);
  return { ...board, notes };
}

const isStale = (entry: BoardNote | undefined, rev: number) => entry?.confirmed != null && rev < entry.confirmed.rev;

/* ── From the server ────────────────────────────────────────────────── */

/** The full board after joining. Replaces everything. */
export function applySnapshot(_board: Board, notes: Note[]): Board {
  return { notes: notes.map(confirmedEntry), removed: [] };
}

/** A new note. With our clientRef, it replaces the temporary note in place. */
export function applyAdded(board: Board, note: Note, clientRef?: string): Board {
  if (clientRef !== undefined) {
    const temp = findNote(board, localId(clientRef));
    if (temp) {
      return patch(board, temp.note.id, (entry) => ({
        ...entry,
        // Keep text committed while the add was in flight; the session sends it as an edit.
        note: { ...note, text: entry.note.text },
        confirmed: note,
        clientRef: null,
      }));
    }
  }
  const existing = findNote(board, note.id);
  if (existing) return applyUpdated(board, note);
  return { ...board, notes: [...board.notes, confirmedEntry(note)] };
}

/** Text (or colour) changed. */
export function applyUpdated(board: Board, note: Note): Board {
  const pendingDelete = board.removed.find((n) => n.note.id === note.id);
  if (pendingDelete) {
    if (isStale(pendingDelete, note.rev)) return board;
    return { ...board, removed: board.removed.map((n) => (n === pendingDelete ? { ...n, confirmed: note } : n)) };
  }
  const entry = findNote(board, note.id);
  if (!entry) return { ...board, notes: [...board.notes, confirmedEntry(note)] };
  if (isStale(entry, note.rev)) return board;
  return patch(board, note.id, (e) => ({
    ...e,
    confirmed: note,
    note: e.dragging ? { ...note, x: e.note.x, y: e.note.y } : note,
  }));
}

export function applyMoved(
  board: Board,
  move: { id: string; x: number; y: number; rev: number; final: boolean },
): Board {
  const entry = findNote(board, move.id);
  if (!entry || isStale(entry, move.rev)) return board;
  return patch(board, move.id, (e) => {
    const confirmed = move.final && e.confirmed ? { ...e.confirmed, x: move.x, y: move.y, rev: move.rev } : e.confirmed;
    const position = e.dragging ? { x: e.note.x, y: e.note.y } : { x: move.x, y: move.y };
    return { ...e, confirmed, note: { ...e.note, ...position, rev: Math.max(e.note.rev, move.rev) } };
  });
}

export function applyDeleted(board: Board, id: string): Board {
  const inNotes = board.notes.some((n) => n.note.id === id);
  const inRemoved = board.removed.some((n) => n.note.id === id);
  if (!inNotes && !inRemoved) return board;
  return { notes: board.notes.filter((n) => n.note.id !== id), removed: board.removed.filter((n) => n.note.id !== id) };
}

/** The server refused an add: remove the temporary note. */
export function rejectAdd(board: Board, clientRef: string): Board {
  const id = localId(clientRef);
  if (!findNote(board, id)) return board;
  return { ...board, notes: board.notes.filter((n) => n.note.id !== id) };
}

/** The server refused an edit, move or delete of `id`: back to what it last confirmed. */
export function rollback(board: Board, id: string): Board {
  const removed = board.removed.find((n) => n.note.id === id);
  if (removed) {
    const { index, ...entry } = removed;
    const notes = [...board.notes];
    notes.splice(Math.min(index, notes.length), 0, entry.confirmed ? { ...entry, note: entry.confirmed } : entry);
    return { notes, removed: board.removed.filter((n) => n !== removed) };
  }
  return patch(board, id, (e) => (e.confirmed ? { ...e, note: e.confirmed, dragging: false } : e));
}

/* ── Local, optimistic ─────────────────────────────────────────────── */

export function addLocal(
  board: Board,
  add: { clientRef: string; x: number; y: number; color: NoteColor; text: string; authorId: string },
): Board {
  const note: Note = {
    id: localId(add.clientRef),
    ...clampNotePosition(add.x, add.y),
    text: add.text,
    color: add.color,
    rev: 1,
    authorId: add.authorId,
  };
  return {
    ...board,
    notes: [...board.notes, { note, confirmed: null, clientRef: add.clientRef, draft: null, dragging: false }],
  };
}

/** A committed edit: shown at once, and the draft is done. */
export function editLocal(board: Board, id: string, text: string): Board {
  return patch(board, id, (e) => ({ ...e, note: { ...e.note, text }, draft: null }));
}

/** Text being typed (null: editing ended without a change). */
export function setDraft(board: Board, id: string, draft: string | null): Board {
  return patch(board, id, (e) => (e.draft === draft ? e : { ...e, draft }));
}

export function moveLocal(board: Board, id: string, x: number, y: number): Board {
  const position = clampNotePosition(x, y);
  return patch(board, id, (e) =>
    e.note.x === position.x && e.note.y === position.y ? e : { ...e, note: { ...e.note, ...position } },
  );
}

export function setDragging(board: Board, id: string, dragging: boolean): Board {
  return patch(board, id, (e) => (e.dragging === dragging ? e : { ...e, dragging }));
}

export function deleteLocal(board: Board, id: string): Board {
  const index = board.notes.findIndex((n) => n.note.id === id);
  const entry = board.notes[index];
  if (!entry) return board;
  return {
    notes: board.notes.filter((n) => n !== entry),
    removed: [...board.removed, { ...entry, dragging: false, index }],
  };
}
