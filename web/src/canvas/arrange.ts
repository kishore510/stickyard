import { BOARD_HEIGHT, BOARD_WIDTH, clampNoteRect, type NoteRect } from "@stickyard/shared";

/*
 * Align, distribute and match size for a multi-selection, and the group drag clamp. Pure, as in
 * Chalkline's canvas/arrange.ts: each returns only the notes it changes, as whole-unit rects
 * clamped to the board (clampNoteRect: size first, then position). The server clamps again.
 */

export interface Placed extends NoteRect {
  id: string;
}

export const ALIGN_MODES = ["left", "centre", "right", "top", "middle", "bottom"] as const;
export type AlignMode = (typeof ALIGN_MODES)[number];
export type Axis = "horizontal" | "vertical";
export type MatchMode = "width" | "height" | "both";

/** Only the rects that differ from the input, clamped to the board. */
function changes(before: readonly Placed[], after: readonly Placed[]): Map<string, NoteRect> {
  const out = new Map<string, NoteRect>();
  after.forEach((p, i) => {
    const rect = clampNoteRect(p);
    const was = before[i]!;
    if (rect.x !== was.x || rect.y !== was.y || rect.w !== was.w || rect.h !== was.h) out.set(p.id, rect);
  });
  return out;
}

function bounds(rects: readonly Placed[]) {
  return {
    left: Math.min(...rects.map((r) => r.x)),
    top: Math.min(...rects.map((r) => r.y)),
    right: Math.max(...rects.map((r) => r.x + r.w)),
    bottom: Math.max(...rects.map((r) => r.y + r.h)),
  };
}

/** Lines the notes up on one edge or centre line of their bounding box. Needs 2+ notes. */
export function align(rects: readonly Placed[], mode: AlignMode): Map<string, NoteRect> {
  if (rects.length < 2) return new Map();
  const b = bounds(rects);
  // Whole-unit centre lines, rounded down, with each note offset by half its size rounded down:
  // aligning again lands on the same line (the widest note keeps the bounds' centre).
  const midX = Math.floor((b.left + b.right) / 2);
  const midY = Math.floor((b.top + b.bottom) / 2);
  return changes(
    rects,
    rects.map((r) => {
      switch (mode) {
        case "left":
          return { ...r, x: b.left };
        case "centre":
          return { ...r, x: midX - Math.floor(r.w / 2) };
        case "right":
          return { ...r, x: b.right - r.w };
        case "top":
          return { ...r, y: b.top };
        case "middle":
          return { ...r, y: midY - Math.floor(r.h / 2) };
        case "bottom":
          return { ...r, y: b.bottom - r.h };
      }
    }),
  );
}

/**
 * Equal gaps between the notes along an axis, taking their sizes into account. Ordered by centre;
 * the first and last stay where they are. Needs 3+ notes. Doing it again changes nothing when
 * the notes fit without overlapping; with overlap (negative gaps) the centre order can change.
 */
export function distribute(rects: readonly Placed[], axis: Axis): Map<string, NoteRect> {
  if (rects.length < 3) return new Map();
  const start = (r: Placed) => (axis === "horizontal" ? r.x : r.y);
  const length = (r: Placed) => (axis === "horizontal" ? r.w : r.h);
  const order = rects.map((_, i) => i).sort((a, b) => start(rects[a]!) + length(rects[a]!) / 2 - (start(rects[b]!) + length(rects[b]!) / 2));
  const first = rects[order[0]!]!;
  const last = rects[order.at(-1)!]!;
  const span = start(last) + length(last) - start(first);
  const gap = (span - rects.reduce((sum, r) => sum + length(r), 0)) / (rects.length - 1);
  const after = [...rects];
  let cursor = start(first);
  order.forEach((index, i) => {
    const r = rects[index]!;
    // The outermost two stay exactly where they are.
    const at = i === order.length - 1 ? start(last) : Math.round(cursor);
    after[index] = axis === "horizontal" ? { ...r, x: at } : { ...r, y: at };
    cursor += length(r) + gap;
  });
  return changes(rects, after);
}

/** Gives every note the first selected note's width, height or both (within min/max, kept on the board). Needs 2+ notes. */
export function matchSize(rects: readonly Placed[], mode: MatchMode): Map<string, NoteRect> {
  const ref = rects[0];
  if (!ref || rects.length < 2) return new Map();
  return changes(
    rects,
    rects.map((r) => ({ ...r, w: mode === "height" ? r.w : ref.w, h: mode === "width" ? r.h : ref.h })),
  );
}

/**
 * A group drag's offset, clamped once for the whole group so the arrangement is kept at the
 * board's edges (the server still clamps each note as a backstop).
 */
export function groupOffset(rects: readonly NoteRect[], dx: number, dy: number): { dx: number; dy: number } {
  if (rects.length === 0) return { dx: 0, dy: 0 };
  const b = bounds(rects.map((r) => ({ ...r, id: "" })));
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
  return { dx: clamp(dx, -b.left, BOARD_WIDTH - b.right), dy: clamp(dy, -b.top, BOARD_HEIGHT - b.bottom) };
}

/** The rects with `changed` applied, in the same order. */
export function applyRects(rects: readonly Placed[], changed: ReadonlyMap<string, NoteRect>): Placed[] {
  return rects.map((r) => {
    const next = changed.get(r.id);
    return next ? { id: r.id, ...next } : r;
  });
}
