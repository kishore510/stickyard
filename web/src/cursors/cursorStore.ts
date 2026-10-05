import { create } from "zustand";
import { idleCursors, moveCursor, nextIdleAt, removeCursor, type CursorSink, type RemoteCursors } from "./cursors";

/*
 * Other people's pointers (protocol v14), by participant id, apart from the room view so a moving
 * pointer re-renders only its own mark (never the notes). One timer marks pointers idle (faded)
 * CURSOR_IDLE_MS after they last moved; nothing ticks while nothing moves. Never persisted.
 */
interface CursorState {
  cursors: RemoteCursors;
  moved(id: string, x: number, y: number): void;
  gone(id: string): void;
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
  moved: (id, x, y) => {
    const cursors = moveCursor(get().cursors, id, x, y, Date.now());
    set({ cursors });
    scheduleIdle(cursors);
  },
  gone: (id) => {
    const cursors = removeCursor(get().cursors, id);
    if (cursors === get().cursors) return;
    set({ cursors });
    scheduleIdle(cursors);
  },
  clear: () => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (get().cursors.size > 0) set({ cursors: new Map() });
  },
}));

/** The store as the session's sink. */
export const cursorSink: CursorSink = {
  moved: (id, x, y) => useCursors.getState().moved(id, x, y),
  gone: (id) => useCursors.getState().gone(id),
  clear: () => useCursors.getState().clear(),
};
