import { useReactFlow, useStoreApi } from "@xyflow/react";
import { useMemo } from "react";
import { readPxToken } from "../lib/cssVar";
import { DEFAULT_NOTE_SIZE, noteSize } from "../notes/size";
import {
  centreOn,
  clampViewport,
  dropPosition,
  fitViewport,
  keepCentre,
  screenToFlow,
  viewportCentre,
  zoomAround,
  zoomStep,
  type Placed,
  type Size,
  type Viewport,
  type XY,
} from "./geometry";

/** Zoom and fit animations take the base duration (0 with reduced motion; see tokens.css). */
const duration = () => readPxToken("--sy-duration-base", 200);

/** Viewport commands on the React Flow instance, using the pure geometry. Needs a ReactFlowProvider. */
export function useCanvasView() {
  const flow = useReactFlow();
  const store = useStoreApi();
  return useMemo(() => {
    const size = (): Size => {
      const { width, height } = store.getState();
      return { width, height };
    };
    const viewport = (): Viewport => {
      const [x, y, zoom] = store.getState().transform;
      return { x, y, zoom };
    };
    const inView = (note: Placed) => {
      const v = viewport();
      const { width, height } = size();
      const n = noteSize(note);
      const topLeft = screenToFlow({ x: 0, y: 0 }, v);
      const bottomRight = screenToFlow({ x: width, y: height }, v);
      return note.x >= topLeft.x && note.y >= topLeft.y && note.x + n.width <= bottomRight.x && note.y + n.height <= bottomRight.y;
    };
    const go = (v: Viewport, animate: boolean) =>
      void flow.setViewport(clampViewport(v, size()), { duration: animate ? duration() : 0 });
    return {
      size,
      /** Fits the view to these notes (centred on the board if none). */
      fit: (notes: Placed[], animate = true) => go(fitViewport(notes, size(), readPxToken("--sy-fit-padding", 72)), animate),
      zoomIn: () => go(zoomAround(viewport(), size(), zoomStep(viewport().zoom, 1)), true),
      zoomOut: () => go(zoomAround(viewport(), size(), zoomStep(viewport().zoom, -1)), true),
      resetZoom: () => go(zoomAround(viewport(), size(), 1), true),
      /** The canvas was `before` and is now another size: keep the same board point at its centre. */
      recentre: (before: Size) => {
        const v = viewport();
        const next = keepCentre(v, before, size());
        if (next !== v) go(next, false);
      },
      /** The flow point at the centre of the view. */
      centre: () => viewportCentre(viewport(), size()),
      /** Pans (same zoom) to show a note that is off screen. */
      reveal: (note: Placed) => {
        const v = viewport();
        const n = noteSize(note);
        if (!inView(note) && size().width > 0) go(centreOn({ x: note.x + n.width / 2, y: note.y + n.height / 2 }, v.zoom, size()), true);
      },
      /** The whole note is on screen (or the canvas has no size yet). */
      visible: (note: Placed) => size().width === 0 || inView(note),
      /** Where a palette tile dropped at this screen point puts a new note, or null if it's off the canvas. */
      dropAt: (client: XY): XY | null => {
        const rect = store.getState().domNode?.getBoundingClientRect();
        if (!rect || rect.width === 0) return null;
        return dropPosition(client, { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, viewport(), DEFAULT_NOTE_SIZE);
      },
    };
  }, [flow, store]);
}

export type CanvasView = ReturnType<typeof useCanvasView>;
