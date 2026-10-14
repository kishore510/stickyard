import { create } from "zustand";
import type { Stencil } from "./data";
import { deleteAllStencils, deleteStencil, loadStencils, renameStencil, saveStencil, type LoadedStencils, type SaveResult } from "./storage";

/*
 * Stencils saved in this browser, as the page shows them (v0.39.0). Read from storage when the
 * board opens and again after every change here; every read is untrusted (stencils/storage.ts).
 * Also the Save as stencil dialog's open state. Nothing here is ever sent: a stencil leaves this
 * browser only when it's placed on a board, through the normal add messages.
 */

interface StencilState {
  loaded: LoadedStencils;
  /** The Save as stencil dialog is open. */
  saveOpen: boolean;
  reload(): void;
  save(stencil: Stencil): SaveResult;
  rename(id: string, name: string): SaveResult;
  remove(id: string): SaveResult;
  removeAll(): SaveResult;
  setSaveOpen(open: boolean): void;
}

export const useStencils = create<StencilState>()((set, get) => {
  const after = (result: SaveResult) => {
    get().reload();
    return result;
  };
  return {
    loaded: { stencils: [], malformed: 0, blocked: false },
    saveOpen: false,
    reload: () => set({ loaded: loadStencils() }),
    save: (stencil) => after(saveStencil(stencil)),
    rename: (id, name) => after(renameStencil(id, name)),
    remove: (id) => after(deleteStencil(id)),
    removeAll: () => after(deleteAllStencils()),
    setSaveOpen: (saveOpen) => set({ saveOpen }),
  };
});

/** A random id for a saved stencil (rename and delete find it by this). */
export function newStencilId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_");
}
