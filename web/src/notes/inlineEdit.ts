import { MAX_NOTE_TEXT, cleanNoteText, codePointLength } from "@stickyard/shared";
import { joinTitleBody } from "./titleBody";

/*
 * Editing a note in place (md and up): two plain textareas, the title (one line) and the body.
 * Pure helpers for the keys, the 280-character cap across both parts, and paste.
 */

export type InlinePart = "title" | "body";

/** Helper text shown in an empty part while editing. Placeholder only: never note text. */
export const INLINE_PLACEHOLDERS: Record<InlinePart, string> = { title: "Type a title", body: "Type body" };

/** The placeholder's ink: the note's foreground at this opacity (faint, still 3:1; test/noteStyle.test.ts). */
export const PLACEHOLDER_ALPHA = 0.6;
export const PLACEHOLDER_CLASS = "placeholder:text-note-fg/60";

/**
 * What a key does while editing in place. "title"/"body": move there; "commit": save and stop;
 * "stay": swallow the key (Tab with nowhere to go); null: the textarea's own behaviour.
 * The title is one line, so Enter and Shift+Enter there move on to the body.
 */
export function inlineKeyAction(
  part: InlinePart,
  e: { key: string; shiftKey: boolean; isComposing: boolean },
): InlinePart | "commit" | "stay" | null {
  if (e.isComposing) return null;
  if (e.key === "Escape") return "commit";
  if (e.key === "Tab") {
    if (part === "title") return e.shiftKey ? "stay" : "body";
    return e.shiftKey ? "title" : "stay";
  }
  if (e.key !== "Enter") return null;
  if (part === "title") return "body";
  return e.shiftKey ? null : "commit";
}

/** Whether a title and body fit the note text cap together (as stored: title, line break, body). */
export function fitsCap(title: string, body: string): boolean {
  return codePointLength(joinTitleBody(title, body)) <= MAX_NOTE_TEXT;
}

/** The title is one line: line breaks (typed, dropped or pasted) become spaces. */
export function titleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

/**
 * Pastes plain text into one part at its selection: cleaned like note text (control and
 * invisible characters dropped), one line in the title, and cut to what still fits the cap.
 */
export function pasteInto({
  value,
  start,
  end,
  pasted,
  part,
  other,
}: {
  value: string;
  start: number;
  end: number;
  pasted: string;
  part: InlinePart;
  /** The other part's text. */
  other: string;
}): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const raw = [...pasted].slice(0, MAX_NOTE_TEXT).join("");
  const cleaned = cleanNoteText(raw) ?? "";
  let insert = [...(part === "title" ? titleLine(cleaned) : cleaned)];
  const join = (s: string) => (part === "title" ? joinTitleBody(s, other) : joinTitleBody(other, s));
  while (insert.length > 0 && codePointLength(join(before + insert.join("") + after)) > MAX_NOTE_TEXT) insert = insert.slice(0, -1);
  const text = insert.join("");
  return { value: before + text + after, caret: before.length + text.length };
}
