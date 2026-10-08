import { MAX_NOTES_PER_ROOM, MAX_SEALED_PER_WRITER, type SilentState } from "@stickyard/shared";

/*
 * Silent brainstorm (protocol v17/v18; web state since v0.27.0, the UI comes later). Pure rules and
 * texts, so tested. While a host's round runs, notes added are sealed: the relay sends each one only
 * to its writer's pages and everyone one count. The relay refuses frame moves and starting a vote
 * then (silent_active), a page with no writer (no_writer) and a writer's 41st note (sealed_full);
 * this page says so before anyone tries. The relay stays the authority.
 */

export const SILENT_TEXT = {
  /** Why a control is off while a round runs. */
  on: "Silent brainstorm is on.",
  export: "Export is off during a silent round.",
  /** My sealed notes are at MAX_SEALED_PER_WRITER (relay: sealed_full). */
  writerFull: "You’ve written the most notes you can in this round.",
  /**
   * This page joined without a key (the browser blocks storage, so none could be kept), so the
   * relay can't take its notes in a round (relay: no_writer). A reload wouldn't help: no "reload".
   */
  noWriter: "This browser is blocking storage, so this page can’t take part in the silent round. You can still watch.",
  /** Votes go on notes everyone can see. */
  sealedVote: "Hidden notes can get votes once they’re revealed.",
} as const;

export const SILENT_OFF: SilentState = { active: false, count: 0 };

/**
 * Notes on the board, everyone's: the ones shown here (mine sealed included) plus the sealed notes
 * of others that this page can't see. `count` is every sealed note in the room, mine too. Never
 * negative (counts can cross in flight).
 */
export function totalNotes(shown: number, silent: SilentState, mine: number): number {
  return shown + Math.max(0, silent.count - mine);
}

/** A control's reason while a round runs: its own reason first; the round only while connected. */
export function withSilent(reason: string | null, s: { live: boolean; active: boolean }): string | null {
  return reason ?? (s.live && s.active ? SILENT_TEXT.on : null);
}

/** Why I can't add a note now because of the round (no writer, or my notes at the cap), or null. */
export function silentNoteReason(s: { active: boolean; writer: boolean; mine: number }): string | null {
  if (!s.active) return null;
  if (!s.writer) return SILENT_TEXT.noWriter;
  return s.mine >= MAX_SEALED_PER_WRITER ? SILENT_TEXT.writerFull : null;
}

/** Room for more sealed notes of mine this round. */
export const writerRoom = (mine: number): number => Math.max(0, MAX_SEALED_PER_WRITER - mine);

/* ── The UI (part 3, v0.28.0) ─────────────────────────────────────── */

/** The room left that the strip mentions (MAX_SEALED_PER_WRITER minus mine) once it's this small. */
export const NEAR_CAP = 5;

const notes = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;

export const SILENT_UI = {
  heading: "Silent brainstorm",
  strip: "Silent brainstorm: write your ideas. Nobody sees them until the host reveals.",
  started: "Silent brainstorm started. Write your ideas: nobody sees them until the host reveals.",
  revealed: (n: number) => `${notes(n)} revealed.`,
  start: "Start silent round",
  reveal: "Reveal notes",
  /** The host's controls, before and during a round. */
  about: "Everyone writes notes only they can see, until you reveal them all at once.",
  running: (n: number) => `A silent round is running: ${notes(n)} hidden.`,
  /** On my sealed notes (with an icon; the short text is what shows on the board). */
  marker: "Only you can see this",
  markerShort: "Only you",
  /** In Properties and the phone editor, for a sealed note of mine. */
  sealedLine: "Only you can see this note until the host reveals the notes.",
  outside: "Some revealed notes are out of view.",
  fit: "Fit to notes",
} as const;

export const SILENT_HINTS = {
  offline: "Not connected.",
  running: "A silent round is already running.",
  none: "No silent round is running.",
  waiting: "Waiting for the relay…",
} as const;

/** The strip while a round runs: what's happening, then the numbers (mine is my sealed notes), or null. */
export function silentStripText(silent: SilentState, mine: number): { lead: string; counts: string } | null {
  if (!silent.active) return null;
  const left = writerRoom(mine);
  const counts = `You’ve written ${mine}. ${notes(silent.count)} written in total.${left <= NEAR_CAP ? ` ${left} left.` : ""}`;
  return { lead: SILENT_UI.strip, counts };
}

/** What the strip's announcer says between two states: the start, and the reveal (the count known before it). Never on joining. */
export function silentAnnouncement(prev: SilentState | null, next: SilentState): string | null {
  if (prev === null) return null;
  if (!prev.active && next.active) return SILENT_UI.started;
  if (prev.active && !next.active) return SILENT_UI.revealed(prev.count);
  return null;
}

/** Start's one confirm: the three facts, and a line each for a locked board and an open vote. */
export function confirmStartText({ locked, votingOpen }: { locked: boolean; votingOpen: boolean }): string {
  return [
    "Start a silent round?",
    "",
    "• Notes added from now on stay hidden from everyone but the person who wrote them, you included, until you reveal them.",
    "• Only this device can reveal them, so keep this page open. If you lose it, the hidden notes stay hidden until the session expires.",
    "• While it runs, frames can’t be moved, and Clear board and Start voting are off.",
    ...(locked ? ["• The board is locked, so guests can’t add notes until you unlock it."] : []),
    ...(votingOpen ? ["• Voting stays open, but nobody can vote on hidden notes until they’re revealed."] : []),
  ].join("\n");
}

/** Reveal's one confirm: one way, how many, everyone at once. */
export function confirmRevealText(hidden: number): string {
  const what =
    hidden === 0
      ? "There are no hidden notes. This ends the silent round for everyone and can’t be undone."
      : `Everyone will see ${hidden === 1 ? "the 1 hidden note" : `all ${hidden} hidden notes`} at once, and the silent round ends. This can’t be undone.`;
  return `Reveal the hidden notes?\n\n${what}`;
}

export const confirmStartSilent = (s: { locked: boolean; votingOpen: boolean }, confirm: (m: string) => boolean = (m) => window.confirm(m)) =>
  confirm(confirmStartText(s));
export const confirmRevealSilent = (hidden: number, confirm: (m: string) => boolean = (m) => window.confirm(m)) => confirm(confirmRevealText(hidden));

/**
 * Why the host's Start and Reveal are off, or null. The relay allows a round during an open vote
 * (votes on hidden notes are ignored), so an open vote doesn't turn Start off.
 */
export function hostSilentReasons(s: { live: boolean; active: boolean; pending: "start" | "reveal" | null }): { start: string | null; reveal: string | null } {
  if (!s.live) return { start: SILENT_HINTS.offline, reveal: SILENT_HINTS.offline };
  if (s.pending !== null) return { start: SILENT_HINTS.waiting, reveal: SILENT_HINTS.waiting };
  return { start: s.active ? SILENT_HINTS.running : null, reveal: s.active ? null : SILENT_HINTS.none };
}

/** The board's note count in Properties: while a round runs, the ones I can see, the hidden ones, and everyone's total. */
export function noteCountText({ shown, silent, mine }: { shown: number; silent: SilentState; mine: number }): string {
  const total = totalNotes(shown, silent, mine);
  if (!silent.active) return `${total} of ${MAX_NOTES_PER_ROOM} notes`;
  const hidden = Math.max(0, silent.count - mine);
  return `${shown} ${shown === 1 ? "note" : "notes"} you can see, ${hidden} hidden: ${total} of ${MAX_NOTES_PER_ROOM} notes`;
}

/** After a reveal: some of the notes it brought are out of view (the Fit line shows), never a view change. */
export const revealedOutside = (ids: readonly string[], visible: (id: string) => boolean): boolean => ids.some((id) => !visible(id));
