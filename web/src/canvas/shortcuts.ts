import { inField, onBoard } from "./deleteKey";

/*
 * Board commands with Ctrl (Cmd on a Mac) shortcuts, from md up. Pure, so the guards are tested:
 * never in a text field (a note edited in place, a frame title, Properties: the browser's own
 * keys apply there), never in a modal sheet, never from a control elsewhere on the page.
 */

export type BoardCommand = "duplicate" | "undo" | "redo";

export interface ShortcutEvent {
  key: string;
  target: EventTarget | null;
  defaultPrevented: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface ShortcutState {
  /** md and up (phones have no board shortcuts). */
  multi: boolean;
  /** A modal sheet is open. */
  modal: boolean;
  /** The board's element: focus inside it (or on nothing) is the board's. */
  board: Element | null;
}

/**
 * The command a key press asks for, or null. Ctrl+D: Duplicate (the caller stops the browser's
 * bookmark). Ctrl+Z: Undo. Ctrl+Shift+Z, and Ctrl+Y (not Cmd+Y: that's the Mac's history): Redo.
 */
export function boardShortcut(e: ShortcutEvent, state: ShortcutState): BoardCommand | null {
  if (e.defaultPrevented || e.altKey || !(e.ctrlKey || e.metaKey)) return null;
  if (!state.multi || state.modal || inField(e.target) || !onBoard(e.target, state.board)) return null;
  const key = e.key.toLowerCase();
  if (key === "d" && !e.shiftKey) return "duplicate";
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y" && e.ctrlKey && !e.metaKey && !e.shiftKey) return "redo";
  return null;
}
