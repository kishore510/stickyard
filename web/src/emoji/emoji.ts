import { codePointLength } from "@stickyard/shared";

/*
 * A small built-in emoji set for typing into notes, shapes and frame titles (web only, no
 * library). Each is one code point with emoji presentation, so it counts as one character
 * against the text caps. Names are their accessible labels.
 */

export interface Emoji {
  char: string;
  name: string;
}

export const EMOJI: readonly Emoji[] = [
  { char: "😀", name: "Grinning face" },
  { char: "😂", name: "Face with tears of joy" },
  { char: "🙂", name: "Slightly smiling face" },
  { char: "😉", name: "Winking face" },
  { char: "😍", name: "Smiling face with heart eyes" },
  { char: "🤔", name: "Thinking face" },
  { char: "😮", name: "Face with open mouth" },
  { char: "😢", name: "Crying face" },
  { char: "😡", name: "Pouting face" },
  { char: "😴", name: "Sleeping face" },
  { char: "🤯", name: "Exploding head" },
  { char: "🥳", name: "Partying face" },
  { char: "😎", name: "Smiling face with sunglasses" },
  { char: "🙌", name: "Raising hands" },
  { char: "👏", name: "Clapping hands" },
  { char: "👍", name: "Thumbs up" },
  { char: "👎", name: "Thumbs down" },
  { char: "👋", name: "Waving hand" },
  { char: "🙏", name: "Folded hands" },
  { char: "💪", name: "Flexed biceps" },
  { char: "👀", name: "Eyes" },
  { char: "🎉", name: "Party popper" },
  { char: "🎯", name: "Bullseye" },
  { char: "🚀", name: "Rocket" },
  { char: "💡", name: "Light bulb" },
  { char: "🔥", name: "Fire" },
  { char: "⭐", name: "Star" },
  { char: "✅", name: "Check mark" },
  { char: "❌", name: "Cross mark" },
  { char: "❓", name: "Question mark" },
  { char: "❗", name: "Exclamation mark" },
  { char: "⚡", name: "High voltage" },
  { char: "💬", name: "Speech balloon" },
  { char: "📌", name: "Pushpin" },
  { char: "📎", name: "Paperclip" },
  { char: "📅", name: "Calendar" },
  { char: "⏰", name: "Alarm clock" },
  { char: "🔒", name: "Locked" },
  { char: "🔑", name: "Key" },
  { char: "🏁", name: "Chequered flag" },
  { char: "📈", name: "Chart going up" },
  { char: "📉", name: "Chart going down" },
  { char: "🐛", name: "Bug" },
  { char: "🧩", name: "Puzzle piece" },
  { char: "💯", name: "Hundred points" },
  { char: "🌱", name: "Seedling" },
  { char: "☕", name: "Hot drink" },
  { char: "🌈", name: "Rainbow" },
];

/** Buttons per row in the picker (arrow keys move by this much up and down). */
export const EMOJI_COLUMNS = 8;

/**
 * Inserts `emoji` into `value` at the selection (replacing it). `fits` decides whether the result
 * is allowed (the caller's cap, e.g. a note's title and body together). Null when it doesn't fit.
 */
export function insertEmoji(
  value: string,
  start: number,
  end: number,
  emoji: string,
  fits: (next: string) => boolean,
): { value: string; caret: number } | null {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  const next = value.slice(0, from) + emoji + value.slice(to);
  if (!fits(next)) return null;
  return { value: next, caret: from + emoji.length };
}

/** A cap check by characters (code points), as the relay counts them. */
export const withinChars = (max: number) => (next: string) => codePointLength(next) <= max;

/** The arrow-key move inside the picker's grid: the index to focus next. */
export function emojiKeyMove(index: number, key: string, count: number = EMOJI.length, columns: number = EMOJI_COLUMNS): number | null {
  switch (key) {
    case "ArrowRight":
      return Math.min(count - 1, index + 1);
    case "ArrowLeft":
      return Math.max(0, index - 1);
    case "ArrowDown":
      return index + columns < count ? index + columns : index;
    case "ArrowUp":
      return index - columns >= 0 ? index - columns : index;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Shown in the picker when an emoji would take the text past its cap (nothing is inserted). */
export const EMOJI_FULL = "No room for another character.";

/** The grid's columns as laid out (buttons sharing the first one's row), or EMOJI_COLUMNS without layout. */
export function laidOutColumns(tops: readonly number[]): number {
  const first = tops[0];
  if (first === undefined) return EMOJI_COLUMNS;
  const row = tops.findIndex((t) => t !== first);
  return row === -1 ? EMOJI_COLUMNS : row;
}
