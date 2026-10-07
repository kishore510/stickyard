import {
  MAX_FRAMES_PER_ROOM,
  MAX_SHAPES_PER_ROOM,
  NOTE_STYLE_FIELDS,
  SHAPE_STYLE_FIELDS,
  clampFrameRect,
  clampShapeRect,
  groupOffset,
  stackOrder,
  type Frame,
  type Note,
  type Shape,
} from "@stickyard/shared";
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
 * Copies of a selection with frames or shapes (v0.20.0; shapes protocol v15): frames alone (never
 * the items inside unless they're selected too), notes and shapes with their full content, all
 * moved by one offset clamped once for the whole group. Frames first (they sit behind everything
 * anyway), then notes and shapes together in stacking order (they share it).
 */
export function duplicateSelectionInputs(notes: readonly Note[], frames: readonly Frame[], offset: number = DUPLICATE_OFFSET, shapes: readonly Shape[] = []): ItemInput[] {
  const { dx, dy } = groupOffset([...notes, ...frames, ...shapes], offset, offset);
  const frameCopies = frames.map((f) => {
    const copy = duplicateFrameInput(f, 0);
    return { ...copy, ...clampFrameRect({ x: f.x + dx, y: f.y + dy, w: f.w, h: f.h }) };
  });
  const noteIds = new Set(notes.map((n) => n.id));
  const stacked = stackOrder<Note | Shape>([...notes, ...shapes]).map((item) =>
    noteIds.has(item.id) ? { ...duplicateNoteInputs([item as Note], 0)[0]!, x: item.x + dx, y: item.y + dy } : duplicateShapeInput(item as Shape, dx, dy),
  );
  return [...frameCopies, ...stacked];
}

/** A copy of a shape with its full content (kind, text, every style field, size), moved by (dx, dy) and clamped. */
export function duplicateShapeInput(shape: Shape, dx: number = DUPLICATE_OFFSET, dy: number = dx): ItemInput {
  return {
    kind: "shape",
    shapeKind: shape.kind,
    ...clampShapeRect({ x: shape.x + dx, y: shape.y + dy, w: shape.w, h: shape.h }),
    text: shape.text,
    ...(Object.fromEntries(SHAPE_STYLE_FIELDS.map((k) => [k, shape[k]])) as Pick<Shape, (typeof SHAPE_STYLE_FIELDS)[number]>),
  };
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
  none: "Select notes, shapes or a frame first.",
  offline: "Not connected.",
  held: "Finish moving or resizing first.",
  unsaved: "Wait until new notes are saved.",
  busy: "Wait until the items being added are saved.",
  notesFull: (needs: number, free: number) => `No room to duplicate ${needs} ${needs === 1 ? "note" : "notes"}: the board has room for ${free} more.`,
  framesFull: (_free: number) => `No room to duplicate the frame: the board has the maximum of ${MAX_FRAMES_PER_ROOM} frames.`,
  framesFullMany: (needs: number, free: number) => `No room to duplicate ${needs} frames: the board has room for ${free} more (at most ${MAX_FRAMES_PER_ROOM}).`,
  shapesFull: (needs: number, free: number) =>
    `No room to duplicate ${needs} ${needs === 1 ? "shape" : "shapes"}: the board has room for ${free} more (at most ${MAX_SHAPES_PER_ROOM}).`,
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
  /** Shapes selected, and room for more (protocol v15; absent: none). */
  shapes?: number;
  freeShapes?: number;
}

/** Duplicate needs a selection, a connection, everything in it saved and still, room for every copy, and no add run in progress. */
export function duplicateDisabledReason(s: DuplicateState): string | null {
  const frames = s.frames ?? (s.frame ? 1 : 0);
  const shapes = s.shapes ?? 0;
  if (s.notes === 0 && frames === 0 && shapes === 0) return DUPLICATE_HINTS.none;
  if (!s.live) return DUPLICATE_HINTS.offline;
  if (s.held) return DUPLICATE_HINTS.held;
  if (s.unsaved) return DUPLICATE_HINTS.unsaved;
  if (frames > s.freeFrames) return frames === 1 ? DUPLICATE_HINTS.framesFull(s.freeFrames) : DUPLICATE_HINTS.framesFullMany(frames, s.freeFrames);
  if (s.notes > s.freeNotes) return DUPLICATE_HINTS.notesFull(s.notes, s.freeNotes);
  if (shapes > (s.freeShapes ?? MAX_SHAPES_PER_ROOM)) return DUPLICATE_HINTS.shapesFull(shapes, s.freeShapes ?? 0);
  if (s.busy) return DUPLICATE_HINTS.busy;
  return null;
}
