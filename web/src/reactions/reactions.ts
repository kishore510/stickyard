import { MAX_REACTIONS_PER_REACTOR, MAX_REACTIONS_PER_ROOM, REACTION_KEYS, type ReactionKey } from "@stickyard/shared";

/*
 * Reactions on notes (v0.34.0, web only, on the protocol v20 plumbing). Pure rules and texts,
 * so they're tested: the one key-to-emoji map, the store's counts per note and key and my own
 * set per note and key, what's shown while my sets wait for the relay, the chips' names, what's
 * announced, the refusal notices and when low zoom collapses the chips. The relay sends keys,
 * never emoji; a key is never shown as text. Counts are everyone's; who reacted is never known
 * here, only which reactions are mine.
 */

/** The one place keys become emoji and names. In REACTION_KEYS order. */
export const REACTIONS: { readonly [K in ReactionKey]: { readonly emoji: string; readonly name: string } } = {
  thumbs_up: { emoji: "👍", name: "Thumbs up" },
  heart: { emoji: "❤️", name: "Heart" },
  laugh: { emoji: "😂", name: "Laugh" },
  celebrate: { emoji: "🎉", name: "Celebrate" },
  thinking: { emoji: "🤔", name: "Thinking" },
  plus: { emoji: "➕", name: "Plus one" },
};

const KEYS: ReadonlySet<string> = new Set(REACTION_KEYS);
export const isReactionKey = (key: string): key is ReactionKey => KEYS.has(key);

/** Every note's non-zero counts by key. Unchanged notes keep their inner map (notes don't re-render). */
export type ReactionCounts = ReadonlyMap<string, ReadonlyMap<ReactionKey, number>>;
/** My own reactions by note. */
export type MyReactions = ReadonlyMap<string, ReadonlySet<ReactionKey>>;
/** A reactionSet sent and not answered yet. */
export interface PendingReaction {
  key: ReactionKey;
  on: boolean;
}

export const NO_COUNTS: ReactionCounts = new Map();
export const NO_MINE: MyReactions = new Map();

/** reactionsSnapshot: replaces every count (never merges). Unknown notes and keys, and counts below 1, are skipped. */
export function countsFromSnapshot(entries: readonly { noteId: string; key: string; count: number }[], known: (id: string) => boolean): ReactionCounts {
  const out = new Map<string, Map<ReactionKey, number>>();
  for (const { noteId, key, count } of entries) {
    if (!isReactionKey(key) || !known(noteId) || !(count > 0)) continue;
    const keys = out.get(noteId) ?? new Map<ReactionKey, number>();
    keys.set(key, count);
    out.set(noteId, keys);
  }
  return out;
}

/** reactionCount: one note's count for one key (0 or less removes it). The same object when nothing changes. */
export function withCount(counts: ReactionCounts, noteId: string, key: string, count: number): ReactionCounts {
  if (!isReactionKey(key)) return counts;
  const next = Math.max(0, count);
  const keys = counts.get(noteId);
  if ((keys?.get(key) ?? 0) === next) return counts;
  const changed = new Map(keys);
  if (next > 0) changed.set(key, next);
  else changed.delete(key);
  const out = new Map(counts);
  if (changed.size > 0) out.set(noteId, changed);
  else out.delete(noteId);
  return out;
}

/** voterGranted.reactions: my whole set (replaces). Unknown notes and keys are skipped. */
export function mineFromGrant(list: readonly { noteId: string; key: string }[], known: (id: string) => boolean): MyReactions {
  let out: MyReactions = new Map();
  for (const { noteId, key } of list) if (known(noteId)) out = withMine(out, noteId, key, true);
  return out;
}

/** reactionMine: one of mine on or off. The same object when nothing changes. */
export function withMine(mine: MyReactions, noteId: string, key: string, on: boolean): MyReactions {
  if (!isReactionKey(key)) return mine;
  const keys = mine.get(noteId);
  if ((keys?.has(key) ?? false) === on) return mine;
  const changed = new Set(keys);
  if (on) changed.add(key);
  else changed.delete(key);
  const out = new Map(mine);
  if (changed.size > 0) out.set(noteId, changed);
  else out.delete(noteId);
  return out;
}

/** Only the notes still here (a delete, a resync). The same object when none went. */
export function keepNotes<T>(map: ReadonlyMap<string, T>, here: (id: string) => boolean): ReadonlyMap<string, T> {
  if ([...map.keys()].every(here)) return map;
  return new Map([...map].filter(([id]) => here(id)));
}

/**
 * What's shown: the relay's counts and my set, with my sets still waiting on top (the last one
 * per key wins). A waiting on that the relay doesn't have yet adds one; a waiting off takes one
 * away, never below 0. Without waiting sets, the relay's own objects.
 */
export function shownReactions(
  counts: ReactionCounts,
  mine: MyReactions,
  pending: ReadonlyMap<string, readonly PendingReaction[]>,
): { counts: ReactionCounts; mine: MyReactions } {
  let shownCounts = counts;
  let shownMine = mine;
  for (const [noteId, sets] of pending) {
    const last = new Map<ReactionKey, boolean>();
    for (const { key, on } of sets) last.set(key, on);
    for (const [key, on] of last) {
      const was = mine.get(noteId)?.has(key) ?? false;
      if (was === on) continue;
      shownMine = withMine(shownMine, noteId, key, on);
      shownCounts = withCount(shownCounts, noteId, key, (counts.get(noteId)?.get(key) ?? 0) + (on ? 1 : -1));
    }
  }
  return { counts: shownCounts, mine: shownMine };
}

/** One chip: a key with a count above 0. */
export interface Chip {
  key: ReactionKey;
  count: number;
  mine: boolean;
}

/** A note's chips, in REACTION_KEYS order. */
export function chipsOf(counts: ReadonlyMap<ReactionKey, number> | undefined, mine: ReadonlySet<ReactionKey> | undefined): Chip[] {
  if (!counts) return [];
  return REACTION_KEYS.flatMap((key) => {
    const count = counts.get(key) ?? 0;
    return count > 0 ? [{ key, count, mine: mine?.has(key) ?? false }] : [];
  });
}

export const REACTION_TEXT = {
  add: "Add reaction",
  picker: "Choose a reaction",
  section: "Reactions",
  /** The phone editor and Properties: what reactions are, in one line. */
  hint: "Everyone sees how many; nobody sees who.",
} as const;

/** A chip's accessible name: "Thumbs up, 3, you reacted. Press to remove." */
export function chipLabel(key: ReactionKey, count: number, mine: boolean): string {
  const { name } = REACTIONS[key];
  return mine ? `${name}, ${count}, you reacted. Press to remove.` : `${name}, ${count}. Press to add yours.`;
}

/** Added to the note's accessible name: "Reactions: Thumbs up 3, Heart 1." ("" when none). */
export function reactionsLabel(chips: readonly Chip[]): string {
  if (chips.length === 0) return "";
  return `Reactions: ${chips.map((c) => `${REACTIONS[c.key].name} ${c.count}`).join(", ")}.`;
}

/** What the polite announcer says after my own action (never anyone else's). */
export function reactionAnnouncement(key: ReactionKey, on: boolean): string {
  const { name } = REACTIONS[key];
  return on ? `You reacted with ${name}.` : `You removed your ${name} reaction.`;
}

/** Short, calm notices for a reaction that wasn't saved (the chip has already gone back). */
export const REACTION_NOTICES = {
  no_voter: "Your reaction wasn’t saved. Rejoin the session to react.",
  reactions_full: `This board has its most reactions (${MAX_REACTIONS_PER_ROOM}), so yours wasn’t added.`,
  reactor_full: `You’ve used all your reactions (${MAX_REACTIONS_PER_REACTOR}). Remove one to add another.`,
  rate_limited: "That was a little quick, so your reaction wasn’t saved. Try again.",
  unknown_note: "That note isn’t on the board any more, so your reaction wasn’t saved.",
  offline: "You’re not connected, so your reaction wasn’t saved.",
} as const;

export type ReactionRefusal = Exclude<keyof typeof REACTION_NOTICES, "offline">;
const REFUSALS: ReadonlySet<string> = new Set<ReactionRefusal>(["no_voter", "reactions_full", "reactor_full", "rate_limited", "unknown_note"]);
export const isReactionRefusal = (code: string): code is ReactionRefusal => REFUSALS.has(code);

/**
 * Low zoom: at REACTION_FULL_ZOOM and above, the chips and Add reaction; down to
 * REACTION_SUMMARY_ZOOM, one quiet summary (a few emoji and the total, not a control); below it,
 * nothing, so a zoomed-out board stays readable. The note's accessible name keeps the counts.
 */
export const REACTION_FULL_ZOOM = 0.5;
export const REACTION_SUMMARY_ZOOM = 0.25;
export type ReactionMode = "full" | "summary" | "none";
export const reactionMode = (zoom: number): ReactionMode => (zoom >= REACTION_FULL_ZOOM ? "full" : zoom >= REACTION_SUMMARY_ZOOM ? "summary" : "none");

/** The summary at middle zoom: the most-used emoji (up to SUMMARY_EMOJI, ties in key order) and the total. */
export const SUMMARY_EMOJI = 3;
export function summaryOf(chips: readonly Chip[]): { emoji: string[]; total: number } {
  const top = [...chips].sort((a, b) => b.count - a.count).slice(0, SUMMARY_EMOJI);
  return { emoji: top.map((c) => REACTIONS[c.key].emoji), total: chips.reduce((s, c) => s + c.count, 0) };
}
