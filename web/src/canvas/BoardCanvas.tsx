import { MiniMap, ReactFlow, useStore } from "@xyflow/react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BOARD_HEIGHT, BOARD_WIDTH, type NoteRect } from "@stickyard/shared";
import { readPxToken } from "../lib/cssVar";
import { useMediaQuery } from "../lib/useMediaQuery";
import { cn } from "../lib/utils";
import { findNote, type Board } from "../notes/board";
import { DEFAULT_NOTE_SIZE, noteSize } from "../notes/size";
import { NoteActionsContext, NoteHelpContext, NoteNode, type NoteActions } from "../notes/NoteCard";
import { MAX_ZOOM, MIN_ZOOM, WHEEL_BEHAVIOUR, dragThreshold, panExtent } from "./geometry";
import { createDragHandlers, createNoteNodeMapper, type CanvasNode } from "./nodes";
import { useBoardUi } from "./uiStore";
import type { CanvasView } from "./useCanvasView";

/** The board's bounded area under the notes: the dot grid, with a visible edge. */
function BoardSurface() {
  return <div className="sy-board-dots size-full rounded-lg border border-border-strong shadow-md" />;
}

const nodeTypes = { note: NoteNode, board: BoardSurface };
/** Where the view can go (the board plus a margin), and where notes can go (the board). */
const VIEW_EXTENT = panExtent();
const BOARD_EXTENT: [[number, number], [number, number]] = [
  [0, 0],
  [BOARD_WIDTH, BOARD_HEIGHT],
];

const minimapColour = (node: CanvasNode) =>
  node.type === "board" ? "var(--sy-board)" : `var(--sy-note-${node.data.entry.note.color})`;

/** Whether a key press belongs to a field or control (so Space there isn't a pan). */
const ownsSpace = (target: EventTarget | null) =>
  target instanceof Element && target.closest('input, textarea, select, button, a, [role="button"], [contenteditable="true"]') !== null;

export interface BoardRoom {
  board: Board;
  startDrag(id: string): boolean;
  moveNote(id: string, x: number, y: number, final: boolean): void;
  startResize(id: string): boolean;
  resizeNote(id: string, rect: NoteRect, final: boolean): void;
  openEditor(id: string): void;
  deleteNote(id: string): void;
}

/**
 * The board canvas: React Flow, controlled. Notes come from the room's board as memoised nodes;
 * React Flow owns only the viewport and gestures (pan, pinch, wheel, drag) and reports drags
 * back through the canvas layer (nodes.ts). Board units are flow units (geometry.ts).
 */
export function BoardCanvas({
  room,
  editable,
  synced,
  minimap,
  minimapLifted,
  view,
}: {
  room: BoardRoom;
  editable: boolean;
  /** The snapshot has arrived: fit to the notes once. */
  synced: boolean;
  minimap: boolean;
  /** The free area is narrow: the minimap sits above the view bar. */
  minimapLifted: boolean;
  view: CanvasView;
}) {
  const helpId = useId();
  const tool = useBoardUi((s) => s.tool);
  const selection = useBoardUi((s) => s.selection);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const panOnly = tool === "hand" || spaceHeld;
  const latest = useRef(room);
  latest.current = room;

  const map = useMemo(createNoteNodeMapper, []);
  const nodes = useMemo(() => map(room.board, editable, !panOnly, selection), [map, room.board, editable, panOnly, selection]);
  const drag = useMemo(
    () =>
      createDragHandlers({
        startDrag: (id) => latest.current.startDrag(id),
        moveNote: (id, x, y, final) => latest.current.moveNote(id, x, y, final),
        sizeOf: (id) => {
          const entry = findNote(latest.current.board, id);
          return entry ? noteSize(entry.note) : DEFAULT_NOTE_SIZE;
        },
      }),
    [],
  );
  const actions = useMemo<NoteActions>(
    () => ({
      moveNote: (id, x, y, final) => latest.current.moveNote(id, x, y, final),
      startResize: (id) => latest.current.startResize(id),
      resizeNote: (id, rect, final) => latest.current.resizeNote(id, rect, final),
      openEditor: (id) => latest.current.openEditor(id),
      deleteNote: (id) => latest.current.deleteNote(id),
      revealNote: (id) => {
        const entry = findNote(latest.current.board, id);
        if (entry) view.reveal(entry.note);
      },
      selectNote: (id) => useBoardUi.getState().select(id),
      clearSelection: () => useBoardUi.getState().clearSelection(),
      canTapEdit: () => useBoardUi.getState().tool === "select",
    }),
    [view],
  );

  // Open fitted to the notes (centred on the board if there are none), once the size is known.
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !synced || width === 0 || height === 0) return;
    fitted.current = true;
    view.fit(
      latest.current.board.notes.map((n) => n.note),
      false,
    );
  }, [synced, width, height, view]);

  // A panel opened, closed or was resized (or the window changed): the canvas is a new size.
  // Keep the same board point at its centre, so the board doesn't jump.
  const lastSize = useRef({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const before = lastSize.current;
    lastSize.current = { width, height };
    if (fitted.current) view.recentre(before);
  }, [width, height, view]);

  // Space held (outside fields and buttons) pans with any drag, like the Hand tool.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || ownsSpace(e.target) || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      if (!e.repeat) setSpaceHeld(true);
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && setSpaceHeld(false);
    const release = () => setSpaceHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, []);

  // iOS Safari ignores touch-action for page zoom; block its pinch while the board is open.
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", block);
    return () => document.removeEventListener("gesturestart", block);
  }, []);

  const coarse = useMediaQuery("(pointer: coarse)");
  const threshold = dragThreshold(coarse);
  const minimapSize = useMemo(
    () => ({ width: readPxToken("--sy-minimap-width", 200), height: readPxToken("--sy-minimap-height", 125) }),
    [],
  );

  return (
    <section aria-label="Board" className={cn("absolute inset-0", panOnly && "[&_.react-flow__pane]:cursor-grab")}>
      <p id={helpId} className="sr-only">
        {editable
          ? "Press Enter to edit, arrow keys to move, Alt and arrow keys to resize (Shift for bigger steps), Delete to delete."
          : "Read only while disconnected."}
      </p>
      <NoteHelpContext.Provider value={helpId}>
        <NoteActionsContext.Provider value={actions}>
          <ReactFlow<CanvasNode>
            nodes={nodes}
            nodeTypes={nodeTypes}
            onNodesChange={drag.onNodesChange}
            onNodeDragStart={(_, node) => drag.onNodeDragStart(node)}
            onNodeDragStop={(_, node) => drag.onNodeDragStop(node)}
            // A click on empty space (the board or around it) clears the selection.
            onPaneClick={() => useBoardUi.getState().clearSelection()}
            nodesDraggable={editable && !panOnly}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            // Notes are the keyboard stops (NoteCard); React Flow's own node keys are off.
            disableKeyboardA11y
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            panActivationKeyCode={null}
            zoomActivationKeyCode={null}
            panOnDrag
            panOnScroll={WHEEL_BEHAVIOUR === "pan"}
            zoomOnScroll={WHEEL_BEHAVIOUR === "zoom"}
            zoomOnPinch
            zoomOnDoubleClick={false}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            translateExtent={VIEW_EXTENT}
            nodeExtent={BOARD_EXTENT}
            nodeDragThreshold={threshold}
            nodeClickDistance={threshold}
            autoPanOnNodeDrag
            attributionPosition="top-right"
            aria-label="Board canvas"
          >
            {minimap && (
              <MiniMap<CanvasNode>
                className={cn("sy-minimap", minimapLifted && "sy-minimap-lifted")}
                position="bottom-right"
                pannable
                zoomable
                ariaLabel="Board overview"
                nodeColor={minimapColour}
                nodeStrokeWidth={0}
                style={minimapSize}
              />
            )}
          </ReactFlow>
        </NoteActionsContext.Provider>
      </NoteHelpContext.Provider>
    </section>
  );
}
