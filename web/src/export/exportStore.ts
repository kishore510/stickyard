import { create } from "zustand";

/**
 * Whether the Export sheet is open (v0.40.0). In memory only, like Share session: not a hash route,
 * so Escape closes it alone and focus goes back to the menu button that opened it.
 */
export const useExport = create<{ open: boolean; show: () => void; hide: () => void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
