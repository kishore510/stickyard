import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CANVAS_MIN,
  DEFAULT_PANEL_STATE,
  KEY_STEP,
  KEY_STEP_BIG,
  MAX_COLUMNS,
  PANEL_LIMITS,
  PANEL_STRIP,
  TILE_GAP,
  TILE_MIN,
  clampWidth,
  cornerLifted,
  keyResize,
  panelWidths,
  parsePanelState,
  serialisePanelState,
  tileColumns,
} from "../src/panels/layout";
import { STORAGE_KEYS, readKey, writeKey, type KeyValueStore } from "../src/storage";

/*
 * The palette and Properties panels: widths, collapse, keyboard resizing, saved layout,
 * and how the free canvas area between them is shared. Pure functions only.
 */

const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const { palette, properties } = PANEL_LIMITS;

describe("panel sizes are tokens", () => {
  it("min, default and max widths, the strip, the tile and the canvas minimum match tokens.css", () => {
    for (const [name, limits] of Object.entries(PANEL_LIMITS)) {
      expect(tokens).toContain(`--sy-${name}-min: ${limits.min}px;`);
      expect(tokens).toContain(`--sy-${name}-width: ${limits.initial}px;`);
      expect(tokens).toContain(`--sy-${name}-max: ${limits.max}px;`);
    }
    expect(tokens).toContain(`--sy-panel-strip: ${PANEL_STRIP}px;`);
    expect(tokens).toContain(`--sy-tile-min: ${TILE_MIN}px;`);
    expect(tokens).toContain(`--sy-canvas-min: ${CANVAS_MIN}px;`);
    expect(tokens).toMatch(/--sy-panel-handle: \d+px;/);
  });

  it("the handle's hit area is a full touch target on touch screens", () => {
    expect(tokens).toMatch(/@media \(pointer: coarse\)\s*{\s*:root\s*{\s*--sy-panel-handle: var\(--sy-touch-min\);/);
  });
});

describe("width clamping", () => {
  it("keeps a width between min and max, in whole pixels", () => {
    expect(clampWidth(10, 100, 300)).toBe(100);
    expect(clampWidth(900, 100, 300)).toBe(300);
    expect(clampWidth(150.6, 100, 300)).toBe(151);
    expect(clampWidth(Number.NaN, 100, 300)).toBe(100);
  });

  it("defaults are used when nothing is saved, and a reset (null) is the default", () => {
    const w = panelWidths(1280, { palette: DEFAULT_PANEL_STATE, properties: DEFAULT_PANEL_STATE });
    expect(w.palette.width).toBe(palette.initial);
    expect(w.properties.width).toBe(properties.initial);
  });

  it("a panel is at most about a third of the window, and never under its minimum", () => {
    const w = panelWidths(1280, { palette: { width: 9999, collapsed: false }, properties: DEFAULT_PANEL_STATE });
    expect(w.palette.max).toBeLessThanOrEqual(Math.floor(1280 / 3));
    expect(w.palette.width).toBe(w.palette.max);
    const narrow = panelWidths(768, { palette: { width: 9999, collapsed: false }, properties: { width: 9999, collapsed: false } });
    expect(narrow.palette.width).toBeGreaterThanOrEqual(palette.min);
    expect(narrow.properties.width).toBeGreaterThanOrEqual(properties.min);
  });

  it("the canvas keeps at least its minimum width at 768 and 1280, whatever was saved", () => {
    for (const window of [768, 1024, 1280]) {
      const w = panelWidths(window, { palette: { width: 9999, collapsed: false }, properties: { width: 9999, collapsed: false } });
      expect(window - w.palette.width - w.properties.width, `${window}px`).toBeGreaterThanOrEqual(CANVAS_MIN);
    }
  });

  it("a collapsed panel is a slim strip, and gives its room to the other panel and the canvas", () => {
    const w = panelWidths(768, { palette: DEFAULT_PANEL_STATE, properties: { width: null, collapsed: true } });
    expect(w.properties.width).toBe(PANEL_STRIP);
    expect(w.palette.width).toBe(palette.initial);
  });
});

describe("keyboard resizing", () => {
  const limits = { min: 150, max: 350 };
  it("arrow keys move the edge in steps (Shift for bigger ones)", () => {
    // The palette's handle is on its right edge: right widens it.
    expect(keyResize(200, { key: "ArrowRight", shiftKey: false }, limits, "right")).toBe(200 + KEY_STEP);
    expect(keyResize(200, { key: "ArrowLeft", shiftKey: true }, limits, "right")).toBe(200 - KEY_STEP_BIG);
    // The Properties handle is on its left edge: left widens it.
    expect(keyResize(200, { key: "ArrowLeft", shiftKey: false }, limits, "left")).toBe(200 + KEY_STEP);
    expect(keyResize(200, { key: "ArrowRight", shiftKey: false }, limits, "left")).toBe(200 - KEY_STEP);
  });

  it("Home and End jump to the minimum and maximum; steps are clamped; other keys do nothing", () => {
    expect(keyResize(200, { key: "Home", shiftKey: false }, limits, "right")).toBe(150);
    expect(keyResize(200, { key: "End", shiftKey: false }, limits, "right")).toBe(350);
    expect(keyResize(340, { key: "ArrowRight", shiftKey: true }, limits, "right")).toBe(350);
    expect(keyResize(155, { key: "ArrowLeft", shiftKey: true }, limits, "right")).toBe(150);
    expect(keyResize(200, { key: "Enter", shiftKey: false }, limits, "right")).toBeNull();
  });
});

describe("tile grid", () => {
  it("one column at the minimum width, two by default, three at the widest (never more)", () => {
    expect(tileColumns(palette.min)).toBe(1);
    expect(tileColumns(palette.initial)).toBe(2);
    expect(tileColumns(palette.max)).toBe(MAX_COLUMNS);
    expect(MAX_COLUMNS).toBe(3);
  });

  it("columns always fit the width (no horizontal scroll)", () => {
    for (let width = palette.min; width <= palette.max; width += 4) {
      const n = tileColumns(width);
      expect(n * TILE_MIN + (n - 1) * TILE_GAP, `${width}px`).toBeLessThanOrEqual(width);
    }
  });
});

describe("saved panel layout", () => {
  const memory = (): KeyValueStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };

  it("uses stickyard: keys, and round-trips width and collapsed state", () => {
    expect(STORAGE_KEYS.palettePanel).toBe("stickyard:palette-panel");
    expect(STORAGE_KEYS.propertiesPanel).toBe("stickyard:properties-panel");
    const store = memory();
    writeKey(STORAGE_KEYS.palettePanel, serialisePanelState({ width: 260, collapsed: true }), store);
    expect(parsePanelState(readKey(STORAGE_KEYS.palettePanel, store), palette)).toEqual({ width: 260, collapsed: true });
    writeKey(STORAGE_KEYS.palettePanel, serialisePanelState({ width: null, collapsed: false }), store);
    expect(parsePanelState(readKey(STORAGE_KEYS.palettePanel, store), palette)).toEqual(DEFAULT_PANEL_STATE);
  });

  it.each([
    ["missing", null],
    ["not JSON", "{oops"],
    ["the wrong shape", '{"w":1}'],
    ["a string width", '{"width":"200","collapsed":false}'],
    ["an array", "[1,2]"],
    ["null", "null"],
  ])("%s falls back to the defaults", (_label, raw) => {
    expect(parsePanelState(raw, palette)).toEqual(DEFAULT_PANEL_STATE);
  });

  it("an out-of-range width falls back to the default width; collapsed is kept", () => {
    expect(parsePanelState('{"width":-50,"collapsed":true}', palette)).toEqual({ width: null, collapsed: true });
    expect(parsePanelState('{"width":100000,"collapsed":false}', palette)).toEqual(DEFAULT_PANEL_STATE);
    expect(parsePanelState('{"width":1e400,"collapsed":false}', palette)).toEqual(DEFAULT_PANEL_STATE);
  });

  it("a saved width is re-clamped to the window it's loaded in", () => {
    const saved = parsePanelState(`{"width":${palette.max},"collapsed":false}`, palette);
    const w = panelWidths(768, { palette: saved, properties: DEFAULT_PANEL_STATE });
    expect(w.palette.width).toBeLessThanOrEqual(Math.floor(768 / 3));
  });
});

describe("free canvas corners", () => {
  it("the minimap and chat sit beside the view bar when there's room, and above it when there isn't", () => {
    // 784px free, a 350px bar centred, a 200px minimap in the corner: they'd touch.
    expect(cornerLifted({ free: 784, bar: 350, corner: 200, edge: 16, gap: 8 })).toBe(true);
    expect(cornerLifted({ free: 1280, bar: 350, corner: 200, edge: 16, gap: 8 })).toBe(false);
    // Just the chat button.
    expect(cornerLifted({ free: 600, bar: 350, corner: 44, edge: 16, gap: 8 })).toBe(false);
    expect(cornerLifted({ free: 400, bar: 350, corner: 44, edge: 16, gap: 8 })).toBe(true);
  });
});
