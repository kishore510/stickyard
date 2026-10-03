import { ReactFlowProvider, useStore } from "@xyflow/react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, SlidersHorizontal } from "lucide-react";
import type { NoteColor } from "@stickyard/shared";
import { ChatDock } from "../chat/ChatDock";
import { Button } from "../components/ui/button";
import { readPxToken } from "../lib/cssVar";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useWindowWidth } from "../lib/useWindowWidth";
import { findNote } from "../notes/board";
import { AddDrawer, CompactPalette, PaletteContent, type PaletteHost } from "../palette/Palette";
import { cornerLifted, panelWidths, type PanelId } from "../panels/layout";
import { usePanels } from "../panels/panelStore";
import { SidePanel } from "../panels/SidePanel";
import { PropertiesContent } from "../properties/PropertiesPanel";
import type { RoomView } from "../rooms/session";
import type { useRoom } from "../rooms/useRoom";
import { MEDIA } from "../styles/breakpoints";
import { BoardCanvas, type BoardRoom } from "./BoardCanvas";
import { newNotePosition, type XY } from "./geometry";
import { Ribbon, ViewBar } from "./ToolBars";
import { noteToolReason, toolForKey, type ToolContext } from "./tools";
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

/** Notices over the top of the board: connection, refused changes, why notes can't be added. */
const Notices = memo(function Notices({
  status,
  noteNotice,
  noteReason,
  onRejoin,
}: {
  status: RoomView["status"];
  noteNotice: string | null;
  noteReason: string | null;
  onRejoin: () => void;
}) {
  const live = status === "joined";
  return (
    <div className="pointer-events-none absolute inset-x-0 top-sm z-20 flex flex-col items-center gap-xs px-gutter">
      {!live && (
        <div role="alert" className="pointer-events-auto flex flex-wrap items-center gap-sm rounded-md border border-status-error bg-surface p-sm pl-md shadow-md">
          <p className="font-medium">
            {status === "connecting" ? "Rejoining…" : "Connection lost. You’re no longer in the session."}
          </p>
          {status !== "connecting" && (
            <Button variant="primary" onClick={onRejoin}>
              <RotateCcw />
              Rejoin
            </Button>
          )}
        </div>
      )}
      {noteNotice && (
        <p role="status" className="pointer-events-auto rounded-md bg-surface px-ms py-xs text-sm text-status-warn shadow-md">
          {noteNotice}
        </p>
      )}
      {noteReason && (
        <p role="status" className="pointer-events-auto rounded-md bg-surface px-ms py-xs text-sm shadow-md">
          {noteReason}
        </p>
      )}
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
  const panels = usePanels();
  const zoom = useStore((s) => s.transform[2]);
  const free = useStore((s) => s.width);
  const live = view.status === "joined";
  const minimap = wide && (minimapPref ?? true);
  const noteCount = view.board.notes.length;
  const noteReason = noteToolReason({ live, count: noteCount });
  const sizes = panelWidths(windowWidth, panels);

  const latest = useRef({ view, room, wide });
  latest.current = { view, room, wide };

  // Notes deleted (here or by someone else) leave the selection.
  useLayoutEffect(() => {
    useBoardUi.getState().pruneSelected((id) => findNote(view.board, id) !== undefined);
  }, [view.board]);

  /**
   * Opens a note's editor: from md up, the Properties panel (expanded if collapsed) with focus in
   * Title; on phones, the editor sheet (a draft opens it). `fresh`: a note just added, empty.
   */
  const openEditor = useCallback((id: string, fresh = false) => {
    const { view: v, room: r, wide: w } = latest.current;
    // A note just added isn't in this render's board yet (the session has it).
    const entry = fresh ? null : findNote(v.board, id);
    if ((!fresh && !entry) || v.status !== "joined") return;
    if (w) {
      if (usePanels.getState().properties.collapsed) usePanels.getState().setCollapsed("properties", false);
      useBoardUi.getState().requestEdit(id);
      return;
    }
    useBoardUi.getState().select(id);
    r.setDraft(id, entry?.note.text ?? "");
  }, []);

  /** Adds a note of this colour at `at` (a board position) or the viewport centre, ready to type. */
  const addNote = useCallback(
    (color: NoteColor, at?: XY) => {
      const { view: v, room: r } = latest.current;
      const position = at ?? newNotePosition(canvas.centre(), v.board.notes.map((n) => n.note));
      const id = r.addNote({ ...position, color });
      useBoardUi.getState().setColor(color);
      if (id) openEditor(id, true);
    },
    [canvas, openEditor],
  );

  // Rebuilt only when what the tools show changes, so remote moves don't re-render the bars.
  const ctx = useMemo<ToolContext>(
    () => ({
      tool,
      setTool,
      zoom,
      minimap,
      noteReason,
      toggleMinimap: () => setMinimap(!minimap),
      fit: () => canvas.fit(latest.current.view.board.notes.map((n) => n.note)),
      zoomIn: canvas.zoomIn,
      zoomOut: canvas.zoomOut,
      resetZoom: canvas.resetZoom,
      addNote: () => {
        if (latest.current.wide) addNote(useBoardUi.getState().color);
        else useBoardUi.getState().setAddSheetOpen(true);
      },
    }),
    [tool, setTool, zoom, minimap, noteReason, setMinimap, canvas, addNote],
  );

  const paletteHost = useMemo<PaletteHost>(
    () => ({
      ctx: { noteReason },
      state: { live, noteCount },
      activate: (item, at) => {
        useBoardUi.getState().setAddSheetOpen(false);
        item.create({ addNote }, at);
      },
      dropAt: canvas.dropAt,
    }),
    [noteReason, live, noteCount, addNote, canvas],
  );

  const rejoinRef = useRef(onRejoin);
  rejoinRef.current = onRejoin;
  const rejoin = useCallback(() => rejoinRef.current(), []);
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
    startDrag: room.startDrag,
    moveNote: room.moveNote,
    startResize: room.startResize,
    resizeNote: room.resizeNote,
    deleteNote: room.deleteNote,
    openEditor,
  };

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
          synced={view.synced}
          minimap={minimap}
          minimapLifted={lifted}
          view={canvas}
        />
        <Notices status={view.status} noteNotice={view.noteNotice} noteReason={noteReason} onRejoin={rejoin} />
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
                people: view.people,
                participants: view.participants,
                setDraft: room.setDraft,
                editNote: room.editNote,
                styleNote: room.styleNote,
                setNoteSize: room.setNoteSize,
                deleteNote: room.deleteNote,
              }}
            />
          )}
        </SidePanel>
      )}
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
