import { create } from "zustand";

/*
 * The empty middle of the top bar, between the mark and the app nav. A page can put its own
 * controls there with a portal: from md up a room puts its board actions (canvas/SelectionBar.tsx)
 * there, so they don't float over the board. Null until the top bar has rendered.
 */
interface TopBarSlot {
  el: HTMLElement | null;
  set(el: HTMLElement | null): void;
}

export const useTopBarSlot = create<TopBarSlot>()((set) => ({
  el: null,
  set: (el) => set({ el }),
}));
