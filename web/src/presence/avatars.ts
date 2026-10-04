import type { Participant } from "@stickyard/shared";

/*
 * The top bar's avatar stack (md and up) and the people count (pure). Names are untrusted: only
 * ever plain text. Colour is never the only cue: the Participants sheet names everyone.
 */

/** Places in the stack; with more people the last place is "+N". */
export const AVATAR_MAX = 4;
/** Names in toasts are cut to this many characters. */
export const NAME_MAX_SHOWN = 16;

export interface StackedAvatar {
  participant: Participant;
  you: boolean;
}

/** You first, then everyone else in the order they arrived; past AVATAR_MAX, the last place is "+overflow". */
export function avatarStack(participants: readonly Participant[], youId: string | null, max: number = AVATAR_MAX): { shown: StackedAvatar[]; overflow: number } {
  const you = participants.filter((p) => p.id === youId);
  const ordered = [...you, ...participants.filter((p) => p.id !== youId)];
  const room = ordered.length <= max ? ordered.length : max - 1;
  return { shown: ordered.slice(0, room).map((participant) => ({ participant, you: participant.id === youId })), overflow: ordered.length - room };
}

/** One or two whole characters: the first letters of the first two words (upper case where that applies). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => w !== "");
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0] ?? "");
  const text = letters.join("").toLocaleUpperCase();
  return text === "" ? "?" : text;
}

/** A name cut to `max` whole characters, with an ellipsis when cut. */
export function truncateName(name: string, max: number = NAME_MAX_SHOWN): string {
  const chars = Array.from(name);
  return chars.length <= max ? name : `${chars.slice(0, max - 1).join("")}…`;
}

/** The Participants button's accessible name: how many people are here (null: not connected). */
export function peopleLabel(count: number | null): string {
  if (count === null) return "Participants";
  return `Participants: ${count} ${count === 1 ? "person" : "people"} in this session`;
}
