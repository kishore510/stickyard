import { MAX_CONNECTORS_PER_ROOM } from "@stickyard/shared";
import { NOTE_TOOL_REASONS } from "../canvas/tools";

/*
 * Arrows (web only): what the page says about them, and why their controls are off. Pure, tested.
 * Reasons are shown, never hidden: a control that can't be used now says why.
 */

const arrows = (n: number) => `${n} ${n === 1 ? "arrow" : "arrows"}`;

export const CONNECTOR_TEXT = {
  full: `The board has the maximum of ${MAX_CONNECTORS_PER_ROOM} arrows. Delete one to add another.`,
  sameItem: "An arrow can’t start and end on the same note or shape.",
  tooShort: "That arrow is too short. Drag a little further.",
  missing: "That note or shape isn’t on the board any more.",
  unknownItem: "That arrow’s note or shape has gone, so the change wasn’t saved.",
  attachedMove: "This arrow is attached, so it moves with its note or shape. Drag one of its ends instead.",
  drawHint: "Drag from where the arrow starts to where it ends, or click the start and then the end. Esc cancels.",
  duplicateFull: (needs: number, free: number) =>
    `No room to duplicate ${arrows(needs)}: the board has room for ${free} more (at most ${MAX_CONNECTORS_PER_ROOM}).`,
  restoreFull: (needs: number, free: number) =>
    `Undo would bring back ${arrows(needs)}, but the board has room for ${free} more (at most ${MAX_CONNECTORS_PER_ROOM}).`,
  added: "Arrow added.",
  deleted: (n: number) => (n === 1 ? "Arrow deleted." : `${n} arrows deleted.`),
  summary: (n: number) => `${n} of ${MAX_CONNECTORS_PER_ROOM} arrows`,
  phone: "Arrows can be drawn and changed on a wider screen.",
} as const;

/** The delete confirm's extra line: arrows attached to what's deleted keep a free end where it was. */
export const freedLine = (n: number) => `${arrows(n)} will keep a free end.`;

/** Why the Connectors tiles are off (before the lock and the silent round), or null. */
export function connectorToolReason({ live, count }: { live: boolean; count: number }): string | null {
  if (!live) return NOTE_TOOL_REASONS.disconnected;
  return count >= MAX_CONNECTORS_PER_ROOM ? CONNECTOR_TEXT.full : null;
}
