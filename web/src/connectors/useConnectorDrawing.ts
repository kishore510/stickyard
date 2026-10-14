import { useReactFlow } from "@xyflow/react";
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { CONNECTOR_DEFAULTS, clampConnectorPoint, isBound, type ConnectorAnchor, type ConnectorEnd, type Point } from "@stickyard/shared";
import { isDrag } from "../canvas/geometry";
import type { Board } from "../notes/board";
import { anchorPoints, boxOfBoard, endAt, snapEnd } from "./geometry";
import { useConnectorUi, type DrawStyle } from "./connectorUi";
import { snapItems } from "./ConnectorLayer";
import { CONNECTOR_TEXT } from "./rules";

/*
 * Drawing an arrow (md and up). A Connectors tile arms the draw tool; then on the canvas either
 * press and drag from where the arrow starts to where it ends, or click the start and then click
 * the end. An end near a note or shape snaps to it (its connection points show) and attaches on
 * release; otherwise it is free. A selected note's or shape's side handles start a drag straight
 * from that side. Esc cancels. One connectorAdd on release, nothing while drawing.
 */

const DRAG_PX = 6;

export function useConnectorDrawing({
  section,
  enabled,
  board,
  add,
}: {
  section: RefObject<HTMLElement | null>;
  /** md and up, and arrows can be changed now. */
  enabled: boolean;
  board: () => Board;
  /** Adds the arrow; its local id, or null (the session says why). */
  add(input: { start: ConnectorEnd; end: ConnectorEnd } & DrawStyle): string | null;
}) {
  const flow = useReactFlow();
  const latest = useRef({ enabled, board, add, flow });
  latest.current = { enabled, board, add, flow };
  const stop = useRef<() => void>(() => {});

  const finish = useCallback(() => {
    const ui = useConnectorUi.getState();
    const drawing = ui.drawing;
    const style = ui.draw ?? { route: CONNECTOR_DEFAULTS.route, startHead: CONNECTOR_DEFAULTS.startHead, endHead: CONNECTOR_DEFAULTS.endHead };
    stop.current();
    ui.arm(null);
    if (!drawing) return;
    const id = latest.current.add({ start: drawing.start, end: endAt(drawing.current, drawing.snap), ...style });
    if (id) useConnectorUi.getState().say(CONNECTOR_TEXT.added);
  }, []);

  const point = (e: { clientX: number; clientY: number }): Point => latest.current.flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false });

  /** Follows the pointer; `dragMode`: the press is held (drag to draw), so release finishes. */
  const follow = useCallback((origin: { x: number; y: number }, dragMode: boolean) => {
    stop.current();
    const exclude = () => {
      const start = useConnectorUi.getState().drawing?.start;
      return start && isBound(start) ? start.item : undefined;
    };
    const move = (m: PointerEvent) => {
      const ui = useConnectorUi.getState();
      const drawing = ui.drawing;
      if (!drawing) return;
      const current = point(m);
      const dragged = drawing.dragged || isDrag(m.clientX - origin.x, m.clientY - origin.y, DRAG_PX);
      ui.setDrawing({ ...drawing, current, dragged, snap: snapEnd(current, snapItems(latest.current.board()), latest.current.flow.getZoom(), exclude()) });
    };
    const up = () => {
      const drawing = useConnectorUi.getState().drawing;
      // A click (no drag): the start is set; the next click sets the end.
      if (dragMode && drawing?.dragged) finish();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    stop.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      stop.current = () => {};
    };
  }, [finish]);

  // An armed press on the canvas starts a drawing (or, mid click-click, sets its end).
  useEffect(() => {
    const el = section.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      const ui = useConnectorUi.getState();
      if (!ui.draw || !latest.current.enabled || e.button !== 0) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.closest(".react-flow__pane, .react-flow__node") || target.closest(".react-flow__panel, .react-flow__minimap, button, a, input, textarea, select")) return;
      e.preventDefault();
      e.stopPropagation();
      const p = point(e);
      if (ui.drawing) {
        ui.setDrawing({ ...ui.drawing, current: p, snap: snapEnd(p, snapItems(latest.current.board()), latest.current.flow.getZoom(), isBound(ui.drawing.start) ? ui.drawing.start.item : undefined) });
        return finish();
      }
      const snap = snapEnd(p, snapItems(latest.current.board()), latest.current.flow.getZoom());
      const startPoint = snap?.point ?? clampConnectorPoint(p.x, p.y);
      ui.setDrawing({ start: endAt(p, snap), startPoint, current: p, snap: null, dragged: false });
      follow({ x: e.clientX, y: e.clientY }, true);
    };
    el.addEventListener("pointerdown", onDown, { capture: true });
    return () => el.removeEventListener("pointerdown", onDown, { capture: true });
  }, [section, finish, follow]);

  // Esc cancels the drawing and disarms the tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const ui = useConnectorUi.getState();
      if (!ui.draw && !ui.drawing && !ui.drag) return;
      e.preventDefault();
      stop.current();
      ui.arm(null);
      ui.setDrag(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  useEffect(() => () => stop.current(), []);

  /** A selected note's or shape's side handle pressed: draw from that side (drag; a click waits for the end). */
  const drawFrom = useCallback(
    (item: string, anchor: Exclude<ConnectorAnchor, "auto">, e: ReactPointerEvent) => {
      if (!latest.current.enabled || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const box = boxOfBoard(latest.current.board())(item);
      if (!box) return;
      const ui = useConnectorUi.getState();
      if (!ui.draw) ui.arm({ route: CONNECTOR_DEFAULTS.route, startHead: CONNECTOR_DEFAULTS.startHead, endHead: CONNECTOR_DEFAULTS.endHead });
      const startPoint = anchorPoints(box)[anchor];
      useConnectorUi.getState().setDrawing({ start: { item, anchor }, startPoint, current: point(e), snap: null, dragged: false });
      follow({ x: e.clientX, y: e.clientY }, true);
    },
    [follow],
  );

  return { drawFrom };
}
