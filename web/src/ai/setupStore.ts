import { create } from "zustand";

/**
 * Board setup from a prompt (v0.43.0): whether its sheet is open, the description being typed (kept
 * while the sheet moves between pages and when it's reopened in this visit; memory only, never
 * stored), and the last add's announcement (the board's polite live region says it once the sheet
 * has closed). Not a hash route, like Import and Export.
 */
export const useSetup = create<{
  open: boolean;
  draft: string;
  announcement: string;
  show: () => void;
  hide: () => void;
  setDraft: (draft: string) => void;
  announce: (text: string) => void;
}>((set) => ({
  open: false,
  draft: "",
  announcement: "",
  show: () => set({ open: true, announcement: "" }),
  hide: () => set({ open: false }),
  setDraft: (draft) => set({ draft }),
  announce: (announcement) => set({ announcement }),
}));
