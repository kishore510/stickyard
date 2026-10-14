import { GROUP_COLORS, type GroupColor } from "@stickyard/shared";
import type { Fields } from "../history/history";
import { sortIds } from "./board";

/*
 * Groups in the undo history (web only). The history keeps plain fields, so the member list is a
 * JSON string of ids in id order (the relay's order). An item's new id (an undo adding it back,
 * then the relay's id) reaches the list through renameMemberRefs.
 */

export const encodeMembers = (ids: readonly string[]): string => JSON.stringify(sortIds(ids));

export function decodeMembers(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((x) => typeof x === "string") ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

/** A group's content (or part of it) as history fields. */
export function groupFields(g: { label?: string; color?: GroupColor; members?: readonly string[] }): Fields {
  const out: Record<string, string> = {};
  if (g.label !== undefined) out.label = g.label;
  if (g.color !== undefined) out.color = g.color;
  if (g.members !== undefined) out.members = encodeMembers(g.members);
  return out;
}

/** History fields back to a group's parts (unknown or malformed keys left out). */
export function groupFromFields(fields: Fields): { label?: string; color?: GroupColor; members?: string[] } {
  const members = decodeMembers(fields.members);
  const color = fields.color;
  return {
    ...(typeof fields.label === "string" ? { label: fields.label } : {}),
    ...(typeof color === "string" && (GROUP_COLORS as readonly string[]).includes(color) ? { color: color as GroupColor } : {}),
    ...(members ? { members } : {}),
  };
}

/** An item's new id in a member list; the same object when the list doesn't name it. */
export function renameMemberRefs(fields: Fields, from: string, to: string): Fields {
  const members = decodeMembers(fields.members);
  if (!members || !members.includes(from)) return fields;
  return { ...fields, members: encodeMembers(members.map((m) => (m === from ? to : m))) };
}
