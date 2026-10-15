import { stackOrder, type Note, type Shape } from "@stickyard/shared";
import type { Board } from "../notes/board";
import { buildStencil, parseStencil, type StencilArrow, type StencilFrame, type StencilGroup, type StencilNote, type StencilShape } from "../stencils/data";

/*
 * Export board file (v0.40.0, web only): the board as JSON, made here from what this page shows.
 * The items are the stencil format's (stencils/data.ts: notes, shapes and frames as the add
 * messages' items with a ref, arrows and groups naming them by ref, places from the top-left at
 * 0, 0), built by Save as stencil's `buildStencil` with everything selected, then checked by
 * `parseStencil` so only the stencil's exact keys can get in. Wrapped in a format name and version,
 * plus `stack`: the notes' and shapes' refs bottom first (one stacking space; the stencil keeps
 * notes and shapes in separate lists). No room code, names, authors, ids, revs, z, votes, reactions
 * or cursors, and never a hidden (sealed) note.
 */

export const BOARD_FILE_FORMAT = "stickyard-board";
export const BOARD_FILE_VERSION = 1;
export const BOARD_FILE_TYPE = "application/json";

export interface BoardFile {
  format: typeof BOARD_FILE_FORMAT;
  formatVersion: typeof BOARD_FILE_VERSION;
  notes: StencilNote[];
  shapes: StencilShape[];
  frames: StencilFrame[];
  arrows: StencilArrow[];
  groups: StencilGroup[];
  /** Every note's and shape's ref once, bottom first. */
  stack: string[];
}

/**
 * The board file, or null when there's nothing to put in it. `hidden`: notes left out (my sealed
 * notes during a silent round; export is off then anyway). An arrow to a left-out note keeps a
 * free end where it was, and a group losing a member is left out, as Save as stencil does.
 */
export function buildBoardFile(board: Board, hidden: ReadonlySet<string> = new Set()): BoardFile | null {
  const notes = stackOrder<Note>(board.notes.map((e) => e.note).filter((n) => !hidden.has(n.id)));
  const shapes = stackOrder<Shape>(board.shapes.map((e) => e.shape));
  if (notes.length + shapes.length + board.frames.length === 0) return null;
  const sel = {
    notes: notes.map((n) => n.id),
    shapes: shapes.map((s) => s.id),
    frames: board.frames.map((f) => f.frame.id),
    connectors: board.connectors.map((c) => c.connector.id),
  };
  const stencil = parseStencil(buildStencil(board, sel, "", "board"));
  if (!stencil) return null;
  // buildStencil names them n1, s1... in the order given.
  const refOf = new Map<string, string>([...notes.map((n, i) => [n.id, `n${i + 1}`] as const), ...shapes.map((s, i) => [s.id, `s${i + 1}`] as const)]);
  const stack = stackOrder<Note | Shape>([...notes, ...shapes]).flatMap((item) => refOf.get(item.id) ?? []);
  const { notes: n, shapes: s, frames, arrows, groups } = stencil;
  return { format: BOARD_FILE_FORMAT, formatVersion: BOARD_FILE_VERSION, notes: n, shapes: s, frames, arrows, groups, stack };
}

/** The file's text: indented JSON, ending in a line break. */
export function boardFileText(file: BoardFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
