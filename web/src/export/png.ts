import { getViewportForBounds } from "@xyflow/react";
import { notesBounds, type Rect } from "../canvas/geometry";

/*
 * Export PNG (v0.22.0): the board's items drawn at 100% zoom, whatever the view, cropped to the
 * box round every note, frame and shape plus EXPORT_MARGIN. html-to-image is loaded only here,
 * with a dynamic import, so it's fetched when someone exports. It clones React Flow's viewport
 * element (computed styles, so the current theme and the bundled Inter font come along) and
 * leaves out everything UI-only: cursors, selection marks, handles, toolbars, the board's dot
 * grid, and the viewer's own dots. Nothing leaves the browser.
 */

/** Space round the items, in board units (mirrored by --sy-export-margin; room for two rows of vote badges above a note). */
export const EXPORT_MARGIN = 64;
/** Neither side of the image goes past this (iOS Safari's canvas limit is a little over 4096 x 4096 = 16.7 MP; 8,192 a side). */
export const EXPORT_MAX_SIDE = 8192;
/** Total pixels stay under this. */
export const EXPORT_MAX_PIXELS = 16_000_000;
/** Pixels per board unit when the image fits. */
export const EXPORT_SCALE = 2;
/** The object URL is revoked this long after the download starts (some browsers read it after click returns). */
export const REVOKE_DELAY_MS = 1000;
/** Class on the viewport while it is drawn: index.css turns off selection outlines and the like under it. */
export const EXPORT_CLASS = "sy-exporting";

export const EXPORT_NOTICES = {
  empty: "Nothing on the board to export.",
  pngStart: "Exporting PNG…",
  mdStart: "Exporting Markdown…",
  pngDone: "PNG downloaded",
  mdDone: "Markdown downloaded",
  failed: "Export failed",
  failedDetail: "Export failed. Try again, or zoom out and export a smaller board.",
} as const;

/** The box to draw: every note, frame and shape plus the margin, in board units; null for an empty board. */
export function exportBounds(items: readonly { x: number; y: number; w: number; h: number }[]): Rect | null {
  const box = notesBounds([...items]);
  if (!box) return null;
  return { x: box.x - EXPORT_MARGIN, y: box.y - EXPORT_MARGIN, width: box.width + 2 * EXPORT_MARGIN, height: box.height + 2 * EXPORT_MARGIN };
}

export interface ExportSize {
  /** Pixels per board unit. */
  scale: number;
  /** The image's size in pixels (whole, within both caps). */
  width: number;
  height: number;
}

/** Scale 2 where it fits, else lower, so neither side passes EXPORT_MAX_SIDE and the total stays under EXPORT_MAX_PIXELS. Null for nothing. */
export function exportSize(width: number, height: number): ExportSize | null {
  if (!(width > 0 && height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  const scale = Math.min(EXPORT_SCALE, EXPORT_MAX_SIDE / width, EXPORT_MAX_SIDE / height, Math.sqrt((EXPORT_MAX_PIXELS - 1) / (width * height)));
  return { scale, width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/** UI-only parts of the canvas, by class or data attribute: never in the image. */
const SKIP_CLASSES = [
  "react-flow__node-board",
  "react-flow__resize-control",
  "react-flow__node-toolbar",
  "react-flow__nodesselection",
  "react-flow__minimap",
  "react-flow__attribution",
  "react-flow__panel",
  "sy-select-badge",
  "sy-selection-box",
  "sy-cursor",
];
const SKIP_ATTRIBUTES = ["data-my-dots", "data-cursor", "data-selection-box", "data-select-badge", "data-vote-controls", "data-export-skip"];

/** html-to-image's filter: false leaves the element (and what's inside it) out. */
export function keepInExport(node: Node): boolean {
  if (!(node instanceof Element)) return true;
  if (SKIP_CLASSES.some((c) => node.classList.contains(c))) return false;
  return !SKIP_ATTRIBUTES.some((a) => node.hasAttribute(a));
}

type HtmlToImage = Pick<typeof import("html-to-image"), "toBlob">;
const loadHtmlToImage = (): Promise<HtmlToImage> => import("html-to-image");

/**
 * Draws `viewport` (React Flow's .react-flow__viewport) for `bounds` as a PNG. The export class
 * is on the viewport only while drawing, and always comes off, also when drawing fails.
 */
export async function renderPng(viewport: HTMLElement, bounds: Rect, load: () => Promise<HtmlToImage> = loadHtmlToImage): Promise<Blob> {
  const size = exportSize(bounds.width, bounds.height);
  if (!size) throw new Error("empty");
  // 100% zoom: a viewport of the box's own size at zoom 1 (min = max = 1, no padding) puts the box's corner at 0,0.
  const v = getViewportForBounds(bounds, bounds.width, bounds.height, 1, 1, 0);
  const background = getComputedStyle(viewport).getPropertyValue("--sy-board").trim();
  viewport.classList.add(EXPORT_CLASS);
  try {
    const { toBlob } = await load();
    const blob = await toBlob(viewport, {
      width: bounds.width,
      height: bounds.height,
      pixelRatio: size.scale,
      ...(background ? { backgroundColor: background } : {}),
      filter: keepInExport,
      style: { width: `${bounds.width}px`, height: `${bounds.height}px`, transform: `translate(${v.x}px, ${v.y}px) scale(${v.zoom})` },
    });
    if (!blob) throw new Error("no image");
    return blob;
  } finally {
    viewport.classList.remove(EXPORT_CLASS);
  }
}

/** Saves `blob` as `name` through a temporary link; never opens or navigates to it. The object URL is revoked shortly after. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}
