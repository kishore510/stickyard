import type { Note, Participant } from "@stickyard/shared";
import { NOTE_COLOR_NAMES } from "./colours";
import { freedLine } from "../connectors/rules";

/** The confirm's line about arrows that keep a free end (v0.36.0), with a leading space; empty for none. */
export const freedSuffix = (freed: number) => (freed > 0 ? ` ${freedLine(freed)}` : "");

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

/**
 * Asks before deleting a note that has text, or that has arrows attached (`freed`: they keep a
 * free end, and the confirm says so). Empty notes without arrows go straight away.
 */
export function confirmDelete(text: string, confirm: (message: string) => boolean = (m) => window.confirm(m), freed = 0): boolean {
  return (!text.trim() && freed === 0) || confirm(`Delete this note? It’s removed for everyone in the session.${freedSuffix(freed)}`);
}

/** Asks before deleting several notes, always (even empty ones), with the count and the arrows that keep a free end. */
export function confirmDeleteNotes(count: number, confirm: (message: string) => boolean = (m) => window.confirm(m), freed = 0): boolean {
  return confirm(`Delete ${count} notes? They’re removed for everyone in the session.${freedSuffix(freed)}`);
}

/**
 * Who added a note, from the relay's participant records (never from the note itself).
 * Ids are per visit, so someone who joined before you and has left, or your own earlier
 * visit, isn't known by name.
 */
export function authorName(
  authorId: string,
  room: { you: Participant | null; people: ReadonlyMap<string, Participant>; participants: readonly Participant[]; yourIds?: ReadonlySet<string> },
): string {
  // Your notes stay yours across a reconnect (which gives you a new id).
  if (room.you && (room.you.id === authorId || room.yourIds?.has(authorId))) return `${room.you.name} (you)`;
  const person = room.people.get(authorId);
  if (!person) return "someone not in the session now";
  return room.participants.some((p) => p.id === authorId) ? person.name : `${person.name} (left)`;
}
