import type { NoteColor } from "@stickyard/shared";
import { create } from "zustand";
import {
  EMPTY_SELECTION,
  clearSelection,
  onlySelected,
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
   * Selected frame ids, in the order they were selected (v0.20.0). A selection can hold notes and
   * frames together: Shift/Ctrl/Cmd-click toggles either, a marquee takes the frames it encloses,
   * Ctrl+A takes everything. A plain click on one selects just it.
   */
  frames: Selection;
  /** The one selected frame when it's selected alone (no notes, no other frame), else null. Derived from `frames`. */
  frameSelected: string | null;
  /** Asks a frame's header to take focus (a new frame: its title is ready to type). */
  frameEditRequest: { id: string; n: number } | null;
  /** Asks the note editor to take focus (Properties' Title from md up). `n` makes each request new. */
  editRequest: { id: string; n: number } | null;
  /** The note being edited in place (md and up), and the part to put the caret in. `n` makes each request new. */
  inlineEdit: { id: string; part: InlinePart; n: number } | null;
  /** Phones: the add drawer (palette tiles) is open. */
  addSheetOpen: boolean;
  /** The host's timer picker is open (facilitation UI, md and up). */
  timerPickerOpen: boolean;
  /** Arrange > Grid's column count; null = automatic (arrange.ts autoColumns). Kept for the session, across rooms. */
  gridColumns: number | null;
  setTool(tool: Mode): void;
  setColor(color: NoteColor): void;
  setMinimap(shown: boolean): void;
  select(id: string): void;
  /** Shift/Ctrl-click: adds the note or takes it out. */
  toggle(id: string): void;
  /** Notes only (the frames are cleared). */
  setSelection(selection: Selection): void;
  /** Notes and frames together. */
  setSelections(selection: Selection, frames: Selection): void;
  selectAll(ids: Iterable<string>, frameIds?: Iterable<string>): void;
  clearSelection(): void;
  /** A note got its server id. */
  renameSelected(from: string, to: string): void;
  /** Drops notes that no longer exist. */
  pruneSelected(exists: (id: string) => boolean): void;
  /** Selects just this frame (no notes). */
  selectFrame(id: string): void;
  /** Shift/Ctrl/Cmd-click on a frame: adds it or takes it out (notes stay). */
  toggleFrame(id: string): void;
  /** A frame got its server id. */
  renameFrame(from: string, to: string): void;
  /** Drops frames that no longer exist. */
  pruneFrame(exists: (id: string) => boolean): void;
  /** Selects the frame and puts the caret in its title. */
  requestFrameEdit(id: string): void;
  requestEdit(id: string): void;
  /** Edits the note in place, caret in `part` (selects just it). */
  startInlineEdit(id: string, part: InlinePart): void;
  endInlineEdit(): void;
  setAddSheetOpen(open: boolean): void;
  setTimerPickerOpen(open: boolean): void;
  /** Asks the board to show a note (a Results row, v0.18.0): it's selected and the view moves to it. `n` makes each request new. */
  revealRequest: { id: string; n: number } | null;
  requestReveal(id: string): void;
  setGridColumns(columns: number | null): void;
  /** Leaving a room: nothing selected or pending. */
  resetRoom(): void;
}

/** The single frame selected alone, or null. */
const soleFrame = (selection: Selection, frames: Selection) => (selection.size === 0 ? onlySelected(frames) : null);
/** Both sets and the derived frameSelected, to spread into a state update. */
const both = (selection: Selection, frames: Selection) => ({ selection, frames, frameSelected: soleFrame(selection, frames) });

export const useBoardUi = create<BoardUi>()((set, get) => ({
  tool: "select",
  color: "yellow",
  minimap: null,
  selection: EMPTY_SELECTION,
  frames: EMPTY_SELECTION,
  frameSelected: null,
  frameEditRequest: null,
  editRequest: null,
  inlineEdit: null,
  addSheetOpen: false,
  timerPickerOpen: false,
  revealRequest: null,
  gridColumns: null,
  setTool: (tool) => set({ tool }),
  setColor: (color) => set({ color }),
  setMinimap: (minimap) => set({ minimap }),
  select: (id) => set(both(selectOnly(get().selection, id), EMPTY_SELECTION)),
  toggle: (id) => set(both(toggleSelected(get().selection, id), get().frames)),
  setSelection: (selection) => {
    if (selection !== get().selection || get().frames.size > 0) set(both(selection, EMPTY_SELECTION));
  },
  setSelections: (selection, frames) => {
    if (selection !== get().selection || frames !== get().frames) set(both(selection, frames));
  },
  selectAll: (ids, frameIds = []) => set(both(selectAll(ids), selectAll(frameIds))),
  clearSelection: () => {
    const { selection, frames } = get();
    if (selection.size > 0 || frames.size > 0) set(both(clearSelection(selection), clearSelection(frames)));
  },
  renameSelected: (from, to) => {
    const { selection, editRequest, inlineEdit } = get();
    set({
      ...both(renameInSelection(selection, from, to), get().frames),
      editRequest: editRequest?.id === from ? { ...editRequest, id: to } : editRequest,
      inlineEdit: inlineEdit?.id === from ? { ...inlineEdit, id: to } : inlineEdit,
    });
  },
  pruneSelected: (exists) => {
    const { selection, inlineEdit, editRequest } = get();
    const next = pruneSelection(selection, exists);
    // A note edited in place, or asked for in Properties, that's gone (deleted, or not in a resync) is let go.
    const goneInline = inlineEdit !== null && !exists(inlineEdit.id);
    const goneRequest = editRequest !== null && !exists(editRequest.id);
    if (next !== selection || goneInline || goneRequest)
      set({ ...both(next, get().frames), ...(goneInline ? { inlineEdit: null } : {}), ...(goneRequest ? { editRequest: null } : {}) });
  },
  selectFrame: (id) => {
    if (get().frameSelected !== id) set({ ...both(EMPTY_SELECTION, selectOnly(get().frames, id)), inlineEdit: null });
  },
  toggleFrame: (id) => set({ ...both(get().selection, toggleSelected(get().frames, id)), inlineEdit: null }),
  renameFrame: (from, to) => {
    const { frames, frameEditRequest } = get();
    set({
      ...both(get().selection, renameInSelection(frames, from, to)),
      frameEditRequest: frameEditRequest?.id === from ? { ...frameEditRequest, id: to } : frameEditRequest,
    });
  },
  pruneFrame: (exists) => {
    const { frames, frameEditRequest } = get();
    const next = pruneSelection(frames, exists);
    const goneRequest = frameEditRequest !== null && !exists(frameEditRequest.id);
    if (next !== frames || goneRequest) set({ ...both(get().selection, next), ...(goneRequest ? { frameEditRequest: null } : {}) });
  },
  requestFrameEdit: (id) => set({ ...both(EMPTY_SELECTION, selectOnly(get().frames, id)), frameEditRequest: { id, n: (get().frameEditRequest?.n ?? 0) + 1 } }),
  requestEdit: (id) => set({ ...both(selectOnly(get().selection, id), EMPTY_SELECTION), editRequest: { id, n: (get().editRequest?.n ?? 0) + 1 } }),
  startInlineEdit: (id, part) =>
    set({ ...both(selectOnly(get().selection, id), EMPTY_SELECTION), inlineEdit: { id, part, n: (get().inlineEdit?.n ?? 0) + 1 } }),
  endInlineEdit: () => {
    if (get().inlineEdit) set({ inlineEdit: null });
  },
  setAddSheetOpen: (addSheetOpen) => set({ addSheetOpen }),
  setTimerPickerOpen: (timerPickerOpen) => set({ timerPickerOpen }),
  requestReveal: (id) =>
    set({ ...both(selectOnly(get().selection, id), EMPTY_SELECTION), inlineEdit: null, revealRequest: { id, n: (get().revealRequest?.n ?? 0) + 1 } }),
  setGridColumns: (gridColumns) => set({ gridColumns }),
  resetRoom: () => set({ ...both(EMPTY_SELECTION, EMPTY_SELECTION), frameEditRequest: null, editRequest: null, inlineEdit: null, addSheetOpen: false, timerPickerOpen: false, revealRequest: null }),
}));
