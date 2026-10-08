/*
 * The board's side panels (md and up): the palette on the left and Properties on the right,
 * with the canvas taking whatever is left between them. Pure functions: widths, collapse,
 * keyboard resizing, the tile grid, the saved layout, and the free area's bottom corners.
 *
 * Sizes mirror tokens in tokens.css (--sy-palette-*, --sy-properties-*, --sy-panel-strip,
 * --sy-tile-min, --sy-canvas-min); test/panels.test.ts checks they match.
 */

export type PanelId = "palette" | "properties";

export interface PanelLimits {
  min: number;
  /** The default width. */
  initial: number;
  max: number;
}

export const PANEL_LIMITS: Readonly<Record<PanelId, PanelLimits>> = {
  // At the minimum the palette fits one column of tiles; at the default two.
  palette: { min: 152, initial: 216, max: 360 },
  properties: { min: 232, initial: 272, max: 400 },
};

/** A collapsed panel: a strip holding its expand button (a touch target plus padding). */
export const PANEL_STRIP = 52;
/** The canvas keeps at least this width (the view bar fits), when the window allows. */
export const CANVAS_MIN = 360;
/** No panel takes more than this share of the window. */
export const WINDOW_SHARE = 1 / 3;
/** Palette tiles: narrowest tile, the gap between tiles, the panel's side padding, most columns. */
export const TILE_MIN = 72;
export const TILE_GAP = 8;
export const PANEL_PADDING = 16;
export const MAX_COLUMNS = 3;
/** Dragging a resize handle this far past the minimum width collapses the panel on release (as in Chalkline). */
export const COLLAPSE_SLACK = 64;
/** Arrow keys on a resize handle move it this far; with Shift, KEY_STEP_BIG. */
export const KEY_STEP = 16;
export const KEY_STEP_BIG = 64;

/** What's remembered per panel. A null width means the default. */
export interface PanelState {
  width: number | null;
  collapsed: boolean;
}

export const DEFAULT_PANEL_STATE: PanelState = { width: null, collapsed: false };

export function clampWidth(width: number, min: number, max: number): number {
  if (!Number.isFinite(width)) return min;
  return Math.round(Math.min(max, Math.max(min, width)));
}

export interface PanelSize {
  /** The width it's drawn at (the strip when collapsed). */
  width: number;
  /** The range its resize handle allows right now. */
  min: number;
  max: number;
}

/**
 * Each panel's drawn width in a window this wide. Saved widths are re-clamped: never under
 * the panel's minimum, never over its maximum or a third of the window, and (where the window
 * allows) leaving the canvas CANVAS_MIN. The palette is sized first, leaving room for at least
 * the Properties panel's minimum (or its strip, when collapsed).
 */
export function panelWidths(windowWidth: number, state: Readonly<Record<PanelId, PanelState>>): Record<PanelId, PanelSize> {
  const room = (limits: PanelLimits, other: number) =>
    Math.max(limits.min, Math.min(limits.max, Math.floor(windowWidth * WINDOW_SHARE), windowWidth - CANVAS_MIN - other));
  const size = (id: PanelId, other: number): PanelSize => {
    const limits = PANEL_LIMITS[id];
    const max = room(limits, other);
    const { width, collapsed } = state[id];
    return { width: collapsed ? PANEL_STRIP : clampWidth(width ?? limits.initial, limits.min, max), min: limits.min, max };
  };
  const reserved = state.properties.collapsed ? PANEL_STRIP : PANEL_LIMITS.properties.min;
  const palette = size("palette", reserved);
  const properties = size("properties", palette.width);
  return { palette, properties };
}

/**
 * A key on a resize handle: the new width, or null for other keys. Arrow keys move the
 * handle that way (`edge` is the side of the panel the handle is on), Home and End go to
 * the minimum and maximum.
 */
export function keyResize(
  width: number,
  key: { key: string; shiftKey: boolean },
  limits: { min: number; max: number },
  edge: "left" | "right",
): number | null {
  const step = key.shiftKey ? KEY_STEP_BIG : KEY_STEP;
  const outward = edge === "right" ? "ArrowRight" : "ArrowLeft";
  const inward = edge === "right" ? "ArrowLeft" : "ArrowRight";
  let next: number;
  if (key.key === outward) next = width + step;
  else if (key.key === inward) next = width - step;
  else if (key.key === "Home") next = limits.min;
  else if (key.key === "End") next = limits.max;
  else return null;
  return clampWidth(next, limits.min, limits.max);
}

/** Released well below the minimum: collapse instead of resizing. */
export function shouldCollapse(rawWidth: number, min: number): boolean {
  return rawWidth < min - COLLAPSE_SLACK;
}

/** Palette tile columns at this panel width: 1 when narrow, up to MAX_COLUMNS. */
export function tileColumns(panelWidth: number): number {
  const inner = panelWidth - 2 * PANEL_PADDING;
  const fit = Math.floor((inner + TILE_GAP) / (TILE_MIN + TILE_GAP));
  return Math.max(1, Math.min(MAX_COLUMNS, fit));
}

/** The saved layout for one panel. Anything missing, malformed or out of range falls back to the defaults. */
export function parsePanelState(raw: string | null, limits: PanelLimits): PanelState {
  return storedPanelState(raw, limits) ?? DEFAULT_PANEL_STATE;
}

/**
 * The choice this browser saved for one panel, or null when there is none (nothing stored, or
 * something malformed). A well-formed entry with an out-of-range width is still a choice: its
 * collapsed state stands and the width goes back to the default.
 */
export function storedPanelState(raw: string | null, limits: PanelLimits): PanelState | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { width, collapsed } = value as Record<string, unknown>;
  if (typeof collapsed !== "boolean" || (width !== null && typeof width !== "number")) return null;
  const inRange = typeof width === "number" && Number.isFinite(width) && width >= limits.min && width <= limits.max;
  return { width: inRange ? Math.round(width) : null, collapsed };
}

/**
 * A panel's first state (v0.24.0): the saved choice when there is one; otherwise open at the lg
 * breakpoint and up (`desktop`), and collapsed below it, so a 768 px tablet's first fit isn't
 * squeezed into the third of the window left between two open panels.
 */
export function initialPanelState(raw: string | null, limits: PanelLimits, desktop: boolean): PanelState {
  return storedPanelState(raw, limits) ?? (desktop ? DEFAULT_PANEL_STATE : { width: null, collapsed: true });
}

export function serialisePanelState(state: PanelState): string {
  return JSON.stringify({ width: state.width, collapsed: state.collapsed });
}

/**
 * Whether the free area's bottom-right stack (minimap, chat button) must sit above the view
 * bar: true when, side by side, the centred bar would come within `gap` of it.
 */
export function cornerLifted({ free, bar, corner, edge, gap }: { free: number; bar: number; corner: number; edge: number; gap: number }): boolean {
  return (free + bar) / 2 + gap > free - edge - corner;
}
