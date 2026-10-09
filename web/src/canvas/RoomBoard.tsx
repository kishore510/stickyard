import { ReactFlowProvider, useStore, useStoreApi } from "@xyflow/react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RotateCcw, SlidersHorizontal, Trophy, WifiOff } from "lucide-react";
import {
  FRAME_DEFAULT_H,
  FRAME_DEFAULT_W,
  MAX_FRAMES_PER_ROOM,
  MAX_NOTES_PER_ROOM,
  MAX_SHAPES_PER_ROOM,
  clampFramePosition,
  clampShapePosition,
  shapeDefaults,
  type Frame,
  type FrameColor,
  type NoteColor,
  type ShapeKind,
} from "@stickyard/shared";
import { ChatDock } from "../chat/ChatDock";
import { Button } from "../components/ui/button";
import { readPxToken } from "../lib/cssVar";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useWindowWidth } from "../lib/useWindowWidth";
import { findFrame, isFrameHeld } from "../frames/board";
import { findNote, isHeld, isLocalId, type Board } from "../notes/board";
import { findShape, isShapeHeld } from "../shapes/board";
import type { InlinePart } from "../notes/inlineEdit";
import { AddDrawer, CompactPalette, PaletteContent, type PaletteHost } from "../palette/Palette";
import { cornerLifted, panelWidths, type PanelId } from "../panels/layout";
import { usePanels } from "../panels/panelStore";
import { SidePanel } from "../panels/SidePanel";
import { PropertiesContent } from "../properties/PropertiesPanel";
import { connectionMessage } from "../rooms/connectionText";
import type { OrphanDraft } from "../rooms/resync";
import type { DeleteReport, ReconnectView, RoomView } from "../rooms/session";
import { cn } from "../lib/utils";
import type { useRoom } from "../rooms/useRoom";
import { MEDIA } from "../styles/breakpoints";
import { useTopBarSlot } from "../shell/topBarSlot";
import { TIMER_HINTS } from "../timer/controls";
import { LOCK_TEXT, lockedOut, withLock } from "../facilitation/lock";
import { LockNotices } from "../facilitation/LockNotices";
import { TimerPicker } from "../timer/TimerPicker";
import { VotingStrip } from "../voting/VotingStrip";
import { SilentStrip } from "../silent/SilentStrip";
import { pickResult, useResultRows } from "../voting/Results";
import { VOTE_TEXT } from "../voting/voting";
import { openSheet } from "../shell/nav";
import { createPortal } from "react-dom";
import type { Placed } from "./arrange";
import { BoardCanvas, deleteFrameAsking, deleteSelected, deleteSelectionAsking, deleteShapeAsking, type BoardRoom } from "./BoardCanvas";
import { duplicateDisabledReason } from "./duplicate";
import { BoardBar } from "./SelectionBar";
import type { BoardCommand } from "./shortcuts";
import { orderedIds } from "./selection";
import { newNotePosition, type Placed as ViewItem, type XY } from "./geometry";
import { Ribbon, ViewBar } from "./ToolBars";
import { placeTemplate, templateOrigin } from "../templates/place";
import type { Template } from "../templates/registry";
import { frameToolReason, noteToolReason, shapeToolReason, templateToolReason, toolForKey, type ToolContext } from "./tools";
import { useBoardUi } from "./uiStore";
import { useCanvasView } from "./useCanvasView";
import { zoomSelectionReason } from "./navigation";
import { ViewNotices, showFitNotice } from "./ViewNotices";
import { useCursors } from "../cursors/cursorStore";
import { truncateName } from "../presence/avatars";
import { SILENT_TEXT, revealedOutside, silentNoteReason } from "../silent/silent";
import { FollowNotices } from "../follow/FollowNotices";
import { useFollow } from "../follow/followStore";
import { setViewSource, stopFollowing } from "../follow/actions";
import type { View } from "../follow/follow";

/*
 * The room's board with its tools and panels, loaded on demand (React Flow is only needed in a
 * room, so the start page doesn't download it). RoomScreen starts loading it as soon as a room
 * link opens, so it's ready by the time you've joined.
 */

type Room = ReturnType<typeof useRoom>;

export interface RoomBoardProps {
  view: RoomView;
  room: Room;
  /** A note editor sheet is open (phones: the ribbon hides, so it never sits over the keyboard). */
  editing: boolean;
  onRejoin: () => void;
}

/**
 * The connection's state while disconnected: reconnecting (with the try), offline, the session
 * full, or the relay perhaps over its daily limit, with Rejoin when automatic tries aren't running.
 * A polite status (never an alert): it changes as tries go by.
 */
function ConnectionBar({ reconnect, onRejoin }: { reconnect: ReconnectView | null; onRejoin: () => void }) {
  const message = connectionMessage(reconnect);
  return (
    <div
      role="status"
      data-connection-status=""
      className="pointer-events-auto flex w-full max-w-content flex-wrap items-center gap-sm rounded-md border border-status-warn bg-surface p-sm pl-md shadow-md"
    >
      <WifiOff aria-hidden="true" className="shrink-0 text-status-warn" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{message.title}</span> <span className="text-sm text-fg-muted">{message.detail}</span>
      </p>
      {message.rejoin && (
        <Button variant="primary" onClick={onRejoin}>
          <RotateCcw />
          Rejoin
        </Button>
      )}
    </div>
  );
}

/** Text typed into a note that's gone after a drop: offered back as a new note (plain text). */
function OrphanDraftOffer({ draft, live, onRestore, onDismiss }: { draft: OrphanDraft; live: boolean; onRestore: () => void; onDismiss: () => void }) {
  return (
    <div role="status" data-orphan-draft="" className="pointer-events-auto flex w-full max-w-content flex-col gap-xs rounded-md bg-surface p-sm pl-md text-sm shadow-md">
      <p>
        The note you were typing in isn’t on the board any more. Your text was kept:{" "}
        <q className="break-words whitespace-pre-wrap">{draft.text}</q>
      </p>
      <div className="flex flex-wrap gap-sm">
        <Button variant="primary" onClick={onRestore} disabled={!live}>
          Add as a new note
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/** Notices over the top of the board: connection, refused changes, why notes can't be added. */
const Notices = memo(function Notices({
  status,
  reconnect,
  noteNotice,
  deleteReport,
  historyReport,
  dropReport,
  orphanDraft,
  presenceToast,
  noteReason,
  onRejoin,
  onRestoreDraft,
  onDismissDraft,
  banner,
  viewNotices,
}: {
  status: RoomView["status"];
  reconnect: ReconnectView | null;
  noteNotice: string | null;
  deleteReport: DeleteReport | null;
  /** A restore running, or how the last undo or redo went. */
  historyReport: DeleteReport | null;
  /** What may not have been saved when the connection dropped. */
  dropReport: string | null;
  orphanDraft: OrphanDraft | null;
  /** Who joined or left (plain text). */
  presenceToast: string | null;
  noteReason: string | null;
  onRejoin: () => void;
  onRestoreDraft: () => void;
  onDismissDraft: () => void;
  /** The lock's banner and announcer (facilitation UI), first in the stack. */
  banner?: ReactNode;
  /** What the last view change left out or where it went (v0.24.0), last in the stack. */
  viewNotices?: ReactNode;
}) {
  const live = status === "joined";
  return (
    <div className="pointer-events-none absolute inset-x-0 top-sm z-20 flex flex-col items-center gap-xs px-gutter">
      {!live && <ConnectionBar reconnect={reconnect} onRejoin={onRejoin} />}
      {banner}
      {dropReport && (
        <p role="status" data-drop-report="" className="pointer-events-auto rounded-md bg-surface px-ms py-xs text-sm text-status-warn shadow-md">
          {dropReport}
        </p>
      )}
      {orphanDraft && <OrphanDraftOffer draft={orphanDraft} live={live} onRestore={onRestoreDraft} onDismiss={onDismissDraft} />}
      {noteNotice && (
        <p role="status" className="pointer-events-auto rounded-md bg-surface px-ms py-xs text-sm text-status-warn shadow-md">
          {noteNotice}
        </p>
      )}
      {deleteReport && (
        <p
          role="status"
          className={cn("pointer-events-auto rounded-md bg-surface px-ms py-xs text-sm shadow-md", deleteReport.partial && "text-status-warn")}
        >
          {deleteReport.text}
        </p>
      )}
      {historyReport && (
        <p
          role="status"
          data-history-report=""
          className={cn("pointer-events-auto rounded-md bg-surface px-ms py-xs text-sm shadow-md", historyReport.partial && "text-status-warn")}
        >
          {historyReport.text}
        </p>
      )}
      {noteReason && (
        <p role="status" className="pointer-events-auto rounded-md bg-surface px-ms py-xs text-sm shadow-md">
          {noteReason}
        </p>
      )}
      {/* Join and leave toasts: always in the page so the live region is ready; no focus, no
          buttons, never over the top bar or the phone ribbon; fade only without reduced motion. */}
      <div role="status" aria-live="polite" data-presence-toasts="" className="flex flex-col items-center">
        {presenceToast && <p className="sy-fade-in max-w-content rounded-md bg-surface px-ms py-xs text-sm break-words shadow-md">{presenceToast}</p>}
      </div>
      {viewNotices}
    </div>
  );
});

/** Ignores keys typed into fields, with modifiers, or while a modal sheet is open. */
function shortcutAllowed(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return false;
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest('input, textarea, select, [contenteditable="true"], [role="separator"]')) return false;
  return document.querySelector('[aria-modal="true"]') === null;
}

/** Keys that collapse or expand the side panels (md and up). */
const PANEL_KEYS: Record<string, PanelId> = { "[": "palette", "]": "properties" };

/** The view bar's size, for keeping the bottom-right corner clear of it (and seeing when it wrapped). */
function useBox() {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = () => setBox((b) => (b.width === el.offsetWidth && b.height === el.offsetHeight ? b : { width: el.offsetWidth, height: el.offsetHeight }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
  }, []);
  return [box, ref] as const;
}

/**
 * The board with its tools. From md up: the palette panel on the left, the Properties panel on
 * the right, and the canvas in between with the view bar, minimap and chat button. On phones:
 * the canvas with the ribbon, and the add and editor sheets. Both layouts use the same tool
 * and palette registries and the same actions; the canvas stays mounted across the switch.
 */
function BoardArea({ view, room, editing, onRejoin }: RoomBoardProps) {
  const wide = useMediaQuery(MEDIA.tablet);
  const windowWidth = useWindowWidth();
  // Follow (v0.31.0): my own pan, zoom or view command stops following (and says so once).
  const canvas = useCanvasView({ onUserMove: () => void stopFollowing(latest.current.room.stopOnUserMove) });
  const tool = useBoardUi((s) => s.tool);
  const setTool = useBoardUi((s) => s.setTool);
  const minimapPref = useBoardUi((s) => s.minimap);
  const setMinimap = useBoardUi((s) => s.setMinimap);
  const addSheetOpen = useBoardUi((s) => s.addSheetOpen);
  const selection = useBoardUi((s) => s.selection);
  const frameSelected = useBoardUi((s) => s.frameSelected);
  const frameSelection = useBoardUi((s) => s.frames);
  const shapeSelection = useBoardUi((s) => s.shapes);
  const panels = usePanels();
  const zoom = useStore((s) => s.transform[2]);
  const free = useStore((s) => s.width);
  const live = view.status === "joined";
  const minimap = wide && (minimapPref ?? true);
  // Everyone's notes, the sealed ones of others too (silent brainstorm): the 200 cap counts them.
  const noteCount = view.totalNotes;
  const silentOn = live && view.silent.active;
  const silentNote = live ? silentNoteReason({ active: view.silent.active, writer: view.writer, mine: view.mySealed.size }) : null;
  // Facilitation: a guest on a locked board has every control off with the lock as the reason
  // (courtesy UI; the relay refuses their changes anyway). Hosts keep everything.
  const isHost = view.isHost;
  const lock = { live, locked: view.locked, isHost };
  const locked = lockedOut(lock);
  const noteReason = withLock(noteToolReason({ live, count: noteCount }) ?? silentNote, lock);
  // The timer (host only) needs a connection.
  const timerReason = live ? null : TIMER_HINTS.offline;
  const frameCount = view.board.frames.length;
  const frameReason = withLock(frameToolReason({ live, count: frameCount }), lock);
  const shapeReason = withLock(shapeToolReason({ live, count: view.board.shapes.length }), lock);
  const templateReason = withLock(templateToolReason({ live, applying: view.template?.state === "applying", adding: view.adding }), lock);
  const sizes = panelWidths(windowWidth, panels);

  const latest = useRef({ view, room, wide });
  latest.current = { view, room, wide };

  // Follow (v0.31.0): the view goes where the person I follow looks, as their updates arrive
  // (programmatic moves: they never count as mine). Controls outside the canvas read my view here.
  useEffect(
    () =>
      useFollow.subscribe((s, prev) => {
        if (s.leader && s.leader !== prev.leader && s.following === s.leader.id) canvas.follow(s.leader);
      }),
    [canvas],
  );
  useEffect(() => {
    setViewSource(canvas.view);
    return () => setViewSource(null);
  }, [canvas]);
  const stopFollow = useCallback(() => void stopFollowing(latest.current.room.stopFollow), []);
  // Go there (Bring to me): stop following first (said once), then go, as the page's own move.
  const goThere = useCallback(
    (to: View) => {
      stopFollowing(latest.current.room.stopFollow);
      canvas.showView(to);
    },
    [canvas],
  );

  // Notes deleted (here or by someone else) leave the selection; after a rejoin, only notes that
  // are still on the board stay selected.
  useLayoutEffect(() => {
    // Also the note being edited in place or asked for in Properties (a resync may remove it).
    useBoardUi.getState().pruneSelected((id) => findNote(view.board, id) !== undefined);
    useBoardUi.getState().pruneFrame((id) => findFrame(view.board, id) !== undefined);
    useBoardUi.getState().pruneShapes((id) => findShape(view.board, id) !== undefined);
  }, [view.board]);

  /**
   * Opens a note's editor. From md up: in place on the note (caret in `part`, the title unless
   * said), or the Properties panel (expanded if collapsed) with focus in Title when the note is
   * off screen or it was a finger tap. On phones: the editor sheet (a draft opens it).
   * `fresh`: a note just added, empty. Held (dragged or resized) notes aren't edited.
   */
  const openEditor = useCallback(
    (id: string, { fresh = false, part = "title", touch = false }: { fresh?: boolean; part?: InlinePart; touch?: boolean } = {}) => {
      const { view: v, room: r, wide: w } = latest.current;
      // A note just added isn't in this render's board yet (the session has it).
      const entry = fresh ? null : findNote(v.board, id);
      if ((!fresh && !entry) || v.status !== "joined" || (entry && isHeld(entry))) return;
      if (w) {
        if (!touch && (fresh || (entry && canvas.visible(entry.note)))) {
          useBoardUi.getState().startInlineEdit(id, part);
          return;
        }
        if (usePanels.getState().properties.collapsed) usePanels.getState().setCollapsed("properties", false);
        useBoardUi.getState().requestEdit(id);
        return;
      }
      useBoardUi.getState().select(id);
      r.setDraft(id, entry?.note.text ?? "");
    },
    [canvas],
  );

  /** Adds a note of this colour at `at` (a board position) or the viewport centre, ready to type. */
  const addNote = useCallback(
    (color: NoteColor, at?: XY) => {
      const { view: v, room: r } = latest.current;
      const position = at ?? newNotePosition(canvas.centre(), v.board.notes.map((n) => n.note));
      const id = r.addNote({ ...position, color });
      useBoardUi.getState().setColor(color);
      if (id) openEditor(id, { fresh: true });
    },
    [canvas, openEditor],
  );

  /** Adds a frame of this colour at `at` (a board position) or centred in the view, its title ready to type. */
  const addFrame = useCallback(
    (color: FrameColor, at?: XY) => {
      const centre = canvas.centre();
      const position = at ?? clampFramePosition(centre.x - FRAME_DEFAULT_W / 2, centre.y - FRAME_DEFAULT_H / 2);
      const id = latest.current.room.addFrame({ ...position, color });
      if (id) useBoardUi.getState().requestFrameEdit(id);
    },
    [canvas],
  );

  /** Adds a shape of a kind at `at` (a board position) or centred in the view, its text ready to type (md and up). */
  const addShape = useCallback(
    (kind: ShapeKind, at?: XY) => {
      const centre = canvas.centre();
      const { w, h } = shapeDefaults(kind);
      const position = at ?? clampShapePosition(centre.x - w / 2, centre.y - h / 2, { w, h });
      const id = latest.current.room.addShape({ kind, ...position });
      if (id) useBoardUi.getState().startShapeEdit(id);
    },
    [canvas],
  );

  /**
   * Applies a template: centred on `at`'s box (a drop gives its top-left) or on the viewport
   * centre, clamped onto the board. Nothing existing is touched, so there's no confirmation.
   */
  const applyTemplate = useCallback(
    (template: Template, at?: XY) => {
      const origin = at ?? templateOrigin(template, canvas.centre());
      latest.current.room.applyTemplate(placeTemplate(template, origin));
    },
    [canvas],
  );

  // A template that finished: fit the view to its frames (animated; instant with reduced motion)
  // and select the first. Once per run.
  const fitted = useRef(0);
  const run = view.template;
  useEffect(() => {
    if (!run || run.state !== "done" || run.seq === fitted.current) return;
    fitted.current = run.seq;
    const frames = templateFrames(latest.current.view.board, run.frameIds);
    if (frames.length === 0) return;
    canvas.fit(frames);
    useBoardUi.getState().selectFrame(frames[0]!.id);
  }, [run, canvas]);

  // Zoom to selection (v0.24.0): off, with the reason, while nothing is selected.
  const selectionReason = zoomSelectionReason(selection.size + frameSelection.size + shapeSelection.size);

  // Rebuilt only when what the tools show changes, so remote moves don't re-render the bars.
  const ctx = useMemo<ToolContext>(
    () => ({
      tool,
      setTool,
      zoom,
      minimap,
      noteReason,
      toggleMinimap: () => setMinimap(!minimap),
      // Fit to notes includes frames and shapes; a far outlier is left out (with a notice and Show all, v0.24.0).
      fit: () => {
        const plan = canvas.fitItems(boardItems(latest.current.view.board));
        showFitNotice(plan.partial);
      },
      zoomSelection: () => {
        const { board } = latest.current.view;
        const ui = useBoardUi.getState();
        const items = [
          ...[...ui.selection].flatMap((id) => findNote(board, id)?.note ?? []),
          ...[...ui.frames].flatMap((id) => findFrame(board, id)?.frame ?? []),
          ...[...ui.shapes].flatMap((id) => findShape(board, id)?.shape ?? []),
        ];
        if (canvas.zoomTo(items)) ui.setViewNotice(null);
      },
      selectionReason,
      zoomIn: canvas.zoomIn,
      zoomOut: canvas.zoomOut,
      resetZoom: canvas.resetZoom,
      addNote: () => {
        if (latest.current.wide) addNote(useBoardUi.getState().color);
        else useBoardUi.getState().setAddSheetOpen(true);
      },
      undo: () => latest.current.room.undo(),
      redo: () => latest.current.room.redo(),
      undoReason: view.history.undo,
      redoReason: view.history.redo,
    }),
    [tool, setTool, zoom, minimap, noteReason, setMinimap, canvas, addNote, view.history.undo, view.history.redo, selectionReason],
  );

  const paletteHost = useMemo<PaletteHost>(
    () => ({
      ctx: { noteReason, frameReason, templateReason, timerReason, shapeReason },
      state: { live, noteCount, isHost },
      activate: (item, at) => {
        useBoardUi.getState().setAddSheetOpen(false);
        item.create({ addNote, addFrame, applyTemplate, addShape, openTimer: () => useBoardUi.getState().setTimerPickerOpen(true) }, at);
      },
      dropAt: canvas.dropAt,
    }),
    [noteReason, frameReason, templateReason, timerReason, shapeReason, live, noteCount, isHost, addNote, addFrame, applyTemplate, addShape, canvas],
  );

  const rejoinRef = useRef(onRejoin);
  rejoinRef.current = onRejoin;
  const rejoin = useCallback(() => rejoinRef.current(), []);
  const restoreDraft = useCallback(() => void latest.current.room.restoreDraft(), []);
  const dismissDraft = useCallback(() => latest.current.room.dismissDraft(), []);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  // Single-key shortcuts from the registry (V, H, N, F, M, +, -, 0), and [ / ] for the panels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shortcutAllowed(e)) return;
      const panel = PANEL_KEYS[e.key];
      if (panel) {
        if (!latest.current.wide) return;
        e.preventDefault();
        usePanels.getState().toggle(panel);
        return;
      }
      const t = toolForKey(e.key);
      if (!t || t.disabled?.(ctxRef.current)) return;
      e.preventDefault();
      t.run(ctxRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const deleteSelection = room.deleteSelection;

  const boardRoom: BoardRoom = {
    board: view.board,
    live,
    startDrag: room.startDrag,
    moveNote: room.moveNote,
    startResize: room.startResize,
    resizeNote: room.resizeNote,
    deleteNote: room.deleteNote,
    openEditor,
    setDraft: room.setDraft,
    editNote: room.editNote,
    startGroupDrag: room.startGroupDrag,
    moveGroup: room.moveGroup,
    deleteNotes: room.deleteNotes,
    startFrameDrag: room.startFrameDrag,
    moveFrame: room.moveFrame,
    setFrameDraft: room.setFrameDraft,
    editFrame: room.editFrame,
    startFrameResize: room.startFrameResize,
    resizeFrame: room.resizeFrame,
    deleteFrame: room.deleteFrame,
    deleteSelection,
    startSelectionDrag: room.startSelectionDrag,
    moveSelection: room.moveSelection,
    shareCursor: room.shareCursor,
    hideCursor: room.hideCursor,
    shareViewport: room.shareViewport,
    startShapeDrag: room.startShapeDrag,
    moveShape: room.moveShape,
    startShapeResize: room.startShapeResize,
    resizeShape: room.resizeShape,
    setShapeDraft: room.setShapeDraft,
    editShape: room.editShape,
    deleteShape: room.deleteShape,
  };

  // The bar: md and up, always there. Notes in selection order (the first is Match size's reference).
  const selectedEntries = wide ? orderedIds(selection).flatMap((id) => findNote(view.board, id) ?? []) : [];
  const selectedNotes: Placed[] = selectedEntries.map((e) => e.note);
  const frameEntry = wide && frameSelected !== null ? findFrame(view.board, frameSelected) : undefined;
  // Every selected frame (v0.20.0); `group` when frames are selected with anything else.
  const selectedFrameEntries = wide ? orderedIds(frameSelection).flatMap((id) => findFrame(view.board, id) ?? []) : [];
  // Selected shapes (protocol v15), in selection order.
  const selectedShapeEntries = wide ? orderedIds(shapeSelection).flatMap((id) => findShape(view.board, id) ?? []) : [];
  const shapeCount = selectedShapeEntries.length;
  // Several items with frames or shapes in them move, duplicate and delete as one selection.
  const group = selectedFrameEntries.length + shapeCount > 0 && selectedFrameEntries.length + selectedEntries.length + shapeCount > 1;
  const framesHeld = selectedFrameEntries.some(isFrameHeld);
  const framesUnsaved = selectedFrameEntries.some((e) => e.confirmed === null);
  const shapesHeld = selectedShapeEntries.some(isShapeHeld);
  const shapesUnsaved = selectedShapeEntries.some((e) => e.confirmed === null);
  const duplicateReason = withLock(duplicateDisabledReason({
    notes: selectedEntries.length,
    frame: selectedFrameEntries.length > 0,
    frames: selectedFrameEntries.length,
    shapes: shapeCount,
    live,
    held: selectedEntries.some(isHeld) || framesHeld || shapesHeld,
    unsaved: selectedEntries.some((e) => e.confirmed === null) || framesUnsaved || shapesUnsaved,
    busy: view.adding,
    freeNotes: Math.max(0, MAX_NOTES_PER_ROOM - noteCount),
    freeFrames: Math.max(0, MAX_FRAMES_PER_ROOM - frameCount),
    freeShapes: Math.max(0, MAX_SHAPES_PER_ROOM - view.board.shapes.length),
  }) ?? (selectedEntries.length > 0 ? silentNote : null), lock);

  /** Duplicates the selection (notes, the frame alone, shapes, or a mix) and selects the copies. */
  const duplicate = () => {
    if (duplicateReason !== null) return room.showNotice(duplicateReason);
    if (group || shapeCount > 0) {
      const ids = room.duplicateSelection(
        selectedEntries.map((e) => e.note.id),
        selectedFrameEntries.map((e) => e.frame.id),
        selectedShapeEntries.map((e) => e.shape.id),
      );
      if (ids) useBoardUi.getState().setSelections(new Set(ids.notes), new Set(ids.frames), new Set(ids.shapes));
      return;
    }
    if (frameEntry) {
      const id = room.duplicateFrame(frameEntry.frame.id);
      if (id) useBoardUi.getState().selectFrame(id);
      return;
    }
    const ids = room.duplicateNotes(selectedEntries.map((e) => e.note.id));
    if (ids && ids.length > 0) useBoardUi.getState().setSelection(new Set(ids));
  };

  /** Deletes the selection as the Delete key does (same confirms and report). */
  const removeSelection = () => {
    if (group) {
      return deleteSelectionAsking(
        { board: view.board, live, deleteSelection },
        selectedEntries.map((e) => e.note.id),
        selectedFrameEntries.map((e) => e.frame.id),
        selectedShapeEntries.map((e) => e.shape.id),
      );
    }
    const onlyShape = selectedShapeEntries[0];
    if (onlyShape) return deleteShapeAsking({ board: view.board, deleteShape: room.deleteShape }, onlyShape.shape.id);
    if (frameEntry) return deleteFrameAsking({ board: view.board, deleteFrame: room.deleteFrame }, frameEntry.frame.id);
    deleteSelected({ board: view.board, live, deleteNote: room.deleteNote, deleteNotes: room.deleteNotes }, selectedEntries.map((e) => e.note.id));
  };

  /** Undo or redo (Ctrl+Z, the bar, the ribbon); off says why. */
  const undo = () => (view.history.undo === null ? room.undo() : room.showNotice(view.history.undo));
  const redo = () => (view.history.redo === null ? room.redo() : room.showNotice(view.history.redo));

  const commands = useRef<Record<BoardCommand, () => void>>({ duplicate, undo, redo });
  commands.current = { duplicate, undo, redo };
  const onShortcut = useCallback((command: BoardCommand) => commands.current[command](), []);

  const barSlot = useTopBarSlot((s) => s.el);
  // Dot voting results (closed rounds): the Properties summary lists them; a row (here or in the
  // phone Results sheet) asks for its note to be selected and shown.
  const resultRows = useResultRows(view.results, view.board);
  // Export PNG draws React Flow's viewport element (export/png.ts).
  const flowStore = useStoreApi();
  const exportViewport = useCallback(() => flowStore.getState().domNode?.querySelector<HTMLElement>(".react-flow__viewport") ?? null, [flowStore]);
  const revealRequest = useBoardUi((s) => s.revealRequest);
  useEffect(() => {
    if (!revealRequest) return;
    const entry = findNote(latest.current.view.board, revealRequest.id);
    if (entry) canvas.reveal(entry.note);
  }, [revealRequest, canvas]);
  // Participants' Go to (v0.24.0): pan to that person's last known pointer and say so (politely).
  const jumpRequest = useBoardUi((s) => s.jumpRequest);
  useEffect(() => {
    if (!jumpRequest) return;
    const point = useCursors.getState().lastSeen.get(jumpRequest.id);
    const person = latest.current.view.participants.find((p) => p.id === jumpRequest.id);
    if (!point || !person) return;
    canvas.jumpTo(point);
    useBoardUi.getState().setViewNotice({ kind: "jump", name: truncateName(person.name), n: jumpRequest.n });
  }, [jumpRequest, canvas]);
  const showAll = useCallback(() => {
    canvas.fit(boardItems(latest.current.view.board));
    useBoardUi.getState().setViewNotice(null);
  }, [canvas]);
  // Show results: the phone sheet, or (md and up) Properties with nothing selected.
  const showResults = useCallback(() => {
    if (!latest.current.wide) return openSheet({ kind: "results" });
    useBoardUi.getState().clearSelection();
    if (usePanels.getState().properties.collapsed) usePanels.getState().setCollapsed("properties", false);
  }, []);
  // After a silent round's reveal (v0.28.0): never a view change; a line with Fit to notes only
  // when some of the notes it brought are out of view.
  const revealSeq = view.lastReveal?.seq ?? 0;
  useEffect(() => {
    const reveal = latest.current.view.lastReveal;
    if (!reveal || reveal.seq !== revealSeq) return;
    const { board } = latest.current.view;
    const outside = revealedOutside(reveal.ids, (id) => {
      const note = findNote(board, id)?.note;
      return note === undefined || canvas.visible(note);
    });
    if (outside) useBoardUi.getState().setViewNotice({ kind: "revealed", n: revealSeq });
  }, [revealSeq, canvas]);
  const closed = view.voting.state === "closed";
  // The lock's banner first, then the voting strip under it (v0.18.0), then the silent brainstorm
  // strip (v0.28.0): both show when a round runs during a vote.
  const lockNotices = useMemo(
    () => (
      <>
        <LockNotices locked={view.locked} isHost={isHost} />
        <VotingStrip
          voting={view.voting}
          remaining={view.remaining}
          action={
            closed ? (
              <Button variant="ghost" className="-my-xs" onClick={showResults}>
                <Trophy />
                {VOTE_TEXT.showResults}
              </Button>
            ) : null
          }
        />
        <SilentStrip silent={view.silent} mine={view.mySealed.size} />
        {/* Follow and Bring to me (v0.31.0): under the strips, so they stack and never overlap. */}
        <FollowNotices wide={wide} onStop={stopFollow} onGo={goThere} />
      </>
    ),
    [view.locked, isHost, view.voting, view.remaining, closed, showResults, view.silent, view.mySealed, wide, stopFollow, goThere],
  );
  const bar = wide ? (
    <BoardBar
      notes={selectedNotes}
      frames={selectedFrameEntries.map((e) => e.frame)}
      framesHeld={framesHeld}
      framesUnsaved={framesUnsaved}
      applyFrames={(rects) => room.applyFrameRects(rects)}
      frame={frameEntry !== undefined || selectedFrameEntries.length > 0}
      live={live}
      held={selectedEntries.some(isHeld)}
      unsaved={selectedEntries.some((e) => isLocalId(e.note.id))}
      duplicateReason={duplicateReason}
      duplicate={duplicate}
      undoReason={view.history.undo}
      redoReason={view.history.redo}
      undo={() => room.undo()}
      redo={() => room.redo()}
      remove={removeSelection}
      apply={(rects) => room.applyRects(rects)}
      order={(action) => room.orderNotes([...selectedNotes.map((n) => n.id), ...selectedShapeEntries.map((e) => e.shape.id)], action)}
      shapes={selectedShapeEntries.map((e) => e.shape)}
      shapesHeld={shapesHeld}
      shapesUnsaved={shapesUnsaved}
      notice={(text) => room.showNotice(text)}
      lockedReason={live && locked ? LOCK_TEXT.reason : null}
      silentReason={silentOn ? SILENT_TEXT.on : null}
      session={isHost ? { locked: view.locked, pending: view.lockPending, setLock: (on: boolean) => room.setLock(on) } : null}
    />
  ) : null;

  // The minimap and chat button share the free area's bottom-right corner with the centred view
  // bar: when there isn't room for both side by side, they move up above it.
  const [barBox, barRef] = useBox();
  const barWidth = barBox.width;
  // Taller than one row of touch targets: the bar wrapped (a narrow canvas), so what sits above it moves up a row.
  const barWrapped = wide && barBox.height > 1.5 * readPxToken("--sy-touch-min", 44);
  const lifted =
    wide &&
    barWidth > 0 &&
    cornerLifted({
      free,
      bar: barWidth,
      corner: minimap ? readPxToken("--sy-minimap-width", 200) : readPxToken("--sy-touch-min", 44),
      edge: readPxToken("--sy-gutter", 16),
      // Spacing tokens are in rem; the gutter is px.
      gap: readPxToken("--sy-gutter", 16),
    });
  const dock = lifted ? (minimap ? "bar-minimap" : "bar") : minimap ? "minimap" : "edge";

  return (
    <div className="absolute inset-0 flex overflow-hidden">
      {wide && (
        <SidePanel
          label="Palette"
          name="palette"
          side="left"
          size={sizes.palette}
          collapsed={panels.palette.collapsed}
          shortcut="["
          onToggle={() => panels.toggle("palette")}
          onWidth={(w) => panels.setWidth("palette", w)}
          strip={<CompactPalette host={paletteHost} />}
        >
          {(collapse) => <PaletteContent host={paletteHost} width={sizes.palette.width} collapse={collapse} />}
        </SidePanel>
      )}
      <div className={cn("relative min-w-0 flex-1 overflow-hidden", barWrapped && "sy-bar-wrapped")}>
        <BoardCanvas
          room={boardRoom}
          editable={live && !locked}
          multiSelect={wide}
          synced={view.synced}
          minimap={minimap}
          minimapLifted={lifted}
          view={canvas}
          onShortcut={onShortcut}
        />
        <Notices
          status={view.status}
          reconnect={view.reconnect}
          noteNotice={view.noteNotice}
          deleteReport={view.deleteReport}
          historyReport={view.historyReport}
          dropReport={view.dropReport}
          orphanDraft={view.orphanDraft}
          presenceToast={view.presenceToast?.text ?? null}
          noteReason={locked ? null : noteReason}
          onRejoin={rejoin}
          onRestoreDraft={restoreDraft}
          onDismissDraft={dismissDraft}
          banner={lockNotices}
          viewNotices={<ViewNotices onShowAll={showAll} onFit={ctx.fit} />}
        />
        {/* The board actions live in the top bar (v0.15.1), between the mark and the menu. */}
        {bar && barSlot && createPortal(bar, barSlot)}
        {wide ? (
          <>
            <ViewBar ctx={ctx} barRef={barRef} wrapped={barWrapped} />
            <ChatDock bottom={dock} />
          </>
        ) : (
          !editing && <Ribbon ctx={ctx} />
        )}
      </div>
      {wide && (
        <SidePanel
          label="Properties"
          name="Properties"
          side="right"
          size={sizes.properties}
          collapsed={panels.properties.collapsed}
          shortcut="]"
          onToggle={() => panels.toggle("properties")}
          onWidth={(w) => panels.setWidth("properties", w)}
          strip={
            <Button variant="ghost" size="icon" aria-label="Properties" title="Properties" onClick={() => panels.setCollapsed("properties", false)}>
              <SlidersHorizontal />
            </Button>
          }
        >
          {(collapse) => (
            <PropertiesContent
              collapse={collapse}
              room={{
                board: view.board,
                live,
                you: view.you,
                yourIds: view.yourIds,
                people: view.people,
                participants: view.participants,
                setDraft: room.setDraft,
                editNote: room.editNote,
                styleNote: room.styleNote,
                setNoteSize: room.setNoteSize,
                deleteNote: room.deleteNote,
                deleteNotes: room.deleteNotes,
                orderNotes: room.orderNotes,
                setFrameDraft: room.setFrameDraft,
                editFrame: room.editFrame,
                editFrames: room.editFrames,
                setFrameSize: room.setFrameSize,
                deleteFrame: room.deleteFrame,
                setShapeDraft: room.setShapeDraft,
                editShape: room.editShape,
                editShapes: room.editShapes,
                setShapeSize: room.setShapeSize,
                deleteShape: room.deleteShape,
                deleteSelection,
                clearBoard: room.clearBoard,
                adding: view.adding,
                clearing: view.clearing,
                deleting: view.deleting,
                locked,
                isHost,
                endSession: room.endSession,
                results: resultRows,
                onPickResult: pickResult,
                exportViewport,
                silent: silentOn,
                silentRound: { silent: view.silent, mine: view.mySealed.size },
              }}
            />
          )}
        </SidePanel>
      )}
      {wide && <TimerPicker />}
      {!wide && <AddDrawer host={paletteHost} open={addSheetOpen} onClose={() => useBoardUi.getState().setAddSheetOpen(false)} />}
    </div>
  );
}

export default function RoomBoard(props: RoomBoardProps) {
  return (
    <ReactFlowProvider>
      <BoardArea {...props} />
    </ReactFlowProvider>
  );
}

/** Everything Fit to notes fits: notes, frames and shapes. */
function boardItems(board: Board): ViewItem[] {
  return [...board.notes.map((n) => n.note), ...board.frames.map((f) => f.frame), ...board.shapes.map((x) => x.shape)];
}

/** A template run's frames that are still on the board, in template order. */
function templateFrames(board: Board, ids: readonly string[]): Frame[] {
  return ids.flatMap((id) => findFrame(board, id)?.frame ?? []);
}
