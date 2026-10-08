import { MAX_SEALED_PER_WRITER, type SilentState } from "@stickyard/shared";

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
