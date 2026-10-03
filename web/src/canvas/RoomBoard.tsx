import { ReactFlowProvider, useStore } from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { RotateCcw } from "lucide-react";
import { ChatDock } from "../chat/ChatDock";
import { Button } from "../components/ui/button";
import { useMediaQuery } from "../lib/useMediaQuery";
import type { RoomView } from "../rooms/session";
import type { useRoom } from "../rooms/useRoom";
import { MEDIA } from "../styles/breakpoints";
import { BoardCanvas, type BoardRoom } from "./BoardCanvas";
import { newNotePosition } from "./geometry";
import { Ribbon, ToolRail, ViewBar } from "./ToolBars";
import { noteToolReason, toolForKey, type ToolContext } from "./tools";
import { useBoardUi } from "./uiStore";
import { useCanvasView } from "./useCanvasView";

/*
 * The room's board with its tools, loaded on demand (React Flow is only needed in a room,
 * so the start page doesn't download it). RoomScreen starts loading it as soon as a room
 * link opens, so it's ready by the time you've joined.
 */

type Room = ReturnType<typeof useRoom>;

export interface RoomBoardProps {
  view: RoomView;
  room: Room;
  /** A note editor is open (the phone ribbon hides, so it never sits over the keyboard). */
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
  if (target?.closest('input, textarea, select, [contenteditable="true"]')) return false;
  return document.querySelector('[aria-modal="true"]') === null;
}

/**
 * The board with its tools: canvas, then (md and up) the rail, view bar, minimap and chat
 * button, or (phones) the ribbon. Both layouts use the same tool registry and actions.
 */
function BoardArea({ view, room, editing, onRejoin }: RoomBoardProps) {
  const wide = useMediaQuery(MEDIA.tablet);
  const canvas = useCanvasView();
  const tool = useBoardUi((s) => s.tool);
  const setTool = useBoardUi((s) => s.setTool);
  const minimapPref = useBoardUi((s) => s.minimap);
  const setMinimap = useBoardUi((s) => s.setMinimap);
  const zoom = useStore((s) => s.transform[2]);
  const live = view.status === "joined";
  const minimap = wide && (minimapPref ?? true);
  const noteReason = noteToolReason({ live, count: view.board.notes.length });

  const latest = useRef({ view, room });
  latest.current = { view, room };

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
      const { view: v, room: r } = latest.current;
      const at = newNotePosition(canvas.centre(), v.board.notes.map((n) => n.note));
      const id = r.addNote({ ...at, color: useBoardUi.getState().color });
      // Straight into typing.
      if (id) r.setDraft(id, "");
    },
  }),
    [tool, setTool, zoom, minimap, noteReason, setMinimap, canvas],
  );
  const rejoinRef = useRef(onRejoin);
  rejoinRef.current = onRejoin;
  const rejoin = useCallback(() => rejoinRef.current(), []);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  // Single-key shortcuts from the registry (V, H, N, F, M, +, -, 0).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shortcutAllowed(e)) return;
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
    deleteNote: room.deleteNote,
    openEditor: (id) => {
      const entry = latest.current.view.board.notes.find((n) => n.note.id === id);
      if (entry && latest.current.view.status === "joined") latest.current.room.setDraft(id, entry.note.text);
    },
  };

  return (
    <div className="absolute inset-0 overflow-hidden">
      <BoardCanvas room={boardRoom} editable={live} synced={view.synced} minimap={minimap} view={canvas} />
      <Notices status={view.status} noteNotice={view.noteNotice} noteReason={noteReason} onRejoin={rejoin} />
      {wide ? (
        <>
          <ToolRail ctx={ctx} />
          <ViewBar ctx={ctx} />
          <ChatDock aboveMinimap={minimap} />
        </>
      ) : (
        !editing && <Ribbon ctx={ctx} />
      )}
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
