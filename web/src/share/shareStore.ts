import { create } from "zustand";

/**
 * Whether the Share session sheet is open (v0.32.0). In memory only. It isn't a hash route: it
 * opens over Participants, Escape closes it alone, and focus goes back to the button that opened it.
 */
export const useShare = create<{ open: boolean; show: () => void; hide: () => void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
