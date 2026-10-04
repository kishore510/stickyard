import { MAX_FRAME_TITLE, MAX_NAME_LENGTH, MAX_NOTE_TEXT, MAX_TEXT_LENGTH } from "./protocol";

/*
 * Cleaning for untrusted display text (names, echoed messages and note text). Both sides use it:
 * the server is the authority, the client cleans first only to give quicker feedback.
 */

/**
 * Invisible characters that can hide or reorder text: zero-width space/joiners, word joiner
 * and invisible operators, BOM, soft hyphen, Mongolian vowel separator, bidi embeddings,
 * overrides, isolates and marks.
 */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿؜]/g;
/** C0 and C1 controls and DEL. Whitespace controls are turned into spaces before this runs. */
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;
const WHITESPACE = /\s+/g;

/** Length in Unicode code points ("characters"), not UTF-16 units. */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

function clean(raw: string, maxLength: number): string | null {
  const value = raw.replace(INVISIBLE, "").replace(WHITESPACE, " ").replace(CONTROLS, "").replace(WHITESPACE, " ").trim();
  if (value.length === 0 || codePointLength(value) > maxLength) return null;
  return value;
}

/** Trim, collapse whitespace, strip controls and invisible characters; 1..MAX_NAME_LENGTH characters, else null. */
export function cleanName(raw: string): string | null {
  return clean(raw, MAX_NAME_LENGTH);
}

/** Same cleaning as names; 1..MAX_TEXT_LENGTH characters, else null. */
export function cleanText(raw: string): string | null {
  return clean(raw, MAX_TEXT_LENGTH);
}

/** Line breaks in any form become "\n"; other whitespace controls become spaces. */
const LINE_BREAKS = /\r\n?|[\u0085\u2028\u2029]/g;
const SPACE_CONTROLS = /[\t\v\f]/g;
/** CONTROLS without "\n". */
const CONTROLS_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

/**
 * Note text: like messages, but keeps line breaks and inner spacing. Trimmed; may be empty.
 * Null if longer than MAX_NOTE_TEXT characters after cleaning.
 */
export function cleanNoteText(raw: string): string | null {
  const value = raw
    .replace(LINE_BREAKS, "\n")
    .replace(SPACE_CONTROLS, " ")
    .replace(INVISIBLE, "")
    .replace(CONTROLS_EXCEPT_NEWLINE, "")
    .trim();
  return codePointLength(value) > MAX_NOTE_TEXT ? null : value;
}

/**
 * A frame title: one line (line breaks and other whitespace collapse to single spaces), controls
 * and invisible characters removed, trimmed. May be empty. Null if longer than MAX_FRAME_TITLE
 * characters after cleaning.
 */
export function cleanFrameTitle(raw: string): string | null {
  const value = raw.replace(INVISIBLE, "").replace(WHITESPACE, " ").replace(CONTROLS, "").replace(WHITESPACE, " ").trim();
  return codePointLength(value) > MAX_FRAME_TITLE ? null : value;
}
