import { MAX_CONNECTORS_PER_ROOM, MAX_FRAMES_PER_ROOM, MAX_GROUPS_PER_ROOM, MAX_NOTES_PER_ROOM, MAX_SHAPES_PER_ROOM } from "@stickyard/shared";
import { NOTE_TOOL_REASONS } from "../canvas/tools";
import { LOCK_TEXT } from "../facilitation/lock";
import { SILENT_TEXT } from "../silent/silent";
import { STENCIL_LIMITS } from "./data";

/*
 * Stencils (web only): what the page says about them, and why their controls are off. Pure.
 * Reasons are shown, never hidden.
 */

export type StencilCap = "notes" | "shapes" | "frames" | "arrows" | "groups";

const CAPS: Record<StencilCap, number> = {
  notes: MAX_NOTES_PER_ROOM,
  shapes: MAX_SHAPES_PER_ROOM,
  frames: MAX_FRAMES_PER_ROOM,
  arrows: MAX_CONNECTORS_PER_ROOM,
  groups: MAX_GROUPS_PER_ROOM,
};

const one: Record<StencilCap, string> = { notes: "note", shapes: "shape", frames: "frame", arrows: "arrow", groups: "group" };
const count = (n: number, kind: StencilCap) => `${n} ${n === 1 ? one[kind] : kind}`;

export const STENCIL_TEXT = {
  noRoom: (kind: StencilCap, needs: number, free: number) =>
    `This stencil needs ${count(needs, kind)}, but the board has room for ${free} more (at most ${CAPS[kind]}).`,
  full: `This browser already keeps ${STENCIL_LIMITS.count} stencils. Delete one to save another.`,
  tooBig: "That selection is too big to save as a stencil. Select fewer items.",
  totalFull: "Saved stencils have used up their space in this browser. Delete one to save another.",
  blocked: "This browser is blocking storage, so stencils can’t be saved here. The built-in stencils still work.",
  malformed: (n: number) => `${n} saved ${n === 1 ? "stencil" : "stencils"} couldn’t be read and ${n === 1 ? "was" : "were"} left out.`,
  saveNote: "Includes the text of the selected items. Saved in this browser only.",
  saved: (name: string) => `Saved “${name}” as a stencil.`,
  nothingToSave: "Select notes, shapes or frames to save as a stencil.",
  builtIn: "Built-in",
  yours: "Saved in this browser",
  none: "Nothing saved yet. Select some notes, shapes or frames and choose Save as stencil.",
  deleteAllConfirm: "Delete every stencil saved in this browser? This can’t be undone.",
  deleteConfirm: (name: string) => `Delete the stencil “${name}” from this browser?`,
  renamePrompt: "New name for this stencil (up to 40 characters):",
} as const;

/** Why stencils can't be placed now (not connected, a guest on a locked board, a silent round for everyone), or null. */
export function stencilReason({ live, lockedOut, silent }: { live: boolean; lockedOut: boolean; silent: boolean }): string | null {
  if (!live) return NOTE_TOOL_REASONS.disconnected;
  if (lockedOut) return LOCK_TEXT.reason;
  return silent ? SILENT_TEXT.on : null;
}
