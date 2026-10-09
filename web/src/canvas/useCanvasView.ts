import { useReactFlow, useStoreApi } from "@xyflow/react";
import { useMemo, useRef } from "react";
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
import { viewFromCentre, type View } from "../follow/follow";
import { MoveGuard, followDuration } from "../follow/followUi";

/** Every view change animates briefly (navigation.ts VIEW_ANIMATION_MS), and not at all with reduced motion. */
const duration = () => viewDuration(Boolean(globalThis.matchMedia?.(MEDIA.reducedMotion).matches));
const reducedMotion = () => duration() === 0;
const fitPadding = () => readPxToken("--sy-fit-padding", 72);

export interface CanvasViewHooks {
  /**
   * I moved the view myself (v0.31.0): a pan or zoom gesture, a view key, Fit, Zoom to selection,
   * Go to, the overview map, revealing a note. Following stops. Never called for the page's own
   * moves (the first fit, keeping the centre on a resize, following, Go there).
   */
  onUserMove?: () => void;
}

/** Viewport commands on the React Flow instance, using the pure geometry. Needs a ReactFlowProvider. */
export function useCanvasView(hooks: CanvasViewHooks = {}) {
  const flow = useReactFlow();
  const store = useStoreApi();
  const latestHooks = useRef(hooks);
  latestHooks.current = hooks;
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
    const go = (v: Viewport, animate: boolean | number) =>
      void flow.setViewport(clampViewport(v, size()), { duration: typeof animate === "number" ? animate : animate ? duration() : 0 });
    // Follow (v0.31.0): moves the page makes for following run inside the guard, so they never count as mine.
    const guard = new MoveGuard();
    let lastFollow: number | null = null;
    /** One of my own view commands: following stops first. */
    const mine = () => latestHooks.current.onUserMove?.();
    return {
      size,
      /** Fits the view to these items, all of them however small that makes them (centred on the board if none): templates and Show all. */
      fit: (notes: Placed[], animate = true) => {
        mine();
        go(fitViewport(notes, size(), fitPadding()), animate);
      },
      /**
       * Fit to notes (v0.24.0): everything, or the largest cluster when everything would be
       * smaller than FIT_READABLE_ZOOM (navigation.ts). The plan says whether items were left out.
       * `user` false for the page's own first fit (it doesn't stop following).
       */
      fitItems: (items: Placed[], animate = true, user = true): FitPlan => {
        if (user) mine();
        const plan = fitPlan(items, size(), fitPadding());
        go(plan.viewport, animate);
        return plan;
      },
      /** Zoom to selection: false (nothing done) with nothing selected or no canvas yet. */
      zoomTo: (items: Placed[]): boolean => {
        const v = size().width > 0 ? selectionViewport(items, size(), fitPadding()) : null;
        if (v) {
          mine();
          go(v, true);
        }
        return v !== null;
      },
      /** Jump to a person: their pointer at the centre, zoom kept (raised to JUMP_MIN_ZOOM if lower). */
      jumpTo: (point: XY) => {
        mine();
        go(jumpViewport(viewport(), size(), point), true);
      },
      /** Centres the view on a board point at the same zoom (a minimap click). */
      centreAt: (point: XY) => {
        mine();
        go(centreOn(point, viewport().zoom, size()), true);
      },
      zoomIn: () => {
        mine();
        go(zoomAround(viewport(), size(), zoomStep(viewport().zoom, 1)), true);
      },
      zoomOut: () => {
        mine();
        go(zoomAround(viewport(), size(), zoomStep(viewport().zoom, -1)), true);
      },
      resetZoom: () => {
        mine();
        go(zoomAround(viewport(), size(), 1), true);
      },
      /**
       * Follow (v0.31.0): centres on the leader's view at their zoom, a programmatic move (never
       * mine). The first move of a run animates briefly; a stream of updates is set directly.
       */
      follow: (view: View) => {
        const now = Date.now();
        const ms = followDuration({ now, last: lastFollow, reduced: reducedMotion() });
        lastFollow = now;
        guard.programmatic(() => go(centreOn(view, view.zoom, size()), ms));
      },
      /** Go there (Bring to me): centres on that view at its zoom, animated unless reduced motion; never mine. */
      showView: (view: View) => {
        lastFollow = null;
        guard.programmatic(() => go(centreOn(view, view.zoom, size()), true));
      },
      /** React Flow reported a move (onMove): following stops when it was my own pan or zoom gesture. */
      moved: (event: Event | MouseEvent | TouchEvent | null | undefined) => {
        if (guard.userMove(event)) mine();
      },
      /** A gesture React Flow reports without an input event (the overview map's drag or wheel): mine. */
      userGesture: () => {
        if (!guard.active) mine();
      },
      /** My view as the wire has it: the board point at the centre and my zoom (clamped onto the board). */
      view: (): View => viewFromCentre(viewport(), size()),
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
        if (!inView(note) && size().width > 0) {
          mine();
          go(centreOn({ x: note.x + n.width / 2, y: note.y + n.height / 2 }, v.zoom, size()), true);
        }
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
