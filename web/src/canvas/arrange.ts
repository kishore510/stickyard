import { BOARD_HEIGHT, BOARD_WIDTH, clampNoteRect, type NoteRect } from "@stickyard/shared";

/*
 * Align, distribute, match size and grid for a multi-selection, and the group drag clamp. Pure, as in
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

/** The gap between grid cells, in board units. Mirrored by `--sy-grid-gap` in tokens.css (test checks). */
export const GRID_GAP = 24;

/** Why a grid can't be laid out: wider than the board, taller, or both. */
export type GridReason = "wide" | "tall" | "big";

export interface GridResult {
  changes: Map<string, NoteRect>;
  reason: GridReason | null;
}

/**
 * The notes in reading order: row bands first (a note joins the current band when it overlaps
 * the band's top-to-bottom extent; touching isn't overlap), top to bottom, then left to right
 * within a band. Ties go by id, so the order never depends on the input's.
 */
export function readingOrder<T extends Placed>(rects: readonly T[]): T[] {
  const byTop = [...rects].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const bands: T[][] = [];
  let bottom = -Infinity;
  for (const r of byTop) {
    const band = bands.at(-1);
    if (band && r.y < bottom) {
      band.push(r);
      bottom = Math.max(bottom, r.y + r.h);
    } else {
      bands.push([r]);
      bottom = r.y + r.h;
    }
  }
  return bands.flatMap((band) => band.sort((a, b) => a.x - b.x || a.y - b.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}

/**
 * Lays the notes out in a grid of `columns` (kept within 1 and the count), in reading order,
 * row by row. Each column is as wide as its widest note and each row as tall as its tallest,
 * with `gap` between cells; notes sit at their cell's top-left and keep their size. The grid's
 * top-left is the selection's top-left, shifted back onto the board if the grid would run off
 * it. Doing it again changes nothing. A grid larger than the board changes nothing and says why.
 * Needs 2+ notes.
 */
export function grid(rects: readonly Placed[], columns: number, gap: number): GridResult {
  if (rects.length < 2) return { changes: new Map(), reason: null };
  const cols = Math.min(Math.max(1, Math.floor(columns)), rects.length);
  const order = readingOrder(rects);
  const widths = Array.from({ length: cols }, () => 0);
  const heights = Array.from({ length: Math.ceil(order.length / cols) }, () => 0);
  order.forEach((r, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    widths[col] = Math.max(widths[col]!, r.w);
    heights[row] = Math.max(heights[row]!, r.h);
  });
  const total = (sizes: number[]) => sizes.reduce((sum, s) => sum + s, 0) + gap * (sizes.length - 1);
  const width = total(widths);
  const height = total(heights);
  const wide = width > BOARD_WIDTH;
  const tall = height > BOARD_HEIGHT;
  if (wide || tall) return { changes: new Map(), reason: wide && tall ? "big" : wide ? "wide" : "tall" };
  const b = bounds(rects);
  const left = Math.max(0, Math.min(b.left, BOARD_WIDTH - width));
  const top = Math.max(0, Math.min(b.top, BOARD_HEIGHT - height));
  // Each cell's offset from the grid's top-left.
  const offsets = (sizes: number[]) => sizes.map((_, i) => sizes.slice(0, i).reduce((sum, s) => sum + s + gap, 0));
  const xs = offsets(widths);
  const ys = offsets(heights);
  const placed = new Map(order.map((r, i) => [r.id, { x: left + xs[i % cols]!, y: top + ys[Math.floor(i / cols)]! }]));
  return { changes: changes(rects, rects.map((r) => ({ ...r, ...placed.get(r.id)! }))), reason: null };
}

/**
 * A column count for `grid` (1 to the count): the one whose grid, estimated with the average
 * note width and height and GRID_GAP between cells, has the aspect ratio (width / height)
 * closest to the selection's bounding box, compared on a log scale so twice as wide and twice
 * as tall count the same. A wide spread gets more columns, a tall one fewer, and a pile of
 * square notes about the square root of the count. Ties go to fewer columns. With notes of
 * one size, a grid laid out with this count picks the same count again.
 */
export function autoColumns(rects: readonly Placed[]): number {
  const n = rects.length;
  if (n < 2) return 1;
  const b = bounds(rects);
  const target = Math.log((b.right - b.left) / (b.bottom - b.top));
  const avgW = rects.reduce((sum, r) => sum + r.w, 0) / n;
  const avgH = rects.reduce((sum, r) => sum + r.h, 0) / n;
  let best = 1;
  let bestDistance = Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const aspect = (cols * avgW + (cols - 1) * GRID_GAP) / (rows * avgH + (rows - 1) * GRID_GAP);
    const distance = Math.abs(Math.log(aspect) - target);
    // A hair of tolerance so float noise doesn't break a tie the wrong way.
    if (distance < bestDistance - 1e-9) {
      best = cols;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * A group drag's offset, clamped once for the whole group so the arrangement is kept at the
 * board's edges. Shared with the relay, which clamps a frame and its carried notes the same way.
 */
export { groupOffset } from "@stickyard/shared";

/** The rects with `changed` applied, in the same order. */
export function applyRects(rects: readonly Placed[], changed: ReadonlyMap<string, NoteRect>): Placed[] {
  return rects.map((r) => {
    const next = changed.get(r.id);
    return next ? { id: r.id, ...next } : r;
  });
}
