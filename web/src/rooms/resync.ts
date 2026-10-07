import type { Frame, Note, NoteColor } from "@stickyard/shared";
import type { BoardFrame } from "../frames/board";
import { rollbackFrame } from "../frames/board";
import { rollback, type Board, type BoardNote } from "../notes/board";
import { discardUnconfirmedShapes } from "../shapes/board";

/*
 * A dropped connection and the resync after it (web only, pure). There's no offline queue: at the
 * drop the board goes back to what the relay last confirmed, and on reconnect the relay's
 * snapshots replace it (not a merge by rev: a restarted relay may have older revs). Text being
 * typed is never lost silently: a draft stays on its note while the note exists, and a draft whose
 * note goes is handed back (an OrphanDraft) so the page can offer it as a new note.
 */

/** Text that was being typed into a note that is no longer on the board, and where that note was. */
export interface OrphanDraft {
  text: string;
  x: number;
  y: number;
  color: NoteColor;
}

const orphanOf = (entry: BoardNote): OrphanDraft[] =>
  entry.draft !== null && entry.draft.trim() !== "" ? [{ text: entry.draft, x: entry.note.x, y: entry.note.y, color: entry.note.color }] : [];

/**
 * Back to what the relay last confirmed: adds not confirmed go, deletes not confirmed come back,
 * local moves, resizes and edits are undone, nothing is held. Drafts stay on the items that stay;
 * a draft on a note that goes is returned. The same entry objects where nothing changes.
 */
export function discardUnconfirmed(board: Board): { board: Board; orphans: OrphanDraft[] } {
  let next = board;
  // Deletes not confirmed: back in their places, last first.
  for (const removed of [...board.removed].reverse()) next = rollback(next, removed.note.id);
  for (const removed of [...board.framesRemoved].reverse()) next = rollbackFrame(next, removed.frame.id);
  const orphans: OrphanDraft[] = [];
  const notes = next.notes.flatMap((entry): BoardNote[] => {
    if (entry.confirmed === null) {
      orphans.push(...orphanOf(entry));
      return [];
    }
    if (entry.note === entry.confirmed && !entry.dragging && !entry.resizing) return [entry];
    return [{ ...entry, note: entry.confirmed, dragging: false, resizing: false }];
  });
  const frames = next.frames.flatMap((entry): BoardFrame[] => {
    if (entry.confirmed === null) return [];
    if (entry.frame === entry.confirmed && !entry.dragging && !entry.resizing) return [entry];
    return [{ ...entry, frame: entry.confirmed, dragging: false, resizing: false }];
  });
  return { board: discardUnconfirmedShapes({ ...next, notes, removed: [], frames, framesRemoved: [] }), orphans };
}

/**
 * The items with changes of mine the relay hasn't confirmed, as "note:<id>" / "frame:<id>" / "shape:<id>": adds
 * not confirmed, deletes not confirmed, items being moved or resized here, and `inFlight` (changes
 * sent and not heard back, from the history). Someone else's live drag isn't mine and isn't
 * counted. `excluded` items are reported elsewhere (a template, a restore, a delete or a clear).
 */
export function unsavedKeys(board: Board, inFlight: Iterable<string>, excluded: ReadonlySet<string>): Set<string> {
  const keys = new Set<string>();
  for (const n of board.notes) if (n.confirmed === null || n.dragging || n.resizing) keys.add(`note:${n.note.id}`);
  for (const n of board.removed) keys.add(`note:${n.note.id}`);
  for (const f of board.frames) if (f.confirmed === null || f.dragging || f.resizing) keys.add(`frame:${f.frame.id}`);
  for (const f of board.framesRemoved) keys.add(`frame:${f.frame.id}`);
  for (const s of board.shapes) if (s.confirmed === null || s.dragging || s.resizing) keys.add(`shape:${s.shape.id}`);
  for (const s of board.shapesRemoved) keys.add(`shape:${s.shape.id}`);
  for (const key of inFlight) keys.add(key);
  for (const key of excluded) keys.delete(key);
  return keys;
}

/**
 * The notes snapshot after a reconnect: it replaces every note (ids, revs and content are the
 * relay's). A draft stays on a note that is still there; drafts on notes that are gone are
 * returned. Frames are left for the frames snapshot that follows (resyncFrames).
 */
export function resyncNotes(board: Board, notes: readonly Note[]): { board: Board; orphans: OrphanDraft[] } {
  const drafts = new Map(board.notes.filter((n) => n.draft !== null).map((n) => [n.note.id, n] as const));
  const next: BoardNote[] = notes.map((note) => ({
    note,
    confirmed: note,
    clientRef: null,
    draft: drafts.get(note.id)?.draft ?? null,
    dragging: false,
    resizing: false,
  }));
  const kept = new Set(notes.map((n) => n.id));
  const orphans = [...drafts.values()].filter((entry) => !kept.has(entry.note.id)).flatMap(orphanOf);
  return { board: { ...board, notes: next, removed: [] }, orphans };
}

/** The frames snapshot after a reconnect: it replaces every frame; a title being typed stays on a frame that is still there. */
export function resyncFrames(board: Board, frames: readonly Frame[]): Board {
  const drafts = new Map(board.frames.filter((f) => f.draft !== null).map((f) => [f.frame.id, f.draft] as const));
  return {
    ...board,
    frames: frames.map((frame) => ({ frame, confirmed: frame, clientRef: null, draft: drafts.get(frame.id) ?? null, dragging: false, resizing: false })),
    framesRemoved: [],
  };
}
