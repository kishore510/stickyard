import { MIN_GROUP_MEMBERS, type Group } from "@stickyard/shared";

/*
 * Groups (protocol v22, stored schema 13): what a change does to the room's groups, worked out
 * without touching storage, so the room and every delete path share one rule. An item is in at
 * most one group: putting it in one takes it out of any other. Every group whose members change
 * gets one rev bump; one left with fewer than MIN_GROUP_MEMBERS is dissolved. Members are kept in
 * id order, so a group reads the same from memory and from storage.
 */

/** One group a change touched: its new state, or null when it was dissolved (or deleted). */
export interface GroupChange {
  id: string;
  group: Group | null;
}

export interface Regrouped {
  /** Every group after the change, in creation order. */
  next: Map<string, Group>;
  /** The groups whose members changed, in creation order (a fresh group last). */
  changes: GroupChange[];
}

/** Which group each item is in. */
export function memberIndex(groups: ReadonlyMap<string, Group>): Map<string, string> {
  const index = new Map<string, string>();
  for (const group of groups.values()) for (const item of group.members) index.set(item, group.id);
  return index;
}

/**
 * The groups after moving items: each item in `moves` goes into the group named (null: into none).
 * `fresh` (a groupCreate) is added last, with no members of its own: its members come in as moves.
 * A group that already existed and whose members change gets rev + 1 (a fresh one keeps its rev);
 * one left with fewer than MIN_GROUP_MEMBERS is dropped and reported with a null group.
 */
export function regroup(groups: ReadonlyMap<string, Group>, moves: ReadonlyMap<string, string | null>, fresh?: Group): Regrouped {
  const members = new Map<string, Set<string>>();
  for (const group of groups.values()) members.set(group.id, new Set(group.members));
  if (fresh) members.set(fresh.id, new Set());
  const index = memberIndex(groups);
  const touched = new Set<string>();
  for (const [item, to] of moves) {
    const from = index.get(item) ?? null;
    if (from === to) continue;
    if (from !== null) {
      members.get(from)?.delete(item);
      touched.add(from);
    }
    if (to !== null && members.has(to)) {
      members.get(to)?.add(item);
      touched.add(to);
    }
  }
  const next = new Map<string, Group>();
  const changes: GroupChange[] = [];
  const all = fresh ? [...groups.values(), fresh] : [...groups.values()];
  for (const group of all) {
    if (!touched.has(group.id)) {
      next.set(group.id, group);
      continue;
    }
    const now = [...(members.get(group.id) ?? [])].sort();
    if (now.length < MIN_GROUP_MEMBERS) {
      changes.push({ id: group.id, group: null });
      continue;
    }
    const changed: Group = { ...group, members: now, rev: group === fresh ? group.rev : group.rev + 1 };
    next.set(group.id, changed);
    changes.push({ id: group.id, group: changed });
  }
  return { next, changes };
}
