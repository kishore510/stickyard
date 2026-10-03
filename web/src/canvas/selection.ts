/*
 * The board's selection: a set of note ids. Pure functions, each returning a new set, or the
 * same one when nothing changed (so stores and memoised nodes don't update for nothing).
 *
 * Since slice 2.8 any number can be selected (Shift/Ctrl-click, marquee, Ctrl+A). A set keeps
 * insertion order: the first selected note is the reference for Match size. The Properties
 * panel shows the board summary for none, the note's fields for one, and "N selected" for more.
 */

export type Selection = ReadonlySet<string>;

export const EMPTY_SELECTION: Selection = new Set<string>();

/** Just this note. */
export function selectOnly(selection: Selection, id: string): Selection {
  return selection.size === 1 && selection.has(id) ? selection : new Set([id]);
}

/** Adds the note, or removes it if it's already selected. */
export function toggleSelected(selection: Selection, id: string): Selection {
  const next = new Set(selection);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function clearSelection(selection: Selection): Selection {
  return selection.size === 0 ? selection : EMPTY_SELECTION;
}

export function isSelected(selection: Selection, id: string): boolean {
  return selection.has(id);
}

/** The selected note's id when exactly one is selected, otherwise null. */
export function onlySelected(selection: Selection): string | null {
  if (selection.size !== 1) return null;
  const [id] = selection;
  return id ?? null;
}

/** Drops ids of notes that no longer exist (deleted here or by someone else). */
export function pruneSelection(selection: Selection, exists: (id: string) => boolean): Selection {
  for (const id of selection) {
    if (!exists(id)) return new Set([...selection].filter(exists));
  }
  return selection;
}

/** A new note got its server id: the selection follows it. */
export function renameInSelection(selection: Selection, from: string, to: string): Selection {
  if (!selection.has(from)) return selection;
  const next = new Set(selection);
  next.delete(from);
  next.add(to);
  return next;
}

/** Every one of these ids, in this order. */
export function selectAll(ids: Iterable<string>): Selection {
  return new Set(ids);
}

/** The selected ids in the order they were selected. */
export function orderedIds(selection: Selection): string[] {
  return [...selection];
}

export interface Box {
  x: number;
  y: number;
  /** Negative when drawn right to left (or bottom to top). */
  width: number;
  height: number;
}

/**
 * A marquee's selection: every note it touches (partly is enough, as in Chalkline), in board
 * order, after the base selection when `additive` (Shift). Returns `previous` when that's the
 * same, so the store doesn't update on every pointer move.
 */
export function marqueeSelection(
  notes: readonly { id: string; x: number; y: number; w: number; h: number }[],
  box: Box,
  base: Selection,
  additive: boolean,
  previous?: Selection,
): Selection {
  const left = Math.min(box.x, box.x + box.width);
  const right = Math.max(box.x, box.x + box.width);
  const top = Math.min(box.y, box.y + box.height);
  const bottom = Math.max(box.y, box.y + box.height);
  const hits = notes.filter((n) => n.x <= right && n.x + n.w >= left && n.y <= bottom && n.y + n.h >= top).map((n) => n.id);
  const next = new Set(additive ? [...base, ...hits] : hits);
  if (previous && previous.size === next.size && [...previous].every((id, i) => [...next][i] === id)) return previous;
  return next;
}
