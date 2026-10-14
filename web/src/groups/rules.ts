import { MAX_GROUP_LABEL, MAX_GROUP_MEMBERS, MAX_GROUPS_PER_ROOM, MIN_GROUP_MEMBERS } from "@stickyard/shared";
import { NOTE_TOOL_REASONS } from "../canvas/tools";
import { LOCK_TEXT } from "../facilitation/lock";
import { SILENT_TEXT } from "../silent/silent";
import { inField, onBoard, onBoardBar, onSidePanel } from "../canvas/deleteKey";

/*
 * Groups (web only): what the page says about them, and why their controls are off. Pure, tested.
 * Reasons are shown, never hidden: a control that can't be used now says why.
 */

const groups = (n: number) => `${n} ${n === 1 ? "group" : "groups"}`;
const items = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

export const GROUP_TEXT = {
  full: `The board has the maximum of ${MAX_GROUPS_PER_ROOM} groups. Ungroup one to make another.`,
  few: `Select ${MIN_GROUP_MEMBERS} or more notes or shapes to group them.`,
  tooMany: `A group holds at most ${MAX_GROUP_MEMBERS} notes and shapes.`,
  unsaved: "Wait until new notes and shapes are saved.",
  ignored: "Frames and arrows can’t be in a group, so they were left out.",
  already: "These items are a group already.",
  size: `A group needs ${MIN_GROUP_MEMBERS} to ${MAX_GROUP_MEMBERS} notes and shapes, so that change wasn’t saved.`,
  unknownItem: "A note or shape in that change has gone, so the change wasn’t saved.",
  unknownGroup: "That group has gone, so the change wasn’t saved.",
  noneToAdd: "Select notes or shapes outside the group to add them.",
  noneToRemove: "Select some of the group’s notes or shapes to take them out.",
  removeAll: `That would leave fewer than ${MIN_GROUP_MEMBERS} items. Use Ungroup instead.`,
  noneToUngroup: "Select a group, or items in one, to ungroup.",
  untitled: "Untitled group",
  labelHint: `Up to ${MAX_GROUP_LABEL} characters, one line.`,
  phone: "Groups can be changed on a wider screen.",
  duplicateFull: (needs: number, free: number) =>
    `No room to duplicate ${groups(needs)}: the board has room for ${free} more (at most ${MAX_GROUPS_PER_ROOM}).`,
  restoreFull: (needs: number, free: number) =>
    `Undo would bring back ${groups(needs)}, but the board has room for ${free} more (at most ${MAX_GROUPS_PER_ROOM}).`,
  summary: (n: number) => `${n} of ${MAX_GROUPS_PER_ROOM} groups`,
  members: (n: number) => `${n} ${n === 1 ? "member" : "members"}`,
  grouped: (n: number) => `Grouped ${items(n)}.`,
  ungrouped: (n: number) => (n === 1 ? "Ungrouped." : `Ungrouped ${groups(n)}.`),
} as const;

/** The delete confirm's extra line: groups a delete leaves with fewer than 2 items are ungrouped. */
export const ungroupedLine = (n: number) => `${groups(n)} will be ungrouped.`;

/** Why every group control is off now (not connected, a guest on a locked board, a silent round for everyone), or null. */
export function groupReason({ live, lockedOut, silent }: { live: boolean; lockedOut: boolean; silent: boolean }): string | null {
  if (!live) return NOTE_TOOL_REASONS.disconnected;
  if (lockedOut) return LOCK_TEXT.reason;
  return silent ? SILENT_TEXT.on : null;
}

/**
 * Why Group is off for a selection, or null. `items`: notes and shapes selected; `unsaved`: one
 * has no server id yet; `already`: they're exactly one group's members; `count`: groups now.
 */
export function createReason(s: { base: string | null; items: number; unsaved: boolean; already: boolean; count: number }): string | null {
  if (s.base !== null) return s.base;
  if (s.items < MIN_GROUP_MEMBERS) return GROUP_TEXT.few;
  if (s.items > MAX_GROUP_MEMBERS) return GROUP_TEXT.tooMany;
  if (s.already) return GROUP_TEXT.already;
  if (s.unsaved) return GROUP_TEXT.unsaved;
  return s.count >= MAX_GROUPS_PER_ROOM ? GROUP_TEXT.full : null;
}

export interface GroupKeyEvent {
  key: string;
  target: EventTarget | null;
  defaultPrevented: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * G groups the selection, Shift+G ungroups (md and up). Never Ctrl+G (browsers' find next), never
 * in a field or a modal sheet, never from a control elsewhere on the page.
 */
export function groupKey(e: GroupKeyEvent, state: { multi: boolean; modal: boolean; board: Element | null }): "group" | "ungroup" | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== "g") return null;
  if (!state.multi || state.modal || inField(e.target)) return null;
  if (!(onBoard(e.target, state.board) || onBoardBar(e.target) || onSidePanel(e.target))) return null;
  return e.shiftKey ? "ungroup" : "group";
}
