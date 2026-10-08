// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PANEL_STATE, PANEL_LIMITS, initialPanelState, panelWidths, serialisePanelState } from "../src/panels/layout";

/*
 * Panel layout at 768 (v0.24.0): below the lg breakpoint the palette and Properties start
 * collapsed, unless this browser saved a choice for that panel (a width or collapsed state).
 */

const { palette, properties } = PANEL_LIMITS;

describe("initialPanelState", () => {
  it("with no stored choice, starts collapsed below lg and open at lg and above", () => {
    expect(initialPanelState(null, palette, false)).toEqual({ width: null, collapsed: true });
    expect(initialPanelState(null, properties, false)).toEqual({ width: null, collapsed: true });
    expect(initialPanelState(null, palette, true)).toEqual(DEFAULT_PANEL_STATE);
    expect(initialPanelState(null, properties, true)).toEqual(DEFAULT_PANEL_STATE);
  });

  it("a stored choice always wins, below lg too", () => {
    const open = serialisePanelState({ width: 240, collapsed: false });
    expect(initialPanelState(open, palette, false)).toEqual({ width: 240, collapsed: false });
    expect(initialPanelState(serialisePanelState({ width: null, collapsed: false }), properties, false)).toEqual({ width: null, collapsed: false });
    expect(initialPanelState(serialisePanelState({ width: 300, collapsed: true }), properties, true)).toEqual({ width: 300, collapsed: true });
  });

  it("a stored width out of range keeps the stored collapsed state (still a choice)", () => {
    expect(initialPanelState('{"width":100000,"collapsed":false}', palette, false)).toEqual({ width: null, collapsed: false });
  });

  it("malformed storage counts as no choice", () => {
    for (const raw of ["", "nope", "[]", "null", '{"width":"wide","collapsed":false}', '{"collapsed":"yes"}']) {
      expect(initialPanelState(raw, palette, false)).toEqual({ width: null, collapsed: true });
      expect(initialPanelState(raw, palette, true)).toEqual(DEFAULT_PANEL_STATE);
    }
  });

  it("at 768, both collapsed leave the canvas everything but the two strips", () => {
    const collapsed = { width: null, collapsed: true };
    const w = panelWidths(768, { palette: collapsed, properties: collapsed });
    expect(768 - w.palette.width - w.properties.width).toBe(768 - 2 * 52);
  });
});

describe("the panel store's first state", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    localStorage.clear();
  });

  const loadStore = async (desktop: boolean) => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: desktop && query.includes("64rem"), addEventListener() {}, removeEventListener() {} }));
    vi.resetModules();
    const { usePanels } = await import("../src/panels/panelStore");
    return usePanels.getState();
  };

  it("below lg with nothing stored: both collapsed, and nothing is written", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem");
    const state = await loadStore(false);
    expect(state.palette.collapsed).toBe(true);
    expect(state.properties.collapsed).toBe(true);
    expect(set).not.toHaveBeenCalled();
    set.mockRestore();
  });

  it("at lg and above with nothing stored: both open, as before", async () => {
    const state = await loadStore(true);
    expect(state.palette).toEqual(DEFAULT_PANEL_STATE);
    expect(state.properties).toEqual(DEFAULT_PANEL_STATE);
  });

  it("below lg, a stored open panel stays open and the other starts collapsed", async () => {
    localStorage.setItem("stickyard:palette-panel", serialisePanelState({ width: 200, collapsed: false }));
    const state = await loadStore(false);
    expect(state.palette).toEqual({ width: 200, collapsed: false });
    expect(state.properties.collapsed).toBe(true);
  });
});
