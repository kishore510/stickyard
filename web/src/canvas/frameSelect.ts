import { MAX_BATCH_ENTRIES } from "@stickyard/shared";
import { findFrame, framedNotes } from "../frames/board";
import type { Board } from "../notes/board";
import type { Box, Selection } from "./selection";

/*
 * Frame multi-select (v0.20.0, web only): pure rules for selections that hold frames, alone or
 * with notes. The store keeps the two sets (uiStore `selection` for notes, `frames` for frames).
 */

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What a selection holds, in words: "3 notes, 2 frames, 1 shape". Empty parts are left out. */
export function itemsLabel(notes: number, frames: number, shapes = 0): string {
  return [notes > 0 ? plural(notes, "note") : null, frames > 0 ? plural(frames, "frame") : null, shapes > 0 ? plural(shapes, "shape") : null]
    .filter((p) => p !== null)
    .join(", ");
}

/** "3 notes and 2 frames", "3 notes, 2 frames and 1 shape": a list of parts in a sentence. */
export function itemsInWords(notes: number, frames: number, shapes = 0): string {
  const parts = itemsLabel(notes, frames, shapes).split(", ");
  return parts.length < 3 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Properties' heading for several items: "3 notes, 2 frames selected". */
export function selectionLabel(notes: number, frames: number, shapes = 0): string {
  return `${itemsLabel(notes, frames, shapes)} selected`;
}

/**
 * A marquee's frames: only those it fully encloses (edges count), unlike notes (touching is
 * enough), so a box drawn inside a frame never grabs the frame. Board order, after `base` when
 * `additive` (Shift). Returns `previous` when that's the same.
 */
export function marqueeFrames(
  frames: readonly { id: string; x: number; y: number; w: number; h: number }[],
  box: Box,
  base: Selection,
  additive: boolean,
  previous?: Selection,
): Selection {
  const left = Math.min(box.x, box.x + box.width);
  const right = Math.max(box.x, box.x + box.width);
  const top = Math.min(box.y, box.y + box.height);
  const bottom = Math.max(box.y, box.y + box.height);
  const hits = frames.filter((f) => f.x >= left && f.x + f.w <= right && f.y >= top && f.y + f.h <= bottom).map((f) => f.id);
  const next = new Set(additive ? [...base, ...hits] : hits);
  if (previous && previous.size === next.size && [...previous].every((id, i) => [...next][i] === id)) return previous;
  return next;
}

/** What deleting a selection removes, and how many items inside its frames aren't selected (they stay). */
export interface DeleteCounts {
  notes: number;
  frames: number;
  /** Shapes (protocol v15). */
  shapes?: number;
  /** Unselected notes whose centre is inside a selected frame (each counted once). */
  staying: number;
  /** Unselected shapes inside a selected frame, likewise. */
  stayingShapes?: number;
}

/** Counts for the delete confirmation: selected items still on the board, and the notes and shapes left inside the frames. */
export function deleteCounts(board: Board, noteIds: readonly string[], frameIds: readonly string[], shapeIds: readonly string[] = []): DeleteCounts {
  const selected = new Set(noteIds);
  const selectedShapes = new Set(shapeIds);
  const notes = board.notes.filter((n) => selected.has(n.note.id)).length;
  const shapes = board.shapes.filter((x) => selectedShapes.has(x.shape.id)).length;
  const frames = frameIds.flatMap((id) => findFrame(board, id)?.frame ?? []);
  const staying = new Set<string>();
  const stayingShapes = new Set<string>();
  for (const f of frames) {
    for (const n of framedNotes(f, board.notes.map((e) => e.note))) if (!selected.has(n.id)) staying.add(n.id);
    for (const x of framedNotes(f, board.shapes.map((e) => e.shape))) if (!selectedShapes.has(x.id)) stayingShapes.add(x.id);
  }
  return { notes, frames: frames.length, ...(shapeIds.length > 0 || stayingShapes.size > 0 ? { shapes, stayingShapes: stayingShapes.size } : {}), staying: staying.size };
}

/** Asks once before deleting a selection of several items: the counts, and the notes and shapes inside frames that stay. */
export function confirmDeleteSelection(counts: DeleteCounts, confirm: (message: string) => boolean = (m) => window.confirm(m)): boolean {
  const what = itemsInWords(counts.notes, counts.frames, counts.shapes ?? 0);
  const stay =
    counts.staying === 0
      ? ""
      : ` ${counts.staying === 1 ? "1 note inside the frames isn’t selected and stays" : `${counts.staying} notes inside the frames aren’t selected and stay`} on the board.`;
  const left = counts.stayingShapes ?? 0;
  const stayShapes =
    left === 0 ? "" : ` ${left === 1 ? "1 shape inside the frames isn’t selected and stays" : `${left} shapes inside the frames aren’t selected and stay`} on the board.`;
  return confirm(`Delete ${what}? They’re removed for everyone in the session.${stay}${stayShapes}`);
}

type Rect = { id: string; x: number; y: number; w: number; h: number };

/** What a selection drag moves: each frame with the notes and shapes it carries, the loose selected items, and frames too full to carry. */
export interface CarryPlan {
  frames: { id: string; noteIds: string[]; shapeIds: string[] }[];
  /** Selected notes no selected frame carries (they move in note batches). */
  loose: string[];
  /** Selected shapes no selected frame carries (they move in shape batches; protocol v15). */
  looseShapes: string[];
  /** Frames that hold more than the cap (notes and shapes together): they move alone (the existing notice says so). */
  alone: string[];
}

/**
 * Who carries what when a selection with frames moves (pure). Frames in selection order: each
 * carries the notes whose centre is inside it (`notes`: the notes that can move) that no earlier
 * frame took, so a note inside two selected frames goes with the first and nothing moves twice.
 * A frame with more than `cap` (MAX_BATCH_ENTRIES) such notes carries none (it moves alone, as a
 * single frame drag does). Without `carry` (Alt held at drag start) frames carry nothing. Selected
 * notes no frame carries are `loose`.
 */
export function carryPlan(
  frames: readonly Rect[],
  notes: readonly Rect[],
  selectedNotes: readonly string[],
  carry: boolean,
  cap: number = MAX_BATCH_ENTRIES,
  shapes: readonly Rect[] = [],
  selectedShapes: readonly string[] = [],
): CarryPlan {
  const taken = new Set<string>();
  const alone: string[] = [];
  const planned = frames.map((f) => {
    if (!carry) return { id: f.id, noteIds: [], shapeIds: [] };
    const inside = framedNotes(f, notes).filter((n) => !taken.has(n.id));
    const insideShapes = framedNotes(f, shapes).filter((x) => !taken.has(x.id));
    // The carry cap is shared by notes and shapes (protocol v15).
    if (inside.length + insideShapes.length > cap) {
      alone.push(f.id);
      return { id: f.id, noteIds: [], shapeIds: [] };
    }
    for (const n of [...inside, ...insideShapes]) taken.add(n.id);
    return { id: f.id, noteIds: inside.map((n) => n.id), shapeIds: insideShapes.map((x) => x.id) };
  });
  const known = new Set(notes.map((n) => n.id));
  const loose = [...new Set(selectedNotes)].filter((id) => known.has(id) && !taken.has(id));
  const knownShapes = new Set(shapes.map((x) => x.id));
  const looseShapes = [...new Set(selectedShapes)].filter((id) => knownShapes.has(id) && !taken.has(id));
  return { frames: planned, loose, looseShapes, alone };
}

/** Why Arrange (Align, Distribute, Grid, Match size) is off for a selection with frames. */
export const ARRANGE_HINTS = {
  mixed: "Arrange works on notes and shapes, or on frames, not both. Select only notes and shapes, or only frames.",
  fewFrames: "Select 2 or more frames to arrange.",
  fewFramesDistribute: "Select 3 or more frames to distribute.",
  offline: "Not connected.",
  held: "Finish moving or resizing first.",
  unsaved: "Wait until new frames are saved.",
} as const;

/**
 * Why arrange is off for frames (or a mix), or null: a guest on a locked board gets the lock's
 * reason, a mix of notes and frames is refused (shown as text, never hidden), and frames need
 * 2+, a connection, and every one saved and still. Notes alone keep their own rules (SelectionBar).
 */
export function arrangeReason(s: { notes: number; frames: number; live: boolean; locked: string | null; held: boolean; unsaved: boolean }): string | null {
  if (s.locked) return s.locked;
  if (s.notes > 0 && s.frames > 0) return ARRANGE_HINTS.mixed;
  if (s.frames < 2) return ARRANGE_HINTS.fewFrames;
  if (!s.live) return ARRANGE_HINTS.offline;
  if (s.held) return ARRANGE_HINTS.held;
  if (s.unsaved) return ARRANGE_HINTS.unsaved;
  return null;
}
