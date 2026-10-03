import type { NoteColor } from "@stickyard/shared";

/*
 * Note colours: the protocol sends palette keys; each maps to a design token
 * (--sy-note-<key>, light and dark). Spelled out in full so Tailwind generates each class.
 * Colour is never the only cue: notes are labelled with their colour name too.
 */
export const NOTE_COLOR_CLASSES: Record<NoteColor, string> = {
  yellow: "bg-note-yellow",
  pink: "bg-note-pink",
  blue: "bg-note-blue",
  green: "bg-note-green",
  orange: "bg-note-orange",
  purple: "bg-note-purple",
};

export const NOTE_COLOR_NAMES: Record<NoteColor, string> = {
  yellow: "Yellow",
  pink: "Pink",
  blue: "Blue",
  green: "Green",
  orange: "Orange",
  purple: "Purple",
};
