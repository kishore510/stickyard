import { MIN_GROUP_MEMBERS, type Group } from "@stickyard/shared";
import type { Board } from "../notes/board";
import { truncate } from "../notes/label";
import { GROUP_TEXT } from "./rules";
import { sortIds } from "./board";

/*
 * Group geometry and selection rules (web only, pure, tested). A group's box is never stored: it
 * is the box round its members' live boxes (as this page shows them, so a drag here or a remote
 * move moves it at once, nothing sent) plus GROUP_PAD.
 */

/** Space between the members and the box (board units; mirrored by --sy-group-pad). */
export const GROUP_PAD = 16;
/** From this zoom the chip shows the whole label; below it, a short summary. */
export const GROUP_LABEL_ZOOM = 0.5;
/** Below this zoom the chip's text is hidden (the outline stays, and still selects). */
export const GROUP_HIDE_ZOOM = 0.25;
/** Characters of the label in the chip's summary (below GROUP_LABEL_ZOOM). */
export const GROUP_SUMMARY_CHARS = 12;

export type Rect = { x: number; y: number; w: number; h: number };
export type LabelMode = "full" | "summary" | "hidden";

/** Shown notes' and shapes' boxes, by id. */
export function itemBoxes(board: Board): (id: string) => Rect | undefined {
  const boxes = new Map<string, Rect>();
  for (const n of board.notes) boxes.set(n.note.id, { x: n.note.x, y: n.note.y, w: n.note.w, h: n.note.h });
  for (const s of board.shapes) boxes.set(s.shape.id, { x: s.shape.x, y: s.shape.y, w: s.shape.w, h: s.shape.h });
  return (id) => boxes.get(id);
}

/** The box round the members on the board plus the padding; null when none is shown. */
export function groupBox(members: readonly string[], boxOf: (id: string) => Rect | undefined, pad = GROUP_PAD): Rect | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const id of members) {
    const b = boxOf(id);
    if (!b) continue;
    left = Math.min(left, b.x);
    top = Math.min(top, b.y);
    right = Math.max(right, b.x + b.w);
    bottom = Math.max(bottom, b.y + b.h);
  }
  if (left === Infinity) return null;
  return { x: left - pad, y: top - pad, w: right - left + 2 * pad, h: bottom - top + 2 * pad };
}

export function labelMode(zoom: number): LabelMode {
  return zoom >= GROUP_LABEL_ZOOM ? "full" : zoom >= GROUP_HIDE_ZOOM ? "summary" : "hidden";
}

/** The chip's text: the label (or "Untitled group"), shortened below 50%, nothing below 25%. Plain text only. */
export function chipText(label: string, mode: LabelMode): string {
  if (mode === "hidden") return "";
  const text = label.trim() === "" ? GROUP_TEXT.untitled : label;
  return mode === "summary" ? truncate(text, GROUP_SUMMARY_CHARS) : truncate(text, 40);
}

/** The chip's accessible name: the label's text only (truncated), never markup. */
export function groupName(group: Pick<Group, "label" | "members">): string {
  const label = group.label.trim() === "" ? GROUP_TEXT.untitled : truncate(group.label, 40);
  return `Group: ${label}, ${GROUP_TEXT.members(group.members.length)}`;
}

/** What taking `items` out of their groups does to the others (confirmed groups only): dissolved below 2, or shrunk. */
export function groupEffects(board: Board, items: readonly string[], keep: string | null = null): { dissolved: Group[]; shrunk: { group: Group; members: string[] }[] } {
  const gone = new Set(items);
  const dissolved: Group[] = [];
  const shrunk: { group: Group; members: string[] }[] = [];
  for (const entry of board.groups) {
    const g = entry.confirmed;
    if (!g || g.id === keep || !g.members.some((m) => gone.has(m))) continue;
    const members = g.members.filter((m) => !gone.has(m));
    if (members.length < MIN_GROUP_MEMBERS) dissolved.push(g);
    else shrunk.push({ group: g, members });
  }
  return { dissolved, shrunk };
}

/** How many groups deleting these items would ungroup (the delete confirm says so). */
export function ungroupedBy(board: Board, items: readonly string[]): number {
  const gone = new Set(items);
  return board.groups.filter((e) => {
    const m = e.group.members;
    return m.some((id) => gone.has(id)) && m.filter((id) => !gone.has(id)).length < MIN_GROUP_MEMBERS;
  }).length;
}

/** The group whose members are exactly these items (and nothing else selected), or null. */
export function groupOfSelection(board: Board, items: readonly string[]): string | null {
  if (items.length < MIN_GROUP_MEMBERS) return null;
  const key = sortIds(items).join(" ");
  return board.groups.find((g) => g.group.members.join(" ") === key)?.group.id ?? null;
}

/** Groups with at least one of these items, in creation order. */
export function groupsTouching(board: Board, items: readonly string[]): string[] {
  const set = new Set(items);
  return board.groups.filter((g) => g.group.members.some((m) => set.has(m))).map((g) => g.group.id);
}

/** Groups every member of which is in `items` (Duplicate copies only these). */
export function wholeGroups(board: Board, items: readonly string[]): Group[] {
  const set = new Set(items);
  return board.groups.flatMap((g) => (g.confirmed !== null && g.group.members.every((m) => set.has(m)) ? [g.group] : []));
}
