/*
 * The board's selection: a set of note ids. Pure functions, each returning a new set, or the
 * same one when nothing changed (so stores and memoised nodes don't update for nothing).
 *
 * The UI only ever selects zero or one note for now (slice 2.8 adds multi-select); the
 * Properties panel shows the board summary for none and the note's fields for one.
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
