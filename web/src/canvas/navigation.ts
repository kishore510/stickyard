import { BOARD_HEIGHT, BOARD_WIDTH } from "@stickyard/shared";
import { noteSize } from "../notes/size";
import { centreOn, clampZoom, fitViewport, fitZoom, notesBounds, screenToFlow, type Placed, type Rect, type Size, type Viewport, type XY } from "./geometry";

/*
 * Navigation (v0.24.0): pure rules for Fit to notes with an outlier, zoom to selection, jump to
 * a person's pointer and how long view changes animate. No React Flow or DOM here; the view
 * commands in useCanvasView.ts apply the results through the same viewport path as before.
 */

/** Below this zoom a fit to everything is too small to read: Fit shows the largest cluster instead. */
export const FIT_READABLE_ZOOM = 0.25;
/** Items closer than this (board units, edge to edge on either axis) belong to one cluster. */
export const CLUSTER_GAP = 600;
/** Jumping to someone's pointer raises the zoom to at least this (it never lowers it). */
export const JUMP_MIN_ZOOM = 0.5;
/** View changes (fit, zoom, jump, minimap click) take this long; 0 with reduced motion. */
export const VIEW_ANIMATION_MS = 200;

/** How long a view change animates. */
export function viewDuration(reducedMotion: boolean): number {
  return reducedMotion ? 0 : VIEW_ANIMATION_MS;
}

const rectOf = (item: Placed): Rect => {
  const { width, height } = noteSize(item);
  return { x: item.x, y: item.y, width, height };
};

/** The gap between two items, edge to edge: the larger of the two axis gaps (0 when they overlap or touch). */
export function itemGap(a: Placed, b: Placed): number {
  const ra = rectOf(a);
  const rb = rectOf(b);
  const dx = Math.max(0, rb.x - (ra.x + ra.width), ra.x - (rb.x + rb.width));
  const dy = Math.max(0, rb.y - (ra.y + ra.height), ra.y - (rb.y + rb.height));
  return Math.max(dx, dy);
}

/**
 * Groups items linked by gaps smaller than CLUSTER_GAP (a gap of exactly CLUSTER_GAP doesn't
 * link). Each cluster keeps the input order; clusters are ordered by their first item.
 */
export function clusters<T extends Placed>(items: readonly T[]): T[][] {
  const parent = items.map((_, i) => i);
  const root = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    return r;
  };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (itemGap(items[i] as T, items[j] as T) >= CLUSTER_GAP) continue;
      const a = root(i);
      const b = root(j);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const groups = new Map<number, T[]>();
  items.forEach((item, i) => {
    const r = root(i);
    const group = groups.get(r);
    if (group) group.push(item);
    else groups.set(r, [item]);
  });
  return [...groups.values()];
}

/**
 * The cluster Fit shows when everything is too far apart: the one with the most items; ties go to
 * the one whose centre is nearest the board's centre, then the higher one, then the one further
 * left (deterministic whatever the input order). Empty for no items.
 */
export function largestCluster<T extends Placed>(items: readonly T[]): T[] {
  const centre = { x: BOARD_WIDTH / 2, y: BOARD_HEIGHT / 2 };
  const scored = clusters(items).map((group) => {
    const b = notesBounds(group) as Rect;
    const distance = (b.x + b.width / 2 - centre.x) ** 2 + (b.y + b.height / 2 - centre.y) ** 2;
    return { group, distance, y: b.y, x: b.x };
  });
  scored.sort((a, b) => b.group.length - a.group.length || a.distance - b.distance || a.y - b.y || a.x - b.x);
  return scored[0]?.group ?? [];
}

/** Whether an item lies wholly inside what a viewport shows on a `size` canvas. */
export function inViewport(item: Placed, v: Viewport, size: Size): boolean {
  const r = rectOf(item);
  const a = screenToFlow({ x: 0, y: 0 }, v);
  const b = screenToFlow({ x: size.width, y: size.height }, v);
  const slack = 0.5 / v.zoom;
  return r.x >= a.x - slack && r.y >= a.y - slack && r.x + r.width <= b.x + slack && r.y + r.height <= b.y + slack;
}

export interface FitPlan {
  viewport: Viewport;
  /** Some items were left out (the largest cluster was fitted instead of everything). */
  partial: boolean;
  /** How many items are outside the view (0 unless partial). */
  outside: number;
}

/**
 * Fit to notes: everything, as before, unless that would zoom out below FIT_READABLE_ZOOM; then
 * the largest cluster (see largestCluster), and `partial` says some items are out of view. One
 * cluster holding everything, or a cluster fit that still shows everything, is a plain fit.
 * An empty board is the plain fit (its middle at 100%).
 */
export function fitPlan(items: readonly Placed[], size: Size, padding: number): FitPlan {
  const all = fitViewport([...items], size, padding);
  const bounds = notesBounds([...items]);
  if (!bounds || fitZoom(bounds, size, padding) >= FIT_READABLE_ZOOM) return { viewport: all, partial: false, outside: 0 };
  const cluster = largestCluster(items);
  if (cluster.length === items.length) return { viewport: all, partial: false, outside: 0 };
  const viewport = fitViewport(cluster, size, padding);
  const outside = items.filter((item) => !inViewport(item, viewport, size)).length;
  return outside === 0 ? { viewport, partial: false, outside: 0 } : { viewport, partial: true, outside };
}

/** Why Zoom to selection is off: nothing is selected. */
export const ZOOM_SELECTION_HINT = "Select notes, frames or shapes to zoom to them.";

export function zoomSelectionReason(selected: number): string | null {
  return selected > 0 ? null : ZOOM_SELECTION_HINT;
}

/** Zoom to selection: the selected items (notes, frames, shapes) fitted with padding, never above FIT_MAX_ZOOM. Null with nothing selected. */
export function selectionViewport(items: readonly Placed[], size: Size, padding: number): Viewport | null {
  return items.length === 0 ? null : fitViewport([...items], size, padding);
}

/** Jump to a person: their pointer at the centre, the zoom kept, or raised to JUMP_MIN_ZOOM if lower. */
export function jumpViewport(v: Viewport, size: Size, point: XY): Viewport {
  return centreOn(point, clampZoom(Math.max(v.zoom, JUMP_MIN_ZOOM)), size);
}

/** Why a person's Go to button is off: no pointer position from them yet (or they're on a phone). */
export const JUMP_HINT = "No pointer position seen yet.";
