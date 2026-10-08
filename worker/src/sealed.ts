import type { NoteCarryingType, ServerMessage } from "@stickyard/shared";

/*
 * Silent brainstorm (protocol v17): what one recipient may see of an outbound message. Every
 * message the room sends goes through Room.send / Room.broadcast, which pass each type marked
 * `carriesNoteContent` in SERVER_MESSAGES through scrubFor with that recipient's view: a sealed
 * note is visible only to its writer's sockets. The handlers already leave hidden notes out; this
 * is the backstop that keeps a missed path from leaking. Pure, so it is tested on its own.
 */

/** Whether the recipient may see this note. */
export type Visible = (noteId: string) => boolean;

type Of<K extends NoteCarryingType> = Extract<ServerMessage, { type: K }>;
type Scrubber<K extends NoteCarryingType> = (message: Of<K>, visible: Visible) => ServerMessage | null;

const one = <M extends { id: string }>(m: M, visible: Visible): M | null => (visible(m.id) ? m : null);

/** One entry per note-carrying type (the compiler checks every one is here). null: send nothing. */
const SCRUB: { [K in NoteCarryingType]: Scrubber<K> } = {
  // Errors go only to the sender and only echo ids it sent itself, exactly as for an unknown id.
  error: (m) => m,
  snapshot: (m, visible) => ({ ...m, notes: m.notes.filter((n) => visible(n.id)) }),
  noteAdded: (m, visible) => (visible(m.note.id) ? m : null),
  noteUpdated: (m, visible) => (visible(m.note.id) ? m : null),
  noteMoved: (m, visible) => one(m, visible),
  noteResized: (m, visible) => one(m, visible),
  noteDeleted: (m, visible) => one(m, visible),
  notesBatchApplied: (m, visible) => {
    const results = m.results.filter((r) => visible(r.id));
    return results.length > 0 ? { ...m, results } : null;
  },
  notesOrdered: (m, visible) => {
    const results = m.results.filter((r) => visible(r.id));
    return results.length > 0 ? { ...m, results } : null;
  },
  frameMoved: (m, visible) => {
    if (!m.notes) return m;
    const { notes: carried, ...rest } = m;
    const notes = carried.filter((n) => visible(n.id));
    return notes.length > 0 ? { ...rest, notes } : rest;
  },
  itemsAdded: (m, visible) => {
    const notes = m.notes.filter((n) => visible(n.note.id));
    if (notes.length === m.notes.length) return m;
    if (notes.length + m.frames.length + (m.shapes?.length ?? 0) === 0) return null;
    // A refused list only ever rides on the sender's copy, whose notes are all its own.
    return { ...m, notes };
  },
  voterGranted: (m, visible) => ({ ...m, mine: m.mine.filter((v) => visible(v.noteId)) }),
  voteConfirmed: (m, visible) => (visible(m.noteId) ? m : null),
  votesRevealed: (m, visible) => ({ ...m, totals: m.totals.filter((v) => visible(v.noteId)) }),
  notesRevealed: (m, visible) => {
    const notes = m.notes.filter((n) => visible(n.id));
    return notes.length > 0 ? { ...m, notes } : null;
  },
};

const carries = (message: ServerMessage): message is Of<NoteCarryingType> => message.type in SCRUB;

/** The message as this recipient may see it, or null when nothing of it is theirs to see. */
export function scrubFor(message: ServerMessage, visible: Visible): ServerMessage | null {
  if (!carries(message)) return message;
  const scrub = SCRUB[message.type] as Scrubber<NoteCarryingType>;
  return scrub(message, visible);
}
