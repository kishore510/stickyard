import type { Selection } from "./selection";
import type { Mode } from "./tools";

/*
 * What a press does, decided by the pointer's type (never the screen size or user agent).
 * Mouse: a left-drag on empty canvas draws a marquee (as in Chalkline), middle and right drag
 * pan. Touch and pen: a drag on empty canvas pans (no marquee on phones). The Hand tool or Space
 * makes every drag pan.
 */

export type PaneGesture = "marquee" | "pan" | "ignore";

export function paneGesture({
  pointerType,
  button,
  tool,
  spaceHeld,
}: {
  pointerType: string;
  button: number;
  tool: Mode;
  spaceHeld: boolean;
}): PaneGesture {
  // Some engines leave pointerType empty for a mouse.
  const mouse = pointerType === "mouse" || pointerType === "";
  if (!mouse) return button === 0 ? "pan" : "ignore";
  if (button === 1 || button === 2) return "pan";
  if (button !== 0) return "ignore";
  return tool === "hand" || spaceHeld ? "pan" : "marquee";
}

/** Shift, Ctrl or Cmd toggles a note in the selection; a plain click selects just it. */
export function noteClick(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): "toggle" | "only" {
  return e.shiftKey || e.ctrlKey || e.metaKey ? "toggle" : "only";
}

/** Dragging a selected note moves the whole selection; dragging any other note selects just it. */
export function dragSelection(selection: Selection, id: string): Selection {
  return selection.has(id) ? selection : new Set([id]);
}
