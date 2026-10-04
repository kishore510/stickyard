import type { CSSProperties } from "react";
import { NOTE_TEXT_COLORS, type Frame, type FrameColor, type NoteFontSize, type NoteTextColor } from "@stickyard/shared";
import { NOTE_ALIGN_CLASSES, NOTE_FONT_SIZE_CLASSES, type PartStyle } from "../notes/style";

/*
 * Frame colour keys (protocol v9) -> design tokens (tokens.css: --sy-frame-<key>-fill, -border,
 * -header, in both themes; --sy-frame-title for the title on every header, 4.5:1 tested).
 * Title style keys (v10) reuse the note sizes and alignments; inks are frame-only tokens
 * (--sy-frame-text-<ink>), since frame headers are dark in the dark theme and notes aren't.
 * Only var() references and token utilities here, never colour values or sizes.
 */

export const FRAME_COLOR_NAMES: Record<FrameColor, string> = {
  neutral: "Neutral",
  yellow: "Yellow",
  pink: "Pink",
  blue: "Blue",
  green: "Green",
  orange: "Orange",
  purple: "Purple",
};

/** The frame's body: its translucent fill and border colour. */
export function frameColourStyle(color: FrameColor): CSSProperties {
  return { backgroundColor: `var(--sy-frame-${color}-fill)`, borderColor: `var(--sy-frame-${color}-border)` };
}

/** "auto" is the usual frame title colour. */
export const frameInkToken = (key: NoteTextColor) => (key === "auto" ? "--sy-frame-title" : `--sy-frame-text-${key}`);

/** The header strip's height for a title size. */
export const frameHeaderHeightToken = (key: NoteFontSize) => `--sy-frame-header-${key}`;

/**
 * The frame's root: its colours, and the header height for its title size. Setting
 * --sy-frame-header-h here makes the header (h-frame-header) and the side strips below it
 * (top-frame-header) follow, since the utilities read that variable directly.
 */
export function frameRootStyle(frame: Pick<Frame, "color" | "titleFontSize">): CSSProperties {
  return { ...frameColourStyle(frame.color), ["--sy-frame-header-h" as string]: `var(${frameHeaderHeightToken(frame.titleFontSize)})` };
}

/** The header strip the title sits on, in the title's ink. */
export function frameHeaderStyle(frame: Pick<Frame, "color" | "titleTextColor">): CSSProperties {
  return { backgroundColor: `var(--sy-frame-${frame.color}-header)`, color: `var(${frameInkToken(frame.titleTextColor)})` };
}

/** The title as a text part style (for the shared Title text fields). */
export function frameTitleStyle(frame: Frame): PartStyle {
  return { fontSize: frame.titleFontSize, bold: frame.titleBold, italic: frame.titleItalic, textColor: frame.titleTextColor, align: frame.titleAlign };
}

/**
 * The title's utility classes: size, alignment, weight, then slant if set. Bold is semibold (the
 * v9 header's weight, a little lighter than a note's bold); not bold is normal weight.
 */
export function frameTitleClasses(frame: Frame): string[] {
  return [
    NOTE_FONT_SIZE_CLASSES[frame.titleFontSize],
    NOTE_ALIGN_CLASSES[frame.titleAlign],
    frame.titleBold ? "font-semibold" : "font-normal",
    ...(frame.titleItalic ? ["italic"] : []),
  ];
}

/** Ink swatches (Properties): the frame ink tokens, so they show the current theme's value. */
export const FRAME_INK_SWATCHES = Object.fromEntries(
  NOTE_TEXT_COLORS.map((key) => [key, { backgroundColor: `var(${frameInkToken(key)})` }]),
) as Record<NoteTextColor, CSSProperties>;

/** A swatch for the colour (Properties): the header colour with the border around it. */
export function frameSwatchStyle(color: FrameColor): CSSProperties {
  return { backgroundColor: `var(--sy-frame-${color}-header)`, borderColor: `var(--sy-frame-${color}-border)` };
}

/** The minimap draws frames in their border colour. */
export const frameMinimapColour = (color: FrameColor) => `var(--sy-frame-${color}-border)`;
