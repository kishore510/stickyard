import type { CSSProperties } from "react";
import type { FrameColor } from "@stickyard/shared";

/*
 * Frame colour keys (protocol v9) -> design tokens (tokens.css: --sy-frame-<key>-fill, -border,
 * -header, in both themes; --sy-frame-title for the title on every header, 4.5:1 tested).
 * Only var() references here, never colour values.
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

/** The header strip the title sits on. */
export function frameHeaderStyle(color: FrameColor): CSSProperties {
  return { backgroundColor: `var(--sy-frame-${color}-header)`, color: "var(--sy-frame-title)" };
}

/** A swatch for the colour (Properties): the header colour with the border around it. */
export function frameSwatchStyle(color: FrameColor): CSSProperties {
  return { backgroundColor: `var(--sy-frame-${color}-header)`, borderColor: `var(--sy-frame-${color}-border)` };
}

/** The minimap draws frames in their border colour. */
export const frameMinimapColour = (color: FrameColor) => `var(--sy-frame-${color}-border)`;
