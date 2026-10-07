import { Hand, Map as MapIcon, Maximize, MousePointer2, Plus, Redo2, Undo2, ZoomIn, ZoomOut, type LucideIcon } from "lucide-react";
import { MAX_FRAMES_PER_ROOM, MAX_NOTES_PER_ROOM, MAX_SHAPES_PER_ROOM } from "@stickyard/shared";
import { MAX_ZOOM, MIN_ZOOM } from "./geometry";

/*
 * The board's tools, in one registry. The desktop view bar and the phone ribbon are both built
 * from it (see ToolBars.tsx), and every tool runs the same shared actions, so a new tool is one
 * entry here plus its action. No placeholder entries. Things you add to the board aren't tools:
 * they're palette tiles (palette/registry.ts), shown in the palette panel from md up and in the
 * add sheet on phones.
 */

export type Surface = "viewbar" | "ribbon";
export type Mode = "select" | "hand";

/** What tools read and do. Built once per render by the board (useBoardTools). */
export interface ToolContext {
  tool: Mode;
  setTool(tool: Mode): void;
  /** Phones: opens the add sheet. md up (the N key): adds a note in the last colour used, ready to type. */
  addNote(): void;
  fit(): void;
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  minimap: boolean;
  toggleMinimap(): void;
  zoom: number;
  /** Why notes can't be added right now, or null. */
  noteReason: string | null;
  /** Undo and redo (the room's history); phones get them in the ribbon, md and up in the board bar (in the top bar). */
  undo(): void;
  redo(): void;
  undoReason: string | null;
  redoReason: string | null;
}

export interface Tool {
  id: string;
  /** The accessible name (and tooltip, with the shortcut). */
  label: string;
  icon: LucideIcon;
  /** Single key, shown in the tooltip and handled by useBoardShortcuts. */
  shortcut?: string;
  /** Where the tool appears, and its position there (lower first). */
  slots: Partial<Record<Surface, number>>;
  run(ctx: ToolContext): void;
  /** For toggles: whether it's on. */
  pressed?(ctx: ToolContext): boolean;
  /** Why it can't be used now, or null. */
  disabled?(ctx: ToolContext): string | null;
  /** Shows this text instead of the icon (e.g. the zoom level). */
  text?(ctx: ToolContext): string;
  /** Drawn as the surface's main action (a round accent button). */
  primary?: boolean;
  /** Neighbouring tools with the same segment are drawn as one group (e.g. the Select/Hand toggle). */
  segment?: { id: string; label: string };
}

const MODE_SEGMENT = { id: "mode", label: "Tool" };

export const NOTE_TOOL_REASONS = {
  disconnected: "Reconnect to add or change notes.",
  full: `The board is full (${MAX_NOTES_PER_ROOM} notes). Delete one to add another.`,
} as const;

export function noteToolReason({ live, count }: { live: boolean; count: number }): string | null {
  if (!live) return NOTE_TOOL_REASONS.disconnected;
  return count >= MAX_NOTES_PER_ROOM ? NOTE_TOOL_REASONS.full : null;
}

/** Why the palette's Frame tile is off right now, or null when frames can be added. */
export function frameToolReason({ live, count }: { live: boolean; count: number }): string | null {
  if (!live) return NOTE_TOOL_REASONS.disconnected;
  return count >= MAX_FRAMES_PER_ROOM ? `The board has the maximum of ${MAX_FRAMES_PER_ROOM} frames.` : null;
}

/** Why the palette's shape tiles are off right now (protocol v15), or null when shapes can be added. */
export function shapeToolReason({ live, count }: { live: boolean; count: number }): string | null {
  if (!live) return NOTE_TOOL_REASONS.disconnected;
  return count >= MAX_SHAPES_PER_ROOM ? `The board has the maximum of ${MAX_SHAPES_PER_ROOM} shapes and text boxes.` : null;
}

/** Why the palette's template tiles are off right now, or null. Too few free frames is a notice when one is tried. */
export function templateToolReason({ live, applying, adding = false }: { live: boolean; applying: boolean; adding?: boolean }): string | null {
  if (!live) return NOTE_TOOL_REASONS.disconnected;
  if (applying) return "A template is being added. Wait for it to finish.";
  return adding ? "Wait until the items being added are saved." : null;
}

export const TOOLS: readonly Tool[] = [
  {
    id: "select",
    label: "Select and move",
    icon: MousePointer2,
    shortcut: "V",
    slots: { viewbar: 5, ribbon: 1 },
    run: (c) => c.setTool("select"),
    pressed: (c) => c.tool === "select",
    segment: MODE_SEGMENT,
  },
  {
    id: "hand",
    label: "Hand (pan)",
    icon: Hand,
    shortcut: "H",
    slots: { viewbar: 6, ribbon: 2 },
    run: (c) => c.setTool(c.tool === "hand" ? "select" : "hand"),
    pressed: (c) => c.tool === "hand",
    segment: MODE_SEGMENT,
  },
  {
    id: "note",
    label: "Add note",
    icon: Plus,
    shortcut: "N",
    // The phone's main action: a round accent button, as Chalkline's Add shape.
    primary: true,
    slots: { ribbon: 3 },
    run: (c) => c.addNote(),
    disabled: (c) => c.noteReason,
  },
  {
    id: "zoom-out",
    label: "Zoom out",
    icon: ZoomOut,
    shortcut: "-",
    slots: { viewbar: 1 },
    run: (c) => c.zoomOut(),
    disabled: (c) => (c.zoom <= MIN_ZOOM + 1e-6 ? "Zoomed out as far as it goes." : null),
  },
  {
    id: "zoom-reset",
    label: "Zoom to 100%",
    icon: ZoomIn,
    shortcut: "0",
    slots: { viewbar: 2 },
    run: (c) => c.resetZoom(),
    text: (c) => `${Math.round(c.zoom * 100)}%`,
  },
  {
    id: "zoom-in",
    label: "Zoom in",
    icon: ZoomIn,
    shortcut: "+",
    slots: { viewbar: 3 },
    run: (c) => c.zoomIn(),
    disabled: (c) => (c.zoom >= MAX_ZOOM - 1e-6 ? "Zoomed in as far as it goes." : null),
  },
  {
    id: "fit",
    label: "Fit to notes",
    icon: Maximize,
    shortcut: "F",
    slots: { viewbar: 4, ribbon: 4 },
    run: (c) => c.fit(),
  },
  {
    id: "undo",
    label: "Undo",
    icon: Undo2,
    // Phones only: from md up Undo is in the board bar in the top bar (Ctrl+Z).
    slots: { ribbon: 5 },
    run: (c) => c.undo(),
    disabled: (c) => c.undoReason,
  },
  {
    id: "redo",
    label: "Redo",
    icon: Redo2,
    slots: { ribbon: 6 },
    run: (c) => c.redo(),
    disabled: (c) => c.redoReason,
  },
  {
    id: "minimap",
    label: "Overview map",
    icon: MapIcon,
    shortcut: "M",
    slots: { viewbar: 7 },
    run: (c) => c.toggleMinimap(),
    pressed: (c) => c.minimap,
  },
];

/** The tools on one surface, in order. */
export function toolsFor(surface: Surface): Tool[] {
  return TOOLS.filter((t) => t.slots[surface] !== undefined).sort((a, b) => (a.slots[surface] ?? 0) - (b.slots[surface] ?? 0));
}

/** The tool with this single-key shortcut (case-insensitive; "=" also zooms in). */
export function toolForKey(key: string): Tool | undefined {
  const k = key === "=" ? "+" : key.toUpperCase();
  return TOOLS.find((t) => t.shortcut === k);
}
