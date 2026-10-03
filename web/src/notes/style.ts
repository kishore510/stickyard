import type { Note, NoteAlign, NoteFontSize, NoteTextColor } from "@stickyard/shared";

/*
 * Note text style: the protocol sends keys; each maps to a design token (tokens.css) through a
 * token-backed utility class, spelled out in full so Tailwind generates each one. The title
 * (first line) and the body (the rest) each have their own style, applied to the whole part
 * (plain text, never inline markup). Text colours have values in both themes
 * and stay readable on every note colour (test/noteStyle.test.ts checks).
 */

export const fontSizeToken = (key: NoteFontSize) => `--sy-note-font-${key}`;
/** "auto" is the note's usual foreground. */
export const textColorToken = (key: NoteTextColor) => (key === "auto" ? "--sy-note-fg" : `--sy-note-text-${key}`);

export const NOTE_FONT_SIZE_CLASSES: Record<NoteFontSize, string> = {
  s: "text-note-s",
  m: "text-note-m",
  l: "text-note-l",
  xl: "text-note-xl",
};

export const NOTE_FONT_SIZE_NAMES: Record<NoteFontSize, string> = {
  s: "Small",
  m: "Medium",
  l: "Large",
  xl: "Extra large",
};

export const NOTE_TEXT_COLOR_CLASSES: Record<NoteTextColor, string> = {
  auto: "text-note-fg",
  red: "text-note-text-red",
  orange: "text-note-text-orange",
  green: "text-note-text-green",
  blue: "text-note-text-blue",
  purple: "text-note-text-purple",
  grey: "text-note-text-grey",
};

/** Swatch fills: the same tokens as backgrounds. */
export const NOTE_TEXT_COLOR_SWATCHES: Record<NoteTextColor, string> = {
  auto: "bg-note-fg",
  red: "bg-note-text-red",
  orange: "bg-note-text-orange",
  green: "bg-note-text-green",
  blue: "bg-note-text-blue",
  purple: "bg-note-text-purple",
  grey: "bg-note-text-grey",
};

export const NOTE_TEXT_COLOR_NAMES: Record<NoteTextColor, string> = {
  auto: "Auto",
  red: "Red",
  orange: "Orange",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  grey: "Grey",
};

export const NOTE_ALIGN_CLASSES: Record<NoteAlign, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

export const NOTE_ALIGN_NAMES: Record<NoteAlign, string> = {
  left: "Align left",
  center: "Align centre",
  right: "Align right",
};

/** Accessible names for the title's and body's alignment buttons. */
export function alignLabel(part: "title" | "body", key: NoteAlign): string {
  return `Align ${part} ${key === "center" ? "centre" : key}`;
}

/** A note's two text parts: the title (first line) and the body (the rest). */
export const NOTE_PARTS = ["title", "body"] as const;
export type NotePart = (typeof NOTE_PARTS)[number];

/** One part's text style. */
export interface PartStyle {
  fontSize: NoteFontSize;
  bold: boolean;
  italic: boolean;
  textColor: NoteTextColor;
  align: NoteAlign;
}

/** The note fields that hold each part's style (the body's keep their v4 names). */
export const PART_FIELDS = {
  title: { fontSize: "titleFontSize", bold: "titleBold", italic: "titleItalic", textColor: "titleTextColor", align: "titleAlign" },
  body: { fontSize: "fontSize", bold: "bold", italic: "italic", textColor: "textColor", align: "align" },
} as const satisfies Record<NotePart, Record<keyof PartStyle, keyof Note>>;

export function partStyle(note: Note, part: NotePart): PartStyle {
  const f = PART_FIELDS[part];
  return { fontSize: note[f.fontSize], bold: note[f.bold], italic: note[f.italic], textColor: note[f.textColor], align: note[f.align] };
}

/** The utility classes one part renders with: size, ink, alignment, then weight and slant if set. */
export function partTextClasses(note: Note, part: NotePart): string[] {
  const s = partStyle(note, part);
  return [
    NOTE_FONT_SIZE_CLASSES[s.fontSize],
    NOTE_TEXT_COLOR_CLASSES[s.textColor],
    NOTE_ALIGN_CLASSES[s.align],
    ...(s.bold ? ["font-bold"] : []),
    ...(s.italic ? ["italic"] : []),
  ];
}
