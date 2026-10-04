import { ReactFlowProvider, useStore } from "@xyflow/react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RotateCcw, SlidersHorizontal, WifiOff } from "lucide-react";
import {
  FRAME_DEFAULT_H,
  FRAME_DEFAULT_W,
  MAX_FRAMES_PER_ROOM,
  MAX_NOTES_PER_ROOM,
  clampFramePosition,
  type Frame,
  type FrameColor,
  type NoteColor,
} from "@stickyard/shared";
import { ChatDock } from "../chat/ChatDock";
import { Button } from "../components/ui/button";
import { readPxToken } from "../lib/cssVar";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useWindowWidth } from "../lib/useWindowWidth";
import { findFrame, isFrameHeld } from "../frames/board";
import { findNote, isHeld, isLocalId, type Board } from "../notes/board";
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
import { TimerPicker } from "../timer/TimerPicker";
import { createPortal } from "react-dom";
import type { Placed } from "./arrange";
import { BoardCanvas, deleteFrameAsking, deleteSelected, type BoardRoom } from "./BoardCanvas";
import { duplicateDisabledReason } from "./duplicate";
import { BoardBar } from "./SelectionBar";
import type { BoardCommand } from "./shortcuts";
import { orderedIds } from "./selection";
import { newNotePosition, type XY } from "./geometry";
import { Ribbon, ViewBar } from "./ToolBars";
import { placeTemplate, templateOrigin } from "../templates/place";
import type { Template } from "../templates/registry";
import { frameToolReason, noteToolReason, templateToolReason, toolForKey, type ToolContext } from "./tools";
import { useBoardUi } from "./uiStore";
import { useCanvasView } from "./useCanvasView";

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
}) {
  const live = status === "joined";
  return (
    <div className="pointer-events-none absolute inset-x-0 top-sm z-20 flex flex-col items-center gap-xs px-gutter">
      {!live && <ConnectionBar reconnect={reconnect} onRejoin={onRejoin} />}
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

/** The view bar's width, for keeping the bottom-right corner clear of it. */
function useWidth() {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setWidth(el.offsetWidth);
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(() => setWidth(el.offsetWidth));
    observer.current.observe(el);
  }, []);
  return [width, ref] as const;
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
  const canvas = useCanvasView();
  const tool = useBoardUi((s) => s.tool);
  const setTool = useBoardUi((s) => s.setTool);
  const minimapPref = useBoardUi((s) => s.minimap);
  const setMinimap = useBoardUi((s) => s.setMinimap);
  const addSheetOpen = useBoardUi((s) => s.addSheetOpen);
  const selection = useBoardUi((s) => s.selection);
  const frameSelected = useBoardUi((s) => s.frameSelected);
  const panels = usePanels();
  const zoom = useStore((s) => s.transform[2]);
  const free = useStore((s) => s.width);
  const live = view.status === "joined";
  const minimap = wide && (minimapPref ?? true);
  const noteCount = view.board.notes.length;
  const noteReason = noteToolReason({ live, count: noteCount });
  // Facilitation (host only): the timer needs a connection.
  const isHost = view.isHost;
  const timerReason = live ? null : TIMER_HINTS.offline;
  const frameCount = view.board.frames.length;
  const frameReason = frameToolReason({ live, count: frameCount });
  const templateReason = templateToolReason({ live, applying: view.template?.state === "applying", adding: view.adding });
  const sizes = panelWidths(windowWidth, panels);

  const latest = useRef({ view, room, wide });
  latest.current = { view, room, wide };

  // Notes deleted (here or by someone else) leave the selection; after a rejoin, only notes that
  // are still on the board stay selected.
  useLayoutEffect(() => {
    // Also the note being edited in place or asked for in Properties (a resync may remove it).
    useBoardUi.getState().pruneSelected((id) => findNote(view.board, id) !== undefined);
    useBoardUi.getState().pruneFrame((id) => findFrame(view.board, id) !== undefined);
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

  // Rebuilt only when what the tools show changes, so remote moves don't re-render the bars.
  const ctx = useMemo<ToolContext>(
    () => ({
      tool,
      setTool,
      zoom,
      minimap,
      noteReason,
      toggleMinimap: () => setMinimap(!minimap),
      // Fit to notes includes frames.
      fit: () => canvas.fit([...latest.current.view.board.notes.map((n) => n.note), ...latest.current.view.board.frames.map((f) => f.frame)]),
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
    [tool, setTool, zoom, minimap, noteReason, setMinimap, canvas, addNote, view.history.undo, view.history.redo],
  );

  const paletteHost = useMemo<PaletteHost>(
    () => ({
      ctx: { noteReason, frameReason, templateReason, timerReason },
      state: { live, noteCount, isHost },
      activate: (item, at) => {
        useBoardUi.getState().setAddSheetOpen(false);
        item.create({ addNote, addFrame, applyTemplate, openTimer: () => useBoardUi.getState().setTimerPickerOpen(true) }, at);
      },
      dropAt: canvas.dropAt,
    }),
    [noteReason, frameReason, templateReason, timerReason, live, noteCount, isHost, addNote, addFrame, applyTemplate, canvas],
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
  };

  // The bar: md and up, always there. Notes in selection order (the first is Match size's reference).
  const selectedEntries = wide ? orderedIds(selection).flatMap((id) => findNote(view.board, id) ?? []) : [];
  const selectedNotes: Placed[] = selectedEntries.map((e) => e.note);
  const frameEntry = wide && frameSelected !== null ? findFrame(view.board, frameSelected) : undefined;
  const duplicateReason = duplicateDisabledReason({
    notes: selectedEntries.length,
    frame: frameEntry !== undefined,
    live,
    held: selectedEntries.some(isHeld) || (frameEntry !== undefined && isFrameHeld(frameEntry)),
    unsaved: selectedEntries.some((e) => e.confirmed === null) || frameEntry?.confirmed === null,
    busy: view.adding,
    freeNotes: Math.max(0, MAX_NOTES_PER_ROOM - noteCount),
    freeFrames: Math.max(0, MAX_FRAMES_PER_ROOM - frameCount),
  });

  /** Duplicates the selection (notes, or the frame alone) and selects the copies. */
  const duplicate = () => {
    if (duplicateReason !== null) return room.showNotice(duplicateReason);
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
  const bar = wide ? (
    <BoardBar
      notes={selectedNotes}
      frame={frameEntry !== undefined}
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
      order={(action) => room.orderNotes(selectedNotes.map((n) => n.id), action)}
      notice={(text) => room.showNotice(text)}
    />
  ) : null;

  // The minimap and chat button share the free area's bottom-right corner with the centred view
  // bar: when there isn't room for both side by side, they move up above it.
  const [barWidth, barRef] = useWidth();
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
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <BoardCanvas
          room={boardRoom}
          editable={live}
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
          noteReason={noteReason}
          onRejoin={rejoin}
          onRestoreDraft={restoreDraft}
          onDismissDraft={dismissDraft}
        />
        {/* The board actions live in the top bar (v0.15.1), between the mark and the menu. */}
        {bar && barSlot && createPortal(bar, barSlot)}
        {wide ? (
          <>
            <ViewBar ctx={ctx} barRef={barRef} />
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
                setFrameSize: room.setFrameSize,
                deleteFrame: room.deleteFrame,
                clearBoard: room.clearBoard,
                adding: view.adding,
                clearing: view.clearing,
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

/** A template run's frames that are still on the board, in template order. */
function templateFrames(board: Board, ids: readonly string[]): Frame[] {
  return ids.flatMap((id) => findFrame(board, id)?.frame ?? []);
}
