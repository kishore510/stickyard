import { useReactFlow, useStoreApi } from "@xyflow/react";
import { useMemo } from "react";
import { readPxToken } from "../lib/cssVar";
import { MEDIA } from "../styles/breakpoints";
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
import { fitPlan, jumpViewport, selectionViewport, viewDuration, type FitPlan } from "./navigation";

/** Every view change animates briefly (navigation.ts VIEW_ANIMATION_MS), and not at all with reduced motion. */
const duration = () => viewDuration(Boolean(globalThis.matchMedia?.(MEDIA.reducedMotion).matches));
const fitPadding = () => readPxToken("--sy-fit-padding", 72);

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
      /** Fits the view to these items, all of them however small that makes them (centred on the board if none): templates and Show all. */
      fit: (notes: Placed[], animate = true) => go(fitViewport(notes, size(), fitPadding()), animate),
      /**
       * Fit to notes (v0.24.0): everything, or the largest cluster when everything would be
       * smaller than FIT_READABLE_ZOOM (navigation.ts). The plan says whether items were left out.
       */
      fitItems: (items: Placed[], animate = true): FitPlan => {
        const plan = fitPlan(items, size(), fitPadding());
        go(plan.viewport, animate);
        return plan;
      },
      /** Zoom to selection: false (nothing done) with nothing selected or no canvas yet. */
      zoomTo: (items: Placed[]): boolean => {
        const v = size().width > 0 ? selectionViewport(items, size(), fitPadding()) : null;
        if (v) go(v, true);
        return v !== null;
      },
      /** Jump to a person: their pointer at the centre, zoom kept (raised to JUMP_MIN_ZOOM if lower). */
      jumpTo: (point: XY) => go(jumpViewport(viewport(), size(), point), true),
      /** Centres the view on a board point at the same zoom (a minimap click). */
      centreAt: (point: XY) => go(centreOn(point, viewport().zoom, size()), true),
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
      /** Where a palette tile dropped at this screen point puts a new note (or something `size` big), or null if it's off the canvas. */
      dropAt: (client: XY, size: Size = DEFAULT_NOTE_SIZE): XY | null => {
        const rect = store.getState().domNode?.getBoundingClientRect();
        if (!rect || rect.width === 0) return null;
        return dropPosition(client, { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, viewport(), size);
      },
    };
  }, [flow, store]);
}

export type CanvasView = ReturnType<typeof useCanvasView>;
