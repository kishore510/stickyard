import { useEffect, useRef, useState } from "react";
import type { FrameColor, NoteColor, NoteRect, OrderAction } from "@stickyard/shared";
import { WORKER_URL, toWebSocketUrl } from "../config";
import { browserSocketFactory } from "../connection/socket";
import { useBoardUi } from "../canvas/uiStore";
import { STORAGE_KEYS, writeKey } from "../storage";
import { browserFetch, checkRoom } from "./api";
import type { FrameEdit } from "../frames/board";
import type { StylePatch } from "../notes/board";
import { INITIAL_VIEW, RoomSession, type RoomView, type TemplateFramePlan } from "./session";

/** One room visit for the room screen. A new socket per join attempt; closed on unmount. */
export function useRoom(code: string) {
  const [view, setView] = useState<RoomView>(INITIAL_VIEW);
  const session = useRef<RoomSession | null>(null);

  useEffect(
    () => () => {
      session.current?.close();
      useBoardUi.getState().resetRoom();
    },
    [],
  );

  // Remember the name that worked, to prefill next time. Names aren't sensitive.
  const joinedName = view.status === "joined" ? view.you?.name : undefined;
  useEffect(() => {
    if (joinedName) writeKey(STORAGE_KEYS.name, joinedName);
  }, [joinedName]);

  const start = (name: string) => {
    session.current?.close();
    const next = new RoomSession({
      url: toWebSocketUrl(WORKER_URL, code),
      createSocket: browserSocketFactory,
      checkCode: () => checkRoom(WORKER_URL, code, browserFetch),
      onChange: setView,
      onNoteConfirmed: (from, to) => useBoardUi.getState().renameSelected(from, to),
      onFrameConfirmed: (from, to) => useBoardUi.getState().renameFrame(from, to),
    });
    session.current = next;
    next.join(name);
  };

  return {
    view,
    /** Joins on the open socket after a refused name; otherwise opens a new one. */
    join: (name: string) => (session.current && view.status === "idle" ? session.current.join(name) : start(name)),
    rejoin: (name: string) => start(name),
    say: (text: string) => session.current?.say(text) ?? false,
    addNote: (at: { x: number; y: number; color: NoteColor }) => session.current?.addNote(at) ?? null,
    editNote: (id: string, text: string) => session.current?.editNote(id, text) ?? false,
    setDraft: (id: string, draft: string | null) => session.current?.setDraft(id, draft),
    startDrag: (id: string) => session.current?.startDrag(id) ?? false,
    moveNote: (id: string, x: number, y: number, final: boolean) => session.current?.moveNote(id, x, y, final),
    startResize: (id: string) => session.current?.startResize(id) ?? false,
    resizeNote: (id: string, rect: NoteRect, final: boolean) => session.current?.resizeNote(id, rect, final),
    setNoteSize: (id: string, w: number, h: number) => session.current?.setNoteSize(id, w, h) ?? false,
    styleNote: (id: string, change: StylePatch) => session.current?.styleNote(id, change) ?? false,
    deleteNote: (id: string) => session.current?.deleteNote(id),
    startGroupDrag: (ids: readonly string[]) => session.current?.startGroupDrag(ids) ?? false,
    moveGroup: (positions: readonly { id: string; x: number; y: number }[], final: boolean) => session.current?.moveGroup(positions, final),
    applyRects: (rects: readonly (NoteRect & { id: string })[]) => session.current?.applyRects(rects) ?? false,
    showNotice: (text: string) => session.current?.showNotice(text),
    deleteNotes: (ids: readonly string[]) => session.current?.deleteNotes(ids),
    orderNotes: (ids: readonly string[], action: OrderAction) => session.current?.orderNotes(ids, action) ?? false,
    addFrame: (at: { x: number; y: number; color: FrameColor; title?: string }) => session.current?.addFrame(at) ?? null,
    editFrame: (id: string, change: FrameEdit) => session.current?.editFrame(id, change) ?? false,
    setFrameDraft: (id: string, draft: string | null) => session.current?.setFrameDraft(id, draft),
    startFrameDrag: (id: string, carry: boolean) => session.current?.startFrameDrag(id, carry) ?? false,
    moveFrame: (id: string, x: number, y: number, final: boolean) => session.current?.moveFrame(id, x, y, final),
    startFrameResize: (id: string) => session.current?.startFrameResize(id) ?? false,
    resizeFrame: (id: string, rect: NoteRect, final: boolean) => session.current?.resizeFrame(id, rect, final),
    setFrameSize: (id: string, w: number, h: number) => session.current?.setFrameSize(id, w, h) ?? false,
    deleteFrame: (id: string) => session.current?.deleteFrame(id),
    clearBoard: () => session.current?.clearBoard() ?? false,
    undo: () => session.current?.undo(),
    redo: () => session.current?.redo(),
    duplicateNotes: (ids: readonly string[]) => session.current?.duplicateNotes(ids) ?? null,
    duplicateFrame: (id: string) => session.current?.duplicateFrame(id) ?? null,
    applyTemplate: (frames: readonly TemplateFramePlan[]) => session.current?.applyTemplate(frames) ?? false,
    leave: () => session.current?.close(),
  };
}
