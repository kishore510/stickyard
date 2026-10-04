import {
  FRAME_DEFAULTS,
  FRAME_DEFAULT_H,
  FRAME_DEFAULT_W,
  FRAME_EDIT_FIELDS,
  clampFramePosition,
  clampFrameRect,
  type Frame,
  type FrameColor,
  type FrameEditField,
  type FrameItem,
  type Note,
  type NoteRect,
} from "@stickyard/shared";
import { localId, type Board } from "../notes/board";

/*
 * Frames on the board as this page sees them (protocol v9): the server's frames plus optimistic
 * local changes, like notes (notes/board.ts). Pure functions on the shared Board, each returning
 * a new Board, or the same one when nothing changed.
 *
 * - `confirmed` is what the server last sent; `frame` is what's shown. A refusal rolls back.
 * - A stale update (lower rev than confirmed) is ignored.
 * - `draft` is the title being typed in the frame's header: remote edits never replace it.
 * - While a frame is dragged or resized here, remote positions and sizes are confirmed but not shown.
 */

export interface BoardFrame {
  frame: Frame;
  confirmed: Frame | null;
  /** Set while an add is waiting for its server id. */
  clientRef: string | null;
  draft: string | null;
  dragging: boolean;
  resizing: boolean;
}

export const isFrameHeld = (entry: BoardFrame) => entry.dragging || entry.resizing;

export function findFrame(board: Board, id: string): BoardFrame | undefined {
  return board.frames.find((f) => f.frame.id === id);
}

const confirmedEntry = (frame: Frame): BoardFrame => ({ frame, confirmed: frame, clientRef: null, draft: null, dragging: false, resizing: false });
const isStale = (entry: BoardFrame | undefined, rev: number) => entry?.confirmed != null && rev < entry.confirmed.rev;
const rectOf = (r: NoteRect): NoteRect => ({ x: r.x, y: r.y, w: r.w, h: r.h });

function patch(board: Board, id: string, change: (entry: BoardFrame) => BoardFrame): Board {
  const index = board.frames.findIndex((f) => f.frame.id === id);
  const entry = board.frames[index];
  if (!entry) return board;
  const next = change(entry);
  if (next === entry) return board;
  const frames = [...board.frames];
  frames[index] = next;
  return { ...board, frames };
}

/* ── From the server ────────────────────────────────────────────────── */

/**
 * The frames after joining (sent right after the notes snapshot). Authoritative for confirmed
 * frames, merged by rev: a frame already here at a newer rev (a message that somehow arrived
 * first) keeps it, and frames being added here (no server id yet) stay.
 */
export function applyFramesSnapshot(board: Board, frames: readonly Frame[]): Board {
  const merged = frames.map((frame) => {
    const existing = findFrame(board, frame.id);
    return existing && isStale(existing, frame.rev) ? existing : confirmedEntry(frame);
  });
  const pending = board.frames.filter((f) => f.clientRef !== null);
  return { ...board, frames: [...pending, ...merged], framesRemoved: [] };
}

/** A new frame. With our clientRef, it replaces the temporary one in place (keeping a title, colour or title style set meanwhile). */
export function applyFrameAdded(board: Board, frame: Frame, clientRef?: string): Board {
  if (clientRef !== undefined) {
    const temp = findFrame(board, localId(clientRef));
    if (temp) {
      return patch(board, temp.frame.id, (e) => ({
        ...e,
        frame: { ...frame, ...editableFields(e.frame) },
        confirmed: frame,
        clientRef: null,
      }));
    }
  }
  if (findFrame(board, frame.id)) return applyFrameUpdated(board, frame);
  return { ...board, frames: [...board.frames, confirmedEntry(frame)] };
}

/** Title, colour or title style changed (the whole frame). Unknown frames are added (a message before the snapshot). */
export function applyFrameUpdated(board: Board, frame: Frame): Board {
  const removed = board.framesRemoved.find((f) => f.frame.id === frame.id);
  if (removed) {
    if (isStale(removed, frame.rev)) return board;
    return { ...board, framesRemoved: board.framesRemoved.map((f) => (f === removed ? { ...f, confirmed: frame } : f)) };
  }
  const entry = findFrame(board, frame.id);
  if (!entry) return { ...board, frames: [...board.frames, confirmedEntry(frame)] };
  if (isStale(entry, frame.rev)) return board;
  return patch(board, frame.id, (e) => ({ ...e, confirmed: frame, frame: isFrameHeld(e) ? { ...frame, ...rectOf(e.frame) } : frame }));
}

export function applyFrameMoved(board: Board, move: { id: string; x: number; y: number; rev: number; final: boolean }): Board {
  const entry = findFrame(board, move.id);
  if (!entry || isStale(entry, move.rev)) return board;
  return patch(board, move.id, (e) => {
    const confirmed = move.final && e.confirmed ? { ...e.confirmed, x: move.x, y: move.y, rev: move.rev } : e.confirmed;
    const position = isFrameHeld(e) ? { x: e.frame.x, y: e.frame.y } : { x: move.x, y: move.y };
    return { ...e, confirmed, frame: { ...e.frame, ...position, rev: Math.max(e.frame.rev, move.rev) } };
  });
}

export function applyFrameResized(board: Board, resize: NoteRect & { id: string; rev: number; final: boolean }): Board {
  const entry = findFrame(board, resize.id);
  if (!entry || isStale(entry, resize.rev)) return board;
  return patch(board, resize.id, (e) => {
    const rect = rectOf(resize);
    const confirmed = resize.final && e.confirmed ? { ...e.confirmed, ...rect, rev: resize.rev } : e.confirmed;
    return { ...e, confirmed, frame: { ...e.frame, ...(isFrameHeld(e) ? rectOf(e.frame) : rect), rev: Math.max(e.frame.rev, resize.rev) } };
  });
}

export function applyFrameDeleted(board: Board, id: string): Board {
  if (!findFrame(board, id) && !board.framesRemoved.some((f) => f.frame.id === id)) return board;
  return { ...board, frames: board.frames.filter((f) => f.frame.id !== id), framesRemoved: board.framesRemoved.filter((f) => f.frame.id !== id) };
}

/** The server refused an add: remove the temporary frame. */
export function rejectFrameAdd(board: Board, clientRef: string): Board {
  const id = localId(clientRef);
  if (!findFrame(board, id)) return board;
  return { ...board, frames: board.frames.filter((f) => f.frame.id !== id) };
}

/** The server refused a change to `id`: back to what it last confirmed (a refused delete comes back). */
export function rollbackFrame(board: Board, id: string): Board {
  const removed = board.framesRemoved.find((f) => f.frame.id === id);
  if (removed) {
    const { index, ...entry } = removed;
    const frames = [...board.frames];
    frames.splice(Math.min(index, frames.length), 0, entry.confirmed ? { ...entry, frame: entry.confirmed } : entry);
    return { ...board, frames, framesRemoved: board.framesRemoved.filter((f) => f !== removed) };
  }
  return patch(board, id, (e) => (e.confirmed ? { ...e, frame: e.confirmed, dragging: false, resizing: false } : e));
}

/* ── Local, optimistic ─────────────────────────────────────────────── */

/** Plain data for a new frame (also what code such as templates would pass). */
export interface FrameDraft {
  clientRef: string;
  x: number;
  y: number;
  color: FrameColor;
  title: string;
  authorId: string;
}

export function addFrameLocal(board: Board, add: FrameDraft): Board {
  const frame: Frame = {
    id: localId(add.clientRef),
    ...clampFrameRect({ x: add.x, y: add.y, w: FRAME_DEFAULT_W, h: FRAME_DEFAULT_H }),
    title: add.title,
    color: add.color,
    ...FRAME_DEFAULTS,
    rev: 1,
    authorId: add.authorId,
  };
  return withPending(board, frame, add.clientRef);
}

/** A frame with its full content (an itemsAdd entry, title already cleaned), clamped as the server will; its ref stands in for a clientRef. */
export function addFrameItemLocal(board: Board, item: FrameItem, authorId: string): Board {
  const { ref, x, y, w, h, ...content } = item;
  return withPending(board, { id: localId(ref), ...content, ...clampFrameRect({ x, y, w, h }), rev: 1, authorId }, ref);
}

function withPending(board: Board, frame: Frame, clientRef: string): Board {
  return { ...board, frames: [...board.frames, { frame, confirmed: null, clientRef, draft: null, dragging: false, resizing: false }] };
}

/** What a frameEdit may change: title, colour and the title style. */
export type FrameEdit = Partial<Pick<Frame, FrameEditField>>;

/** A frame's editable fields (FRAME_EDIT_FIELDS). */
export function editableFields(frame: Frame): Pick<Frame, FrameEditField> {
  const { title, color, titleFontSize, titleBold, titleItalic, titleTextColor, titleAlign } = frame;
  return { title, color, titleFontSize, titleBold, titleItalic, titleTextColor, titleAlign };
}

/** The fields of `after` that differ from `before`: what a frameEdit should carry. */
export function frameChanges(before: Frame, after: Frame): FrameEdit {
  return Object.fromEntries(FRAME_EDIT_FIELDS.filter((f) => after[f] !== before[f]).map((f) => [f, after[f]])) as FrameEdit;
}

/** A committed title, colour or title style, shown at once; a title ends the draft. The same board when nothing changes. */
export function editFrameLocal(board: Board, id: string, change: FrameEdit): Board {
  return patch(board, id, (e) => {
    const defined = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) as FrameEdit;
    const frame = { ...e.frame, ...defined };
    const draft = change.title !== undefined ? null : e.draft;
    if (Object.keys(frameChanges(e.frame, frame)).length === 0 && draft === e.draft) return e;
    return { ...e, frame, draft };
  });
}

/** The title being typed (null: editing ended). */
export function setFrameDraft(board: Board, id: string, draft: string | null): Board {
  return patch(board, id, (e) => (e.draft === draft ? e : { ...e, draft }));
}

/** Moves a frame, clamped at its own size. */
export function moveFrameLocal(board: Board, id: string, x: number, y: number): Board {
  return patch(board, id, (e) => {
    const p = clampFramePosition(x, y, e.frame);
    return p.x === e.frame.x && p.y === e.frame.y ? e : { ...e, frame: { ...e.frame, ...p } };
  });
}

/** Resizes a frame (position and size together), clamped: size within the frame limits, then on the board. */
export function resizeFrameLocal(board: Board, id: string, rect: NoteRect): Board {
  return patch(board, id, (e) => {
    const r = clampFrameRect(rect);
    const f = e.frame;
    return f.x === r.x && f.y === r.y && f.w === r.w && f.h === r.h ? e : { ...e, frame: { ...f, ...r } };
  });
}

export function setFrameDragging(board: Board, id: string, dragging: boolean): Board {
  return patch(board, id, (e) => (e.dragging === dragging ? e : { ...e, dragging }));
}

export function setFrameResizing(board: Board, id: string, resizing: boolean): Board {
  return patch(board, id, (e) => (e.resizing === resizing ? e : { ...e, resizing }));
}

export function deleteFrameLocal(board: Board, id: string): Board {
  const index = board.frames.findIndex((f) => f.frame.id === id);
  const entry = board.frames[index];
  if (!entry) return board;
  return {
    ...board,
    frames: board.frames.filter((f) => f !== entry),
    framesRemoved: [...board.framesRemoved, { ...entry, dragging: false, resizing: false, index }],
  };
}

/** The notes a frame carries when dragged: those whose centre is inside it (edges count). */
export function framedNotes<T extends Pick<Note, "x" | "y" | "w" | "h">>(frame: NoteRect, notes: readonly T[]): T[] {
  return notes.filter((n) => {
    const cx = n.x + n.w / 2;
    const cy = n.y + n.h / 2;
    return cx >= frame.x && cx <= frame.x + frame.w && cy >= frame.y && cy <= frame.y + frame.h;
  });
}
