import { create } from "zustand";
import type { ConnectorEnd, ConnectorHead, ConnectorRoute, Point } from "@stickyard/shared";
import type { Snap } from "./geometry";

/*
 * Arrow UI state that isn't the board's (web only, md and up): the draw tool a Connectors tile
 * arms, a drawing in progress, an end or line being dragged, and the polite announcer's text for
 * my own adds and deletes. Nothing here is sent per frame: the session gets one message on release.
 */

/** What the armed tile draws. */
export interface DrawStyle {
  route: ConnectorRoute;
  startHead: ConnectorHead;
  endHead: ConnectorHead;
}

/** A drawing in progress: where it starts (an item's side or a free point) and where the pointer is. */
export interface Drawing {
  start: ConnectorEnd;
  /** The start's point on the board (for the preview). */
  startPoint: Point;
  current: Point;
  /** What the pointer snaps to now (its connection points are shown). */
  snap: Snap | null;
  /** The press moved (drag to draw), or it didn't (click, then click the end). */
  dragged: boolean;
}

/** An end of a selected arrow being dragged (attach, free, re-attach), or its line being dragged. */
export type ConnectorDrag =
  | { kind: "end"; id: string; which: "start" | "end"; point: Point; snap: Snap | null }
  | { kind: "line"; id: string; dx: number; dy: number };

interface ConnectorUi {
  draw: DrawStyle | null;
  drawing: Drawing | null;
  drag: ConnectorDrag | null;
  /** Hovered note or shape while drawing (its connection points show). */
  announce: { n: number; text: string } | null;
  arm(style: DrawStyle | null): void;
  setDrawing(drawing: Drawing | null): void;
  setDrag(drag: ConnectorDrag | null): void;
  say(text: string): void;
  reset(): void;
}

export const useConnectorUi = create<ConnectorUi>()((set, get) => ({
  draw: null,
  drawing: null,
  drag: null,
  announce: null,
  arm: (draw) => set({ draw, drawing: null }),
  setDrawing: (drawing) => set({ drawing }),
  setDrag: (drag) => set({ drag }),
  say: (text) => set({ announce: { n: (get().announce?.n ?? 0) + 1, text } }),
  reset: () => set({ draw: null, drawing: null, drag: null, announce: null }),
}));
