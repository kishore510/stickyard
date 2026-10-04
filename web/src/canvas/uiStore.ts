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
  /**
   * The selected frame, if any (protocol v9). Apart from the note selection: selecting a frame
   * clears the notes and selecting notes clears the frame. Marquee, Ctrl+A and arrange are notes only.
   */
  frameSelected: string | null;
  /** Asks a frame's header to take focus (a new frame: its title is ready to type). */
  frameEditRequest: { id: string; n: number } | null;
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
  /** Selects just this frame (no notes). */
  selectFrame(id: string): void;
  /** A frame got its server id. */
  renameFrame(from: string, to: string): void;
  /** Drops the frame if it no longer exists. */
  pruneFrame(exists: (id: string) => boolean): void;
  /** Selects the frame and puts the caret in its title. */
  requestFrameEdit(id: string): void;
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
  frameSelected: null,
  frameEditRequest: null,
  editRequest: null,
  inlineEdit: null,
  addSheetOpen: false,
  setTool: (tool) => set({ tool }),
  setColor: (color) => set({ color }),
  setMinimap: (minimap) => set({ minimap }),
  select: (id) => set({ selection: selectOnly(get().selection, id), frameSelected: null }),
  toggle: (id) => set({ selection: toggleSelected(get().selection, id), frameSelected: null }),
  setSelection: (selection) => {
    if (selection !== get().selection || get().frameSelected !== null) set({ selection, frameSelected: null });
  },
  selectAll: (ids) => set({ selection: selectAll(ids), frameSelected: null }),
  clearSelection: () => {
    const { selection, frameSelected } = get();
    if (selection.size > 0 || frameSelected !== null) set({ selection: clearSelection(selection), frameSelected: null });
  },
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
  selectFrame: (id) => {
    if (get().frameSelected !== id || get().selection.size > 0) set({ frameSelected: id, selection: EMPTY_SELECTION, inlineEdit: null });
  },
  renameFrame: (from, to) => {
    const { frameSelected, frameEditRequest } = get();
    set({
      frameSelected: frameSelected === from ? to : frameSelected,
      frameEditRequest: frameEditRequest?.id === from ? { ...frameEditRequest, id: to } : frameEditRequest,
    });
  },
  pruneFrame: (exists) => {
    const id = get().frameSelected;
    if (id !== null && !exists(id)) set({ frameSelected: null });
  },
  requestFrameEdit: (id) => set({ frameSelected: id, selection: EMPTY_SELECTION, frameEditRequest: { id, n: (get().frameEditRequest?.n ?? 0) + 1 } }),
  requestEdit: (id) => set({ selection: selectOnly(get().selection, id), frameSelected: null, editRequest: { id, n: (get().editRequest?.n ?? 0) + 1 } }),
  startInlineEdit: (id, part) =>
    set({ selection: selectOnly(get().selection, id), frameSelected: null, inlineEdit: { id, part, n: (get().inlineEdit?.n ?? 0) + 1 } }),
  endInlineEdit: () => {
    if (get().inlineEdit) set({ inlineEdit: null });
  },
  setAddSheetOpen: (addSheetOpen) => set({ addSheetOpen }),
  resetRoom: () => set({ selection: EMPTY_SELECTION, frameSelected: null, frameEditRequest: null, editRequest: null, inlineEdit: null, addSheetOpen: false }),
}));
