import {
  CONNECTOR_ANCHORS,
  anchorPoint,
  clampConnectorPoint,
  isBound,
  resolveConnector,
  type Box,
  type BoxOf,
  type Connector,
  type ConnectorAnchor,
  type ConnectorEnd,
  type ConnectorRoute,
  type Point,
} from "@stickyard/shared";
import type { Board } from "../notes/board";
import { NOTE_COLOR_NAMES } from "../notes/colours";
import { truncate } from "../notes/label";
import { SHAPE_KIND_NAMES } from "../shapes/style";
import type { Box as MarqueeBox, Selection } from "../canvas/selection";
import type { ConnectorPatch } from "./board";

/*
 * Arrow geometry for the canvas (web only, pure, tested). Every bound end is drawn from the
 * item's live box (shared resolveConnector), so a local drag, a remote move, a frame carrying the
 * item, Align, Distribute, Grid and Match size all re-route the arrow with nothing sent.
 */

/** A pointer this close to a note or shape (screen pixels) snaps the end to it. */
export const SNAP_PX = 24;
/** This close to the middle of one of its sides (screen pixels), the end takes that side's anchor; elsewhere auto. */
export const ANCHOR_PX = 16;
/** Characters of item text in an arrow's accessible name. */
export const LABEL_CHARS = 32;

type Rect = { x: number; y: number; w: number; h: number };

/**
 * Where each note's and shape's box is now, as this page shows it. A note or shape deleted here
 * and waiting for the relay keeps its last box, so its arrows stay where they were until the
 * relay's connectorUpdated frees them there.
 */
export function boxOfBoard(board: Board): BoxOf {
  const boxes = new Map<string, Box>();
  const put = (r: Rect & { id: string }) => boxes.set(r.id, { x: r.x, y: r.y, w: r.w, h: r.h });
  for (const n of board.removed) put(n.note);
  for (const s of board.shapesRemoved) put(s.shape);
  for (const n of board.notes) put(n.note);
  for (const s of board.shapes) put(s.shape);
  return (id) => boxes.get(id);
}

/** Both ends' points, or null when a bound item isn't there. */
export function resolveShown(connector: Pick<Connector, "start" | "end">, boxOf: BoxOf): { start: Point; end: Point } | null {
  return resolveConnector(connector, boxOf);
}

/**
 * The line's points. Straight: the two ends. Elbow: one bend each way through the middle,
 * horizontal first when the arrow is wider than it is tall, else vertical first.
 */
export function routePoints(start: Point, end: Point, route: ConnectorRoute): Point[] {
  if (route === "straight") return [start, end];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const mx = start.x + dx / 2;
    return [start, { x: mx, y: start.y }, { x: mx, y: end.y }, end];
  }
  const my = start.y + dy / 2;
  return [start, { x: start.x, y: my }, { x: end.x, y: my }, end];
}

/** An SVG path through the points. */
export const pathOf = (points: readonly Point[]) => points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");

/** The middles of a box's four sides (the connection points shown while snapping). */
export function anchorPoints(box: Box): Record<Exclude<ConnectorAnchor, "auto">, Point> {
  const at = (anchor: Exclude<ConnectorAnchor, "auto">) => anchorPoint(box, anchor, { x: 0, y: 0 });
  return { top: at("top"), right: at("right"), bottom: at("bottom"), left: at("left") };
}

export interface Snap {
  item: string;
  anchor: ConnectorAnchor;
  /** Where the end shows while snapped: the side's middle, or the item's centre for auto. */
  point: Point;
}

/**
 * The note or shape an end at `point` snaps to (the topmost, within SNAP_PX screen pixels of its
 * box), with the side whose middle is within ANCHOR_PX, else auto. `exclude`: the other end's item
 * (an arrow can't start and end on one item). Null: a free end.
 */
export function snapEnd(point: Point, items: readonly (Rect & { id: string; z: number })[], zoom: number, exclude?: string): Snap | null {
  const scale = zoom > 0 ? 1 / zoom : 1;
  const reach = SNAP_PX * scale;
  const hits = items.filter(
    (r) => r.id !== exclude && point.x >= r.x - reach && point.x <= r.x + r.w + reach && point.y >= r.y - reach && point.y <= r.y + r.h + reach,
  );
  const top = hits.reduce<(typeof hits)[number] | null>((best, r) => (best === null || r.z > best.z ? r : best), null);
  if (!top) return null;
  const box = { x: top.x, y: top.y, w: top.w, h: top.h };
  let best: { anchor: ConnectorAnchor; point: Point; d: number } | null = null;
  for (const [anchor, p] of Object.entries(anchorPoints(box)) as [Exclude<ConnectorAnchor, "auto">, Point][]) {
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (d <= ANCHOR_PX * scale && (best === null || d < best.d)) best = { anchor, point: p, d };
  }
  if (best) return { item: top.id, anchor: best.anchor, point: best.point };
  return { item: top.id, anchor: "auto", point: { x: box.x + box.w / 2, y: box.y + box.h / 2 } };
}

/** The end to store: bound to the snapped item, or free (rounded and clamped onto the board, as the relay will). */
export function endAt(point: Point, snap: { item: string; anchor: ConnectorAnchor; point?: Point } | null): ConnectorEnd {
  return snap ? { item: snap.item, anchor: snap.anchor } : clampConnectorPoint(point.x, point.y);
}

/** Why the relay would refuse these ends (refused here first): both on one item, zero length, or an item that's gone. */
export function endsProblem(start: ConnectorEnd, end: ConnectorEnd, boxOf: BoxOf): "same_item" | "zero" | "missing" | null {
  if (isBound(start) && isBound(end) && start.item === end.item) return "same_item";
  const points = resolveConnector({ start, end }, boxOf);
  if (!points) return "missing";
  const a = clampConnectorPoint(points.start.x, points.start.y);
  const b = clampConnectorPoint(points.end.x, points.end.y);
  return a.x === b.x && a.y === b.y ? "zero" : null;
}

/** Both ends moved by (dx, dy), for dragging the line of an arrow with both ends free; null when an end is attached. */
export function moveFreeArrow(c: Pick<Connector, "start" | "end">, dx: number, dy: number): ConnectorPatch | null {
  if (isBound(c.start) || isBound(c.end)) return null;
  return { start: clampConnectorPoint(c.start.x + dx, c.start.y + dy), end: clampConnectorPoint(c.end.x + dx, c.end.y + dy) };
}

/** Reverse: the ends and their heads swapped. */
export function reversedPatch(c: Pick<Connector, "start" | "end" | "startHead" | "endHead">): ConnectorPatch {
  return { start: c.end, end: c.start, startHead: c.endHead, endHead: c.startHead };
}

/**
 * A marquee's arrows: those with both ends (as drawn now) inside the box, after the base
 * selection when `additive`. Returns `previous` when that's the same.
 */
export function marqueeConnectors(
  list: readonly { id: string; start: Point; end: Point }[],
  box: MarqueeBox,
  base: Selection,
  additive: boolean,
  previous?: Selection,
): Selection {
  const left = Math.min(box.x, box.x + box.width);
  const right = Math.max(box.x, box.x + box.width);
  const top = Math.min(box.y, box.y + box.height);
  const bottom = Math.max(box.y, box.y + box.height);
  const inside = (p: Point) => p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
  const hits = list.filter((c) => inside(c.start) && inside(c.end)).map((c) => c.id);
  const next = new Set(additive ? [...base, ...hits] : hits);
  if (previous && previous.size === next.size && [...previous].every((id, i) => [...next][i] === id)) return previous;
  return next;
}

/** "Arrow", "Line", "Elbow arrow" or "Elbow line": what the arrow is, for its name and Properties. */
export function connectorKindName(c: Pick<Connector, "route" | "startHead" | "endHead">): string {
  const headed = c.startHead !== "none" || c.endHead !== "none";
  const kind = headed ? "arrow" : "line";
  return c.route === "elbow" ? `Elbow ${kind}` : kind === "arrow" ? "Arrow" : "Line";
}

/** An item in an arrow's name: its kind and short, text-only content (room content is untrusted, and only ever text). */
export function itemName(board: Board, id: string): string | null {
  const note = board.notes.find((n) => n.note.id === id)?.note;
  if (note) {
    const colour = NOTE_COLOR_NAMES[note.color];
    return note.text.trim() ? `${colour} note: ${truncate(note.text, LABEL_CHARS)}` : `${colour} note, empty`;
  }
  const shape = board.shapes.find((s) => s.shape.id === id)?.shape;
  if (shape) return shape.text.trim() ? `${SHAPE_KIND_NAMES[shape.kind]}: ${truncate(shape.text, LABEL_CHARS)}` : `${SHAPE_KIND_NAMES[shape.kind]}, empty`;
  return null;
}

const endName = (board: Board, end: ConnectorEnd) => (isBound(end) ? (itemName(board, end.item) ?? "a note or shape that's gone") : "a free end");

/** The arrow's accessible name: "Arrow from Yellow note: Plan to a free end". */
export function connectorLabel(c: Pick<Connector, "start" | "end" | "route" | "startHead" | "endHead">, board: Board): string {
  return `${connectorKindName(c)} from ${endName(board, c.start)} to ${endName(board, c.end)}`;
}

/**
 * Arrows (not deleted with them) that keep a free end when these notes and shapes go: the relay
 * frees every end bound to a deleted item. Each arrow counted once.
 */
export function freedArrows(board: Board, itemIds: readonly string[], deletedConnectorIds: readonly string[] = []): number {
  const gone = new Set(itemIds);
  const deleted = new Set(deletedConnectorIds);
  const boundTo = (end: ConnectorEnd) => isBound(end) && gone.has(end.item);
  return board.connectors.filter((c) => !deleted.has(c.connector.id) && (boundTo(c.connector.start) || boundTo(c.connector.end))).length;
}

/** The anchors, for Properties and tests. */
export const ANCHORS = CONNECTOR_ANCHORS;
