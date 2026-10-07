import type { CSSProperties } from "react";
import {
  NOTE_TEXT_COLORS,
  type NoteAlign,
  type NoteTextColor,
  type Shape,
  type ShapeFill,
  type ShapeFontSize,
  type ShapeKind,
  type ShapeStroke,
  type ShapeStrokeStyle,
  type ShapeStrokeWidth,
  type ShapeValign,
} from "@stickyard/shared";

/*
 * Shape style keys (protocol v15) -> design tokens (tokens.css --sy-shape-*, both themes). Only
 * var() references here, never colour values or sizes. Fills, borders and inks have their own
 * tokens; "auto" ink is --sy-shape-fg, 4.5:1 on every fill and on the board (tested).
 */

export const SHAPE_KIND_NAMES: Record<ShapeKind, string> = { text: "Text", rect: "Rectangle", oval: "Oval", diamond: "Diamond" };

export const SHAPE_FILL_NAMES: Record<ShapeFill, string> = {
  none: "No fill",
  neutral: "Neutral",
  yellow: "Yellow",
  pink: "Pink",
  blue: "Blue",
  green: "Green",
  orange: "Orange",
  purple: "Purple",
};

export const SHAPE_STROKE_WIDTH_NAMES: Record<ShapeStrokeWidth, string> = { none: "No border", thin: "Thin", medium: "Medium", thick: "Thick" };
export const SHAPE_STROKE_STYLE_NAMES: Record<ShapeStrokeStyle, string> = { solid: "Solid", dashed: "Dashed" };
export const SHAPE_FONT_SIZE_NAMES: Record<ShapeFontSize, string> = {
  s: "Small",
  m: "Medium",
  l: "Large",
  xl: "Extra large",
  "2xl": "Heading 3",
  "3xl": "Heading 2",
  "4xl": "Heading 1",
};
export const SHAPE_VALIGN_NAMES: Record<ShapeValign, string> = { top: "Top", middle: "Middle", bottom: "Bottom" };

export const shapeFontToken = (key: ShapeFontSize) => `--sy-shape-font-${key}`;
export const shapeInkToken = (key: NoteTextColor) => (key === "auto" ? "--sy-shape-fg" : `--sy-shape-text-${key}`);
/** null for "none": the board shows through. */
export const shapeFillToken = (key: ShapeFill) => (key === "none" ? null : `--sy-shape-${key}-fill`);
export const shapeStrokeToken = (key: ShapeStroke) => `--sy-shape-${key}-stroke`;
/** null for "none": no border. */
export const shapeStrokeWidthToken = (key: ShapeStrokeWidth) => (key === "none" ? null : `--sy-shape-stroke-${key}`);

/** Fill and border for the SVG outline (style properties, so var() works). */
export function shapeOutlineStyle(shape: Pick<Shape, "fill" | "stroke" | "strokeWidth" | "strokeStyle">): CSSProperties {
  const fill = shapeFillToken(shape.fill);
  const width = shapeStrokeWidthToken(shape.strokeWidth);
  return {
    fill: fill ? `var(${fill})` : "none",
    stroke: width ? `var(${shapeStrokeToken(shape.stroke)})` : "none",
    strokeWidth: width ? `var(${width})` : 0,
    ...(width && shape.strokeStyle === "dashed" ? { strokeDasharray: "var(--sy-shape-dash)" } : {}),
  };
}

const JUSTIFY: Record<ShapeValign, string> = { top: "flex-start", middle: "center", bottom: "flex-end" };
const TEXT_ALIGN: Record<NoteAlign, "left" | "center" | "right"> = { left: "left", center: "center", right: "right" };

/** Where the text area sits inside the shape (so text stays within an oval's or diamond's outline). */
export function shapeTextBoxStyle(kind: ShapeKind): CSSProperties {
  const inset = kind === "oval" ? "var(--sy-shape-inset-oval)" : kind === "diamond" ? "var(--sy-shape-inset-diamond)" : "0";
  return { position: "absolute", inset, padding: "var(--sy-shape-pad)", display: "flex", flexDirection: "column" };
}

/** The vertical placement of the text in its area. */
export const shapeValignStyle = (valign: ShapeValign): CSSProperties => ({ justifyContent: JUSTIFY[valign] });

/** The text itself: size, ink, alignment, weight, slant and underline. Inter only (the app's font). */
export function shapeTextStyle(shape: Pick<Shape, "fontSize" | "textColor" | "align" | "bold" | "italic" | "underline">): CSSProperties {
  return {
    fontSize: `var(${shapeFontToken(shape.fontSize)})`,
    lineHeight: 1.25,
    color: `var(${shapeInkToken(shape.textColor)})`,
    textAlign: TEXT_ALIGN[shape.align],
    fontWeight: shape.bold ? 700 : 400,
    fontStyle: shape.italic ? "italic" : "normal",
    textDecorationLine: shape.underline ? "underline" : "none",
  };
}

/** Ink swatches (Properties): the shape ink tokens, so they show the current theme's value. */
export const SHAPE_INK_SWATCHES = Object.fromEntries(NOTE_TEXT_COLORS.map((key) => [key, { backgroundColor: `var(${shapeInkToken(key)})` }])) as Record<
  NoteTextColor,
  CSSProperties
>;

/** A fill swatch: the fill (or the board, crossed out by its border, for none). */
export function shapeFillSwatch(key: ShapeFill): CSSProperties {
  const fill = shapeFillToken(key);
  return fill ? { backgroundColor: `var(${fill})` } : { backgroundColor: "var(--sy-board)", borderStyle: "dashed" };
}

export const shapeStrokeSwatch = (key: ShapeStroke): CSSProperties => ({ backgroundColor: `var(${shapeStrokeToken(key)})` });

/** The minimap draws a shape in its fill, or its border colour when it has no fill. */
export const shapeMinimapColour = (shape: Pick<Shape, "fill" | "stroke">) => {
  const fill = shapeFillToken(shape.fill);
  return fill ? `var(${fill})` : `var(${shapeStrokeToken(shape.stroke)})`;
};
