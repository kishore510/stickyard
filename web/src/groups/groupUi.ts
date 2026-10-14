import { create } from "zustand";

/*
 * Group UI state that isn't the board's (web only): the polite announcer's text for my own group
 * and ungroup (never anyone else's), and a chip drag in progress (nothing is sent per frame for
 * the group itself: its members move with the existing batch moves).
 */

interface GroupUi {
  announce: { n: number; text: string } | null;
  /** The group whose chip is being dragged, or null. */
  dragging: string | null;
  say(text: string): void;
  setDragging(id: string | null): void;
}

export const useGroupUi = create<GroupUi>()((set, get) => ({
  announce: null,
  dragging: null,
  say: (text) => set({ announce: { n: (get().announce?.n ?? 0) + 1, text } }),
  setDragging: (dragging) => set({ dragging }),
}));

/** The outline's ink: the shapes' border tokens (3:1 on the board in both themes, tested there). Never a colour value. */
export const groupInk = (color: string) => `var(--sy-shape-${color}-stroke)`;
