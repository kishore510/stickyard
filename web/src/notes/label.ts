import type { Note } from "@stickyard/shared";
import { NOTE_COLOR_NAMES } from "./colours";

/** Characters of note text in its accessible name. */
export const LABEL_TEXT_LENGTH = 40;

/** Collapses whitespace and cuts at a character (not UTF-16 unit) boundary. */
export function truncate(text: string, max = LABEL_TEXT_LENGTH): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max).join("").trimEnd()}…`;
}

/** e.g. "Yellow note: Idea one", or "Pink note, empty". */
export function noteLabel(note: Pick<Note, "text" | "color">): string {
  const colour = NOTE_COLOR_NAMES[note.color];
  return note.text.trim() ? `${colour} note: ${truncate(note.text)}` : `${colour} note, empty`;
}

/** Asks before deleting a note that has text. Empty notes go straight away. */
export function confirmDelete(text: string, confirm: (message: string) => boolean = (m) => window.confirm(m)): boolean {
  return !text.trim() || confirm("Delete this note? It’s removed for everyone in the session.");
}
