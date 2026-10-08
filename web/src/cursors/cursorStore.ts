import { create } from "zustand";
import {
  forgetPosition,
  idleCursors,
  moveCursor,
  nextIdleAt,
  rememberPosition,
  removeCursor,
  type CursorSink,
  type LastPositions,
  type RemoteCursors,
} from "./cursors";

/*
 * Other people's pointers (protocol v14), by participant id, apart from the room view so a moving
 * pointer re-renders only its own mark (never the notes). One timer marks pointers idle (faded)
 * CURSOR_IDLE_MS after they last moved; nothing ticks while nothing moves. Never persisted.
 * `lastSeen` (v0.24.0) keeps each person's last position for Participants' Go to: it outlives the
 * fade and cursorGone, and goes when they leave or on a new visit, reconnect or drop.
 */
interface CursorState {
  cursors: RemoteCursors;
  lastSeen: LastPositions;
  moved(id: string, x: number, y: number): void;
  gone(id: string): void;
  left(id: string): void;
  clear(): void;
}

let idleTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleIdle(cursors: RemoteCursors): void {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  const at = nextIdleAt(cursors);
  if (at === null) return;
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    const state = useCursors.getState();
    const next = idleCursors(state.cursors, Date.now());
    if (next !== state.cursors) useCursors.setState({ cursors: next });
    scheduleIdle(next);
  }, Math.max(0, at - Date.now()));
}

export const useCursors = create<CursorState>()((set, get) => ({
  cursors: new Map(),
  lastSeen: new Map(),
  moved: (id, x, y) => {
    const cursors = moveCursor(get().cursors, id, x, y, Date.now());
    set({ cursors, lastSeen: rememberPosition(get().lastSeen, id, x, y) });
    scheduleIdle(cursors);
  },
  gone: (id) => {
    const cursors = removeCursor(get().cursors, id);
    if (cursors === get().cursors) return;
    set({ cursors });
    scheduleIdle(cursors);
  },
  left: (id) => {
    get().gone(id);
    const lastSeen = forgetPosition(get().lastSeen, id);
    if (lastSeen !== get().lastSeen) set({ lastSeen });
  },
  clear: () => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (get().cursors.size > 0) set({ cursors: new Map() });
    if (get().lastSeen.size > 0) set({ lastSeen: new Map() });
  },
}));

/** The store as the session's sink. */
export const cursorSink: CursorSink = {
  moved: (id, x, y) => useCursors.getState().moved(id, x, y),
  gone: (id) => useCursors.getState().gone(id),
  left: (id) => useCursors.getState().left(id),
  clear: () => useCursors.getState().clear(),
};
