import { MAX_FRAMES_PER_ROOM, NOTE_STYLE_FIELDS, clampFrameRect, groupOffset, stackOrder, type Frame, type Note } from "@stickyard/shared";
import type { ItemInput } from "../rooms/session";

/*
 * Duplicate (web only; the copies go out as itemsAdd, protocol v11). Pure planning: what the
 * copies are and why Duplicate can't run now. The session sends them (RoomSession.duplicateNotes,
 * duplicateFrame), so pacing, confirmation by ref and per-item rollback are the itemsAdd ones.
 */

/** Copies go this far right and down from their originals, in board units. Mirrored by `--sy-duplicate-offset` in tokens.css (test checks). */
export const DUPLICATE_OFFSET = 24;

/**
 * Copies of these notes with their full content (text, colour, every style field, size), moved by
 * one offset clamped once for the whole group (so their arrangement is kept at the board's edges),
 * in the originals' stacking order, bottom first: added in this order, the copies land on top
 * with the same order among themselves.
 */
export function duplicateNoteInputs(notes: readonly Note[], offset: number = DUPLICATE_OFFSET): ItemInput[] {
  const { dx, dy } = groupOffset(notes, offset, offset);
  return stackOrder(notes).map((n) => ({
    kind: "note",
    x: n.x + dx,
    y: n.y + dy,
    w: n.w,
    h: n.h,
    text: n.text,
    // Colour is one of the style fields.
    ...(Object.fromEntries(NOTE_STYLE_FIELDS.map((k) => [k, n[k]])) as Pick<Note, (typeof NOTE_STYLE_FIELDS)[number]>),
  }));
}

/**
 * Copies of a selection with frames (v0.20.0): frames alone (never the notes inside unless they're
 * selected too) and notes with their full content, all moved by one offset clamped once for the
 * whole group. Frames first (they sit behind notes anyway), then notes in stacking order.
 */
export function duplicateSelectionInputs(notes: readonly Note[], frames: readonly Frame[], offset: number = DUPLICATE_OFFSET): ItemInput[] {
  const { dx, dy } = groupOffset([...notes, ...frames], offset, offset);
  const frameCopies = frames.map((f) => {
    const copy = duplicateFrameInput(f, 0);
    return { ...copy, ...clampFrameRect({ x: f.x + dx, y: f.y + dy, w: f.w, h: f.h }) };
  });
  const noteCopies = stackOrder(notes).map((n) => ({ ...duplicateNoteInputs([n], 0)[0]!, x: n.x + dx, y: n.y + dy }));
  return [...frameCopies, ...noteCopies];
}

/** A copy of the frame alone (title, colour, title style and size; never the notes inside), offset and clamped. */
export function duplicateFrameInput(frame: Frame, offset: number = DUPLICATE_OFFSET): ItemInput {
  const { title, color, titleFontSize, titleBold, titleItalic, titleTextColor, titleAlign } = frame;
  return {
    kind: "frame",
    ...clampFrameRect({ x: frame.x + offset, y: frame.y + offset, w: frame.w, h: frame.h }),
    title,
    color,
    titleFontSize,
    titleBold,
    titleItalic,
    titleTextColor,
    titleAlign,
  };
}

/** Why Duplicate is off, shown in the bar (and as a notice for Ctrl+D). */
export const DUPLICATE_HINTS = {
  none: "Select notes or a frame first.",
  offline: "Not connected.",
  held: "Finish moving or resizing first.",
  unsaved: "Wait until new notes are saved.",
  busy: "Wait until the items being added are saved.",
  notesFull: (needs: number, free: number) => `No room to duplicate ${needs} ${needs === 1 ? "note" : "notes"}: the board has room for ${free} more.`,
  framesFull: (_free: number) => `No room to duplicate the frame: the board has the maximum of ${MAX_FRAMES_PER_ROOM} frames.`,
  framesFullMany: (needs: number, free: number) => `No room to duplicate ${needs} frames: the board has room for ${free} more (at most ${MAX_FRAMES_PER_ROOM}).`,
} as const;

export interface DuplicateState {
  /** Notes selected. */
  notes: number;
  /** A frame is selected (instead of notes). */
  frame: boolean;
  /** Frames selected (v0.20.0; absent: one if `frame`). */
  frames?: number;
  live: boolean;
  /** A selected note or frame is being moved or resized here. */
  held: boolean;
  /** A selected note or frame has no server id yet. */
  unsaved: boolean;
  /** An add (or restore) run is still being sent. */
  busy: boolean;
  freeNotes: number;
  freeFrames: number;
}

/** Duplicate needs a selection, a connection, everything in it saved and still, room for every copy, and no add run in progress. */
export function duplicateDisabledReason(s: DuplicateState): string | null {
  const frames = s.frames ?? (s.frame ? 1 : 0);
  if (s.notes === 0 && frames === 0) return DUPLICATE_HINTS.none;
  if (!s.live) return DUPLICATE_HINTS.offline;
  if (s.held) return DUPLICATE_HINTS.held;
  if (s.unsaved) return DUPLICATE_HINTS.unsaved;
  if (frames > s.freeFrames) return frames === 1 ? DUPLICATE_HINTS.framesFull(s.freeFrames) : DUPLICATE_HINTS.framesFullMany(frames, s.freeFrames);
  if (s.notes > s.freeNotes) return DUPLICATE_HINTS.notesFull(s.notes, s.freeNotes);
  if (s.busy) return DUPLICATE_HINTS.busy;
  return null;
}
