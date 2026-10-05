import { VOTE_BUDGET_DEFAULT, VOTE_BUDGET_MAX, VOTE_BUDGET_MIN, type VotingState } from "@stickyard/shared";
import { CLEAR_HINTS } from "../properties/clearBoard";
import { splitTitleBody } from "../notes/titleBody";

/*
 * Dot voting UI (v0.18.0, on the protocol v13 plumbing; web only). Pure rules and texts, so
 * they're tested: the strip under the top bar, what is announced, why the vote buttons are off,
 * the host's controls, and the results list. The relay is the authority on every vote; this is
 * courtesy UI that says why before anyone tries. Votes are anonymous: nothing here knows who
 * voted for what, only my own dots and the totals once a round is closed.
 */

export const VOTE_TEXT = {
  /** The strip while a round is open (N dots left of the budget M). */
  open: (left: number, budget: number) => `Voting is open — you have ${left} of ${budget} ${budget === 1 ? "dot" : "dots"} left.`,
  closed: "Voting has ended — results are shown on the notes.",
  /** Announced (politely) once each: a round starts, my last dot is placed, the round ends. */
  started: (budget: number) => `Voting is open. You have ${budget} ${budget === 1 ? "dot" : "dots"} to place.`,
  none: "You have no dots left.",
  ended: "Voting has ended. Results are shown on the notes.",
  add: "Add a dot",
  remove: "Remove a dot",
  showResults: "Show results",
  noResults: "No votes were cast.",
  topVoted: "Top voted",
  untitled: "Untitled note",
  /** The keyboard shortcut, as Help and the board's instructions say it. */
  keys: "With voting open, press D on a focused note to add a dot, Shift+D to take one off.",
} as const;

/** Why a vote button is off (text, always shown next to it). */
export const VOTE_HINTS = {
  notOpen: "Voting isn’t open.",
  offline: "Not connected.",
  noDots: "You have no dots left.",
  nothing: "You have no dots on this note.",
  unsaved: "Wait until the note is saved.",
  joining: "Joining the vote…",
  full: "This vote is full.",
} as const;

/** What the strip says (null: no strip while voting is off). */
export function stripText(voting: VotingState, remaining: number): string | null {
  if (voting.state === "open") return VOTE_TEXT.open(remaining, voting.budget);
  if (voting.state === "closed") return VOTE_TEXT.closed;
  return null;
}

/** What the announcer says between two states (null: nothing). Never per dot: only start, reaching 0 and stop. */
export interface AnnounceState {
  state: VotingState["state"];
  round: number;
  budget: number;
  remaining: number;
}

export function voteAnnouncement(prev: AnnounceState | null, next: AnnounceState): string | null {
  // The first state seen (joining) isn't news.
  if (prev === null) return null;
  if (next.state === "open" && (prev.state !== "open" || prev.round !== next.round)) return VOTE_TEXT.started(next.budget);
  if (next.state === "closed" && prev.state === "open") return VOTE_TEXT.ended;
  if (next.state === "open" && prev.remaining > 0 && next.remaining === 0) return VOTE_TEXT.none;
  return null;
}

/** Everything the vote buttons of one note depend on. The board lock is not one of them (decided). */
export interface VoteButtonState {
  voting: VotingState;
  live: boolean;
  /** The note has its server id (votes need it). */
  confirmed: boolean;
  isVoter: boolean;
  /** The relay said this round has its maximum of voters. */
  votersFull: boolean;
  remaining: number;
  /** My dots on this note. */
  mine: number;
}

/** Why "Add a dot" and "Remove a dot" are off (null: on), in this order of precedence. */
export function voteReasons(s: VoteButtonState): { add: string | null; remove: string | null } {
  const shared = s.voting.state !== "open"
    ? VOTE_HINTS.notOpen
    : !s.live
      ? VOTE_HINTS.offline
      : !s.confirmed
        ? VOTE_HINTS.unsaved
        : s.votersFull
          ? VOTE_HINTS.full
          : !s.isVoter
            ? VOTE_HINTS.joining
            : null;
  if (shared) return { add: shared, remove: shared };
  return {
    add: s.remaining <= 0 || s.mine >= VOTE_BUDGET_MAX ? VOTE_HINTS.noDots : null,
    remove: s.mine <= 0 ? VOTE_HINTS.nothing : null,
  };
}

/** The reasons to show under a pair of vote buttons: each different one once. */
export const reasonLines = (r: { add: string | null; remove: string | null }): string[] =>
  [...new Set([r.add, r.remove].filter((x): x is string => x !== null))];

/** Is this key press the vote shortcut on a focused note? D adds a dot, Shift+D takes one off. */
export function voteKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): "add" | "remove" | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== "d") return null;
  return e.shiftKey ? "remove" : "add";
}

/* ── Host controls ─────────────────────────────────────────────── */

export const BUDGET = { min: VOTE_BUDGET_MIN, max: VOTE_BUDGET_MAX, default: VOTE_BUDGET_DEFAULT } as const;

/** A budget within the relay's bounds (1 to 20 whole dots), or null: the relay refuses anything else, so nothing is sent. */
export function validBudget(value: number): boolean {
  return Number.isInteger(value) && value >= BUDGET.min && value <= BUDGET.max;
}

/** The stepper's next value, kept within the bounds. */
export const stepBudget = (value: number, by: number) => Math.min(BUDGET.max, Math.max(BUDGET.min, Math.round(value) + by));

export const HOST_VOTE_TEXT = {
  heading: "Dot voting",
  budget: "Dots each",
  start: "Start voting",
  restart: "Start a new round",
  stop: "Stop and reveal",
  clear: "Clear votes",
  /** Said beside Start: starting always clears what came before. */
  startNote: "Starting a round clears the previous round’s votes.",
  open: "Voting is open.",
  closed: "Results are shown to everyone.",
  confirmStop: "End voting and show results to everyone?",
  confirmClear: "Clear every vote and the results? Voting turns off.",
  confirmRestart: "Start a new round? Every dot from this round is cleared.",
} as const;

export const HOST_VOTE_HINTS = {
  offline: "Not connected.",
  busy: CLEAR_HINTS.busy,
  clearing: CLEAR_HINTS.clearing,
  notOpen: "Voting isn’t open.",
  nothing: "There are no votes to clear.",
} as const;

/** Why each host voting command is off (null: on). A run in progress (a template, a restore, a clear) blocks them all. */
export function hostVoteReasons(s: { live: boolean; busy: boolean; clearing: boolean; state: VotingState["state"] }): {
  start: string | null;
  stop: string | null;
  clear: string | null;
} {
  const shared = !s.live ? HOST_VOTE_HINTS.offline : s.clearing ? HOST_VOTE_HINTS.clearing : s.busy ? HOST_VOTE_HINTS.busy : null;
  return {
    start: shared,
    stop: shared ?? (s.state !== "open" ? HOST_VOTE_HINTS.notOpen : null),
    clear: shared ?? (s.state === "off" ? HOST_VOTE_HINTS.nothing : null),
  };
}

/* ── Results ───────────────────────────────────────────────────── */

export interface ResultRow {
  noteId: string;
  /** The note's first line, plain text (untrusted: rendered as text only). */
  title: string;
  count: number;
  /** Tied for the most dots. */
  top: boolean;
}

/** Totals sorted by count, most first; ties keep the relay's order (note creation order). Notes no longer here are left out. */
export function resultRows(results: readonly { noteId: string; count: number }[], notes: readonly { id: string; text: string }[]): ResultRow[] {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const here = results.filter((r) => r.count > 0 && byId.has(r.noteId));
  const most = here.reduce((m, r) => Math.max(m, r.count), 0);
  return here
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.count - a.r.count || a.i - b.i)
    .map(({ r }) => ({ noteId: r.noteId, title: noteTitle(byId.get(r.noteId)!.text), count: r.count, top: r.count === most }));
}

/** A note's title line for lists (trimmed; "Untitled note" when empty). */
export function noteTitle(text: string): string {
  const title = splitTitleBody(text).title.trim();
  return title === "" ? VOTE_TEXT.untitled : title;
}

/** Totals by note and the highest, for the badges on the notes (cached per results array). */
const totalsCache = new WeakMap<readonly { noteId: string; count: number }[], { byId: Map<string, number>; most: number }>();
export function totalsOf(results: readonly { noteId: string; count: number }[]): { byId: Map<string, number>; most: number } {
  let t = totalsCache.get(results);
  if (!t) {
    const byId = new Map(results.filter((r) => r.count > 0).map((r) => [r.noteId, r.count]));
    t = { byId, most: Math.max(0, ...byId.values()) };
    totalsCache.set(results, t);
  }
  return t;
}

/** What a note's badges say to a screen reader (added to the note's name). */
export function voteLabel(s: { mine: number; total: number | null; top: boolean }): string {
  const parts: string[] = [];
  if (s.mine > 0) parts.push(`Your dots: ${s.mine}.`);
  if (s.total !== null && s.total > 0) parts.push(`Total: ${s.total}${s.top ? `, ${VOTE_TEXT.topVoted.toLowerCase()}` : ""}.`);
  return parts.join(" ");
}

export const dotsWord = (n: number) => `${n} ${n === 1 ? "dot" : "dots"}`;
