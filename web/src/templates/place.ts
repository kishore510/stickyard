import { BOARD_HEIGHT, BOARD_WIDTH, type FrameColor } from "@stickyard/shared";
import type { Size, XY } from "../canvas/geometry";
import type { FrameTitleStyle, Template } from "./registry";

/*
 * Where a template's frames go (pure). A click centres the template's bounding box on the
 * viewport centre; a drop centres it on the pointer (the palette passes the box's top-left).
 * Either way the top-left is clamped so every frame is fully on the board, and the frames keep
 * their arrangement. Nothing on the board is looked at: existing frames and notes never move.
 */

/** A template frame at its place on the board. */
export interface PlacedTemplateFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  color: FrameColor;
  style: FrameTitleStyle;
}

/** The template's size (its frames start at 0, 0). */
export function templateBounds(template: Template): Size {
  return {
    width: Math.max(...template.frames.map((f) => f.x + f.w)),
    height: Math.max(...template.frames.map((f) => f.y + f.h)),
  };
}

/** A top-left for the template, rounded and clamped so the whole template is on the board. */
export function clampTemplateOrigin(template: Template, topLeft: XY): XY {
  const { width, height } = templateBounds(template);
  const clamp = (v: number, max: number) => Math.min(Math.max(0, Math.round(v)), Math.max(0, max));
  return { x: clamp(topLeft.x, BOARD_WIDTH - width), y: clamp(topLeft.y, BOARD_HEIGHT - height) };
}

/** The top-left that centres the template on `centre` (the viewport centre), clamped. */
export function templateOrigin(template: Template, centre: XY): XY {
  const { width, height } = templateBounds(template);
  return clampTemplateOrigin(template, { x: centre.x - width / 2, y: centre.y - height / 2 });
}

/** The template's frames with their top-left at `origin` (clamped again, so any origin is safe). */
export function placeTemplate(template: Template, origin: XY): PlacedTemplateFrame[] {
  const o = clampTemplateOrigin(template, origin);
  return template.frames.map((f) => ({ x: o.x + f.x, y: o.y + f.y, w: f.w, h: f.h, title: f.title, color: f.color, style: f.style }));
}
