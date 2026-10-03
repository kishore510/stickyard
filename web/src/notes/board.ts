import {
  NOTE_DEFAULTS,
  NOTE_STYLE_FIELDS,
  clampNotePosition,
  clampNoteRect,
  restack,
  type Note,
  type NoteColor,
  type NoteRect,
  type NoteStyle,
  type OrderAction,
} from "@stickyard/shared";

/*
 * The board as this page sees it: the server's notes plus optimistic local changes.
 * Pure functions (no I/O), each returning a new Board, or the same one when nothing changed.
 *
 * Rules (protocol v4, last-write-wins):
 * - `confirmed` is the last state the server sent; `note` is what's shown (confirmed plus
 *   local changes). A rejected change rolls `note` back to `confirmed`.
 * - A server update whose rev is lower than the confirmed rev is stale and ignored.
 * - A local draft (text being typed) is kept apart from `note`, so remote updates never clobber it.
 * - While a note is being dragged or resized here, remote positions and sizes are confirmed but
 *   not shown (its rect stays where this page put it until release).
 * - Stacking is each note's z (protocol v8), never the array order or what's held or selected.
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
  resizing: boolean;
}

/** The style fields (and colour) one change may set. */
export type StylePatch = Partial<NoteStyle>;
const STYLE_KEYS = NOTE_STYLE_FIELDS;

/** Being moved or resized here: its rect is this page's until release. */
export const isHeld = (entry: BoardNote) => entry.dragging || entry.resizing;
const rectOf = (n: NoteRect): NoteRect => ({ x: n.x, y: n.y, w: n.w, h: n.h });

export interface Board {
  /** In creation order. Stacking comes from each note's z, not from this order. */
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
  resizing: false,
});

/** Applies `change` to the note with `id`; the same board if there's none. */
function patch(board: Board, id: string, change: (entry: BoardNote) => BoardNote): Board {
  const index = board.notes.findIndex((n) => n.note.id === id);
  const entry = board.notes[index];
  if (!entry) return board;
  const next = change(entry);
  if (next === entry) return board;
  const notes = [...board.notes];
  notes[index] = next;
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
        // Keep text and style set while the add was in flight; the session sends them as an edit.
        note: { ...note, text: entry.note.text, ...pickStyle(entry.note) },
        confirmed: note,
        clientRef: null,
      }));
    }
  }
  const existing = findNote(board, note.id);
  if (existing) return applyUpdated(board, note);
  return { ...board, notes: [...board.notes, confirmedEntry(note)] };
}

/** Text, colour or style changed (the whole note). */
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
    note: isHeld(e) ? { ...note, ...rectOf(e.note) } : note,
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
    const position = isHeld(e) ? { x: e.note.x, y: e.note.y } : { x: move.x, y: move.y };
    return { ...e, confirmed, note: { ...e.note, ...position, rev: Math.max(e.note.rev, move.rev) } };
  });
}

export function applyResized(board: Board, resize: NoteRect & { id: string; rev: number; final: boolean }): Board {
  const entry = findNote(board, resize.id);
  if (!entry || isStale(entry, resize.rev)) return board;
  return patch(board, resize.id, (e) => {
    const rect = rectOf(resize);
    const confirmed = resize.final && e.confirmed ? { ...e.confirmed, ...rect, rev: resize.rev } : e.confirmed;
    const shown = isHeld(e) ? rectOf(e.note) : rect;
    return { ...e, confirmed, note: { ...e.note, ...shown, rev: Math.max(e.note.rev, resize.rev) } };
  });
}

/**
 * Notes restacked (a notesOrder, or a renumbering at the bound): confirms z and rev, and changes
 * only z on what's shown, so local edits waiting for the server are kept. Stale results and
 * unknown notes are ignored; the same board comes back when nothing changes.
 */
export function applyOrdered(board: Board, results: readonly { id: string; z: number; rev: number }[]): Board {
  let next = board;
  for (const r of results) {
    const reorder = (e: BoardNote): BoardNote => {
      if (!e.confirmed || isStale(e, r.rev)) return e;
      if (e.confirmed.z === r.z && e.confirmed.rev === r.rev && e.note.z === r.z) return e;
      return { ...e, confirmed: { ...e.confirmed, z: r.z, rev: r.rev }, note: { ...e.note, z: r.z, rev: Math.max(e.note.rev, r.rev) } };
    };
    const removed = next.removed.find((n) => n.note.id === r.id);
    if (removed) {
      const changed = reorder(removed);
      if (changed !== removed) next = { ...next, removed: next.removed.map((n) => (n === removed ? { ...changed, index: removed.index } : n)) };
      continue;
    }
    next = patch(next, r.id, reorder);
  }
  return next;
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
  return patch(board, id, (e) => (e.confirmed ? { ...e, note: e.confirmed, dragging: false, resizing: false } : e));
}

/* ── Local, optimistic ─────────────────────────────────────────────── */

export function addLocal(
  board: Board,
  add: { clientRef: string; x: number; y: number; color: NoteColor; text: string; authorId: string },
): Board {
  const note: Note = {
    id: localId(add.clientRef),
    ...NOTE_DEFAULTS,
    ...clampNotePosition(add.x, add.y),
    text: add.text,
    color: add.color,
    // On top, as the server will put it (its z replaces this once confirmed).
    z: Math.max(-1, ...board.notes.map((n) => n.note.z)) + 1,
    rev: 1,
    authorId: add.authorId,
  };
  return {
    ...board,
    notes: [...board.notes, { note, confirmed: null, clientRef: add.clientRef, draft: null, dragging: false, resizing: false }],
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

/** Colour and style, shown at once. The same board when nothing changes. */
export function styleLocal(board: Board, id: string, change: StylePatch): Board {
  const entry = findNote(board, id);
  if (!entry) return board;
  const next = { ...entry.note, ...definedStyle(change) };
  if (STYLE_KEYS.every((k) => next[k] === entry.note[k])) return board;
  return patch(board, id, (e) => ({ ...e, note: next }));
}

/** The style fields that differ between two versions of a note (for a deferred edit). */
export function styleChanges(from: Note, to: Note): StylePatch {
  return Object.fromEntries(STYLE_KEYS.filter((k) => from[k] !== to[k]).map((k) => [k, to[k]])) as StylePatch;
}

function pickStyle(n: Note): NoteStyle {
  return Object.fromEntries(STYLE_KEYS.map((k) => [k, n[k]])) as NoteStyle;
}

function definedStyle(change: StylePatch): StylePatch {
  return Object.fromEntries(STYLE_KEYS.filter((k) => change[k] !== undefined).map((k) => [k, change[k]])) as StylePatch;
}

/** Moves a note, clamped at its own size. */
export function moveLocal(board: Board, id: string, x: number, y: number): Board {
  return patch(board, id, (e) => {
    const position = clampNotePosition(x, y, e.note);
    return e.note.x === position.x && e.note.y === position.y ? e : { ...e, note: { ...e.note, ...position } };
  });
}

/** Resizes a note (position and size together), clamped: size within min/max, then on the board. */
export function resizeLocal(board: Board, id: string, rect: NoteRect): Board {
  return patch(board, id, (e) => {
    const r = clampNoteRect(rect);
    const n = e.note;
    return n.x === r.x && n.y === r.y && n.w === r.w && n.h === r.h ? e : { ...e, note: { ...n, ...r } };
  });
}

export function setResizing(board: Board, id: string, resizing: boolean): Board {
  return patch(board, id, (e) => (e.resizing === resizing ? e : { ...e, resizing }));
}

export function setDragging(board: Board, id: string, dragging: boolean): Board {
  return patch(board, id, (e) => (e.dragging === dragging ? e : { ...e, dragging }));
}

/**
 * Bring to front or send to back, shown at once, computed as the server does (shared restack)
 * from what's shown. At the bound the server renumbers the whole room; that isn't guessed here,
 * so nothing changes until its notesOrdered arrives. The same board when nothing changes.
 */
export function reorderLocal(board: Board, ids: readonly string[], action: OrderAction): Board {
  const { changes, renormalised } = restack(
    board.notes.map((n) => n.note),
    ids,
    action,
  );
  if (renormalised) return board;
  let next = board;
  for (const { id, z } of changes) next = patch(next, id, (e) => (e.note.z === z ? e : { ...e, note: { ...e.note, z } }));
  return next;
}

export function deleteLocal(board: Board, id: string): Board {
  const index = board.notes.findIndex((n) => n.note.id === id);
  const entry = board.notes[index];
  if (!entry) return board;
  return {
    notes: board.notes.filter((n) => n !== entry),
    removed: [...board.removed, { ...entry, dragging: false, resizing: false, index }],
  };
}
