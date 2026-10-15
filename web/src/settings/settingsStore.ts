import { create } from "zustand";

/**
 * Whether the Settings sheet is open (v0.42.0). In memory only, like Share session and Export: not a
 * hash route, so it opens over any screen (the start page, a room, another sheet), Escape closes it
 * alone, and focus goes back to the menu button that opened it.
 */
export const useSettings = create<{ open: boolean; show: () => void; hide: () => void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
