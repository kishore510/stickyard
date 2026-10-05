import type { CSSProperties } from "react";
import type { Node, NodeChange } from "@xyflow/react";
import { BOARD_HEIGHT, BOARD_WIDTH, NOTE_Z_LIMIT, type NoteRect } from "@stickyard/shared";
import { isFrameHeld, type BoardFrame } from "../frames/board";
import { isHeld, isLocalId, type Board, type BoardNote } from "../notes/board";
import { noteSize } from "../notes/size";
import { groupOffset } from "./arrange";
import { boardToFlow, flowToBoard, type Size } from "./geometry";
import { EMPTY_SELECTION, isSelected, type Selection } from "./selection";

/*
 * Between the room's board (notes/board.ts, driven by RoomSession) and React Flow. React Flow
 * is controlled: it gets nodes made from our notes and reports drags back; it never owns notes.
 *
 * Node objects are reused while their note entry is unchanged (board.ts keeps unchanged entries
 * referentially equal), so React Flow re-renders only the notes that actually changed.
 */

export const BOARD_NODE_ID = "sy-board";

/** `resizable`: show the resize handles (the only selected note, editable, not under Hand, and confirmed). */
export type NoteFlowNode = Node<{ entry: BoardNote; editable: boolean; selected: boolean; resizable: boolean }, "note">;
/** `resizable`: the only selected frame, editable (md and up), not under Hand, and confirmed. */
export type FrameFlowNode = Node<{ entry: BoardFrame; editable: boolean; selected: boolean; resizable: boolean }, "frame">;
export type BoardFlowNode = Node<Record<string, never>, "board">;
export type CanvasNode = NoteFlowNode | FrameFlowNode | BoardFlowNode;

/**
 * Frames sit in one band behind every note (whatever its z, down to -NOTE_Z_LIMIT) and above
 * the board. Among themselves, frames stack in creation order (the node list's order).
 */
export const FRAME_Z_INDEX = -NOTE_Z_LIMIT - 1;

/** The board's bounded area, drawn under the notes (and shown in the minimap). Never interactive. */
export const BOARD_NODE: BoardFlowNode = {
  id: BOARD_NODE_ID,
  type: "board",
  position: { x: 0, y: 0 },
  data: {},
  width: BOARD_WIDTH,
  height: BOARD_HEIGHT,
  measured: { width: BOARD_WIDTH, height: BOARD_HEIGHT },
  draggable: false,
  selectable: false,
  focusable: false,
  // Below every frame and note, whatever its z.
  zIndex: -NOTE_Z_LIMIT - 2,
  // A click on the board's area is a click on empty space (it clears the selection).
  style: { pointerEvents: "none" },
  domAttributes: { "aria-hidden": true },
};

/*
 * React Flow gives a node that is neither draggable nor selectable pointer-events: none. Under
 * the Hand tool notes aren't draggable (so a drag that starts on one pans), but they must still
 * get double-clicks, clicks and focus. Shared, so nodes stay cheap to compare.
 */
const NOTE_STYLE: CSSProperties = { pointerEvents: "all" };
/**
 * Stacking is each note's z and nothing else: React Flow must not raise selected nodes (it would
 * by 1000), so what you see is what everyone sees. Spread onto <ReactFlow>.
 */
export const FLOW_STACKING = { elevateNodesOnSelect: false, zIndexMode: "manual" } as const;

/** Each note stays on the board: React Flow stops drags and resize handles at its edges. */
const NOTE_EXTENT: [[number, number], [number, number]] = [
  [0, 0],
  [BOARD_WIDTH, BOARD_HEIGHT],
];

function toNode(entry: BoardNote, editable: boolean, movable: boolean, selected: boolean, resizable: boolean): NoteFlowNode {
  const { width, height } = noteSize(entry.note);
  const confirmed = !isLocalId(entry.note.id);
  return {
    id: entry.note.id,
    type: "note",
    position: boardToFlow(entry.note),
    data: { entry, editable, selected, resizable },
    // Known size (from the size lookup): React Flow needn't measure before showing, fitting or
    // drawing the minimap, and the note fills its node.
    width,
    height,
    measured: { width, height },
    style: NOTE_STYLE,
    // Moved or resized here: no easing (that's for other people's changes).
    ...(isHeld(entry) ? { className: "sy-held" } : {}),
    extent: NOTE_EXTENT,
    // Notes waiting for their server id can't move yet (moves need the id).
    draggable: editable && movable && confirmed,
    selectable: false,
    focusable: false,
    // Stacking order (protocol v8). Dragging, resizing and selecting never raise a note.
    zIndex: entry.note.z,
  };
}

/*
 * A frame's body lets pointers through (to the canvas behind it, for clicks, marquee and pan,
 * and to the notes in front): the node itself has no pointer events, and only its title bar and
 * border (class sy-frame-handle, pointer events on) take presses and drag it.
 */
const FRAME_STYLE: CSSProperties = { pointerEvents: "none" };
export const FRAME_DRAG_HANDLE = ".sy-frame-handle";

function toFrameNode(entry: BoardFrame, editable: boolean, movable: boolean, selected: boolean, resizable: boolean): FrameFlowNode {
  const { x, y, w, h } = entry.frame;
  const confirmed = !isLocalId(entry.frame.id);
  return {
    id: entry.frame.id,
    type: "frame",
    position: boardToFlow({ x, y }),
    data: { entry, editable, selected, resizable },
    width: w,
    height: h,
    measured: { width: w, height: h },
    style: FRAME_STYLE,
    className: cnNode("sy-frame-node", isFrameHeld(entry) && "sy-held"),
    extent: NOTE_EXTENT,
    dragHandle: FRAME_DRAG_HANDLE,
    draggable: editable && movable && confirmed,
    selectable: false,
    focusable: false,
    zIndex: FRAME_Z_INDEX,
  };
}

const cnNode = (...names: (string | false)[]) => names.filter(Boolean).join(" ");

/** Frames on the canvas: which are selected (one id, or the set since v0.20.0), and whether this layout can change them (md and up). */
export interface FrameView {
  selected: string | null | Selection;
  wide: boolean;
}
const NO_FRAMES: FrameView = { selected: null, wide: false };

/**
 * Board -> nodes (the board, then frames, then notes), reusing the node for every entry that
 * hasn't changed (and whose selected state hasn't). `movable` is false while the Hand tool is on
 * (every drag pans), so notes and frames can't be dragged even when editable. Frames can only be
 * changed from md up (`frames.wide`); phones show them.
 */
export function createNoteNodeMapper(): (board: Board, editable: boolean, movable?: boolean, selection?: Selection, frames?: FrameView) => CanvasNode[] {
  let cache = new WeakMap<BoardNote, NoteFlowNode>();
  let frameCache = new WeakMap<BoardFrame, FrameFlowNode>();
  let lastKey = "";
  return (board, editable, movable = true, selection = EMPTY_SELECTION, frames = NO_FRAMES) => {
    const key = `${editable}:${movable}:${frames.wide}`;
    if (key !== lastKey) {
      cache = new WeakMap();
      frameCache = new WeakMap();
      lastKey = key;
    }
    const nodes: CanvasNode[] = [BOARD_NODE];
    const frameEditable = editable && frames.wide;
    const chosen: Selection = typeof frames.selected === "string" ? new Set([frames.selected]) : (frames.selected ?? EMPTY_SELECTION);
    // Resize handles only for one frame selected alone (several resize through Match size).
    const soleFrame = chosen.size === 1 && selection.size === 0;
    for (const entry of board.frames) {
      const selected = chosen.has(entry.frame.id);
      const resizable = selected && soleFrame && frameEditable && movable && !isLocalId(entry.frame.id);
      let node = frameCache.get(entry);
      if (!node || node.data.selected !== selected || node.data.resizable !== resizable) {
        node = toFrameNode(entry, frameEditable, movable, selected, resizable);
        frameCache.set(entry, node);
      }
      nodes.push(node);
    }
    // Resize handles only for a single selected note (several resize through Match size).
    const single = selection.size === 1 && chosen.size === 0;
    for (const entry of board.notes) {
      const selected = isSelected(selection, entry.note.id);
      const resizable = selected && single && editable && movable && !isLocalId(entry.note.id);
      let node = cache.get(entry);
      if (!node || node.data.selected !== selected || node.data.resizable !== resizable) {
        node = toNode(entry, editable, movable, selected, resizable);
        cache.set(entry, node);
      }
      nodes.push(node);
    }
    return nodes;
  };
}

export interface DragActions {
  startDrag(id: string): boolean;
  moveNote(id: string, x: number, y: number, final: boolean): void;
  /** The note's size, so positions are clamped at it (the session clamps again either way). */
  sizeOf?(id: string): Size;
  /**
   * The notes a drag of `id` moves (selecting just it first if it wasn't selected). Two or more
   * make it a group drag. Without this, every drag moves one note.
   */
  groupFor?(id: string): string[];
  /** A note's rect when the group drag starts. */
  rectOf?(id: string): NoteRect | null;
  startGroupDrag?(ids: string[]): boolean;
  moveGroup?(positions: { id: string; x: number; y: number }[], final: boolean): void;
  /** A frame drag: carries the notes inside it unless `carry` is false (Alt held). False if it can't move. */
  startFrameDrag?(id: string, carry: boolean): boolean;
  /** A frame's new (flow) position; the session clamps and moves its carried notes. */
  moveFrame?(id: string, x: number, y: number, final: boolean): void;
}

/** A group drag: React Flow drags the grabbed note; the others follow at the same offset. */
interface Group {
  anchor: string;
  start: Map<string, NoteRect>;
}

/**
 * React Flow drag events -> session moves. Positions in between are sent throttled by the
 * session; the drop is sent once as the final move. A drag the session refuses (not connected,
 * or the note was deleted) is ignored to the end. Dragging a note of a multi-selection moves the
 * whole selection: the grabbed note's offset is clamped once for the group (canvas/arrange.ts),
 * so the arrangement is kept at the board's edges.
 */
export function createDragHandlers(actions: DragActions) {
  const active = new Set<string>();
  const frames = new Set<string>();
  let group: Group | null = null;

  const groupMoves = (offset: XYLike) => {
    if (!group) return [];
    const rects = [...group.start.values()];
    const { dx, dy } = groupOffset(rects, offset.x, offset.y);
    return [...group.start].map(([id, r]) => ({ id, x: r.x + dx, y: r.y + dy }));
  };
  const offsetOf = (id: string, position: XYLike) => {
    const start = group?.start.get(id);
    const p = flowToBoard(position, actions.sizeOf?.(id));
    return start ? { x: p.x - start.x, y: p.y - start.y } : { x: 0, y: 0 };
  };

  return {
    onNodeDragStart(node: Pick<CanvasNode, "id"> & { type?: string }, event?: { altKey: boolean }) {
      if (node.id === BOARD_NODE_ID) return;
      if (node.type === "frame") {
        // Alt moves the frame alone; otherwise the notes inside it come along.
        if (actions.startFrameDrag?.(node.id, !(event?.altKey ?? false))) frames.add(node.id);
        return;
      }
      const ids = actions.groupFor?.(node.id) ?? [node.id];
      if (ids.length > 1 && actions.rectOf && actions.startGroupDrag && actions.moveGroup) {
        const start = new Map<string, NoteRect>();
        for (const id of ids) {
          const rect = actions.rectOf(id);
          if (rect && !isLocalId(id)) start.set(id, rect);
        }
        if (start.has(node.id) && actions.startGroupDrag([...start.keys()])) group = { anchor: node.id, start };
        return;
      }
      if (actions.startDrag(node.id)) active.add(node.id);
    },
    onNodesChange(changes: NodeChange<CanvasNode>[]) {
      for (const change of changes) {
        if (change.type !== "position" || !change.dragging || !change.position) continue;
        if (frames.has(change.id)) {
          actions.moveFrame?.(change.id, change.position.x, change.position.y, false);
          continue;
        }
        if (group?.anchor === change.id) {
          actions.moveGroup?.(groupMoves(offsetOf(change.id, change.position)), false);
          continue;
        }
        if (!active.has(change.id)) continue;
        const p = flowToBoard(change.position, actions.sizeOf?.(change.id));
        actions.moveNote(change.id, p.x, p.y, false);
      }
    },
    onNodeDragStop(node: Pick<CanvasNode, "id" | "position">) {
      if (frames.delete(node.id)) {
        actions.moveFrame?.(node.id, node.position.x, node.position.y, true);
        return;
      }
      if (group?.anchor === node.id) {
        actions.moveGroup?.(groupMoves(offsetOf(node.id, node.position)), true);
        group = null;
        return;
      }
      if (!active.delete(node.id)) return;
      const p = flowToBoard(node.position, actions.sizeOf?.(node.id));
      actions.moveNote(node.id, p.x, p.y, true);
    },
  };
}

type XYLike = { x: number; y: number };
