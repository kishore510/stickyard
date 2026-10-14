import { useEffect, useRef, useState } from "react";
import type { FrameColor, NoteColor, NoteRect, OrderAction, ReactionKey, ShapeKind } from "@stickyard/shared";
import { WORKER_URL, healthUrl, toWebSocketUrl } from "../config";
import { probeHealth } from "../connection/connectionCheck";
import { browserConnectionEnv } from "../connection/reconnect";
import { browserSocketFactory } from "../connection/socket";
import { useBoardUi } from "../canvas/uiStore";
import { STORAGE_KEYS, hostTokenKey, readKey, removeKey, writeKey } from "../storage";
import { forgetVoterKey, voterKeyFor } from "../voting/voterKey";
import { cursorSink } from "../cursors/cursorStore";
import { followSink } from "../follow/followStore";
import type { View } from "../follow/follow";
import { browserFetch, checkRoom } from "./api";
import type { FrameEdit } from "../frames/board";
import type { StylePatch } from "../notes/board";
import type { ShapeEdit } from "../shapes/board";
import type { ConnectorContent, ConnectorPatch } from "../connectors/board";
import { useConnectorUi } from "../connectors/connectorUi";
import { useGroupUi } from "../groups/groupUi";
import type { Stencil } from "../stencils/data";
import type { ConnectorEnd, GroupColor } from "@stickyard/shared";
import { INITIAL_VIEW, RoomSession, type RoomView, type TemplateFramePlan } from "./session";

/**
 * One room visit for the room screen. A new session per join from the name sheet; after joining,
 * the session reconnects by itself (and Rejoin restarts that) with the stored name. Closed on unmount.
 */
export function useRoom(code: string) {
  const roomId = code.split(".")[0] ?? "";
  const [view, setView] = useState<RoomView>(INITIAL_VIEW);
  const session = useRef<RoomSession | null>(null);

  useEffect(
    () => () => {
      session.current?.close();
      useBoardUi.getState().resetRoom();
      useConnectorUi.getState().reset();
      useGroupUi.setState({ announce: null, dragging: null });
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
      checkHealth: () => probeHealth(healthUrl(WORKER_URL), browserFetch),
      storedName: () => readKey(STORAGE_KEYS.name),
      // Protocol v12: this room's host token, if this device started it. Sent only in claimHost.
      hostToken: () => readKey(hostTokenKey(roomId)),
      forgetHostToken: () => removeKey(hostTokenKey(roomId)),
      // Protocol v13: this device's voter key for the room, made on first use. Sent only in claimVoter.
      voterKey: () => (roomId ? voterKeyFor(roomId) : null),
      forgetVoterKey: () => forgetVoterKey(roomId),
      env: browserConnectionEnv,
      // Protocol v14: other people's pointers go to their own store, never the view.
      cursors: cursorSink,
      // Protocol v19: following and Bring to me go to their own store, never the view.
      follow: followSink,
      onChange: setView,
      onNoteConfirmed: (from, to) => useBoardUi.getState().renameSelected(from, to),
      onFrameConfirmed: (from, to) => useBoardUi.getState().renameFrame(from, to),
      onShapeConfirmed: (from, to) => useBoardUi.getState().renameShape(from, to),
      onConnectorConfirmed: (from, to) => useBoardUi.getState().renameConnector(from, to),
      onGroupConfirmed: (from, to) => useBoardUi.getState().renameGroup(from, to),
    });
    session.current = next;
    next.join(name);
  };

  return {
    view,
    /** Joins on the open socket after a refused name; otherwise opens a new one. */
    join: (name: string) => (session.current && view.status === "idle" ? session.current.join(name) : start(name)),
    /** Tries to reconnect now (after a drop), with the stored name and no prompt. */
    rejoin: () => session.current?.rejoin(),
    restoreDraft: () => session.current?.restoreDraft() ?? null,
    dismissDraft: () => session.current?.dismissDraft(),
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
    addShape: (at: { kind: ShapeKind; x: number; y: number }) => session.current?.addShape(at) ?? null,
    editShape: (id: string, change: ShapeEdit) => session.current?.editShape(id, change) ?? false,
    editShapes: (ids: readonly string[], change: ShapeEdit) => session.current?.editShapes(ids, change) ?? false,
    setShapeDraft: (id: string, draft: string | null) => session.current?.setShapeDraft(id, draft),
    startShapeDrag: (id: string) => session.current?.startShapeDrag(id) ?? false,
    moveShape: (id: string, x: number, y: number, final: boolean) => session.current?.moveShape(id, x, y, final),
    startShapeResize: (id: string) => session.current?.startShapeResize(id) ?? false,
    resizeShape: (id: string, rect: NoteRect, final: boolean) => session.current?.resizeShape(id, rect, final),
    setShapeSize: (id: string, w: number, h: number) => session.current?.setShapeSize(id, w, h) ?? false,
    deleteShape: (id: string) => session.current?.deleteShape(id),
    clearBoard: () => session.current?.clearBoard() ?? false,
    deleteSelection: (noteIds: readonly string[], frameIds: readonly string[], shapeIds: readonly string[] = [], connectorIds: readonly string[] = []) =>
      session.current?.deleteSelection(noteIds, frameIds, shapeIds, connectorIds) ?? false,
    addConnector: (input: { start: ConnectorEnd; end: ConnectorEnd } & Partial<Omit<ConnectorContent, "start" | "end">>) => session.current?.addConnector(input) ?? null,
    updateConnector: (id: string, change: ConnectorPatch) => session.current?.updateConnector(id, change) ?? false,
    updateConnectors: (ids: readonly string[], change: ConnectorPatch) => session.current?.updateConnectors(ids, change) ?? false,
    reverseConnectors: (ids: readonly string[]) => session.current?.reverseConnectors(ids) ?? false,
    moveConnector: (id: string, dx: number, dy: number) => session.current?.moveConnector(id, dx, dy) ?? false,
    deleteConnectors: (ids: readonly string[]) => session.current?.deleteConnectors(ids),
    createGroup: (ids: readonly string[], options?: { label?: string; color?: GroupColor }) => session.current?.createGroup(ids, options) ?? null,
    updateGroup: (id: string, change: { label?: string; color?: GroupColor }) => session.current?.updateGroup(id, change) ?? false,
    addToGroup: (id: string, ids: readonly string[]) => session.current?.addToGroup(id, ids) ?? false,
    removeFromGroup: (id: string, ids: readonly string[]) => session.current?.removeFromGroup(id, ids) ?? false,
    ungroup: (ids: readonly string[]) => session.current?.ungroup(ids) ?? false,
    placeStencil: (stencil: Stencil, centre: { x: number; y: number }) => session.current?.placeStencil(stencil, centre) ?? false,
    startSelectionDrag: (frameIds: readonly string[], noteIds: readonly string[], carry: boolean, shapeIds: readonly string[] = []) =>
      session.current?.startSelectionDrag(frameIds, noteIds, carry, shapeIds) ?? false,
    applyFrameRects: (rects: readonly (NoteRect & { id: string })[]) => session.current?.applyFrameRects(rects) ?? false,
    editFrames: (ids: readonly string[], change: FrameEdit) => session.current?.editFrames(ids, change) ?? false,
    duplicateSelection: (noteIds: readonly string[], frameIds: readonly string[], shapeIds: readonly string[] = [], connectorIds: readonly string[] = []) =>
      session.current?.duplicateSelection(noteIds, frameIds, shapeIds, connectorIds) ?? null,
    moveSelection: (dx: number, dy: number, final: boolean) => session.current?.moveSelection(dx, dy, final) ?? { dx: 0, dy: 0 },
    undo: () => session.current?.undo(),
    redo: () => session.current?.redo(),
    duplicateNotes: (ids: readonly string[]) => session.current?.duplicateNotes(ids) ?? null,
    duplicateFrame: (id: string) => session.current?.duplicateFrame(id) ?? null,
    applyTemplate: (frames: readonly TemplateFramePlan[]) => session.current?.applyTemplate(frames) ?? false,
    startRoomTimer: (durationMs: number) => session.current?.startRoomTimer(durationMs) ?? false,
    stopRoomTimer: () => session.current?.stopRoomTimer() ?? false,
    setLock: (locked: boolean) => session.current?.setLock(locked) ?? false,
    endSession: () => session.current?.endSession() ?? false,
    voteSet: (noteId: string, count: number) => session.current?.voteSet(noteId, count) ?? false,
    startVote: (budget: number) => session.current?.startVote(budget) ?? false,
    stopVote: () => session.current?.stopVote() ?? false,
    clearVotes: () => session.current?.clearVotes() ?? false,
    startSilent: () => session.current?.startSilent() ?? false,
    revealSilent: () => session.current?.revealSilent() ?? false,
    reactionSet: (noteId: string, key: ReactionKey, on: boolean) => session.current?.reactionSet(noteId, key, on) ?? false,
    shareCursor: (x: number, y: number) => session.current?.shareCursor(x, y) ?? false,
    hideCursor: () => session.current?.hideCursor(),
    startFollow: (id: string) => session.current?.startFollow(id) ?? false,
    stopFollow: () => session.current?.stopFollow() ?? false,
    stopOnUserMove: () => session.current?.stopOnUserMove() ?? false,
    shareViewport: (view: View, compact: boolean) => session.current?.shareViewport(view, compact) ?? false,
    bringToMe: (view: View) => session.current?.bringToMe(view) ?? false,
    leave: () => session.current?.close(),
  };
}
