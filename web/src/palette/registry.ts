import { Frame as FrameIcon, Timer as TimerIcon, type LucideIcon } from "lucide-react";
import { FRAME_DEFAULT_H, FRAME_DEFAULT_W, NOTE_COLORS, SHAPE_KINDS, shapeDefaults, type FrameColor, type NoteColor, type ShapeKind } from "@stickyard/shared";
import type { DrawStyle } from "../connectors/connectorUi";
import { SHAPE_KIND_NAMES } from "../shapes/style";
import type { Size, XY } from "../canvas/geometry";
import { NOTE_COLOR_NAMES } from "../notes/colours";
import { templateBounds } from "../templates/place";
import { TEMPLATE_GROUPS, TEMPLATES, type Template } from "../templates/registry";
import { BUILTIN_STENCILS } from "../stencils/builtins";
import { stencilBounds, type Stencil } from "../stencils/data";

/*
 * The palette: everything you can add to the board, in one registry. The desktop palette
 * panel and the phone add sheet are both built from it (palette/Palette.tsx), so a new tile
 * is one item here, a new category one entry in PALETTE_CATEGORIES, and a new tab one entry
 * in PALETTE_TABS. Only what exists is listed: no placeholder tiles, and a tab or category
 * with nothing in it isn't shown (so there's no Stencils tab until a stencil is registered).
 *
 * A new kind of object (group box, connector) needs its own protocol change first, in its own
 * slice; its tile then arrives as one entry here. Facilitation tiles (the host's Timer) come from
 * the room's state through `fromRoom`.
 */

/** What the tile shows: a small note in a palette colour, an icon, or a template's frames in miniature. */
export type PalettePreview =
  | { kind: "note"; color: NoteColor }
  | { kind: "icon"; icon: LucideIcon }
  | { kind: "template"; template: Template }
  | { kind: "shape"; shape: ShapeKind }
  | { kind: "connector"; style: DrawStyle }
  | { kind: "stencil"; stencil: Stencil };

/** What a drag carries (shown under the pointer while dragging). */
export type PalettePayload =
  | { kind: "note"; color: NoteColor }
  | { kind: "frame"; color: FrameColor }
  | { kind: "template"; id: string }
  | { kind: "timer" }
  | { kind: "shape"; shape: ShapeKind }
  | { kind: "connector"; style: DrawStyle }
  | { kind: "stencil"; id: string };

/**
 * What tiles can do, with plain data. `at` is a board position (a drop: the top-left of the
 * thing, `dropSize` big, centred on the pointer); without it, the viewport centre.
 */
export interface PaletteActions {
  addNote(color: NoteColor, at?: XY): void;
  addFrame(color: FrameColor, at?: XY): void;
  applyTemplate(template: Template, at?: XY): void;
  /** Opens the host's timer picker (a click or a drop both just open it). */
  openTimer(): void;
  /** Adds a shape of a kind (protocol v15), its text ready to type. */
  addShape(kind: ShapeKind, at?: XY): void;
  /** Arms the arrow draw tool with this style (v0.36.0); a drop starts the arrow where it lands. */
  startArrow(style: DrawStyle, at?: XY): void;
  /** Places a stencil (v0.39.0) centred on the viewport, or with its top-left at a drop's `at`. */
  placeStencil?(stencil: Stencil, at?: XY): void;
}

/** What tiles need to know to be enabled. */
export interface PaletteContext {
  /** Why notes can't be added right now (disconnected, board full), or null. */
  noteReason: string | null;
  /** Why frames can't be added right now (disconnected, the board has its frames), or null. */
  frameReason: string | null;
  /** Why templates can't be applied right now (disconnected, one is being applied), or null. Too few free frames is a notice instead, with the numbers. */
  templateReason: string | null;
  /** Why the host can't start a timer right now (disconnected), or null. */
  timerReason: string | null;
  /** Why shapes can't be added right now (disconnected, the board has its shapes, locked), or null. */
  shapeReason: string | null;
  /** Why arrows can't be drawn right now (disconnected, 100 arrows, locked, a silent round), or null. */
  connectorReason?: string | null;
  /** Why stencils can't be placed right now (disconnected, locked, a silent round, adding), or null. */
  stencilReason?: string | null;
}

/** Where tiles are listed: the palette panel (md and up, also its collapsed strip) or the phone add drawer. */
export type PaletteSurface = "panel" | "drawer";

/**
 * Room state the palette can draw items from. Today no selector uses it; later, tiles the
 * room defines (slice 6) come from here with no panel changes.
 */
export interface PaletteRoomState {
  live: boolean;
  noteCount: number;
  /** This visit has host powers (facilitation tiles are the host's only). */
  isHost: boolean;
  /** Stencils saved in this browser (v0.39.0), already checked (stencils/storage.ts). */
  stencils?: readonly Stencil[];
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
  /** The size of what a drop places (centred on the pointer); a note's size when not given. */
  dropSize?: Size;
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
  /** Listed only on these surfaces (all when not given). Frames are md and up only. */
  surfaces?: readonly PaletteSurface[];
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

/** The one Frames tile: a neutral frame (colour changes in Properties). Its title is ready to type. */
export const FRAME_TILES: readonly PaletteItem[] = [
  {
    id: "frame",
    label: "Frame",
    keywords: ["frame", "area", "section", "group", "zone", "box"],
    preview: { kind: "icon", icon: FrameIcon },
    payload: { kind: "frame", color: "neutral" },
    create: (actions, at) => actions.addFrame("neutral", at),
    dropSize: { width: FRAME_DEFAULT_W, height: FRAME_DEFAULT_H },
    disabled: (ctx) => ctx.frameReason,
  },
];

/** Search words for each shape tile. */
const SHAPE_KEYWORDS: Record<ShapeKind, readonly string[]> = {
  text: ["text", "label", "heading", "title", "words", "type"],
  rect: ["rectangle", "box", "square", "process", "step"],
  oval: ["oval", "ellipse", "circle", "round", "start", "end"],
  diamond: ["diamond", "decision", "choice", "rhombus"],
};

/** One tile per shape kind (protocol v15): a click adds it at the view centre, a drop where it lands; its text is ready to type. */
export const SHAPE_TILES: readonly PaletteItem[] = SHAPE_KINDS.map((kind) => {
  const { w, h } = shapeDefaults(kind);
  return {
    id: `shape-${kind}`,
    label: SHAPE_KIND_NAMES[kind],
    keywords: ["shape", ...SHAPE_KEYWORDS[kind]],
    preview: { kind: "shape", shape: kind },
    payload: { kind: "shape", shape: kind },
    create: (actions, at) => actions.addShape(kind, at),
    dropSize: { width: w, height: h },
    disabled: (ctx) => ctx.shapeReason,
  };
});

/** One tile per kind of arrow (v0.36.0): a click (or a drop) arms the draw tool; then drag or click-click on the board. */
export const CONNECTOR_TILES: readonly PaletteItem[] = (
  [
    { id: "connector-arrow", label: "Arrow", style: { route: "straight", startHead: "none", endHead: "arrow" }, keywords: ["arrow", "connector", "link", "flow"] },
    { id: "connector-line", label: "Line", style: { route: "straight", startHead: "none", endHead: "none" }, keywords: ["line", "connector", "link"] },
    { id: "connector-elbow", label: "Elbow arrow", style: { route: "elbow", startHead: "none", endHead: "arrow" }, keywords: ["elbow", "arrow", "connector", "step", "flowchart"] },
  ] as const
).map((t) => ({
  id: t.id,
  label: t.label,
  keywords: t.keywords,
  preview: { kind: "connector", style: t.style },
  payload: { kind: "connector", style: t.style },
  create: (actions, at) => actions.startArrow(t.style, at),
  dropSize: { width: 0, height: 0 },
  disabled: (ctx) => ctx.connectorReason ?? null,
}));

/** A template's tile (templates/registry.ts): a drop centres the whole template on the pointer. */
const templateTile = (template: Template): PaletteItem => ({
  id: `template-${template.id}`,
  label: template.label,
  keywords: ["template", ...template.keywords],
  preview: { kind: "template", template },
  payload: { kind: "template", id: template.id },
  create: (actions, at) => actions.applyTemplate(template, at),
  dropSize: templateBounds(template),
  disabled: (ctx) => ctx.templateReason,
});

/** A stencil's tile (v0.39.0): a click places it at the view centre, a drop centres it on the pointer. */
export const stencilTile = (stencil: Stencil, saved = false): PaletteItem => ({
  id: `${saved ? "saved" : "stencil"}-${stencil.id}`,
  label: stencil.name,
  keywords: ["stencil", saved ? "saved" : "built-in"],
  preview: { kind: "stencil", stencil },
  payload: { kind: "stencil", id: stencil.id },
  create: (actions, at) => actions.placeStencil?.(stencil, at),
  dropSize: stencilBounds(stencil),
  disabled: (ctx) => ctx.stencilReason ?? null,
});

/** Stencils saved in this browser, from the room board's state (they change as you save and delete). */
export function savedStencilTiles(state: PaletteRoomState): readonly PaletteItem[] {
  return (state.stencils ?? []).map((s) => stencilTile(s, true));
}

/** The host's Timer tile: opens the duration picker (the timer is the room's, not a thing on the board). */
export const TIMER_TILE: PaletteItem = {
  id: "timer",
  label: "Timer",
  keywords: ["timer", "countdown", "clock", "time", "timebox", "facilitation", "host"],
  preview: { kind: "icon", icon: TimerIcon },
  payload: { kind: "timer" },
  create: (actions) => actions.openTimer(),
  disabled: (ctx) => ctx.timerReason,
};

/** Facilitation tiles: the host's only, so they come from the room's state (nothing for guests, so no section). */
export function facilitationTiles(state: PaletteRoomState): readonly PaletteItem[] {
  return state.isHost ? [TIMER_TILE] : [];
}

/** Note tiles defined by the room. None yet (facilitator palettes are slice 6). */
export function roomNoteTiles(_state: PaletteRoomState): readonly PaletteItem[] {
  return [];
}

export const PALETTE_TABS: readonly PaletteTab[] = [
  { id: "add", label: "Add", order: 1 },
  // Shown once a category in it has an item: the built-in stencils (v0.39.0), md and up.
  { id: "stencils", label: "Stencils", order: 2 },
];

export const PALETTE_CATEGORIES: readonly PaletteCategory[] = [
  { id: "notes", label: "Notes", order: 1, tab: "add", items: NOTE_TILES, fromRoom: roomNoteTiles },
  // Frames can only be added from md up (phones show them but don't change them).
  { id: "frames", label: "Frames", order: 2, tab: "add", items: FRAME_TILES, surfaces: ["panel"] },
  // Shapes and text (protocol v15): edited from md up only, so not in the phone drawer.
  { id: "shapes", label: "Shapes", order: 2.5, tab: "add", items: SHAPE_TILES, surfaces: ["panel"] },
  // Arrows (v0.36.0): drawn and changed from md up only; phones show them read-only.
  { id: "connectors", label: "Connectors", order: 2.7, tab: "add", items: CONNECTOR_TILES, surfaces: ["panel"] },
  // Templates are frames, so md and up only too: one category per template group, headed by its name (v0.29.0).
  ...TEMPLATE_GROUPS.map(
    (group, i): PaletteCategory => ({
      id: group.categoryId,
      label: group.label,
      order: 3 + i / 10,
      tab: "add",
      items: TEMPLATES.filter((t) => t.group === group.label).map(templateTile),
      surfaces: ["panel"],
    }),
  ),
  // Host only, md and up (phones: the Participants sheet's Session section).
  { id: "facilitation", label: "Facilitation", order: 4, tab: "add", items: [], fromRoom: facilitationTiles, surfaces: ["panel"] },
  // Stencils (v0.39.0): md and up only (phones show the board's items but don't place stencils).
  { id: "stencils-builtin", label: "Built-in", order: 1, tab: "stencils", items: BUILTIN_STENCILS.map((s) => stencilTile(s)), surfaces: ["panel"] },
  { id: "stencils-saved", label: "Saved in this browser", order: 2, tab: "stencils", items: [], fromRoom: savedStencilTiles, surfaces: ["panel"] },
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

/** One tab's categories in order, each with its items (static, then from the room) matching the query. Empty ones, and ones not on this surface, are left out. */
export function paletteSections(
  categories: readonly PaletteCategory[],
  tab: string,
  state: PaletteRoomState,
  query: string,
  surface: PaletteSurface = "panel",
): PaletteSection[] {
  return byOrder(categories.filter((c) => c.tab === tab && (!c.surfaces || c.surfaces.includes(surface))))
    .map((category) => ({
      category,
      items: [...category.items, ...(category.fromRoom?.(state) ?? [])].filter((item) => matchesQuery(item, query)),
    }))
    .filter((section) => section.items.length > 0);
}

/** The tabs with anything in them, in order. */
export function visibleTabs(tabs: readonly PaletteTab[], categories: readonly PaletteCategory[], state: PaletteRoomState, surface: PaletteSurface = "panel"): PaletteTab[] {
  return byOrder(tabs).filter((t) => paletteSections(categories, t.id, state, "", surface).length > 0);
}
