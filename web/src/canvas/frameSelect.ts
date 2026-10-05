import { MAX_BATCH_ENTRIES } from "@stickyard/shared";
import { findFrame, framedNotes } from "../frames/board";
import type { Board } from "../notes/board";
import type { Box, Selection } from "./selection";

/*
 * Frame multi-select (v0.20.0, web only): pure rules for selections that hold frames, alone or
 * with notes. The store keeps the two sets (uiStore `selection` for notes, `frames` for frames).
 */

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What a selection holds, in words: "3 notes, 2 frames". Empty parts are left out. */
export function itemsLabel(notes: number, frames: number): string {
  return [notes > 0 ? plural(notes, "note") : null, frames > 0 ? plural(frames, "frame") : null].filter((p) => p !== null).join(", ");
}

/** Properties' heading for several items: "3 notes, 2 frames selected". */
export function selectionLabel(notes: number, frames: number): string {
  return `${itemsLabel(notes, frames)} selected`;
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

/** What deleting a selection removes, and how many notes inside its frames aren't selected (they stay). */
export interface DeleteCounts {
  notes: number;
  frames: number;
  /** Unselected notes whose centre is inside a selected frame (each counted once). */
  staying: number;
}

/** Counts for the delete confirmation: selected notes and frames still on the board, and the notes left inside the frames. */
export function deleteCounts(board: Board, noteIds: readonly string[], frameIds: readonly string[]): DeleteCounts {
  const selected = new Set(noteIds);
  const notes = board.notes.filter((n) => selected.has(n.note.id)).length;
  const frames = frameIds.flatMap((id) => findFrame(board, id)?.frame ?? []);
  const staying = new Set<string>();
  for (const f of frames) {
    for (const n of framedNotes(f, board.notes.map((e) => e.note))) if (!selected.has(n.id)) staying.add(n.id);
  }
  return { notes, frames: frames.length, staying: staying.size };
}

/** Asks once before deleting a selection with frames: the counts, and the notes inside that stay. */
export function confirmDeleteSelection(counts: DeleteCounts, confirm: (message: string) => boolean = (m) => window.confirm(m)): boolean {
  const what = itemsLabel(counts.notes, counts.frames).replace(", ", " and ");
  const stay =
    counts.staying === 0
      ? ""
      : ` ${counts.staying === 1 ? "1 note inside the frames isn’t selected and stays" : `${counts.staying} notes inside the frames aren’t selected and stay`} on the board.`;
  return confirm(`Delete ${what}? They’re removed for everyone in the session.${stay}`);
}

type Rect = { id: string; x: number; y: number; w: number; h: number };

/** What a selection drag moves: each frame with the notes it carries, the loose selected notes, and frames too full to carry. */
export interface CarryPlan {
  frames: { id: string; noteIds: string[] }[];
  /** Selected notes no selected frame carries (they move in note batches). */
  loose: string[];
  /** Frames that hold more than the cap: they move alone (the existing notice says so). */
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
export function carryPlan(frames: readonly Rect[], notes: readonly Rect[], selectedNotes: readonly string[], carry: boolean, cap: number = MAX_BATCH_ENTRIES): CarryPlan {
  const taken = new Set<string>();
  const alone: string[] = [];
  const planned = frames.map((f) => {
    if (!carry) return { id: f.id, noteIds: [] };
    const inside = framedNotes(f, notes).filter((n) => !taken.has(n.id));
    if (inside.length > cap) {
      alone.push(f.id);
      return { id: f.id, noteIds: [] };
    }
    for (const n of inside) taken.add(n.id);
    return { id: f.id, noteIds: inside.map((n) => n.id) };
  });
  const known = new Set(notes.map((n) => n.id));
  const loose = [...new Set(selectedNotes)].filter((id) => known.has(id) && !taken.has(id));
  return { frames: planned, loose, alone };
}

/** Why Arrange (Align, Distribute, Grid, Match size) is off for a selection with frames. */
export const ARRANGE_HINTS = {
  mixed: "Arrange works on notes or on frames, not both. Select only notes, or only frames.",
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
