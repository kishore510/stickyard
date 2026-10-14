import { ViewportPortal, useReactFlow, useStore } from "@xyflow/react";
import { memo, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { BOARD_HEIGHT, BOARD_WIDTH, NOTE_Z_LIMIT, isBound, type Connector, type ConnectorAnchor, type Point } from "@stickyard/shared";
import { readPxToken } from "../lib/cssVar";
import type { Board } from "../notes/board";
import { isLocalId } from "../notes/board";
import type { Selection } from "../canvas/selection";
import { isDrag } from "../canvas/geometry";
import { anchorPoints, boxOfBoard, connectorLabel, endAt, pathOf, resolveShown, routePoints, snapEnd } from "./geometry";
import { useConnectorUi, type ConnectorDrag } from "./connectorUi";
import type { ConnectorPatch } from "./board";

/*
 * The arrows on the canvas (protocol v21; v0.36.0). One SVG in React Flow's viewport (board
 * units), at a z-index between the frames' band and the lowest note, so arrows draw above frames
 * and below notes and shapes. Every end is resolved from the items' live boxes, so moves re-route
 * with nothing sent. Strokes keep their screen width at any zoom; below READABLE_ZOOM they are
 * plain lines (no heads, no dashes). From md up each arrow is a focusable, selectable button with
 * a text-only name; phones draw them read-only.
 *
 * ConnectorOverlay sits above everything (handles, snap points, a drawing in progress): never
 * exported (data-connector-overlay), and its targets are 44 px whatever the zoom.
 */

/** Arrows sit between the frames (FRAME_Z_INDEX, -NOTE_Z_LIMIT - 2) and the lowest possible note (-NOTE_Z_LIMIT). */
export const CONNECTOR_Z_INDEX = -NOTE_Z_LIMIT - 1;
/** Below this zoom arrows are plain lines: heads and dashes would be noise. */
export const READABLE_ZOOM = 0.25;
/** The overlay (handles, a drawing in progress): above notes, below other people's cursors. */
const OVERLAY_Z_INDEX = 150_000;

const WIDTH_TOKEN = { thin: "--sy-connector-thin", medium: "--sy-connector-medium", thick: "--sy-connector-thick" } as const;
export const connectorInk = (ink: Connector["ink"]) => `var(--sy-shape-${ink}-stroke)`;

/** Sizes from the tokens, read once (screen pixels). */
function useSizes() {
  return useMemo(
    () => ({
      thin: readPxToken("--sy-connector-thin", 2),
      medium: readPxToken("--sy-connector-medium", 3),
      thick: readPxToken("--sy-connector-thick", 5),
      head: readPxToken("--sy-connector-head", 12),
      dash: readPxToken("--sy-connector-dash", 10),
      hit: readPxToken("--sy-connector-hit", 16),
      touch: readPxToken("--sy-touch-min", 44),
      dot: readPxToken("--sy-connector-dot", 6),
    }),
    [],
  );
}

/** A head at `tip`, pointing away from `from`, `size` board units long. */
function headPoints(from: Point, tip: Point, size: number): string {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const half = size * 0.55;
  const bx = tip.x - ux * size;
  const by = tip.y - uy * size;
  return `${tip.x},${tip.y} ${bx - uy * half},${by + ux * half} ${bx + uy * half},${by - ux * half}`;
}

export interface ConnectorLayerActions {
  select(id: string): void;
  toggle(id: string): void;
  /** Delete on a focused arrow: deletes it (or the whole selection when it's one of several). */
  removeFromKey(id: string): void;
  clearSelection(): void;
  /** The line of an arrow dragged by (dx, dy) board units, on release. */
  moveLine(id: string, dx: number, dy: number): void;
  /** An end dropped (free, attached or re-attached). */
  update(id: string, change: ConnectorPatch): void;
}

/** The ends to draw: an end or line being dragged here shows where it will go. */
function shownEnds(c: Connector, points: { start: Point; end: Point }, drag: ConnectorDrag | null): { start: Point; end: Point } {
  if (!drag || drag.id !== c.id) return points;
  if (drag.kind === "line") return { start: { x: points.start.x + drag.dx, y: points.start.y + drag.dy }, end: { x: points.end.x + drag.dx, y: points.end.y + drag.dy } };
  const p = drag.snap?.point ?? drag.point;
  return drag.which === "start" ? { start: p, end: points.end } : { start: points.start, end: p };
}

export const ConnectorLayer = memo(function ConnectorLayer({
  board,
  selected,
  interactive,
  editable,
  actions,
}: {
  board: Board;
  selected: Selection;
  /** md and up: arrows are focusable and selectable (phones draw them read-only). */
  interactive: boolean;
  /** Changes can be made (connected, not locked out); the line can be dragged. */
  editable: boolean;
  actions: ConnectorLayerActions;
}) {
  const zoom = useStore((s) => s.transform[2]);
  const drag = useConnectorUi((s) => s.drag);
  const sizes = useSizes();
  const flow = useReactFlow();
  // Where an end was last drawn: a bound item gone for a moment (deleted, the relay's freed end on its way) keeps it there.
  const last = useRef(new Map<string, { start: Point; end: Point }>());
  const boxOf = useMemo(() => boxOfBoard(board), [board]);
  const readable = zoom >= READABLE_ZOOM;
  const scale = zoom > 0 ? 1 / zoom : 1;

  const pressLine = (c: Connector) => (e: ReactPointerEvent<SVGPathElement>) => {
    if (!interactive || e.button !== 0) return;
    e.stopPropagation();
    if (!editable || !selected.has(c.id)) return;
    const start = { x: e.clientX, y: e.clientY };
    const origin = flow.screenToFlowPosition(start, { snapToGrid: false });
    let moved = false;
    const move = (m: PointerEvent) => {
      if (!moved && !isDrag(m.clientX - start.x, m.clientY - start.y, 4)) return;
      moved = true;
      const p = flow.screenToFlowPosition({ x: m.clientX, y: m.clientY }, { snapToGrid: false });
      useConnectorUi.getState().setDrag({ kind: "line", id: c.id, dx: p.x - origin.x, dy: p.y - origin.y });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const d = useConnectorUi.getState().drag;
      useConnectorUi.getState().setDrag(null);
      if (moved && d?.kind === "line" && d.id === c.id) actions.moveLine(c.id, d.dx, d.dy);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const onKey = (c: Connector) => (e: ReactKeyboardEvent<SVGGElement>) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      if (!editable) return;
      e.preventDefault();
      e.stopPropagation();
      actions.removeFromKey(c.id);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      actions.clearSelection();
    }
  };

  return (
    <ViewportPortal>
      <svg
        data-connector-layer=""
        role="group"
        aria-label="Arrows"
        className="sy-connector-layer"
        width={BOARD_WIDTH}
        height={BOARD_HEIGHT}
        style={{ zIndex: CONNECTOR_Z_INDEX }}
      >
        {board.connectors.map(({ connector: c }) => {
          const resolved = resolveShown(c, boxOf) ?? last.current.get(c.id) ?? null;
          if (!resolved) return null;
          last.current.set(c.id, resolved);
          const ends = shownEnds(c, resolved, drag);
          const points = routePoints(ends.start, ends.end, c.route);
          const d = pathOf(points);
          const width = sizes[c.width];
          const isSelected = selected.has(c.id);
          const head = (sizes.head + width * 2) * scale;
          const dash =
            !readable || c.dash === "solid" ? undefined : c.dash === "dashed" ? `${sizes.dash * scale} ${sizes.dash * 0.7 * scale}` : `${width * scale} ${width * 1.6 * scale}`;
          return (
            <g
              key={c.id}
              data-connector-id={c.id}
              role={interactive ? "button" : "img"}
              aria-roledescription="arrow"
              aria-label={connectorLabel(c, board)}
              {...(interactive ? { tabIndex: 0, "aria-pressed": isSelected } : {})}
              data-selected={isSelected || undefined}
              className="sy-connector"
              onFocus={() => {
                if (interactive && !selected.has(c.id)) actions.select(c.id);
              }}
              onKeyDown={onKey(c)}
              onClick={(e) => {
                if (!interactive) return;
                e.stopPropagation();
                if (e.shiftKey || e.ctrlKey || e.metaKey) actions.toggle(c.id);
                else actions.select(c.id);
              }}
            >
              {isSelected && <path className="sy-connector-halo" d={d} style={{ strokeWidth: width + 6 }} data-export-skip="" />}
              <path className="sy-connector-focus" d={d} style={{ strokeWidth: width + 6 }} data-export-skip="" />
              <path
                data-connector-line=""
                data-dash={c.dash}
                d={d}
                className="sy-connector-line"
                style={{ stroke: connectorInk(c.ink), strokeWidth: `var(${WIDTH_TOKEN[c.width]})`, ...(dash ? { strokeDasharray: dash } : {}) }}
              />
              {readable && c.startHead === "arrow" && points[1] && <polygon className="sy-connector-head" points={headPoints(points[1], points[0]!, head)} style={{ fill: connectorInk(c.ink) }} />}
              {readable && c.endHead === "arrow" && points.length > 1 && (
                <polygon className="sy-connector-head" points={headPoints(points[points.length - 2]!, points[points.length - 1]!, head)} style={{ fill: connectorInk(c.ink) }} />
              )}
              <path
                data-connector-hit=""
                className={interactive ? "sy-connector-hit nopan nodrag" : "sy-connector-hit-off"}
                d={d}
                style={{ strokeWidth: sizes.hit }}
                onPointerDown={pressLine(c)}
              />
            </g>
          );
        })}
      </svg>
    </ViewportPortal>
  );
});

/** A note or shape the drawing can attach to (confirmed: a bound end needs the server id). */
export type SnapItem = { id: string; x: number; y: number; w: number; h: number; z: number };

/** Snap targets: confirmed notes and shapes. */
export function snapItems(board: Board): SnapItem[] {
  return [
    ...board.notes.filter((n) => !isLocalId(n.note.id)).map((n) => n.note),
    ...board.shapes.filter((s) => !isLocalId(s.shape.id)).map((s) => s.shape),
  ].map(({ id, x, y, w, h, z }) => ({ id, x, y, w, h, z }));
}

const SIDES: Exclude<ConnectorAnchor, "auto">[] = ["top", "right", "bottom", "left"];

export interface OverlayActions {
  /** A press on a selected note's or shape's side handle: start drawing an arrow from there. */
  drawFrom(item: string, anchor: Exclude<ConnectorAnchor, "auto">, e: ReactPointerEvent): void;
  /** An end of the selected arrow dropped. */
  update(id: string, change: ConnectorPatch): void;
}

/**
 * Above every note (md and up): the selected arrow's end handles, the four "draw from here"
 * handles of one selected note or shape, and a drawing in progress with the connection points of
 * what it would attach to. Never in an export.
 */
export const ConnectorOverlay = memo(function ConnectorOverlay({
  board,
  arrow,
  editable,
  actions,
}: {
  board: Board;
  /** The one selected arrow (handles on its ends), or null. */
  arrow: string | null;
  editable: boolean;
  actions: OverlayActions;
}) {
  const zoom = useStore((s) => s.transform[2]);
  const drawing = useConnectorUi((s) => s.drawing);
  const drag = useConnectorUi((s) => s.drag);
  const sizes = useSizes();
  const flow = useReactFlow();
  const scale = zoom > 0 ? 1 / zoom : 1;
  const boxOf = useMemo(() => boxOfBoard(board), [board]);
  const target = (sizes.touch / 2) * scale;
  const dot = (sizes.dot / 2) * scale;
  const entry = arrow ? board.connectors.find((c) => c.connector.id === arrow) : undefined;
  const ends = entry ? resolveShown(entry.connector, boxOf) : null;
  const shown = entry && ends ? shownEnds(entry.connector, ends, drag) : null;
  const snap = drawing?.snap ?? (drag?.kind === "end" ? drag.snap : null);
  const snapBox = snap ? boxOf(snap.item) : undefined;

  const pressEnd = (which: "start" | "end") => (e: ReactPointerEvent<SVGCircleElement>) => {
    if (!entry || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const c = entry.connector;
    const other = which === "start" ? c.end : c.start;
    const exclude = isBound(other) ? other.item : undefined;
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (m: PointerEvent) => {
      if (!moved && !isDrag(m.clientX - start.x, m.clientY - start.y, 4)) return;
      moved = true;
      const point = flow.screenToFlowPosition({ x: m.clientX, y: m.clientY }, { snapToGrid: false });
      useConnectorUi.getState().setDrag({ kind: "end", id: c.id, which, point, snap: snapEnd(point, snapItems(board), flow.getZoom(), exclude) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const d = useConnectorUi.getState().drag;
      useConnectorUi.getState().setDrag(null);
      if (moved && d?.kind === "end" && d.id === c.id) actions.update(c.id, { [which]: endAt(d.point, d.snap) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const preview = drawing ? routePoints(drawing.startPoint, drawing.snap?.point ?? drawing.current, useConnectorUi.getState().draw?.route ?? "straight") : null;

  return (
    <ViewportPortal>
      <svg
        data-connector-overlay=""
        aria-hidden="true"
        className="sy-connector-overlay"
        width={BOARD_WIDTH}
        height={BOARD_HEIGHT}
        style={{ zIndex: OVERLAY_Z_INDEX }}
      >
        {snapBox &&
          Object.entries(anchorPoints(snapBox)).map(([side, p]) => (
            <circle key={side} data-connector-snap={side} className={snap?.anchor === side ? "sy-connector-snap sy-connector-snap-on" : "sy-connector-snap"} cx={p.x} cy={p.y} r={dot * 1.4} />
          ))}
        {preview && <path data-connector-preview="" className="sy-connector-preview" d={pathOf(preview)} />}
        {editable && shown && (
          <>
            {(["start", "end"] as const).map((which) => (
              <g key={which} data-connector-handle={which} className="sy-connector-handle nopan nodrag" onPointerDown={pressEnd(which)}>
                <circle className="sy-connector-handle-target" cx={shown[which].x} cy={shown[which].y} r={target} />
                <circle className="sy-connector-handle-dot" cx={shown[which].x} cy={shown[which].y} r={dot} />
              </g>
            ))}
          </>
        )}
      </svg>
    </ViewportPortal>
  );
});

/**
 * The four "draw from here" handles of one selected note or shape (md and up). In the arrows'
 * layer, under every note, so the item's own controls (reactions, votes) and its neighbours stay
 * on top; the 44 px targets reach out past the item's edge.
 */
export const DrawHandles = memo(function DrawHandles({ board, item, actions }: { board: Board; item: string; actions: Pick<OverlayActions, "drawFrom"> }) {
  const zoom = useStore((s) => s.transform[2]);
  const drawing = useConnectorUi((s) => s.drawing);
  const sizes = useSizes();
  const scale = zoom > 0 ? 1 / zoom : 1;
  const box = useMemo(() => (isLocalId(item) ? undefined : boxOfBoard(board)(item)), [board, item]);
  if (!box || drawing) return null;
  const target = (sizes.touch / 2) * scale;
  const dot = (sizes.dot / 2) * scale;
  const out = target;
  return (
    <ViewportPortal>
      <svg data-connector-overlay="" aria-hidden="true" className="sy-connector-overlay" width={BOARD_WIDTH} height={BOARD_HEIGHT} style={{ zIndex: CONNECTOR_Z_INDEX }}>
        {SIDES.map((side) => {
          const p = anchorPoints(box)[side];
          const at = side === "top" ? { x: p.x, y: p.y - out } : side === "bottom" ? { x: p.x, y: p.y + out } : side === "left" ? { x: p.x - out, y: p.y } : { x: p.x + out, y: p.y };
          return (
            <g key={side} data-connector-handle={`out-${side}`} className="sy-connector-handle nopan nodrag" onPointerDown={(e) => actions.drawFrom(item, side, e)}>
              <circle className="sy-connector-handle-target" cx={at.x} cy={at.y} r={target} />
              <circle className="sy-connector-handle-dot sy-connector-handle-out" cx={at.x} cy={at.y} r={dot} />
            </g>
          );
        })}
      </svg>
    </ViewportPortal>
  );
});
