import { MiniMap, ReactFlow, ViewportPortal, useStore } from "@xyflow/react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BOARD_HEIGHT, BOARD_WIDTH, type NoteRect } from "@stickyard/shared";
import { readPxToken } from "../lib/cssVar";
import { useMediaQuery } from "../lib/useMediaQuery";
import { cn } from "../lib/utils";
import { findFrame } from "../frames/board";
import { confirmFrameDelete } from "../frames/label";
import { FrameActionsContext, FrameNode, type FrameActions } from "../frames/FrameNode";
import { frameMinimapColour } from "../frames/style";
import { findNote, type Board } from "../notes/board";
import { confirmDelete, confirmDeleteNotes } from "../notes/label";
import { DEFAULT_NOTE_SIZE, noteSize } from "../notes/size";
import { NoteActionsContext, NoteHelpContext, NoteNode, type EditorRequest, type NoteActions } from "../notes/NoteCard";
import { groupOffset } from "./arrange";
import { MAX_ZOOM, MIN_ZOOM, WHEEL_BEHAVIOUR, dragThreshold, notesBounds, panExtent } from "./geometry";
import { FLOW_STACKING, createDragHandlers, createNoteNodeMapper, type CanvasNode } from "./nodes";
import { framedNotes } from "../frames/board";
import { deleteKeyTarget, inField, onBoard } from "./deleteKey";
import { dragSelection } from "./pointer";
import { boardShortcut, type BoardCommand } from "./shortcuts";
import { orderedIds } from "./selection";
import { useBoardUi } from "./uiStore";
import { useMarquee } from "./useMarquee";
import { confirmDeleteSelection, deleteCounts } from "./frameSelect";
import { VOTE_TEXT } from "../voting/voting";
import type { CanvasView } from "./useCanvasView";
import { CursorLayer } from "../cursors/CursorLayer";
import { useCursorSharing } from "../cursors/useCursorSharing";

/** The board's bounded area under the notes: the dot grid, with a visible edge. */
function BoardSurface() {
  return <div className="sy-board-dots size-full rounded-lg border border-border-strong shadow-md" />;
}

const nodeTypes = { note: NoteNode, frame: FrameNode, board: BoardSurface };
/** Where the view can go (the board plus a margin), and where notes can go (the board). */
const VIEW_EXTENT = panExtent();
const BOARD_EXTENT: [[number, number], [number, number]] = [
  [0, 0],
  [BOARD_WIDTH, BOARD_HEIGHT],
];

const minimapColour = (node: CanvasNode) =>
  node.type === "board" ? "var(--sy-board)" : node.type === "frame" ? frameMinimapColour(node.data.entry.frame.color) : `var(--sy-note-${node.data.entry.note.color})`;

/** After the last arrow key press on a selection, its position is committed (stored) this much later. */
const KEY_COMMIT_MS = 400;

/** Whether a key press belongs to a field or control (so Space there isn't a pan). */
const ownsSpace = (target: EventTarget | null) =>
  target instanceof Element && target.closest('input, textarea, select, button, a, [role="button"], [contenteditable="true"]') !== null;

export interface BoardRoom {
  board: Board;
  /** Connected: changes can be sent. */
  live: boolean;
  startDrag(id: string): boolean;
  moveNote(id: string, x: number, y: number, final: boolean): void;
  startResize(id: string): boolean;
  resizeNote(id: string, rect: NoteRect, final: boolean): void;
  openEditor(id: string, how?: EditorRequest): void;
  /** Text typed in place: a draft (remote edits never replace it) until it's committed. */
  setDraft(id: string, draft: string | null): void;
  editNote(id: string, text: string): boolean;
  deleteNote(id: string): void;
  startGroupDrag(ids: readonly string[]): boolean;
  moveGroup(positions: readonly { id: string; x: number; y: number }[], final: boolean): void;
  deleteNotes(ids: readonly string[]): void;
  startFrameDrag(id: string, carry: boolean): boolean;
  moveFrame(id: string, x: number, y: number, final: boolean): void;
  setFrameDraft(id: string, draft: string | null): void;
  editFrame(id: string, change: { title?: string }): boolean;
  startFrameResize(id: string): boolean;
  resizeFrame(id: string, rect: NoteRect, final: boolean): void;
  deleteFrame(id: string): void;
  /** Deletes notes and frames together (v0.20.0): one paced run, one report, one undo step. False if it couldn't start. */
  deleteSelection(noteIds: readonly string[], frameIds: readonly string[]): boolean;
  /** Live cursors (protocol v14): share my pointer (false: not sent), and say it left. */
  shareCursor(x: number, y: number): boolean;
  hideCursor(): void;
}

/**
 * Deletes these selected notes, asking once (one note: only if it has text) and clearing the
 * selection. Not connected: asks nothing, and the room says nothing was deleted.
 */
export function deleteSelected(room: Pick<BoardRoom, "board" | "live" | "deleteNote" | "deleteNotes">, ids: readonly string[]): void {
  const [only] = ids;
  if (only === undefined) return;
  if (!room.live) return room.deleteNotes(ids);
  if (ids.length === 1) {
    if (!confirmDelete(findNote(room.board, only)?.note.text ?? "")) return;
    room.deleteNote(only);
  } else {
    if (!confirmDeleteNotes(ids.length)) return;
    room.deleteNotes(ids);
  }
  useBoardUi.getState().clearSelection();
}

/** Deletes the selected frame, asking first when it has a title or notes inside (they stay), and clears the selection. */
export function deleteFrameAsking(room: Pick<BoardRoom, "board" | "deleteFrame">, id: string): void {
  const entry = findFrame(room.board, id);
  if (!entry) return;
  const inside = framedNotes(entry.frame, room.board.notes.map((n) => n.note)).length;
  if (!confirmFrameDelete(entry.frame.title, inside)) return;
  room.deleteFrame(entry.frame.id);
  useBoardUi.getState().clearSelection();
}

/**
 * Deletes a selection that holds frames (several, or frames and notes), asking once with the
 * counts and how many unselected notes inside the frames stay. Clears the selection.
 */
export function deleteSelectionAsking(
  room: Pick<BoardRoom, "board" | "live" | "deleteSelection">,
  noteIds: readonly string[],
  frameIds: readonly string[],
): void {
  if (noteIds.length + frameIds.length === 0) return;
  if (!room.live) return void room.deleteSelection(noteIds, frameIds);
  const counts = deleteCounts(room.board, noteIds, frameIds);
  if (!confirmDeleteSelection(counts)) return;
  if (room.deleteSelection(noteIds, frameIds)) useBoardUi.getState().clearSelection();
}

/**
 * The board canvas: React Flow, controlled. Notes come from the room's board as memoised nodes;
 * React Flow owns only the viewport and gestures (pan, pinch, wheel, drag) and reports drags
 * back through the canvas layer (nodes.ts). Board units are flow units (geometry.ts).
 */
export function BoardCanvas({
  room,
  editable,
  multiSelect,
  synced,
  minimap,
  minimapLifted,
  view,
  onShortcut,
}: {
  room: BoardRoom;
  editable: boolean;
  /** Several notes can be selected (md and up): marquee, Shift/Ctrl-click, Ctrl+A, group moves. */
  multiSelect: boolean;
  /** The snapshot has arrived: fit to the notes once. */
  synced: boolean;
  minimap: boolean;
  /** The free area is narrow: the minimap sits above the view bar. */
  minimapLifted: boolean;
  view: CanvasView;
  /** A board command asked for from the keyboard (Ctrl/Cmd+D, md and up). */
  onShortcut?: (command: BoardCommand) => void;
}) {
  const helpId = useId();
  const tool = useBoardUi((s) => s.tool);
  const selection = useBoardUi((s) => s.selection);
  const frameSelection = useBoardUi((s) => s.frames);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const panOnly = tool === "hand" || spaceHeld;
  const latest = useRef(room);
  latest.current = room;
  const multi = useRef(multiSelect);
  multi.current = multiSelect;
  const sectionRef = useRef<HTMLElement>(null);
  const keyCommit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(keyCommit.current), []);

  const map = useMemo(createNoteNodeMapper, []);
  // Several items selected (notes and frames): a dashed box round them (board units; it follows a group drag).
  const selectionBox = useMemo(
    () =>
      selection.size + frameSelection.size > 1
        ? notesBounds([
            ...[...selection].flatMap((id) => findNote(room.board, id)?.note ?? []),
            ...[...frameSelection].flatMap((id) => findFrame(room.board, id)?.frame ?? []),
          ])
        : null,
    [selection, frameSelection, room.board],
  );
  const nodes = useMemo(
    () => map(room.board, editable, !panOnly, selection, { selected: frameSelection, wide: multiSelect }),
    [map, room.board, editable, panOnly, selection, frameSelection, multiSelect],
  );
  const drag = useMemo(
    () =>
      createDragHandlers({
        startDrag: (id) => latest.current.startDrag(id),
        moveNote: (id, x, y, final) => latest.current.moveNote(id, x, y, final),
        sizeOf: (id) => {
          const entry = findNote(latest.current.board, id);
          return entry ? noteSize(entry.note) : DEFAULT_NOTE_SIZE;
        },
        groupFor: (id) => {
          if (!multi.current) return [id];
          const ui = useBoardUi.getState();
          const selection = dragSelection(ui.selection, id);
          ui.setSelection(selection);
          return orderedIds(selection);
        },
        rectOf: (id) => {
          const note = findNote(latest.current.board, id)?.note;
          return note ? { x: note.x, y: note.y, w: note.w, h: note.h } : null;
        },
        startGroupDrag: (ids) => latest.current.startGroupDrag(ids),
        moveGroup: (positions, final) => latest.current.moveGroup(positions, final),
        startFrameDrag: (id, carry) => {
          useBoardUi.getState().selectFrame(id);
          return latest.current.startFrameDrag(id, carry);
        },
        moveFrame: (id, x, y, final) => latest.current.moveFrame(id, x, y, final),
      }),
    [],
  );
  const frameActions = useMemo<FrameActions>(
    () => ({
      selectFrame: (id) => useBoardUi.getState().selectFrame(id),
      toggleFrame: (id) => {
        if (multi.current) useBoardUi.getState().toggleFrame(id);
        else useBoardUi.getState().selectFrame(id);
      },
      setDraft: (id, draft) => latest.current.setFrameDraft(id, draft),
      commitTitle: (id) => {
        const draft = findFrame(latest.current.board, id)?.draft;
        if (draft != null) latest.current.editFrame(id, { title: draft });
      },
      startResize: (id) => latest.current.startFrameResize(id),
      resize: (id, rect, final) => latest.current.resizeFrame(id, rect, final),
    }),
    [],
  );
  const actions = useMemo<NoteActions>(
    () => ({
      moveNote: (id, x, y, final) => latest.current.moveNote(id, x, y, final),
      startResize: (id) => latest.current.startResize(id),
      resizeNote: (id, rect, final) => latest.current.resizeNote(id, rect, final),
      openEditor: (id, how) => latest.current.openEditor(id, how),
      setDraft: (id, text) => latest.current.setDraft(id, text),
      commitEdit: (id) => {
        // Only once per edit (Enter, Escape and the blur that follows all end it).
        if (useBoardUi.getState().inlineEdit?.id !== id) return;
        useBoardUi.getState().endInlineEdit();
        const draft = findNote(latest.current.board, id)?.draft;
        if (draft != null) latest.current.editNote(id, draft);
      },
      endEdit: (id) => {
        if (useBoardUi.getState().inlineEdit?.id === id) useBoardUi.getState().endInlineEdit();
      },
      deleteNote: (id) => latest.current.deleteNote(id),
      revealNote: (id) => {
        const entry = findNote(latest.current.board, id);
        if (entry) view.reveal(entry.note);
      },
      selectNote: (id) => useBoardUi.getState().select(id),
      toggleNote: (id) => {
        if (multi.current) useBoardUi.getState().toggle(id);
        else useBoardUi.getState().select(id);
      },
      clearSelection: () => useBoardUi.getState().clearSelection(),
      canTapEdit: () => useBoardUi.getState().tool === "select",
      groupOf: (id) => {
        const { selection } = useBoardUi.getState();
        return selection.size > 1 && selection.has(id) ? orderedIds(selection) : null;
      },
      moveSelection: (dx, dy) => {
        const room = latest.current;
        const notes = orderedIds(useBoardUi.getState().selection).flatMap((id) => findNote(room.board, id)?.note ?? []);
        if (notes.length === 0 || !room.startGroupDrag(notes.map((n) => n.id))) return;
        const offset = groupOffset(notes, dx, dy);
        const positions = notes.map((n) => ({ id: n.id, x: n.x + offset.dx, y: n.y + offset.dy }));
        room.moveGroup(positions, false);
        clearTimeout(keyCommit.current);
        keyCommit.current = setTimeout(() => {
          const now = latest.current;
          const ids = positions.map((p) => p.id);
          now.moveGroup(ids.flatMap((id) => findNote(now.board, id)?.note ?? []).map((n) => ({ id: n.id, x: n.x, y: n.y })), true);
        }, KEY_COMMIT_MS);
      },
      deleteFromKey: (id) => {
        // A note outside the selection (focused before a marquee or Ctrl-click) deletes the selection, never itself.
        const { selection } = useBoardUi.getState();
        const own = selection.size === 0 || (selection.size === 1 && selection.has(id)) || !multi.current;
        deleteSelected(latest.current, own ? [id] : orderedIds(selection));
      },
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
    // Notes, and any frames already here (they arrive right after the notes snapshot).
    view.fit([...latest.current.board.notes.map((n) => n.note), ...latest.current.board.frames.map((f) => f.frame)], false);
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

  // Ctrl+A (Cmd+A) selects every note and frame and Escape clears the selection, outside fields and sheets.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || inField(e.target) || document.querySelector('[aria-modal="true"]')) return;
      if (multi.current && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        const { board } = latest.current;
        useBoardUi.getState().selectAll(
          board.notes.map((n) => n.note.id),
          board.frames.map((f) => f.frame.id),
        );
        return;
      }
      const ui = useBoardUi.getState();
      if (e.key === "Escape" && (ui.selection.size > 0 || ui.frames.size > 0)) ui.clearSelection();
      const target = deleteKeyTarget(e, {
        multi: multi.current,
        selection: ui.selection.size,
        frameSelected: ui.frameSelected !== null,
        frames: ui.frames.size,
        modal: document.querySelector('[aria-modal="true"]') !== null,
        board: sectionRef.current,
      });
      // Enter on a selected frame (nothing else focused) edits its title.
      if (e.key === "Enter" && multi.current && ui.frameSelected !== null && !ownsSpace(e.target) && onBoard(e.target, sectionRef.current)) {
        e.preventDefault();
        ui.requestFrameEdit(ui.frameSelected);
        return;
      }
      // Frames with notes, or several frames: one confirm with the counts, then one paced delete.
      if (target === "selection") {
        e.preventDefault();
        deleteSelectionAsking(latest.current, orderedIds(ui.selection), orderedIds(ui.frames));
        return;
      }
      // Delete with the selection but no note focused (after Ctrl+A or a marquee): delete the selection.
      if (target === "notes") {
        e.preventDefault();
        deleteSelected(latest.current, orderedIds(ui.selection));
        return;
      }
      // Delete (or Backspace) on a selected frame deletes it, asking first; its notes stay.
      if (target === "frame" && ui.frameSelected !== null) {
        if (!findFrame(latest.current.board, ui.frameSelected)) return;
        e.preventDefault();
        deleteFrameAsking(latest.current, ui.frameSelected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ctrl/Cmd shortcuts for board commands (shortcuts.ts guards them): the browser's own action
  // (Ctrl+D bookmarks) is stopped whenever the board takes the key.
  const shortcut = useRef(onShortcut);
  shortcut.current = onShortcut;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const command = boardShortcut(e, { multi: multi.current, modal: document.querySelector('[aria-modal="true"]') !== null, board: sectionRef.current });
      if (!command || !shortcut.current) return;
      e.preventDefault();
      shortcut.current(command);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // iOS Safari ignores touch-action for page zoom; block its pinch while the board is open.
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", block);
    return () => document.removeEventListener("gesturestart", block);
  }, []);

  const coarse = useMediaQuery("(pointer: coarse)");
  const threshold = dragThreshold(coarse);
  const marquee = useMarquee({
    section: sectionRef,
    enabled: multiSelect,
    tool,
    spaceHeld,
    threshold,
    notes: () => latest.current.board.notes.map((n) => n.note),
    frames: () => latest.current.board.frames.map((f) => f.frame),
  });
  // My pointer, shared from md up with a mouse or a hovering pen (phones only receive).
  useCursorSharing(sectionRef, multiSelect, room);
  const minimapSize = useMemo(
    () => ({ width: readPxToken("--sy-minimap-width", 200), height: readPxToken("--sy-minimap-height", 125) }),
    [],
  );

  return (
    <section
      ref={sectionRef}
      aria-label="Board"
      className={cn("absolute inset-0", panOnly && "[&_.react-flow__pane]:cursor-grab")}
      // Right-drag pans, so the browser's menu stays away from the canvas.
      onContextMenu={(e) => e.preventDefault()}
    >
      <p id={helpId} className="sr-only">
        {editable
          ? "Press Enter to edit, arrow keys to move, Alt and arrow keys to resize (Shift for bigger steps), Delete to delete."
          : "Read only while disconnected."}{" "}
        {VOTE_TEXT.keys}
      </p>
      <NoteHelpContext.Provider value={helpId}>
        <NoteActionsContext.Provider value={actions}>
          <FrameActionsContext.Provider value={frameActions}>
          <ReactFlow<CanvasNode>
            nodes={nodes}
            nodeTypes={nodeTypes}
            onNodesChange={drag.onNodesChange}
            onNodeDragStart={(event, node) => drag.onNodeDragStart(node, event)}
            onNodeDragStop={(_, node) => drag.onNodeDragStop(node)}
            // A click on empty space (the board or around it) clears the selection. A mouse press
            // there was already handled by the marquee (useMarquee); taps come through here.
            onPaneClick={() => {
              if (marquee.handledClick.current) {
                marquee.handledClick.current = false;
                return;
              }
              useBoardUi.getState().clearSelection();
            }}
            nodesDraggable={editable && !panOnly}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            {...FLOW_STACKING}
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
            {selectionBox && (
              <ViewportPortal>
                <div
                  data-selection-box
                  aria-hidden="true"
                  className="sy-selection-box"
                  style={{
                    left: `calc(${selectionBox.x}px - var(--sy-selection-pad))`,
                    top: `calc(${selectionBox.y}px - var(--sy-selection-pad))`,
                    width: `calc(${selectionBox.width}px + 2 * var(--sy-selection-pad))`,
                    height: `calc(${selectionBox.height}px + 2 * var(--sy-selection-pad))`,
                  }}
                />
              </ViewportPortal>
            )}
            <CursorLayer compact={!multiSelect} />
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
          </FrameActionsContext.Provider>
        </NoteActionsContext.Provider>
      </NoteHelpContext.Provider>
      {marquee.box && (
        <div
          data-marquee
          aria-hidden="true"
          className="pointer-events-none absolute z-10 rounded-sm border border-accent bg-accent-subtle/40"
          style={marquee.box}
        />
      )}
    </section>
  );
}
