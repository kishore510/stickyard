import type { LucideIcon } from "lucide-react";
import { NOTE_COLORS, type NoteColor } from "@stickyard/shared";
import type { XY } from "../canvas/geometry";
import { NOTE_COLOR_NAMES } from "../notes/colours";

/*
 * The palette: everything you can add to the board, in one registry. The desktop palette
 * panel and the phone add sheet are both built from it (palette/Palette.tsx), so a new tile
 * is one item here, a new category one entry in PALETTE_CATEGORIES, and a new tab one entry
 * in PALETTE_TABS. Only what exists is listed: no placeholder tiles, and a tab or category
 * with nothing in it isn't shown (so there's no Stencils tab until a stencil is registered).
 *
 * A new kind of object (timer, text box, group box) needs its own protocol change first, in
 * its own slice; its tile then arrives as one entry here.
 */

/** What the tile shows: a small note in a palette colour, or an icon. */
export type PalettePreview = { kind: "note"; color: NoteColor } | { kind: "icon"; icon: LucideIcon };

/** What a drag carries (shown under the pointer while dragging). */
export type PalettePayload = { kind: "note"; color: NoteColor };

/** What tiles can do. `at` is a board position (a drop); without it, the viewport centre. */
export interface PaletteActions {
  addNote(color: NoteColor, at?: XY): void;
}

/** What tiles need to know to be enabled. */
export interface PaletteContext {
  /** Why notes can't be added right now (disconnected, board full), or null. */
  noteReason: string | null;
}

/**
 * Room state the palette can draw items from. Today no selector uses it; later, tiles the
 * room defines (slice 6) come from here with no panel changes.
 */
export interface PaletteRoomState {
  live: boolean;
  noteCount: number;
}

export interface PaletteItem {
  id: string;
  /** The accessible name and visible label, e.g. "Yellow note". */
  label: string;
  /** Extra words search matches. */
  keywords: readonly string[];
  preview: PalettePreview;
  payload: PalettePayload;
  /** Click (at the viewport centre) or drop (at `at`, in board units). */
  create(actions: PaletteActions, at?: XY): void;
  /** Why it can't be used now, or null. */
  disabled(ctx: PaletteContext): string | null;
}

export interface PaletteTab {
  id: string;
  label: string;
  order: number;
}

export interface PaletteCategory {
  id: string;
  label: string;
  order: number;
  /** The tab it's listed under. */
  tab: string;
  items: readonly PaletteItem[];
  /** Extra items derived from the room's state, after the static ones. */
  fromRoom?: (state: PaletteRoomState) => readonly PaletteItem[];
}

/** A note tile: the colour's note, labelled with its name. */
export function noteTile(id: string, color: NoteColor, label = `${NOTE_COLOR_NAMES[color]} note`): PaletteItem {
  return {
    id,
    label,
    keywords: ["note", "sticky", "add", NOTE_COLOR_NAMES[color].toLowerCase(), color],
    preview: { kind: "note", color },
    payload: { kind: "note", color },
    create: (actions, at) => actions.addNote(color, at),
    disabled: (ctx) => ctx.noteReason,
  };
}

export const NOTE_TILES: readonly PaletteItem[] = NOTE_COLORS.map((color) => noteTile(`note-${color}`, color));

/** Note tiles defined by the room. None yet (facilitator palettes are slice 6). */
export function roomNoteTiles(_state: PaletteRoomState): readonly PaletteItem[] {
  return [];
}

export const PALETTE_TABS: readonly PaletteTab[] = [
  { id: "add", label: "Add", order: 1 },
  // Shown once a category in it has an item (slice 7 registers the first stencils).
  { id: "stencils", label: "Stencils", order: 2 },
];

export const PALETTE_CATEGORIES: readonly PaletteCategory[] = [
  { id: "notes", label: "Notes", order: 1, tab: "add", items: NOTE_TILES, fromRoom: roomNoteTiles },
];

export interface PaletteSection {
  category: PaletteCategory;
  items: readonly PaletteItem[];
}

const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/** Every word of the query appears in the item's label or keywords. */
export function matchesQuery(item: PaletteItem, query: string): boolean {
  const haystack = `${item.label} ${item.keywords.join(" ")}`.toLowerCase();
  return words(query).every((w) => haystack.includes(w));
}

const byOrder = <T extends { order: number }>(list: readonly T[]) => [...list].sort((a, b) => a.order - b.order);

/** One tab's categories in order, each with its items (static, then from the room) matching the query. Empty ones are left out. */
export function paletteSections(
  categories: readonly PaletteCategory[],
  tab: string,
  state: PaletteRoomState,
  query: string,
): PaletteSection[] {
  return byOrder(categories.filter((c) => c.tab === tab))
    .map((category) => ({
      category,
      items: [...category.items, ...(category.fromRoom?.(state) ?? [])].filter((item) => matchesQuery(item, query)),
    }))
    .filter((section) => section.items.length > 0);
}

/** The tabs with anything in them, in order. */
export function visibleTabs(tabs: readonly PaletteTab[], categories: readonly PaletteCategory[], state: PaletteRoomState): PaletteTab[] {
  return byOrder(tabs).filter((t) => paletteSections(categories, t.id, state, "").length > 0);
}
