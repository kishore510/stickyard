import { describe, expect, it, vi } from "vitest";
import { MAX_NOTES_PER_ROOM } from "@stickyard/shared";
import { NOTE_TOOL_REASONS, TOOLS, noteToolReason, toolsFor, type ToolContext } from "../src/canvas/tools";
import { countUnread } from "../src/chat/unread";

const ctx = (patch: Partial<ToolContext> = {}): ToolContext => ({
  tool: "select",
  setTool: vi.fn(),
  addNote: vi.fn(),
  fit: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  resetZoom: vi.fn(),
  minimap: false,
  toggleMinimap: vi.fn(),
  zoom: 1,
  noteReason: null,
  ...patch,
});

describe("tool registry", () => {
  it("every tool has a unique id, a label and an icon", () => {
    const ids = TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TOOLS) {
      expect(t.label.trim()).not.toBe("");
      expect(t.icon).toBeDefined();
      expect(t.surfaces.length).toBeGreaterThan(0);
    }
  });

  it("the desktop rail has Select, Hand and Note", () => {
    expect(toolsFor("rail").map((t) => t.id)).toEqual(["select", "hand", "note"]);
  });

  it("the desktop view bar has zoom out, zoom level, zoom in, fit, hand and minimap", () => {
    expect(toolsFor("viewbar").map((t) => t.id)).toEqual(["zoom-out", "zoom-reset", "zoom-in", "fit", "hand", "minimap"]);
  });

  it("the phone ribbon has Add note, fit and the hand toggle (no zoom buttons)", () => {
    expect(toolsFor("ribbon").map((t) => t.id)).toEqual(["note", "fit", "hand"]);
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
