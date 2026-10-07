import { BOARD_HEIGHT, BOARD_WIDTH, NOTE_DEFAULT_H, NOTE_DEFAULT_W, NOTE_MAX_H, NOTE_MAX_W, NOTE_MIN_H, NOTE_MIN_W, type NoteRect } from "@stickyard/shared";

/*
 * A note's size on the board, in board units. Everything that needs it (the canvas nodes, fit,
 * reveal, drop placement, keyboard moves) asks here. Since protocol v4 every note has its own
 * size; something without one (a spot for a new note) is the default size.
 */

export interface NoteSize {
  width: number;
  height: number;
}

/** A new note's size. */
export const DEFAULT_NOTE_SIZE: NoteSize = { width: NOTE_DEFAULT_W, height: NOTE_DEFAULT_H };

export function noteSize(note: { w?: number; h?: number }): NoteSize {
  return { width: note.w ?? NOTE_DEFAULT_W, height: note.h ?? NOTE_DEFAULT_H };
}

/** Alt+Arrow changes the size by this much; with Shift too, by RESIZE_STEP_BIG. */
export const RESIZE_STEP = 10;
export const RESIZE_STEP_BIG = 50;

const KEY_DELTA: Record<string, [number, number]> = {
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0],
  ArrowDown: [0, 1],
  ArrowUp: [0, -1],
};

const between = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** Size limits: a note's by default (shapes pass theirs, protocol v15). */
export interface SizeLimits {
  minW: number;
  minH: number;
  maxW: number;
  maxH: number;
}
export const NOTE_LIMITS: SizeLimits = { minW: NOTE_MIN_W, minH: NOTE_MIN_H, maxW: NOTE_MAX_W, maxH: NOTE_MAX_H };

/**
 * The size (top-left corner fixed) after `w` x `h` is asked for: whole units, within min/max,
 * and no further than the board's right and bottom edges.
 */
export function sizeAt(note: NoteRect, w: number, h: number, limits: SizeLimits = NOTE_LIMITS): NoteRect {
  return {
    x: note.x,
    y: note.y,
    w: between(Math.round(w), limits.minW, Math.min(limits.maxW, BOARD_WIDTH - note.x)),
    h: between(Math.round(h), limits.minH, Math.min(limits.maxH, BOARD_HEIGHT - note.y)),
  };
}

/** Alt+Arrow: Right/Left widen/narrow, Down/Up heighten/shorten, by a step (`big`: Shift held). */
export function keyResize(note: NoteRect, key: string, big: boolean, limits: SizeLimits = NOTE_LIMITS): NoteRect | null {
  const delta = KEY_DELTA[key];
  if (!delta) return null;
  const step = big ? RESIZE_STEP_BIG : RESIZE_STEP;
  return sizeAt(note, note.w + delta[0] * step, note.h + delta[1] * step, limits);
}

/** A Width or Height field's value: a whole number within the limits, or null if it isn't a number. */
export function sizeFieldValue(raw: string, axis: "w" | "h", note: NoteRect, limits: SizeLimits = NOTE_LIMITS): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  const sized = axis === "w" ? sizeAt(note, n, note.h, limits) : sizeAt(note, note.w, n, limits);
  return sized[axis];
}
