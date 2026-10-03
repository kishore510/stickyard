import type { NoteColor } from "@stickyard/shared";
import { create } from "zustand";
import type { Mode } from "./tools";

/*
 * Board UI state that must outlive any one layout: the rail and the phone ribbon are swapped
 * at the md breakpoint, so the chosen tool and colour live here, not in either component.
 * (The viewport lives in React Flow, which stays mounted across the switch.) Not persisted.
 */
interface BoardUi {
  tool: Mode;
  color: NoteColor;
  /** null: the default for the layout (shown from md up, hidden on phones). */
  minimap: boolean | null;
  setTool(tool: Mode): void;
  setColor(color: NoteColor): void;
  setMinimap(shown: boolean): void;
}

export const useBoardUi = create<BoardUi>()((set) => ({
  tool: "select",
  color: "yellow",
  minimap: null,
  setTool: (tool) => set({ tool }),
  setColor: (color) => set({ color }),
  setMinimap: (minimap) => set({ minimap }),
}));
