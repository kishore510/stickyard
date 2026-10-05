/*
 * Clear board (Properties, nothing selected, md and up): why it's off, and its one confirmation.
 * Pure, so tested. The session does the deleting (RoomSession.clearBoard).
 */

export const CLEAR_HINTS = {
  offline: "Not connected.",
  empty: "The board is already empty.",
  busy: "Wait until the items being added are saved.",
  clearing: "The board is being cleared.",
  deleting: "Wait until the delete finishes.",
} as const;

export interface ClearState {
  live: boolean;
  notes: number;
  frames: number;
  /** A template, a duplicate or a restore is still being sent. */
  busy: boolean;
  /** A clear is still running. */
  clearing: boolean;
  /** A delete of a selection with frames is still running (v0.20.0). */
  deleting?: boolean;
}

export function clearBoardReason(s: ClearState): string | null {
  if (!s.live) return CLEAR_HINTS.offline;
  if (s.clearing) return CLEAR_HINTS.clearing;
  if (s.deleting) return CLEAR_HINTS.deleting;
  if (s.notes + s.frames === 0) return CLEAR_HINTS.empty;
  if (s.busy) return CLEAR_HINTS.busy;
  return null;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Asks once, with the counts, before deleting everything. */
export function confirmClearBoard(notes: number, frames: number, confirm: (message: string) => boolean = (m) => window.confirm(m)): boolean {
  const what = [notes > 0 ? count(notes, "note") : null, frames > 0 ? count(frames, "frame") : null].filter((p) => p !== null).join(" and ");
  return confirm(`Delete ${what} for everyone in this session? You can undo this until you leave or reconnect.`);
}
