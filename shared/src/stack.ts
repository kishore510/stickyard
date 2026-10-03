/*
 * Stacking order (protocol v8): which object sits on top of which. Each object has a
 * server-assigned integer z; higher is in front. Ties (possible only in rooms that older code
 * wrote to) are broken by id, in plain code-unit order, so the relay and every page agree.
 *
 * Pure functions on { id, z } only, so anything that shares the stacking space later can reuse
 * them without change.
 */

/** z stays within ±this. An action that would pass it renumbers the whole room (see restack). */
export const NOTE_Z_LIMIT = 100_000;

export const ORDER_ACTIONS = ["front", "back"] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];

export interface Stacked {
  id: string;
  z: number;
}

/** Negative if `a` is below `b`, positive if above: by z, then by id. */
export function compareStack(a: Stacked, b: Stacked): number {
  if (a.z !== b.z) return a.z - b.z;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A sorted copy, bottom first. */
export function stackOrder<T extends Stacked>(items: readonly T[]): T[] {
  return [...items].sort(compareStack);
}

/** Every item numbered 0..n-1 in `order`; only the ones whose z changes are returned. */
function renumber(order: readonly Stacked[]): Stacked[] {
  return order.flatMap((item, z) => (item.z === z ? [] : [{ id: item.id, z }]));
}

export interface Restack {
  /** The items whose z changes, with their new z. */
  changes: Stacked[];
  /** The bound would have been passed, so the whole room was renumbered. */
  renormalised: boolean;
}

/**
 * Brings the named items to the front (above all others) or sends them to the back (below all
 * others), keeping their order among themselves. Ids not in `items` are ignored. Only items
 * that must move change: a named item already above everything below it in the result keeps
 * its z, and a changed item never ties with its neighbour. If a new z would pass NOTE_Z_LIMIT,
 * every item is renumbered 0..n-1 in the resulting order instead.
 */
export function restack(items: readonly Stacked[], ids: readonly string[], action: OrderAction): Restack {
  const named = new Set(ids);
  const sorted = stackOrder(items);
  const chosen = sorted.filter((item) => named.has(item.id));
  const others = sorted.filter((item) => !named.has(item.id));
  if (chosen.length === 0) return { changes: [], renormalised: false };

  const front = action === "front";
  // Walk away from the others: upwards for front, downwards for back.
  const walk = front ? chosen : [...chosen].reverse();
  const step = front ? 1 : -1;
  type Neighbour = Stacked & { moved: boolean };
  // Past an unchanged neighbour by the usual order; past a moved one strictly by z (no new ties).
  const beyond = (item: Stacked, n: Neighbour) => {
    const c = n.moved ? item.z - n.z : compareStack(item, n);
    return front ? c > 0 : c < 0;
  };
  const edge = front ? others.at(-1) : others[0];
  let prev: Neighbour | undefined = edge ? { ...edge, moved: false } : undefined;
  const changes: Stacked[] = [];
  for (const item of walk) {
    if (!prev || beyond(item, prev)) {
      prev = { ...item, moved: false };
      continue;
    }
    const z = prev.z + step;
    if (Math.abs(z) > NOTE_Z_LIMIT) {
      return { changes: renumber(front ? [...others, ...chosen] : [...chosen, ...others]), renormalised: true };
    }
    changes.push({ id: item.id, z });
    prev = { id: item.id, z, moved: true };
  }
  return { changes, renormalised: false };
}

/**
 * The z for a new item: on top of everything (max z + 1; 0 when there is nothing). At the bound,
 * the others are renumbered 0..n-1 first (returned as changes) and the new item gets n.
 */
export function zForNew(items: readonly Stacked[]): { z: number; changes: Stacked[] } {
  if (items.length === 0) return { z: 0, changes: [] };
  const z = Math.max(...items.map((item) => item.z)) + 1;
  if (z <= NOTE_Z_LIMIT) return { z, changes: [] };
  return { z: items.length, changes: renumber(stackOrder(items)) };
}

/** A z read from storage, forced into the bound (and to a whole number). */
export function clampZ(z: number): number {
  if (!Number.isFinite(z)) return 0;
  return Math.min(NOTE_Z_LIMIT, Math.max(-NOTE_Z_LIMIT, Math.round(z)));
}
