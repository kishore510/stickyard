import { MAX_FRAMES_PER_ROOM, MAX_NOTES_PER_ROOM } from "@stickyard/shared";
import { importReason } from "../importer/rules";
import { countsText, type ImportCounts, type ImportKind } from "../importer/parse";
import { SETUP_LIMITS } from "./setupPrompt";
import type { SetupFree } from "./setupParse";

/*
 * Board setup from a prompt (v0.43.0): who can use it and when, and what the page says. Pure.
 * Anyone who can add to the board: Import's reasons (not connected, a guest on a locked board, a
 * silent round for everyone, another add still being sent), plus a board with no room for a note.
 * Reasons are shown as text, never hidden.
 */

/** Why it can't run now, or null: the same reasons as Import. */
export function setupReason(state: { live: boolean; lockedOut: boolean; silent: boolean; busy: boolean }): string | null {
  return importReason(state);
}

/** The room's spare notes and frames (every note counts, the hidden ones of a silent round too). */
export function setupFree(used: ImportCounts): SetupFree {
  return { notes: Math.max(0, MAX_NOTES_PER_ROOM - used.notes), frames: Math.max(0, MAX_FRAMES_PER_ROOM - used.frames) };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const more = (n: number, word: string) => (n === 0 ? `no more ${word}s` : `${n} more ${n === 1 ? word : `${word}s`}`);

export const SETUP_TEXT = {
  title: "Set up board from a prompt",
  noKey: "Add your API key first",
  noKeyBody: "Board setup uses your own Anthropic API key. Add it in Settings, under AI (your own key), then come back here.",
  intro: "Describe the session you want to run. The page asks Anthropic for frames and notes, shows you a preview, and adds nothing until you choose Add to board.",
  label: "What is the board for?",
  examples: "Examples",
  counter: (n: number) => `${n.toLocaleString("en-GB")} / ${SETUP_LIMITS.description.toLocaleString("en-GB")}`,
  sent: "Only the description you typed. No board content, no names, no notes.",
  yourKey: "Anything you send goes to Anthropic using your key.",
  replyCap: (tokens: number) => `The reply can use up to ${tokens.toLocaleString("en-GB")} tokens (the most it is allowed).`,
  sending: "Sending your description to Anthropic.",
  receiving: "Receiving the reply.",
  progress: (chars: number) => `Receiving… ${plural(chars, "character")}`,
  waiting: "Waiting for Anthropic…",
  full: `This board already has ${MAX_NOTES_PER_ROOM} notes, the most it holds, so there’s no room for a new set-up. Delete some notes first.`,
  room: (free: SetupFree): string | null =>
    free.notes >= SETUP_LIMITS.items && free.frames >= SETUP_LIMITS.frames
      ? null
      : `This board has room for ${more(free.notes, "note")} and ${more(free.frames, "frame")}. Anything beyond that is left out.`,
  counts: (frames: number, notes: number) => `${plural(frames, "frame")}, ${plural(notes, "note")}`,
  previewReady: (frames: number, notes: number) => `Preview ready: ${plural(frames, "frame")}, ${plural(notes, "note")}. Nothing is added until you choose Add to board.`,
  tokens: (input: number, output: number) => `Used ${input.toLocaleString("en-GB")} input and ${output.toLocaleString("en-GB")} output tokens.`,
  unreadable: {
    title: "Couldn’t make a board",
    message: "The reply couldn’t be turned into a board. Nothing was changed on the board.",
    next: "Try again, or describe the board a little differently.",
  },
  truncatedNext: "Ask for fewer frames or notes, then try again.",
  blocked: (reason: string) => `Can’t add it now: ${reason}`,
  noRoom: (fails: readonly (readonly [ImportKind, number, number])[]) =>
    `This needs ${fails.map(([kind, needs, free]) => `${countsText({ notes: 0, shapes: 0, frames: 0, arrows: 0, groups: 0, [kind]: needs })}, but the board has room for ${free} more`).join("; ")}. Nothing was added.`,
  added: (frames: number, notes: number) =>
    `Added ${[frames > 0 ? plural(frames, "frame") : "", notes > 0 ? plural(notes, "note") : ""].filter(Boolean).join(" and ")}. One Undo removes all of it.`,
  notAdded: "Nothing was added. Close this to see why on the board.",
  emptyBoard: "This board is empty.",
} as const;

/** A board with no room for even one note can't take a set-up (said up front, before anything is sent). */
export function setupFullReason(free: SetupFree): string | null {
  return free.notes === 0 ? SETUP_TEXT.full : null;
}
