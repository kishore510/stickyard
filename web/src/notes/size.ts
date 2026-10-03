import { NOTE_SIZE } from "@stickyard/shared";

/*
 * A note's size on the board, in board units. Everything that needs it (the canvas nodes,
 * fit, reveal, drop placement) asks here, so per-note sizes (slice 2.7) change this one
 * lookup and not the note component. Today every note is the default square.
 */

export interface NoteSize {
  width: number;
  height: number;
}

/** A new note's size. */
export const DEFAULT_NOTE_SIZE: NoteSize = { width: NOTE_SIZE, height: NOTE_SIZE };

export function noteSize<T extends { x: number; y: number }>(_note: T): NoteSize {
  return DEFAULT_NOTE_SIZE;
}
