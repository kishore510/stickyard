import { MAX_NAME_LENGTH, MAX_TEXT_LENGTH } from "./protocol";

/*
 * Cleaning for untrusted display text (names and echoed messages). Both sides use it:
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
