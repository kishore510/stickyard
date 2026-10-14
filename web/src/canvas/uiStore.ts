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

export type ViewNotice = { kind: "outside"; n: number } | { kind: "jump"; name: string; n: number } | { kind: "revealed"; n: number };

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
  /**
   * Selected shape ids (protocol v15), in the order they were selected, beside notes and frames.
   * Notes and shapes share stacking, moves, arrange and delete.
   */
  shapes: Selection;
  /** The one selected shape when it's selected alone (nothing else), else null. Derived from `shapes`. */
  shapeSelected: string | null;
  /** Selected arrows (protocol v21; v0.36.0), in the order they were selected, beside the rest. */
  connectors: Selection;
  /** The one selected arrow when it's selected alone, else null. Derived from `connectors`. */
  connectorSelected: string | null;
  /** Selects just this arrow. */
  selectConnector(id: string): void;
  /** Shift/Ctrl/Cmd-click on an arrow: adds it or takes it out (the rest stays). */
  toggleConnector(id: string): void;
  /** An arrow got its server id. */
  renameConnector(from: string, to: string): void;
  /** Drops arrows that no longer exist. */
  pruneConnectors(exists: (id: string) => boolean): void;
  /**
   * The group shown in Properties (v0.38.0): its chip or outline was clicked (its members became
   * the selection). Shift/Ctrl-clicks keep it, so items can be picked to add or take out; any plain
   * selection lets it go. Null: none (Properties still shows a group when exactly its members are selected).
   */
  group: string | null;
  /** Selects a group: its notes and shapes become the selection, and it's shown in Properties. */
  selectGroup(id: string, noteIds: Iterable<string>, shapeIds: Iterable<string>): void;
  /** A group got its server id. */
  renameGroup(from: string, to: string): void;
  /** Lets go of the group if it no longer exists (and of an edit of its label). */
  pruneGroup(exists: (id: string) => boolean): void;
  /** The group whose label is being edited on its chip (md and up). `n` makes each request new. */
  groupEdit: { id: string; n: number } | null;
  startGroupEdit(id: string): void;
  endGroupEdit(): void;
  /** The shape whose text is being edited in place (md and up). `n` makes each request new. */
  shapeEdit: { id: string; n: number } | null;
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
  /** Notes, frames and (optionally) shapes and arrows together. */
  setSelections(selection: Selection, frames: Selection, shapes?: Selection, connectors?: Selection): void;
  selectAll(ids: Iterable<string>, frameIds?: Iterable<string>, shapeIds?: Iterable<string>, connectorIds?: Iterable<string>): void;
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
  /** Selects just this shape. */
  selectShape(id: string): void;
  /** Shift/Ctrl/Cmd-click on a shape: adds it or takes it out (the rest stays). */
  toggleShape(id: string): void;
  /** A shape got its server id. */
  renameShape(from: string, to: string): void;
  /** Drops shapes that no longer exist (and an edit of one). */
  pruneShapes(exists: (id: string) => boolean): void;
  /** Edits the shape's text in place (selects just it). */
  startShapeEdit(id: string): void;
  endShapeEdit(): void;
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
  /** Asks the board to pan to a person's last known pointer (Participants' Go to, v0.24.0). `n` makes each request new. */
  jumpRequest: { id: string; n: number } | null;
  requestJump(id: string): void;
  /**
   * What the board says about the last view change (v0.24.0): Fit left items out ("Some items are
   * out of view." with Show all), or a jump to someone's pointer (the name, plain text, truncated).
   */
  viewNotice: ViewNotice | null;
  setViewNotice(notice: ViewNotice | null): void;
  /** Leaving a room: nothing selected or pending. */
  resetRoom(): void;
}

/** The single item of `only` when nothing else is selected, or null. */
const sole = (only: Selection, ...others: Selection[]) => (others.every((o) => o.size === 0) ? onlySelected(only) : null);
/** Every set and the derived sole frame, shape and arrow, to spread into a state update. */
const all = (selection: Selection, frames: Selection, shapes: Selection = EMPTY_SELECTION, connectors: Selection = EMPTY_SELECTION) => ({
  group: null,
  selection,
  frames,
  shapes,
  connectors,
  frameSelected: sole(frames, selection, shapes, connectors),
  shapeSelected: sole(shapes, selection, frames, connectors),
  connectorSelected: sole(connectors, selection, frames, shapes),
});

export const useBoardUi = create<BoardUi>()((set, get) => ({
  tool: "select",
  color: "yellow",
  minimap: null,
  selection: EMPTY_SELECTION,
  frames: EMPTY_SELECTION,
  frameSelected: null,
  shapes: EMPTY_SELECTION,
  shapeSelected: null,
  connectors: EMPTY_SELECTION,
  connectorSelected: null,
  group: null,
  groupEdit: null,
  shapeEdit: null,
  frameEditRequest: null,
  editRequest: null,
  inlineEdit: null,
  addSheetOpen: false,
  timerPickerOpen: false,
  revealRequest: null,
  gridColumns: null,
  jumpRequest: null,
  viewNotice: null,
  setTool: (tool) => set({ tool }),
  setColor: (color) => set({ color }),
  setMinimap: (minimap) => set({ minimap }),
  select: (id) => set(all(selectOnly(get().selection, id), EMPTY_SELECTION)),
  toggle: (id) => set({ ...all(toggleSelected(get().selection, id), get().frames, get().shapes, get().connectors), group: get().group }),
  setSelection: (selection) => {
    if (selection !== get().selection || get().frames.size > 0 || get().shapes.size > 0 || get().connectors.size > 0) set(all(selection, EMPTY_SELECTION));
  },
  setSelections: (selection, frames, shapes = EMPTY_SELECTION, connectors = EMPTY_SELECTION) => {
    if (selection !== get().selection || frames !== get().frames || shapes !== get().shapes || connectors !== get().connectors) set(all(selection, frames, shapes, connectors));
  },
  selectAll: (ids, frameIds = [], shapeIds = [], connectorIds = []) => set(all(selectAll(ids), selectAll(frameIds), selectAll(shapeIds), selectAll(connectorIds))),
  clearSelection: () => {
    const { selection, frames, shapes, connectors } = get();
    if (selection.size > 0 || frames.size > 0 || shapes.size > 0 || connectors.size > 0)
      set(all(clearSelection(selection), clearSelection(frames), clearSelection(shapes), clearSelection(connectors)));
  },
  selectConnector: (id) => {
    if (get().connectorSelected !== id) set({ ...all(EMPTY_SELECTION, EMPTY_SELECTION, EMPTY_SELECTION, selectOnly(get().connectors, id)), inlineEdit: null, shapeEdit: null });
  },
  toggleConnector: (id) => set({ ...all(get().selection, get().frames, get().shapes, toggleSelected(get().connectors, id)), group: get().group, inlineEdit: null, shapeEdit: null }),
  renameConnector: (from, to) => set({ ...all(get().selection, get().frames, get().shapes, renameInSelection(get().connectors, from, to)), group: get().group }),
  pruneConnectors: (exists) => {
    const next = pruneSelection(get().connectors, exists);
    if (next !== get().connectors) set({ ...all(get().selection, get().frames, get().shapes, next), group: get().group });
  },
  selectGroup: (id, noteIds, shapeIds) => set({ ...all(selectAll(noteIds), EMPTY_SELECTION, selectAll(shapeIds)), group: id, inlineEdit: null, shapeEdit: null }),
  renameGroup: (from, to) => {
    const { group, groupEdit } = get();
    if (group === from || groupEdit?.id === from) set({ group: group === from ? to : group, groupEdit: groupEdit?.id === from ? { ...groupEdit, id: to } : groupEdit });
  },
  pruneGroup: (exists) => {
    const { group, groupEdit } = get();
    const goneGroup = group !== null && !exists(group);
    const goneEdit = groupEdit !== null && !exists(groupEdit.id);
    if (goneGroup || goneEdit) set({ ...(goneGroup ? { group: null } : {}), ...(goneEdit ? { groupEdit: null } : {}) });
  },
  startGroupEdit: (id) => set({ groupEdit: { id, n: (get().groupEdit?.n ?? 0) + 1 } }),
  endGroupEdit: () => {
    if (get().groupEdit) set({ groupEdit: null });
  },
  renameSelected: (from, to) => {
    const { selection, editRequest, inlineEdit } = get();
    set({
      ...all(renameInSelection(selection, from, to), get().frames, get().shapes, get().connectors),
      group: get().group,
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
      set({ ...all(next, get().frames, get().shapes, get().connectors), group: get().group, ...(goneInline ? { inlineEdit: null } : {}), ...(goneRequest ? { editRequest: null } : {}) });
  },
  selectFrame: (id) => {
    if (get().frameSelected !== id) set({ ...all(EMPTY_SELECTION, selectOnly(get().frames, id)), inlineEdit: null });
  },
  toggleFrame: (id) => set({ ...all(get().selection, toggleSelected(get().frames, id), get().shapes, get().connectors), group: get().group, inlineEdit: null }),
  renameFrame: (from, to) => {
    const { frames, frameEditRequest } = get();
    set({
      ...all(get().selection, renameInSelection(frames, from, to), get().shapes, get().connectors),
      group: get().group,
      frameEditRequest: frameEditRequest?.id === from ? { ...frameEditRequest, id: to } : frameEditRequest,
    });
  },
  pruneFrame: (exists) => {
    const { frames, frameEditRequest } = get();
    const next = pruneSelection(frames, exists);
    const goneRequest = frameEditRequest !== null && !exists(frameEditRequest.id);
    if (next !== frames || goneRequest) set({ ...all(get().selection, next, get().shapes, get().connectors), group: get().group, ...(goneRequest ? { frameEditRequest: null } : {}) });
  },
  selectShape: (id) => {
    if (get().shapeSelected !== id) set({ ...all(EMPTY_SELECTION, EMPTY_SELECTION, selectOnly(get().shapes, id)), inlineEdit: null });
  },
  toggleShape: (id) => set({ ...all(get().selection, get().frames, toggleSelected(get().shapes, id), get().connectors), group: get().group, inlineEdit: null, shapeEdit: null }),
  renameShape: (from, to) => {
    const { shapes, shapeEdit } = get();
    set({ ...all(get().selection, get().frames, renameInSelection(shapes, from, to), get().connectors), group: get().group, shapeEdit: shapeEdit?.id === from ? { ...shapeEdit, id: to } : shapeEdit });
  },
  pruneShapes: (exists) => {
    const { shapes, shapeEdit } = get();
    const next = pruneSelection(shapes, exists);
    const goneEdit = shapeEdit !== null && !exists(shapeEdit.id);
    if (next !== shapes || goneEdit) set({ ...all(get().selection, get().frames, next, get().connectors), group: get().group, ...(goneEdit ? { shapeEdit: null } : {}) });
  },
  startShapeEdit: (id) =>
    set({ ...all(EMPTY_SELECTION, EMPTY_SELECTION, selectOnly(get().shapes, id)), inlineEdit: null, shapeEdit: { id, n: (get().shapeEdit?.n ?? 0) + 1 } }),
  endShapeEdit: () => {
    if (get().shapeEdit) set({ shapeEdit: null });
  },
  requestFrameEdit: (id) => set({ ...all(EMPTY_SELECTION, selectOnly(get().frames, id)), frameEditRequest: { id, n: (get().frameEditRequest?.n ?? 0) + 1 } }),
  requestEdit: (id) => set({ ...all(selectOnly(get().selection, id), EMPTY_SELECTION), editRequest: { id, n: (get().editRequest?.n ?? 0) + 1 } }),
  startInlineEdit: (id, part) =>
    set({ ...all(selectOnly(get().selection, id), EMPTY_SELECTION), inlineEdit: { id, part, n: (get().inlineEdit?.n ?? 0) + 1 } }),
  endInlineEdit: () => {
    if (get().inlineEdit) set({ inlineEdit: null });
  },
  setAddSheetOpen: (addSheetOpen) => set({ addSheetOpen }),
  setTimerPickerOpen: (timerPickerOpen) => set({ timerPickerOpen }),
  requestReveal: (id) =>
    set({ ...all(selectOnly(get().selection, id), EMPTY_SELECTION), inlineEdit: null, revealRequest: { id, n: (get().revealRequest?.n ?? 0) + 1 } }),
  setGridColumns: (gridColumns) => set({ gridColumns }),
  requestJump: (id) => set({ jumpRequest: { id, n: (get().jumpRequest?.n ?? 0) + 1 } }),
  setViewNotice: (viewNotice) => set({ viewNotice }),
  resetRoom: () => set({ groupEdit: null, jumpRequest: null, viewNotice: null,  ...all(EMPTY_SELECTION, EMPTY_SELECTION), shapeEdit: null, frameEditRequest: null, editRequest: null, inlineEdit: null, addSheetOpen: false, timerPickerOpen: false, revealRequest: null }),
}));
