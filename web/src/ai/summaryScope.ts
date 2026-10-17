import { MAX_NOTE_TEXT, truncateCodePoints } from "@stickyard/shared";
import { readingOrder } from "../canvas/arrange";
import { frameMembers } from "../frames/board";
import type { Board } from "../notes/board";

/*
 * Summary and sentiment (v0.44.0, 10c, AI part 3 of 4): what is sent. Only note text and frame
 * titles, grouped by frame membership (frames/board.ts frameMembers, v0.41.0: inside the frame and
 * placed at or after it; on a board from before v23 that's simply inside it). Loose notes go in one
 * "loose" group. The page's own ids are replaced by stand-in refs (f1, n1...), kept here to map the
 * reply back; nothing else about a note or frame is read: no author, colour, position, vote or
 * reaction. Hidden (sealed) notes are never in it. Pure.
 */

export interface ScopeNote {
  /** The stand-in ref sent instead of the id. */
  ref: string;
  /** The note's id on this page (never sent). */
  id: string;
  text: string;
}
export interface ScopeFrame {
  ref: string;
  id: string;
  title: string;
  notes: ScopeNote[];
}
export interface SummaryScope {
  /** Frames holding at least one note in scope, in reading order, each with its notes in reading order. */
  frames: ScopeFrame[];
  /** Notes in no frame, in reading order. */
  loose: ScopeNote[];
  noteCount: number;
}

export interface ScopeSelection {
  notes: ReadonlySet<string>;
  frames: ReadonlySet<string>;
}

type Rect = { id: string; x: number; y: number; w: number; h: number; placed?: number | undefined };

/** Each note's frame by membership: of the frames that hold it, the latest placed, then the smallest. */
function frameOfNotes(frames: readonly Rect[], notes: readonly Rect[]): Map<string, string | null> {
  const out = new Map<string, string | null>(notes.map((n) => [n.id, null]));
  const best = new Map<string, Rect>();
  for (const f of frames) {
    for (const n of frameMembers(f, notes)) {
      const current = best.get(n.id);
      const better = !current || (f.placed ?? 0) > (current.placed ?? 0) || ((f.placed ?? 0) === (current.placed ?? 0) && f.w * f.h < current.w * current.h);
      if (better) {
        best.set(n.id, f);
        out.set(n.id, f.id);
      }
    }
  }
  return out;
}

/**
 * The notes in scope, grouped. No selection: the whole board. A selection: the selected notes plus
 * the notes belonging to the selected frames (each still grouped under its own frame).
 */
export function summaryScope(board: Board, { selection = null, hidden }: { selection?: ScopeSelection | null; hidden?: ReadonlySet<string> | undefined }): SummaryScope {
  const notes = board.notes.map((e) => e.note).filter((n) => !hidden?.has(n.id) && n.text.trim() !== "");
  const frames = board.frames.map((e) => e.frame);
  const frameOf = frameOfNotes(frames, notes);
  const inScope = selection === null ? notes : notes.filter((n) => selection.notes.has(n.id) || (frameOf.get(n.id) !== null && selection.frames.has(frameOf.get(n.id)!)));

  let noteRef = 0;
  const toNote = (n: { id: string; text: string }): ScopeNote => ({ ref: `n${++noteRef}`, id: n.id, text: truncateCodePoints(n.text, MAX_NOTE_TEXT) });
  const out: ScopeFrame[] = [];
  for (const f of readingOrder(frames)) {
    const mine = inScope.filter((n) => frameOf.get(n.id) === f.id);
    if (mine.length === 0) continue;
    out.push({ ref: `f${out.length + 1}`, id: f.id, title: f.title, notes: readingOrder(mine).map(toNote) });
  }
  const loose = readingOrder(inScope.filter((n) => frameOf.get(n.id) === null)).map(toNote);
  return { frames: out, loose, noteCount: inScope.length };
}

/** Every note in scope, frames first, in ref order. */
export const scopeNotes = (scope: SummaryScope): ScopeNote[] => [...scope.frames.flatMap((f) => f.notes), ...scope.loose];

/** The JSON sent between the <board> tags, every < escaped (<) so nothing in it can close or open a tag. */
export function summaryPayload(scope: SummaryScope): string {
  const plain = (n: ScopeNote) => ({ ref: n.ref, text: n.text });
  const json = JSON.stringify({ frames: scope.frames.map((f) => ({ ref: f.ref, title: f.title, notes: f.notes.map(plain) })), loose: scope.loose.map(plain) });
  return json.replace(/</g, "\\u003c");
}
