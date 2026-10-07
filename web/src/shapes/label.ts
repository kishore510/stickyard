import type { Shape } from "@stickyard/shared";
import { truncate } from "../notes/label";
import { SHAPE_KIND_NAMES } from "./style";

/** e.g. "Rectangle: Step 1", or "Text, empty". Text is untrusted and only ever used as text. */
export function shapeLabel(shape: Pick<Shape, "kind" | "text">): string {
  const kind = SHAPE_KIND_NAMES[shape.kind];
  return shape.text.trim() ? `${kind}: ${truncate(shape.text)}` : `${kind}, empty`;
}

/** Asks before deleting a shape that has text. Empty ones go straight away. */
export function confirmShapeDelete(shape: Pick<Shape, "kind" | "text">, confirm: (message: string) => boolean = (m) => window.confirm(m)): boolean {
  const what = shape.kind === "text" ? "text box" : "shape";
  return !shape.text.trim() || confirm(`Delete this ${what}? It’s removed for everyone in the session.`);
}

/** The placeholder an empty shape shows so it can be found (never stored or sent). */
export const SHAPE_PLACEHOLDER = "Text";
