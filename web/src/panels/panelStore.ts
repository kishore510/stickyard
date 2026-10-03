import { create } from "zustand";
import { STORAGE_KEYS, readKey, writeKey } from "../storage";
import { PANEL_LIMITS, parsePanelState, serialisePanelState, type PanelId, type PanelState } from "./layout";

/*
 * The side panels' layout (md and up): each one's width (null: the default) and whether it's
 * collapsed. Loaded from browser storage once and saved on every change, under stickyard:
 * keys. Storage can be missing or blocked: then the defaults are used and nothing is saved.
 * Lives outside the panels, so crossing the md breakpoint and back restores them as they were.
 */

const KEYS: Record<PanelId, string> = {
  palette: STORAGE_KEYS.palettePanel,
  properties: STORAGE_KEYS.propertiesPanel,
};

const load = (id: PanelId) => parsePanelState(readKey(KEYS[id]), PANEL_LIMITS[id]);

interface Panels extends Record<PanelId, PanelState> {
  setWidth(id: PanelId, width: number | null): void;
  setCollapsed(id: PanelId, collapsed: boolean): void;
  toggle(id: PanelId): void;
}

export const usePanels = create<Panels>()((set, get) => {
  const update = (id: PanelId, patch: Partial<PanelState>) => {
    const next = { ...get()[id], ...patch };
    set(id === "palette" ? { palette: next } : { properties: next });
    writeKey(KEYS[id], serialisePanelState(next));
  };
  return {
    palette: load("palette"),
    properties: load("properties"),
    setWidth: (id, width) => update(id, { width }),
    setCollapsed: (id, collapsed) => update(id, { collapsed }),
    toggle: (id) => update(id, { collapsed: !get()[id].collapsed }),
  };
});
