import type { Group, GroupColor } from "@stickyard/shared";
import { localId, type Board } from "../notes/board";

/*
 * Groups (protocol v22; the page since v0.38.0) on the board as this page sees them: the relay's
 * groups plus optimistic local changes, like arrows (connectors/board.ts). Pure functions on the
 * shared Board, each returning a new Board, or the same one when nothing changed.
 *
 * - `confirmed` is what the relay last sent; `group` is what's shown. A refusal rolls back.
 * - No message carries a rev from the page: the relay's groupUpdated is applied by rev (an older
 *   or equal one is stale), and an update for an id this page doesn't know is ignored.
 * - Membership is exclusive: an item named by a new or updated group leaves every other group
 *   (the relay sends their own updates too, in any order).
 * - No box is stored: the canvas works it out from the members' live boxes (groups/geometry.ts).
 */

export interface BoardGroup {
  group: Group;
  /** The relay's latest version; null while a create hasn't been confirmed. */
  confirmed: Group | null;
  /** Set while a create is waiting for its server id. */
  clientRef: string | null;
}

/** What a group's own change may carry (groupUpdate: label, colour; groupMembers: the whole member list here). */
export type GroupPatch = Partial<Pick<Group, "label" | "color" | "members">>;

export const sortIds = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

export function findGroup(board: Board, id: string): BoardGroup | undefined {
  return board.groups.find((g) => g.group.id === id);
}

/** The group an item is in, as shown (or undefined). */
export function groupOfItem(board: Board, itemId: string): BoardGroup | undefined {
  return board.groups.find((g) => g.group.members.includes(itemId));
}

const confirmedEntry = (group: Group): BoardGroup => ({ group, confirmed: group, clientRef: null });
const isStale = (entry: BoardGroup | undefined, rev: number) => entry?.confirmed != null && rev <= entry.confirmed.rev;

function patch(board: Board, id: string, change: (entry: BoardGroup) => BoardGroup): Board {
  const index = board.groups.findIndex((g) => g.group.id === id);
  const entry = board.groups[index];
  if (!entry) return board;
  const next = change(entry);
  if (next === entry) return board;
  const groups = [...board.groups];
  groups[index] = next;
  return { ...board, groups };
}

/** Items named by `group` leave every other group, shown and confirmed (the relay's word on membership). */
function exclusive(board: Board, group: Group): Board {
  const taken = new Set(group.members);
  let changed = false;
  const strip = (g: Group | null): Group | null => {
    if (!g || g.id === group.id || !g.members.some((m) => taken.has(m))) return g;
    changed = true;
    return { ...g, members: g.members.filter((m) => !taken.has(m)) };
  };
  const groups = board.groups.map((e) => {
    if (e.group.id === group.id) return e;
    const shown = strip(e.group)!;
    const confirmed = strip(e.confirmed);
    return shown === e.group && confirmed === e.confirmed ? e : { ...e, group: shown, confirmed };
  });
  return changed ? { ...board, groups } : board;
}

/* ── From the relay ─────────────────────────────────────────────────── */

/** Every join's groupsSnapshot: it replaces every confirmed group (never a merge). Creates still waiting here stay. */
export function applyGroupsSnapshot(board: Board, groups: readonly Group[]): Board {
  const pending = board.groups.filter((g) => g.clientRef !== null);
  return { ...board, groups: [...pending, ...groups.map(confirmedEntry)], groupsRemoved: [] };
}

/** A new group. With my clientRef, it replaces the temporary one in place. */
export function applyGroupCreated(board: Board, group: Group, clientRef?: string): Board {
  let next = board;
  if (clientRef !== undefined && findGroup(board, localId(clientRef))) next = patch(board, localId(clientRef), () => confirmedEntry(group));
  else if (findGroup(board, group.id)) return applyGroupUpdated(board, group);
  else next = { ...board, groups: [...board.groups, confirmedEntry(group)] };
  return exclusive(next, group);
}

/** A label, colour or member change (the whole group), by rev. Unknown ids are ignored. */
export function applyGroupUpdated(board: Board, group: Group): Board {
  const removed = board.groupsRemoved.find((g) => g.group.id === group.id);
  if (removed) {
    if (isStale(removed, group.rev)) return board;
    return exclusive({ ...board, groupsRemoved: board.groupsRemoved.map((g) => (g === removed ? { ...g, confirmed: group } : g)) }, group);
  }
  const entry = findGroup(board, group.id);
  if (!entry || isStale(entry, group.rev)) return board;
  return exclusive(patch(board, group.id, () => confirmedEntry(group)), group);
}

/** Ungrouped or dissolved: the group goes, its items stay. */
export function applyGroupDeleted(board: Board, id: string): Board {
  if (!findGroup(board, id) && !board.groupsRemoved.some((g) => g.group.id === id)) return board;
  return {
    ...board,
    groups: board.groups.filter((g) => g.group.id !== id),
    groupsRemoved: board.groupsRemoved.filter((g) => g.group.id !== id),
  };
}

/** The relay refused a create: the temporary group goes. */
export function rejectGroupCreate(board: Board, clientRef: string): Board {
  const id = localId(clientRef);
  if (!findGroup(board, id)) return board;
  return { ...board, groups: board.groups.filter((g) => g.group.id !== id) };
}

/** The relay refused a change to `id`: back to what it last confirmed (a refused delete comes back in its place). */
export function rollbackGroup(board: Board, id: string): Board {
  const removed = board.groupsRemoved.find((g) => g.group.id === id);
  if (removed) {
    const { index, ...entry } = removed;
    const groups = [...board.groups];
    groups.splice(Math.min(index, groups.length), 0, entry.confirmed ? { ...entry, group: entry.confirmed } : entry);
    return { ...board, groups, groupsRemoved: board.groupsRemoved.filter((g) => g !== removed) };
  }
  return patch(board, id, (e) => (e.confirmed && e.group !== e.confirmed ? { ...e, group: e.confirmed } : e));
}

/* ── Local, optimistic ─────────────────────────────────────────────── */

/**
 * Items taken out of every group but `keep` (shown only): a group left with fewer than 2 is shown
 * as gone (deleted here, waiting for the relay's groupDeleted). The groups touched, by id.
 */
export function takeOutLocal(board: Board, items: readonly string[], keep: string | null = null): { board: Board; touched: string[] } {
  const taken = new Set(items);
  let next = board;
  const touched: string[] = [];
  for (const entry of board.groups) {
    const g = entry.group;
    if (g.id === keep || !g.members.some((m) => taken.has(m))) continue;
    touched.push(g.id);
    const members = g.members.filter((m) => !taken.has(m));
    next = members.length < 2 ? deleteGroupLocal(next, g.id) : patch(next, g.id, (e) => ({ ...e, group: { ...e.group, members } }));
  }
  return { board: next, touched };
}

/** A new group, waiting for its server id (its clientRef names it until then). Its items leave other groups here. */
export function addGroupLocal(board: Board, add: { clientRef: string; label: string; color: GroupColor; members: readonly string[] }): { board: Board; touched: string[] } {
  const group: Group = { id: localId(add.clientRef), label: add.label, color: add.color, members: sortIds(add.members), rev: 1 };
  const out = takeOutLocal(board, group.members);
  return { board: { ...out.board, groups: [...out.board.groups, { group, confirmed: null, clientRef: add.clientRef }] }, touched: out.touched };
}

/** Label, colour or members shown at once. The same board when nothing changes. */
export function updateGroupLocal(board: Board, id: string, change: GroupPatch): Board {
  return patch(board, id, (e) => {
    const next: Group = {
      ...e.group,
      ...(change.label !== undefined ? { label: change.label } : {}),
      ...(change.color !== undefined ? { color: change.color } : {}),
      ...(change.members !== undefined ? { members: sortIds(change.members) } : {}),
    };
    const same = next.label === e.group.label && next.color === e.group.color && next.members.join(" ") === e.group.members.join(" ");
    return same ? e : { ...e, group: next };
  });
}

export function deleteGroupLocal(board: Board, id: string): Board {
  const index = board.groups.findIndex((g) => g.group.id === id);
  const entry = board.groups[index];
  if (!entry) return board;
  return { ...board, groups: board.groups.filter((g) => g !== entry), groupsRemoved: [...board.groupsRemoved, { ...entry, index }] };
}

/** An item got its server id: groups still waiting here that name its local id follow it. */
export function renameItemInGroups(board: Board, from: string, to: string): Board {
  let changed = false;
  const groups = board.groups.map((e) => {
    if (e.confirmed !== null || !e.group.members.includes(from)) return e;
    changed = true;
    return { ...e, group: { ...e.group, members: sortIds(e.group.members.map((m) => (m === from ? to : m))) } };
  });
  return changed ? { ...board, groups } : board;
}

/** Back to what the relay last confirmed (a dropped connection): creates go, deletes come back, local changes undone. */
export function discardUnconfirmedGroups(board: Board): Board {
  let next = board;
  for (const removed of [...board.groupsRemoved].reverse()) next = rollbackGroup(next, removed.group.id);
  const groups = next.groups.flatMap((e): BoardGroup[] => {
    if (e.confirmed === null) return [];
    return e.group === e.confirmed ? [e] : [{ ...e, group: e.confirmed }];
  });
  return { ...next, groups, groupsRemoved: [] };
}
