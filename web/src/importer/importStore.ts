import { create } from "zustand";

/**
 * Import (v0.40.0): whether the Import sheet is open, and the last placement's announcement (the
 * board's polite live region says it once the sheet has closed). In memory only, like Share
 * session and Export: not a hash route.
 */
export const useImport = create<{ open: boolean; announcement: string; show: () => void; hide: () => void; announce: (text: string) => void }>((set) => ({
  open: false,
  announcement: "",
  show: () => set({ open: true, announcement: "" }),
  hide: () => set({ open: false }),
  announce: (announcement) => set({ announcement }),
}));
