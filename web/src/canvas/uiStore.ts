import type { NoteColor } from "@stickyard/shared";
import { create } from "zustand";
import {
  EMPTY_SELECTION,
  clearSelection,
  pruneSelection,
  renameInSelection,
  selectAll,
  selectOnly,
  toggleSelected,
  type Selection,
} from "./selection";
import type { InlinePart } from "../notes/inlineEdit";
import type { Mode } from "./tools";

/*
 * Board UI state that must outlive any one layout: the panels (md and up) and the phone ribbon
 * and sheets are swapped at the md breakpoint, so the tool, the last colour added, the
 * selection and pending edit requests live here, not in any of them. (The viewport lives in
 * React Flow, which stays mounted across the switch; panel widths live in panels/panelStore.ts.)
 * Not persisted.
 */
interface BoardUi {
  tool: Mode;
  /** The colour of the last note added from the palette; N adds this colour. */
  color: NoteColor;
  /** null: the default for the layout (shown from md up, hidden on phones). */
  minimap: boolean | null;
  /** Selected note ids, in the order they were selected (see selection.ts). */
  selection: Selection;
  /** Asks the note editor to take focus (Properties' Title from md up). `n` makes each request new. */
  editRequest: { id: string; n: number } | null;
  /** The note being edited in place (md and up), and the part to put the caret in. `n` makes each request new. */
  inlineEdit: { id: string; part: InlinePart; n: number } | null;
  /** Phones: the add drawer (palette tiles) is open. */
  addSheetOpen: boolean;
  setTool(tool: Mode): void;
  setColor(color: NoteColor): void;
  setMinimap(shown: boolean): void;
  select(id: string): void;
  /** Shift/Ctrl-click: adds the note or takes it out. */
  toggle(id: string): void;
  setSelection(selection: Selection): void;
  selectAll(ids: Iterable<string>): void;
  clearSelection(): void;
  /** A note got its server id. */
  renameSelected(from: string, to: string): void;
  /** Drops notes that no longer exist. */
  pruneSelected(exists: (id: string) => boolean): void;
  requestEdit(id: string): void;
  /** Edits the note in place, caret in `part` (selects just it). */
  startInlineEdit(id: string, part: InlinePart): void;
  endInlineEdit(): void;
  setAddSheetOpen(open: boolean): void;
  /** Leaving a room: nothing selected or pending. */
  resetRoom(): void;
}

export const useBoardUi = create<BoardUi>()((set, get) => ({
  tool: "select",
  color: "yellow",
  minimap: null,
  selection: EMPTY_SELECTION,
  editRequest: null,
  inlineEdit: null,
  addSheetOpen: false,
  setTool: (tool) => set({ tool }),
  setColor: (color) => set({ color }),
  setMinimap: (minimap) => set({ minimap }),
  select: (id) => set({ selection: selectOnly(get().selection, id) }),
  toggle: (id) => set({ selection: toggleSelected(get().selection, id) }),
  setSelection: (selection) => {
    if (selection !== get().selection) set({ selection });
  },
  selectAll: (ids) => set({ selection: selectAll(ids) }),
  clearSelection: () => set({ selection: clearSelection(get().selection) }),
  renameSelected: (from, to) => {
    const { selection, editRequest, inlineEdit } = get();
    set({
      selection: renameInSelection(selection, from, to),
      editRequest: editRequest?.id === from ? { ...editRequest, id: to } : editRequest,
      inlineEdit: inlineEdit?.id === from ? { ...inlineEdit, id: to } : inlineEdit,
    });
  },
  pruneSelected: (exists) => {
    const selection = get().selection;
    const next = pruneSelection(selection, exists);
    if (next !== selection) set({ selection: next });
  },
  requestEdit: (id) => set({ selection: selectOnly(get().selection, id), editRequest: { id, n: (get().editRequest?.n ?? 0) + 1 } }),
  startInlineEdit: (id, part) =>
    set({ selection: selectOnly(get().selection, id), inlineEdit: { id, part, n: (get().inlineEdit?.n ?? 0) + 1 } }),
  endInlineEdit: () => {
    if (get().inlineEdit) set({ inlineEdit: null });
  },
  setAddSheetOpen: (addSheetOpen) => set({ addSheetOpen }),
  resetRoom: () => set({ selection: EMPTY_SELECTION, editRequest: null, inlineEdit: null, addSheetOpen: false }),
}));
