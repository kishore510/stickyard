import { useReactFlow, useStoreApi } from "@xyflow/react";
import { useMemo } from "react";
import { NOTE_SIZE } from "@stickyard/shared";
import { readPxToken } from "../lib/cssVar";
import {
  centreOn,
  clampViewport,
  fitViewport,
  screenToFlow,
  viewportCentre,
  zoomAround,
  zoomStep,
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
    const go = (v: Viewport, animate: boolean) =>
      void flow.setViewport(clampViewport(v, size()), { duration: animate ? duration() : 0 });
    return {
      size,
      /** Fits the view to these notes (centred on the board if none). */
      fit: (notes: XY[], animate = true) => go(fitViewport(notes, size(), readPxToken("--sy-fit-padding", 72)), animate),
      zoomIn: () => go(zoomAround(viewport(), size(), zoomStep(viewport().zoom, 1)), true),
      zoomOut: () => go(zoomAround(viewport(), size(), zoomStep(viewport().zoom, -1)), true),
      resetZoom: () => go(zoomAround(viewport(), size(), 1), true),
      /** The flow point at the centre of the view. */
      centre: () => viewportCentre(viewport(), size()),
      /** Pans (same zoom) to show a note that is off screen. */
      reveal: (note: XY) => {
        const v = viewport();
        const { width, height } = size();
        const topLeft = screenToFlow({ x: 0, y: 0 }, v);
        const bottomRight = screenToFlow({ x: width, y: height }, v);
        const inside =
          note.x >= topLeft.x && note.y >= topLeft.y && note.x + NOTE_SIZE <= bottomRight.x && note.y + NOTE_SIZE <= bottomRight.y;
        if (!inside && width > 0) go(centreOn({ x: note.x + NOTE_SIZE / 2, y: note.y + NOTE_SIZE / 2 }, v.zoom, size()), true);
      },
    };
  }, [flow, store]);
}

export type CanvasView = ReturnType<typeof useCanvasView>;
