import { useReactFlow } from "@xyflow/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { isDrag } from "./geometry";
import { paneGesture } from "./pointer";
import { marqueeFrames } from "./frameSelect";
import { marqueeSelection, type Selection } from "./selection";
import type { Mode } from "./tools";
import { useBoardUi } from "./uiStore";

/** The marquee as drawn, in pixels from the board section's top-left corner. */
export interface MarqueeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where a press landed: empty canvas (the pane, or the board's area, which lets clicks through), not a note or a control. */
const onEmptyCanvas = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest(".react-flow__pane") !== null &&
  target.closest(".react-flow__node, .react-flow__panel, .react-flow__minimap, button, a, input, textarea, select") === null;

/**
 * Mouse marquee selection, as in Chalkline (Select tool, left-drag on empty canvas; Shift adds
 * to the selection). Notes it touches are selected; frames only when it encloses them (v0.20.0). A left press that doesn't move past the drag threshold clears the
 * selection instead (unless Shift is held). Touch and pen presses, other buttons, Hand and Space
 * are left to React Flow, which pans (canvas/pointer.ts decides).
 *
 * The press is taken in the capture phase and its default prevented, so React Flow's pan (which
 * listens for the compatibility mousedown) never starts. `handledClick` tells the pane's click
 * handler that this press was dealt with here.
 */
export function useMarquee({
  section,
  enabled,
  tool,
  spaceHeld,
  threshold,
  notes,
  frames = () => [],
  shapes = () => [],
}: {
  section: RefObject<HTMLElement | null>;
  /** Multi-select is on (md and up). */
  enabled: boolean;
  tool: Mode;
  spaceHeld: boolean;
  threshold: number;
  /** The notes as board rects, read when the marquee moves. */
  notes: () => { id: string; x: number; y: number; w: number; h: number }[];
  /** The frames as board rects, likewise. */
  frames?: () => { id: string; x: number; y: number; w: number; h: number }[];
  /** The shapes as board rects (protocol v15): taken like notes, by touching. */
  shapes?: () => { id: string; x: number; y: number; w: number; h: number }[];
}) {
  const flow = useReactFlow();
  const [box, setBox] = useState<MarqueeBox | null>(null);
  const handledClick = useRef(false);
  const latest = useRef({ enabled, tool, spaceHeld, threshold, notes, frames, shapes, flow });
  latest.current = { enabled, tool, spaceHeld, threshold, notes, frames, shapes, flow };

  useEffect(() => {
    const el = section.current;
    if (!el) return;
    let stop = () => {};

    const onDown = (e: PointerEvent) => {
      const { enabled: on, tool: t, spaceHeld: space } = latest.current;
      handledClick.current = false;
      if (!on || !onEmptyCanvas(e.target)) return;
      if (paneGesture({ pointerType: e.pointerType, button: e.button, tool: t, spaceHeld: space }) !== "marquee") return;
      e.preventDefault();
      e.stopPropagation();
      handledClick.current = true;
      // A field being edited (Properties) loses focus, so its draft commits, as a click would.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches("input, textarea, select")) active.blur();

      const start = { x: e.clientX, y: e.clientY };
      const base: Selection = useBoardUi.getState().selection;
      const baseFrames: Selection = useBoardUi.getState().frames;
      const baseShapes: Selection = useBoardUi.getState().shapes;
      const additive = e.shiftKey;
      let moved = false;
      let last: Selection | undefined;
      let lastFrames: Selection | undefined;
      let lastShapes: Selection | undefined;

      const onMove = (m: PointerEvent) => {
        const { threshold: limit, flow: f, notes: list, frames: frameList, shapes: shapeList } = latest.current;
        if (!moved && !isDrag(m.clientX - start.x, m.clientY - start.y, limit)) return;
        moved = true;
        const bounds = el.getBoundingClientRect();
        setBox({
          left: Math.min(start.x, m.clientX) - bounds.left,
          top: Math.min(start.y, m.clientY) - bounds.top,
          width: Math.abs(m.clientX - start.x),
          height: Math.abs(m.clientY - start.y),
        });
        const a = f.screenToFlowPosition(start, { snapToGrid: false });
        const b = f.screenToFlowPosition({ x: m.clientX, y: m.clientY }, { snapToGrid: false });
        const area = { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
        last = marqueeSelection(list(), area, base, additive, last);
        lastFrames = marqueeFrames(frameList(), area, baseFrames, additive, lastFrames);
        lastShapes = marqueeSelection(shapeList(), area, baseShapes, additive, lastShapes);
        useBoardUi.getState().setSelections(last, lastFrames, lastShapes);
      };
      const onUp = () => {
        stop();
        if (!moved && !additive) useBoardUi.getState().clearSelection();
        setBox(null);
      };
      stop = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        stop = () => {};
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };

    el.addEventListener("pointerdown", onDown, { capture: true });
    return () => {
      el.removeEventListener("pointerdown", onDown, { capture: true });
      stop();
    };
  }, [section]);

  return { box, handledClick };
}
