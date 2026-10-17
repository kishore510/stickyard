import { create } from "zustand";
import type { SummaryResult } from "./summaryParse";
import type { SummaryScope } from "./summaryScope";
import { SUMMARY_TEXT, type StaleKind } from "./summaryRules";

/**
 * Summary and sentiment (v0.44.0): whether its sheet is open, why this page can't send the board
 * (published by the board, so the menu can show the entry off with the reason), the last summary
 * (memory only, never stored: it lives while the page is open, and is dropped when the room
 * closes), and whether something happened since the send that means it can't be added: a
 * reconnect, losing the host, or a silent round starting (`stale`, kept until the next send).
 */
export interface StoredSummary {
  result: SummaryResult;
  scope: SummaryScope;
  /** When it arrived (ms since the epoch). */
  at: number;
  model: string;
  input: number;
  output: number;
}

interface SummaryState {
  open: boolean;
  gate: string | null;
  summary: StoredSummary | null;
  pending: boolean;
  stale: string | null;
  announcement: string;
  show: () => void;
  hide: () => void;
  setGate: (gate: string | null) => void;
  /** A send starts: nothing stale yet. */
  startSend: () => void;
  setPending: (pending: boolean) => void;
  setSummary: (summary: StoredSummary | null) => void;
  /** Something changed that the summary can't be added after: only while a request runs or a summary is held; the first reason stays. */
  invalidate: (kind: StaleKind) => void;
  announce: (text: string) => void;
  reset: () => void;
}

export const useSummary = create<SummaryState>((set, get) => ({
  open: false,
  // Off until the board says otherwise (it loads lazily; a guest must never see the entry on meanwhile).
  gate: SUMMARY_TEXT.hostOnly,
  summary: null,
  pending: false,
  stale: null,
  announcement: "",
  show: () => set({ open: true, announcement: "" }),
  hide: () => set({ open: false }),
  setGate: (gate) => set({ gate }),
  startSend: () => set({ pending: true, stale: null }),
  setPending: (pending) => set({ pending }),
  setSummary: (summary) => set({ summary }),
  invalidate: (kind) => {
    const { pending, summary, stale } = get();
    if (stale === null && (pending || summary !== null)) set({ stale: SUMMARY_TEXT.stale[kind] });
  },
  announce: (announcement) => set({ announcement }),
  reset: () => set({ open: false, gate: SUMMARY_TEXT.hostOnly, summary: null, pending: false, stale: null, announcement: "" }),
}));
