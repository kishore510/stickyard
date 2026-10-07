/*
 * What the Delete (or Backspace) key does when it reaches the window, outside a note card
 * (a focused note card handles its own Delete first; see NoteCard). Pure, so it's tested.
 */

/**
 * The selected frame (alone), the selected shape (alone), the selected notes (no frames or shapes),
 * a selection of several items with frames or shapes, or nothing.
 */
export type DeleteKeyTarget = "frame" | "shape" | "notes" | "selection" | null;

export interface DeleteKeyEvent {
  key: string;
  target: EventTarget | null;
  defaultPrevented: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export interface DeleteKeyState {
  /** Several notes can be selected (md and up). Phones keep single-note delete on the note. */
  multi: boolean;
  /** Notes selected. */
  selection: number;
  /** One frame selected alone. */
  frameSelected: boolean;
  /** Frames selected (v0.20.0; absent counts as one when frameSelected, else none). */
  frames?: number;
  /** Shapes selected (protocol v15; absent: none). */
  shapes?: number;
  /** A modal sheet is open. */
  modal: boolean;
  /** The board's element: focus inside it (or on nothing) is the board's. */
  board: Element | null;
}

export const isDeleteKey = (key: string) => key === "Delete" || key === "Backspace";

/** Whether a key press belongs to a field (so Ctrl+A, Escape and Delete there are the field's). */
export const inField = (target: EventTarget | null) =>
  target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]') !== null;

/**
 * Focus inside the board, or on nothing in particular: the page, or an element round the board
 * (a click on the canvas focuses the app's focusable <main>). The key is then the board's.
 */
export const onBoard = (target: EventTarget | null, board: Element | null) =>
  target === null ||
  (typeof document !== "undefined" && (target === document.body || target === document.documentElement)) ||
  (target instanceof Node && board !== null && (board.contains(target) || target.contains(board)));

/** Focus in the board actions bar (it sits in the top bar since v0.15.1): keys there still act on the board. */
export const onBoardBar = (target: EventTarget | null) => target instanceof Element && target.closest("[data-board-bar]") !== null;

/**
 * Focus in a side panel (Palette, Properties; md and up): they're the board's too, so Delete
 * after dragging a tile onto the board, or after Ctrl+A with a panel control focused, acts on the
 * selection. Fields inside them stay the field's (inField is checked first).
 */
export const onSidePanel = (target: EventTarget | null) => target instanceof Element && target.closest("[data-side-panel]") !== null;

export function deleteKeyTarget(e: DeleteKeyEvent, state: DeleteKeyState): DeleteKeyTarget {
  if (!isDeleteKey(e.key) || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (inField(e.target) || state.modal || !state.multi || !(onBoard(e.target, state.board) || onBoardBar(e.target) || onSidePanel(e.target))) return null;
  const frames = state.frames ?? (state.frameSelected ? 1 : 0);
  const shapes = state.shapes ?? 0;
  const total = state.selection + frames + shapes;
  if ((frames > 0 || shapes > 0) && total > 1) return "selection";
  if (frames === 1) return "frame";
  if (shapes === 1) return "shape";
  return state.selection > 0 ? "notes" : null;
}
