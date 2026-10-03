import { Hand, Map as MapIcon, Maximize, MousePointer2, StickyNote, ZoomIn, ZoomOut, type LucideIcon } from "lucide-react";
import { MAX_NOTES_PER_ROOM } from "@stickyard/shared";
import { MAX_ZOOM, MIN_ZOOM } from "./geometry";

/*
 * The board's tools, in one registry. The desktop rail and view bar and the phone ribbon are
 * all built from it (see ToolBars.tsx), and every tool runs the same shared actions, so a new
 * tool (group, text, timer...) is one entry here plus its action. No placeholder entries.
 */

export type Surface = "rail" | "viewbar" | "ribbon";
export type Mode = "select" | "hand";

/** What tools read and do. Built once per render by the board (useBoardTools). */
export interface ToolContext {
  tool: Mode;
  setTool(tool: Mode): void;
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
  /** Has the note colour choice next to it. */
  colour?: boolean;
}

export const NOTE_TOOL_REASONS = {
  disconnected: "Reconnect to add or change notes.",
  full: `The board is full (${MAX_NOTES_PER_ROOM} notes). Delete one to add another.`,
} as const;

export function noteToolReason({ live, count }: { live: boolean; count: number }): string | null {
  if (!live) return NOTE_TOOL_REASONS.disconnected;
  return count >= MAX_NOTES_PER_ROOM ? NOTE_TOOL_REASONS.full : null;
}

export const TOOLS: readonly Tool[] = [
  {
    id: "select",
    label: "Select and move",
    icon: MousePointer2,
    shortcut: "V",
    slots: { rail: 1 },
    run: (c) => c.setTool("select"),
    pressed: (c) => c.tool === "select",
  },
  {
    id: "hand",
    label: "Hand (pan)",
    icon: Hand,
    shortcut: "H",
    slots: { rail: 2, viewbar: 5, ribbon: 3 },
    run: (c) => c.setTool(c.tool === "hand" ? "select" : "hand"),
    pressed: (c) => c.tool === "hand",
  },
  {
    id: "note",
    label: "Add note",
    icon: StickyNote,
    shortcut: "N",
    slots: { rail: 3, ribbon: 1 },
    run: (c) => c.addNote(),
    disabled: (c) => c.noteReason,
    colour: true,
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
    slots: { viewbar: 4, ribbon: 2 },
    run: (c) => c.fit(),
  },
  {
    id: "minimap",
    label: "Overview map",
    icon: MapIcon,
    shortcut: "M",
    slots: { viewbar: 6 },
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
