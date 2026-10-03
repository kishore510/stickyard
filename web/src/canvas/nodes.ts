import type { CSSProperties } from "react";
import type { Node, NodeChange } from "@xyflow/react";
import { BOARD_HEIGHT, BOARD_WIDTH } from "@stickyard/shared";
import { isLocalId, type Board, type BoardNote } from "../notes/board";
import { noteSize } from "../notes/size";
import { boardToFlow, flowToBoard } from "./geometry";
import { EMPTY_SELECTION, isSelected, type Selection } from "./selection";

/*
 * Between the room's board (notes/board.ts, driven by RoomSession) and React Flow. React Flow
 * is controlled: it gets nodes made from our notes and reports drags back; it never owns notes.
 *
 * Node objects are reused while their note entry is unchanged (board.ts keeps unchanged entries
 * referentially equal), so React Flow re-renders only the notes that actually changed.
 */

export const BOARD_NODE_ID = "sy-board";

export type NoteFlowNode = Node<{ entry: BoardNote; editable: boolean; selected: boolean }, "note">;
export type BoardFlowNode = Node<Record<string, never>, "board">;
export type CanvasNode = NoteFlowNode | BoardFlowNode;

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
  zIndex: -1,
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

function toNode(entry: BoardNote, editable: boolean, movable: boolean, selected: boolean): NoteFlowNode {
  const { width, height } = noteSize(entry.note);
  return {
    id: entry.note.id,
    type: "note",
    position: boardToFlow(entry.note),
    data: { entry, editable, selected },
    // Known size (from the size lookup): React Flow needn't measure before showing, fitting or
    // drawing the minimap, and the note fills its node.
    width,
    height,
    measured: { width, height },
    style: NOTE_STYLE,
    // Notes waiting for their server id can't move yet (moves need the id).
    draggable: editable && movable && !isLocalId(entry.note.id),
    selectable: false,
    focusable: false,
    // The note being dragged sits above the rest.
    zIndex: entry.dragging ? 1 : 0,
  };
}

/**
 * Board -> nodes, reusing the node for every entry that hasn't changed (and whose selected state
 * hasn't). `movable` is false while the Hand tool is on (every drag pans), so notes can't be
 * dragged even when editable.
 */
export function createNoteNodeMapper(): (board: Board, editable: boolean, movable?: boolean, selection?: Selection) => CanvasNode[] {
  let cache = new WeakMap<BoardNote, NoteFlowNode>();
  let lastKey = "";
  return (board, editable, movable = true, selection = EMPTY_SELECTION) => {
    const key = `${editable}:${movable}`;
    if (key !== lastKey) {
      cache = new WeakMap();
      lastKey = key;
    }
    const nodes: CanvasNode[] = [BOARD_NODE];
    for (const entry of board.notes) {
      const selected = isSelected(selection, entry.note.id);
      let node = cache.get(entry);
      if (!node || node.data.selected !== selected) {
        node = toNode(entry, editable, movable, selected);
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
}

/**
 * React Flow drag events -> session moves. Positions in between are sent throttled by the
 * session; the drop is sent once as the final move. A drag the session refuses (not connected,
 * or the note was deleted) is ignored to the end.
 */
export function createDragHandlers(actions: DragActions) {
  const active = new Set<string>();
  return {
    onNodeDragStart(node: Pick<CanvasNode, "id">) {
      if (node.id !== BOARD_NODE_ID && actions.startDrag(node.id)) active.add(node.id);
    },
    onNodesChange(changes: NodeChange<CanvasNode>[]) {
      for (const change of changes) {
        if (change.type !== "position" || !change.dragging || !change.position || !active.has(change.id)) continue;
        const p = flowToBoard(change.position);
        actions.moveNote(change.id, p.x, p.y, false);
      }
    },
    onNodeDragStop(node: Pick<CanvasNode, "id" | "position">) {
      if (!active.delete(node.id)) return;
      const p = flowToBoard(node.position);
      actions.moveNote(node.id, p.x, p.y, true);
    },
  };
}
