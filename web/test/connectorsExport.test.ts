// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { MAX_NOTE_TEXT } from "@stickyard/shared";
import { applyConnectorsSnapshot } from "../src/connectors/board";
import { exportBoardOf } from "../src/export/ExportSection";
import { boardToMarkdown, type ExportBoard } from "../src/export/markdown";
import { exportItems, keepInExport } from "../src/export/png";
import { applySnapshot, EMPTY_BOARD } from "../src/notes/board";
import { applyShapesSnapshot } from "../src/shapes/board";
import { connector, nid, note, shape, sid } from "./helpers/fakeRelay";

/* Arrows part 2: export. PNG draws the arrows (not their handles or snap points); Markdown lists the connections. */

const DATE = new Date(2026, 9, 14, 9, 0);
const free = (x: number, y: number) => ({ x, y });
const bound = (item: string) => ({ item, anchor: "auto" as const });

const md = (b: Partial<ExportBoard>) => boardToMarkdown({ notes: [], frames: [], shapes: [], results: null, ...b }, DATE);
const section = (text: string) => {
  const lines = text.split("\n");
  const at = lines.indexOf("## Connections");
  return at < 0 ? null : lines.slice(at + 2, lines.findIndex((l, i) => i > at + 1 && l === "") >>> 0);
};

describe("Markdown: Connections", () => {
  const n = (id: string, text: string) => ({ id, x: 0, y: 0, w: 160, h: 160, text });

  it("one line per arrow, A → B, with (free end), from the cleaned, escaped item text; nothing about style", () => {
    const out = md({
      notes: [n("a", "Plan\nthe work"), n("b", "<img src=x onerror=alert(1)>")],
      shapes: [{ id: "s", kind: "diamond", x: 900, y: 0, w: 200, h: 120, text: "Ship?" }],
      connectors: [
        { start: bound("a"), end: bound("b") },
        { start: bound("b"), end: bound("s") },
        { start: free(1, 1), end: bound("a") },
        { start: bound("gone"), end: bound("a") },
      ],
    });
    expect(section(out)).toEqual([
      "- Plan the work → \\<img src=x onerror=alert\\(1\\)\\>",
      "- \\<img src=x onerror=alert\\(1\\)\\> → Ship?",
      "- (free end) → Plan the work",
    ]);
    expect(out).not.toMatch(/dashed|solid|neutral|thick/);
  });

  it("a label near the caps stays one escaped line", () => {
    const long = `# ${"Lorem ipsum [x](http://example.test) ".repeat(20)}`.slice(0, MAX_NOTE_TEXT);
    const out = md({ notes: [n("a", long), n("b", "B")], connectors: [{ start: bound("a"), end: bound("b") }] });
    const line = section(out)?.[0] ?? "";
    expect(line.startsWith("- \\# Lorem ipsum \\[x\\]\\(http\\://example.test\\)")).toBe(true);
    expect(line.endsWith(" → B")).toBe(true);
    expect(line).not.toContain("\n");
  });

  it("no arrows, no section; exportBoardOf carries the arrows", () => {
    expect(section(md({ notes: [n("a", "A")] }))).toBeNull();
    const board = applyConnectorsSnapshot(applySnapshot(EMPTY_BOARD, [note(1)]), [connector(1, bound(nid(1)), free(9, 9))]);
    expect(exportBoardOf(board, null).connectors).toEqual([{ start: bound(nid(1)), end: free(9, 9) }]);
  });
});

describe("PNG: arrows in, UI out", () => {
  it("the arrow layer is drawn; handles, snap points and the drawing preview are left out", () => {
    const layer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    layer.setAttribute("data-connector-layer", "");
    expect(keepInExport(layer)).toBe(true);
    for (const attr of ["data-connector-handle", "data-connector-snap", "data-connector-preview", "data-connector-overlay"]) {
      const el = document.createElement("div");
      el.setAttribute(attr, "");
      expect(keepInExport(el)).toBe(false);
    }
  });

  it("the image's box takes in free ends past the items", () => {
    const board = applyConnectorsSnapshot(applyShapesSnapshot(applySnapshot(EMPTY_BOARD, [note(1)]), [shape(1)]), [
      connector(1, bound(nid(1)), free(2000, 1500)),
      connector(2, bound(sid(1)), bound(nid(1))),
    ]);
    const items = exportItems(board);
    expect(items).toContainEqual({ x: 2000, y: 1500, w: 0, h: 0 });
    expect(items.filter((i) => i.w > 0)).toHaveLength(2);
  });
});
