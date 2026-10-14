import { BOARD_HEIGHT, BOARD_WIDTH, type BoundEnd, type ConnectorAnchor, type ConnectorEnd } from "./protocol";

/*
 * Connector geometry (protocol v21), pure so both sides share it: the relay uses it to turn a
 * bound end free when its item is deleted (and to refuse zero-length arrows); the page will draw
 * with it (part 2). A bound end has no stored coordinates: its point comes from the item's box.
 * In v1 every item kind (note, any shape) is its box: an oval's or diamond's edge isn't traced.
 */

export interface Point {
  x: number;
  y: number;
}

/** An item's box in board units: top-left corner and size. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A note's or shape's box by id, or undefined when it isn't on the board (or this viewer can't see it). */
export type BoxOf = (item: string) => Box | undefined;

const finite = (value: number) => (Number.isFinite(value) ? value : 0);

/** Whether an end is bound to an item (else it is a free point). */
export function isBound(end: ConnectorEnd): end is BoundEnd {
  return "item" in end;
}

/**
 * Where a bound end meets its item's box. top / right / bottom / left: the middle of that side,
 * whatever `other` is. auto: where the line from the box's centre towards `other` leaves the box
 * (`other` inside the box still gives the edge in its direction). With `other` exactly at the
 * centre there is no direction: the top middle, a fixed choice. Exact on the edge it lands on.
 */
export function anchorPoint(box: Box, anchor: ConnectorAnchor, other: Point): Point {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  switch (anchor) {
    case "top":
      return { x: cx, y: box.y };
    case "right":
      return { x: box.x + box.w, y: cy };
    case "bottom":
      return { x: cx, y: box.y + box.h };
    case "left":
      return { x: box.x, y: cy };
    case "auto": {
      const dx = finite(other.x) - cx;
      const dy = finite(other.y) - cy;
      if (dx === 0 && dy === 0) return { x: cx, y: box.y };
      // How far along the line each pair of sides is; the nearer one is where it leaves.
      const tx = dx === 0 ? Number.POSITIVE_INFINITY : box.w / 2 / Math.abs(dx);
      const ty = dy === 0 ? Number.POSITIVE_INFINITY : box.h / 2 / Math.abs(dy);
      if (tx <= ty) return { x: dx > 0 ? box.x + box.w : box.x, y: cy + dy * tx };
      return { x: cx + dx * ty, y: dy > 0 ? box.y + box.h : box.y };
    }
  }
}

/**
 * What the other end of a connector aims at: a free end's point; a fixed anchor's point; an auto
 * anchor's item centre (so two auto ends aim at each other's centres, never in a circle). null when
 * the bound item isn't there.
 */
export function endReference(end: ConnectorEnd, boxOf: BoxOf): Point | null {
  if (!isBound(end)) return { x: end.x, y: end.y };
  const box = boxOf(end.item);
  if (!box) return null;
  if (end.anchor === "auto") return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  return anchorPoint(box, end.anchor, { x: 0, y: 0 });
}

/** Both ends' points on the board, or null when either bound item isn't there. */
export function resolveConnector(connector: { start: ConnectorEnd; end: ConnectorEnd }, boxOf: BoxOf): { start: Point; end: Point } | null {
  const startRef = endReference(connector.start, boxOf);
  const endRef = endReference(connector.end, boxOf);
  if (!startRef || !endRef) return null;
  const resolve = (end: ConnectorEnd, otherRef: Point): Point | null => {
    if (!isBound(end)) return { x: end.x, y: end.y };
    const box = boxOf(end.item);
    return box ? anchorPoint(box, end.anchor, otherRef) : null;
  };
  const start = resolve(connector.start, endRef);
  const end = resolve(connector.end, startRef);
  return start && end ? { start, end } : null;
}

/** Rounds a point to whole units and clamps it onto the board (edges included): how a free end is stored. */
export function clampConnectorPoint(x: number, y: number): Point {
  const round = (v: number) => (Number.isFinite(v) ? Math.round(v) : 0);
  return { x: Math.min(BOARD_WIDTH, Math.max(0, round(x))), y: Math.min(BOARD_HEIGHT, Math.max(0, round(y))) };
}
