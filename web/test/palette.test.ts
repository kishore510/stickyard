import { describe, expect, it, vi } from "vitest";
import { NOTE_COLORS } from "@stickyard/shared";
import { StickyNote } from "lucide-react";
import {
  NOTE_TILES,
  PALETTE_CATEGORIES,
  PALETTE_TABS,
  facilitationTiles,
  noteTile,
  paletteSections,
  roomNoteTiles,
  visibleTabs,
  type PaletteActions,
  type PaletteCategory,
  type PaletteItem,
  type PaletteRoomState,
} from "../src/palette/registry";

/*
 * The palette registry: tabs hold categories, categories hold items (static, plus any a
 * room-state selector adds). The panel and the phone add sheet only ever render what these
 * functions return, so a new category, tile or tab is one registry entry.
 */

const state: PaletteRoomState = { live: true, noteCount: 0, isHost: false };
const actions = (): PaletteActions => ({ addNote: vi.fn(), addFrame: vi.fn(), applyTemplate: vi.fn(), openTimer: vi.fn(), addShape: vi.fn() });
const ids = (items: readonly PaletteItem[]) => items.map((i) => i.id);

describe("palette registry", () => {
  it("the Notes category has one tile per palette key, in palette order", () => {
    const [notes] = paletteSections(PALETTE_CATEGORIES, "add", state, "");
    expect(notes?.category.label).toBe("Notes");
    expect(notes?.items.map((i) => i.payload)).toEqual(NOTE_COLORS.map((color) => ({ kind: "note", color })));
    expect(notes?.items.map((i) => i.label)).toEqual(["Yellow note", "Pink note", "Blue note", "Green note", "Orange note", "Purple note"]);
    for (const tile of NOTE_TILES) expect(tile.preview).toEqual({ kind: "note", color: tile.payload.kind === "note" && tile.payload.color });
  });

  it("each tile creates a note of its colour: at the centre on click, at a board point on drop", () => {
    for (const color of NOTE_COLORS) {
      const a = actions();
      const tile = NOTE_TILES.find((t) => t.payload.kind === "note" && t.payload.color === color);
      tile?.create(a);
      tile?.create(a, { x: 100, y: 200 });
      expect(a.addNote).toHaveBeenNthCalledWith(1, color, undefined);
      expect(a.addNote).toHaveBeenNthCalledWith(2, color, { x: 100, y: 200 });
    }
  });

  it("every item has a unique id, a label and keywords", () => {
    const all = PALETTE_CATEGORIES.flatMap((c) => c.items);
    expect(new Set(ids(all)).size).toBe(all.length);
    for (const item of all) {
      expect(item.label.trim()).not.toBe("");
      expect(item.keywords.length).toBeGreaterThan(0);
    }
  });

  it("tiles are disabled with a reason when the board is full or disconnected", () => {
    const tile = NOTE_TILES[0];
    expect(tile?.disabled({ noteReason: null, frameReason: null, templateReason: null, timerReason: null, shapeReason: null })).toBeNull();
    expect(tile?.disabled({ noteReason: "Reconnect to add or change notes.", frameReason: null, templateReason: null, timerReason: null, shapeReason: null })).toBe("Reconnect to add or change notes.");
  });

  it("categories render in order from the registry, and a second category needs no panel code", () => {
    const shapes: PaletteCategory = {
      id: "test-shapes",
      label: "Test shapes",
      order: 0,
      tab: "add",
      items: [
        {
          id: "test-circle",
          label: "Circle",
          keywords: ["round"],
          preview: { kind: "icon", icon: StickyNote },
          payload: { kind: "note", color: "blue" },
          create: () => {},
          disabled: () => null,
        },
      ],
    };
    const sections = paletteSections([...PALETTE_CATEGORIES, shapes], "add", state, "");
    expect(sections.map((s) => s.category.label)).toEqual(["Test shapes", "Notes", "Frames", "Shapes", "Retros", "Planning and facilitation", "Architecture and analysis"]);
  });

  it("a category with no items (static or from the room) is hidden", () => {
    const empty: PaletteCategory = { id: "empty", label: "Empty", order: 5, tab: "add", items: [] };
    expect(paletteSections([...PALETTE_CATEGORIES, empty], "add", state, "").map((s) => s.category.id)).toEqual([
      "notes",
      "frames",
      "shapes",
      "templates-retros",
      "templates-planning",
      "templates-architecture",
    ]);
  });

  it("search hides empty groups: a template group with no matching entry loses its heading, the others keep theirs", () => {
    const labels = (query: string) => paletteSections(PALETTE_CATEGORIES, "add", state, query).map((s) => s.category.label);
    expect(labels("template")).toEqual(["Retros", "Planning and facilitation", "Architecture and analysis"]);
    expect(labels("starfish")).toEqual(["Retros"]);
    expect(labels("lean coffee")).toEqual(["Planning and facilitation"]);
    expect(labels("raid")).toEqual(["Architecture and analysis"]);
    expect(labels("no such tile")).toEqual([]);
  });

  it("a room-state selector adds tiles to the Notes category (none today)", () => {
    expect(roomNoteTiles(state)).toEqual([]);
    const extra = noteTile("room-team-a", "pink", "Team A");
    const withRoom = PALETTE_CATEGORIES.map((c) => (c.id === "notes" ? { ...c, fromRoom: (s: PaletteRoomState) => (s.live ? [extra] : []) } : c));
    const [notes] = paletteSections(withRoom, "add", state, "");
    expect(ids(notes?.items ?? []).at(-1)).toBe("room-team-a");
    expect(notes?.items.at(-1)?.label).toBe("Team A");
    expect(paletteSections(withRoom, "add", { ...state, live: false }, "")[0]?.items).toHaveLength(NOTE_COLORS.length);
  });
});

describe("palette search", () => {
  it("filters every category by label and keywords, case-insensitively", () => {
    expect(ids(paletteSections(PALETTE_CATEGORIES, "add", state, "PINK")[0]?.items ?? [])).toEqual(["note-pink"]);
    // "sticky" is a keyword of every note tile.
    expect(paletteSections(PALETTE_CATEGORIES, "add", state, "sticky")[0]?.items).toHaveLength(NOTE_COLORS.length);
    // Every word must match.
    expect(ids(paletteSections(PALETTE_CATEGORIES, "add", state, "note blue")[0]?.items ?? [])).toEqual(["note-blue"]);
  });

  it("searches across categories and hides those with no match", () => {
    const other: PaletteCategory = {
      id: "other",
      label: "Other",
      order: 2,
      tab: "add",
      items: [{ ...NOTE_TILES[0]!, id: "other-thing", label: "Pink banner", keywords: ["flag"] }],
    };
    const sections = paletteSections([...PALETTE_CATEGORIES, other], "add", state, "pink");
    expect(sections.map((s) => [s.category.id, ids(s.items)])).toEqual([
      ["notes", ["note-pink"]],
      ["other", ["other-thing"]],
    ]);
    expect(paletteSections([...PALETTE_CATEGORIES, other], "add", state, "flag").map((s) => s.category.id)).toEqual(["other"]);
  });

  it("no match anywhere returns no sections (the panel shows No matches)", () => {
    expect(paletteSections(PALETTE_CATEGORIES, "add", state, "zebra")).toEqual([]);
  });
});

describe("palette tabs", () => {
  it("only tabs with something in them are shown: no Stencils tab without a stencil", () => {
    expect(visibleTabs(PALETTE_TABS, PALETTE_CATEGORIES, state).map((t) => t.id)).toEqual(["add"]);
  });

  it("registering a stencil shows the Stencils tab, after Add", () => {
    const stencils: PaletteCategory = {
      id: "test-stencils",
      label: "Planning",
      order: 1,
      tab: "stencils",
      items: [{ ...NOTE_TILES[0]!, id: "stencil-retro", label: "Retro", keywords: ["retro"] }],
    };
    const tabs = visibleTabs(PALETTE_TABS, [...PALETTE_CATEGORIES, stencils], state);
    expect(tabs.map((t) => [t.id, t.label])).toEqual([
      ["add", "Add"],
      ["stencils", "Stencils"],
    ]);
    expect(paletteSections([...PALETTE_CATEGORIES, stencils], "stencils", state, "").map((s) => s.category.id)).toEqual(["test-stencils"]);
  });
});

describe("Facilitation (host only, md and up)", () => {
  it("a Timer tile for the host only; no section at all for a guest", () => {
    const panel = (isHost: boolean) => paletteSections(PALETTE_CATEGORIES, "add", { ...state, isHost }, "", "panel");
    expect(panel(true).find((s) => s.category.id === "facilitation")?.items.map((i) => i.label)).toEqual(["Timer"]);
    expect(panel(false).some((s) => s.category.id === "facilitation")).toBe(false);
  });

  it("not in the phone drawer (phones: the Participants sheet)", () => {
    const drawer = paletteSections(PALETTE_CATEGORIES, "add", { ...state, isHost: true }, "", "drawer");
    expect(drawer.some((s) => s.category.id === "facilitation")).toBe(false);
  });

  it("the tile opens the picker (a drop too) and is off with the reason while disconnected", () => {
    const tile = facilitationTiles({ ...state, isHost: true })[0]!;
    const openTimer = vi.fn();
    tile.create({ addNote: vi.fn(), addFrame: vi.fn(), applyTemplate: vi.fn(), openTimer, addShape: vi.fn() });
    tile.create({ addNote: vi.fn(), addFrame: vi.fn(), applyTemplate: vi.fn(), openTimer, addShape: vi.fn() }, { x: 10, y: 10 });
    expect(openTimer).toHaveBeenCalledTimes(2);
    expect(tile.disabled({ noteReason: null, frameReason: null, templateReason: null, timerReason: "Not connected.", shapeReason: null })).toBe("Not connected.");
  });
});
