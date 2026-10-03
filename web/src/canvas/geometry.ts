import { BOARD_HEIGHT, BOARD_WIDTH, NOTE_SIZE, clampNotePosition } from "@stickyard/shared";

/*
 * Canvas geometry: pure functions, no React Flow or DOM.
 *
 * Coordinates: React Flow's flow coordinates ARE board units (1 unit = 1 CSS px at zoom 1),
 * with the board's top-left at (0, 0). A note's node sits at the note's x/y. flowToBoard is
 * the one conversion back: whole units, clamped so the note stays on the board (the server
 * clamps the same way). A viewport is React Flow's transform: screen = flow * zoom + (x, y).
 */

export interface XY {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Rect extends XY, Size {}
export interface Viewport extends XY {
  zoom: number;
}

/** What a plain mouse wheel does. Ctrl+wheel and pinch always zoom. Flip to "zoom" for wheel-zooms. */
export const WHEEL_BEHAVIOUR: "pan" | "zoom" = "pan";

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2;
/** Fit never zooms in past this, so one note doesn't fill the screen. */
export const FIT_MAX_ZOOM = 1;
/** Each zoom in/out step multiplies or divides the zoom by this. */
export const ZOOM_FACTOR = 1.25;
/** How far past the board's edge the view can be panned, in board units. */
export const PAN_MARGIN = NOTE_SIZE;
/** A new note on a taken spot steps down and right by this much, up to STACK_TRIES times. */
export const STACK_OFFSET = 24;
export const STACK_TRIES = 8;

/** Flow position -> board position: whole units, kept on the board. */
export function flowToBoard(p: XY): XY {
  return clampNotePosition(p.x, p.y);
}

/** Board position -> flow position (the same numbers; see the note above). */
export function boardToFlow(p: XY): XY {
  return { x: p.x, y: p.y };
}

export function screenToFlow(p: XY, v: Viewport): XY {
  return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
}

/** The flow point at the centre of a `size` container. */
export function viewportCentre(v: Viewport, size: Size): XY {
  return screenToFlow({ x: size.width / 2, y: size.height / 2 }, v);
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** One zoom step in (direction 1) or out (-1). */
export function zoomStep(zoom: number, direction: 1 | -1): number {
  return clampZoom(zoom * ZOOM_FACTOR ** direction);
}

/** The viewport at `zoom` showing the same centre point. */
export function zoomAround(v: Viewport, size: Size, zoom: number): Viewport {
  return centreOn(viewportCentre(v, size), clampZoom(zoom), size);
}

/** The viewport with flow point `p` at the centre of the container. */
export function centreOn(p: XY, zoom: number, size: Size): Viewport {
  return { x: size.width / 2 - p.x * zoom, y: size.height / 2 - p.y * zoom, zoom };
}

/** Where the view may go: the board plus PAN_MARGIN all round (React Flow's translateExtent). */
export function panExtent(): [[number, number], [number, number]] {
  return [
    [-PAN_MARGIN, -PAN_MARGIN],
    [BOARD_WIDTH + PAN_MARGIN, BOARD_HEIGHT + PAN_MARGIN],
  ];
}

/** Keeps the view inside the pan extent; an extent smaller than the screen is centred. */
export function clampViewport(v: Viewport, size: Size): Viewport {
  const [[x0, y0], [x1, y1]] = panExtent();
  const axis = (offset: number, screen: number, lo: number, hi: number) => {
    if ((hi - lo) * v.zoom <= screen) return screen / 2 - ((lo + hi) / 2) * v.zoom;
    // Visible flow range is [-offset/zoom, (screen-offset)/zoom]; keep it within [lo, hi].
    return Math.min(-lo * v.zoom, Math.max(screen - hi * v.zoom, offset));
  };
  return { x: axis(v.x, size.width, x0, x1), y: axis(v.y, size.height, y0, y1), zoom: v.zoom };
}

/** The box around every note (top-left corners plus NOTE_SIZE), or null for none. */
export function notesBounds(notes: XY[]): Rect | null {
  if (notes.length === 0) return null;
  const xs = notes.map((n) => n.x);
  const ys = notes.map((n) => n.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) + NOTE_SIZE - x, height: Math.max(...ys) + NOTE_SIZE - y };
}

/**
 * Fit to notes: every note inside `padding` (screen px) of the edges, zoom at most
 * FIT_MAX_ZOOM. An empty board is centred at zoom 1.
 */
export function fitViewport(notes: XY[], size: Size, padding: number): Viewport {
  const bounds = notesBounds(notes);
  if (!bounds) return clampViewport(centreOn({ x: BOARD_WIDTH / 2, y: BOARD_HEIGHT / 2 }, 1, size), size);
  const room = (screen: number) => Math.max(1, screen - 2 * padding);
  const zoom = clampZoom(Math.min(FIT_MAX_ZOOM, room(size.width) / bounds.width, room(size.height) / bounds.height));
  const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  return clampViewport(centreOn(centre, zoom, size), size);
}

/**
 * Where a new note goes: centred on `centre` (the viewport centre), on the board. If a note
 * already starts (nearly) there, step down and right so they don't stack exactly.
 */
export function newNotePosition(centre: XY, notes: XY[]): XY {
  const taken = (p: XY) => notes.some((n) => Math.abs(n.x - p.x) < STACK_OFFSET / 2 && Math.abs(n.y - p.y) < STACK_OFFSET / 2);
  let p = flowToBoard({ x: centre.x - NOTE_SIZE / 2, y: centre.y - NOTE_SIZE / 2 });
  for (let i = 0; i < STACK_TRIES && taken(p); i++) {
    const next = flowToBoard({ x: p.x + STACK_OFFSET, y: p.y + STACK_OFFSET });
    if (next.x === p.x && next.y === p.y) break;
    p = next;
  }
  return p;
}

/** Pointer travel (screen px) before a press on a note is a drag rather than a tap. */
export function dragThreshold(coarsePointer: boolean): number {
  return coarsePointer ? 8 : 4;
}

export function isDrag(dx: number, dy: number, threshold: number): boolean {
  return Math.hypot(dx, dy) >= threshold;
}
