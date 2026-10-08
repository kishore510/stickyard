import { describe, expect, it, vi } from "vitest";
import { MAX_NOTES_PER_ROOM } from "@stickyard/shared";
import { NOTE_TOOL_REASONS, TOOLS, noteToolReason, toolForKey, toolsFor, type ToolContext } from "../src/canvas/tools";
import { countUnread } from "../src/chat/unread";

const ctx = (patch: Partial<ToolContext> = {}): ToolContext => ({
  tool: "select",
  setTool: vi.fn(),
  addNote: vi.fn(),
  fit: vi.fn(),
  zoomSelection: vi.fn(),
  selectionReason: null,
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  resetZoom: vi.fn(),
  minimap: false,
  toggleMinimap: vi.fn(),
  zoom: 1,
  noteReason: null,
  undo: vi.fn(),
  redo: vi.fn(),
  undoReason: null,
  redoReason: null,
  ...patch,
});

describe("tool registry", () => {
  it("every tool has a unique id, a label and an icon", () => {
    const ids = TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TOOLS) {
      expect(t.label.trim()).not.toBe("");
      expect(t.icon).toBeDefined();
      expect(Object.keys(t.slots).length).toBeGreaterThan(0);
    }
  });

  it("there is no tool rail: from md up the palette panel adds things, and tools live in the view bar", () => {
    for (const t of TOOLS) expect(Object.keys(t.slots).every((s) => s === "viewbar" || s === "ribbon"), t.id).toBe(true);
  });

  it("the desktop view bar has zoom out, zoom level, zoom in, fit, zoom to selection, the Select/Hand toggle and minimap", () => {
    expect(toolsFor("viewbar").map((t) => t.id)).toEqual(["zoom-out", "zoom-reset", "zoom-in", "fit", "zoom-selection", "select", "hand", "minimap"]);
  });

  it("S zooms to the selection (v0.24.0): a key no other tool or shortcut uses; off with nothing selected", () => {
    const shortcuts = TOOLS.flatMap((t) => (t.shortcut ? [t.shortcut] : []));
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
    // D is dot voting, [ and ] the panels.
    expect(shortcuts).not.toContain("D");
    const tool = toolForKey("s");
    expect(tool?.id).toBe("zoom-selection");
    const zoomSelection = vi.fn();
    expect(tool?.disabled?.(ctx({ selectionReason: "why" }))).toBe("why");
    tool?.run(ctx({ zoomSelection }));
    expect(zoomSelection).toHaveBeenCalledOnce();
    expect(tool?.slots.ribbon).toBeUndefined();
  });

  it("the phone ribbon has Add note, fit, the Select/Hand toggle, then Undo and Redo (no zoom buttons)", () => {
    // Ordered as Chalkline's phone toolbar: tool toggle, the main add button, fit; then history.
    expect(toolsFor("ribbon").map((t) => t.id)).toEqual(["select", "hand", "note", "fit", "undo", "redo"]);
    expect(TOOLS.find((t) => t.id === "note")?.primary).toBe(true);
  });

  it("tools run the shared actions", () => {
    const c = ctx();
    const byId = (id: string) => TOOLS.find((t) => t.id === id);
    byId("note")?.run(c);
    byId("fit")?.run(c);
    byId("zoom-in")?.run(c);
    byId("zoom-out")?.run(c);
    byId("zoom-reset")?.run(c);
    byId("minimap")?.run(c);
    byId("hand")?.run(c);
    byId("undo")?.run(c);
    byId("redo")?.run(c);
    expect(c.undo).toHaveBeenCalledOnce();
    expect(c.redo).toHaveBeenCalledOnce();
    expect(byId("undo")?.disabled?.(ctx({ undoReason: "Nothing to undo." }))).toBe("Nothing to undo.");
    expect(toolsFor("viewbar").some((t) => t.id === "undo")).toBe(false);
    expect(c.addNote).toHaveBeenCalledOnce();
    expect(c.fit).toHaveBeenCalledOnce();
    expect(c.zoomIn).toHaveBeenCalledOnce();
    expect(c.zoomOut).toHaveBeenCalledOnce();
    expect(c.resetZoom).toHaveBeenCalledOnce();
    expect(c.toggleMinimap).toHaveBeenCalledOnce();
    expect(c.setTool).toHaveBeenCalledWith("hand");
  });

  it("Hand toggles back to Select; Select and Hand show which is active", () => {
    const hand = TOOLS.find((t) => t.id === "hand");
    const select = TOOLS.find((t) => t.id === "select");
    const c = ctx({ tool: "hand" });
    hand?.run(c);
    expect(c.setTool).toHaveBeenCalledWith("select");
    expect(hand?.pressed?.(c)).toBe(true);
    expect(select?.pressed?.(c)).toBe(false);
    expect(select?.pressed?.(ctx())).toBe(true);
  });

  it("the Note tool is disabled with a reason when the board is full or disconnected", () => {
    expect(noteToolReason({ live: true, count: 0 })).toBeNull();
    expect(noteToolReason({ live: false, count: 0 })).toBe(NOTE_TOOL_REASONS.disconnected);
    expect(noteToolReason({ live: true, count: MAX_NOTES_PER_ROOM })).toBe(NOTE_TOOL_REASONS.full);
    const note = TOOLS.find((t) => t.id === "note");
    expect(note?.disabled?.(ctx({ noteReason: NOTE_TOOL_REASONS.full }))).toBe(NOTE_TOOL_REASONS.full);
    expect(note?.disabled?.(ctx())).toBeNull();
  });

  it("zoom buttons are disabled at the zoom limits", () => {
    const zoomIn = TOOLS.find((t) => t.id === "zoom-in");
    const zoomOut = TOOLS.find((t) => t.id === "zoom-out");
    expect(zoomIn?.disabled?.(ctx({ zoom: 100 }))).not.toBeNull();
    expect(zoomOut?.disabled?.(ctx({ zoom: 0.0001 }))).not.toBeNull();
    expect(zoomIn?.disabled?.(ctx())).toBeNull();
  });
});

describe("chat unread count", () => {
  const msg = (key: number, from: string) => ({ key, from, name: "x", colourIndex: 0, text: "hi" });

  it("counts messages from others after the last one seen", () => {
    const list = [msg(0, "me"), msg(1, "sam"), msg(2, "sam"), msg(3, "me")];
    expect(countUnread(list, -1, "me")).toBe(2);
    expect(countUnread(list, 1, "me")).toBe(1);
    expect(countUnread(list, 3, "me")).toBe(0);
    expect(countUnread([], -1, "me")).toBe(0);
  });
});
