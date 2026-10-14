// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { NOTE_DEFAULTS, type Group, type Note } from "@stickyard/shared";
import { boardToMarkdown, type ExportBoard } from "../src/export/markdown";
import { exportItems, keepInExport } from "../src/export/png";
import { exportBoardOf } from "../src/export/ExportSection";
import { EMPTY_BOARD, applySnapshot } from "../src/notes/board";
import { applyGroupsSnapshot } from "../src/groups/board";
import { GROUP_PAD } from "../src/groups/geometry";

/*
 * Groups part 2: export. The PNG draws group boxes (never the chip's UI: focus, editing, the
 * selected outline); the Markdown file lists each group as a sub-list under its label, inside the
 * frame section its box's centre falls in. Every label and item text is cleaned and escaped.
 */

const HOSTILE = "<img src=x onerror=alert(1)>";
const DATE = new Date(2026, 9, 14);
const n = (id: string, x: number, y: number, text: string) => ({ id, x, y, w: 200, h: 160, text });

const base: ExportBoard = {
  notes: [n("a", 100, 100, "Loose"), n("b", 100, 400, "Kept"), n("c", 400, 400, HOSTILE), n("d", 2000, 2000, "Far")],
  frames: [{ id: "F", x: 0, y: 0, w: 900, h: 900, title: "Retro" }],
  shapes: [{ id: "s", kind: "rect", x: 2300, y: 2000, w: 200, h: 120, text: "Step" }],
  results: null,
};

describe("Markdown export with groups", () => {
  it("is unchanged without groups", () => {
    expect(boardToMarkdown({ ...base, groups: [] }, DATE)).toBe(boardToMarkdown(base, DATE));
  });

  it("lists a group as a sub-list under its label in the frame its box's centre is in; its items aren't listed twice", () => {
    const md = boardToMarkdown({ ...base, groups: [{ label: HOSTILE, members: ["b", "c"] }, { label: "", members: ["d", "s"] }] }, DATE);
    const retro = md.slice(md.indexOf("## Retro"), md.indexOf("## Not in a frame"));
    expect(retro).toContain("- **Loose**");
    expect(retro).toContain("- Group: \\<img src=x onerror=alert\\(1\\)\\>\n  - **Kept**\n  - **\\<img src=x onerror=alert\\(1\\)\\>**");
    expect(md.match(/Kept/g)).toHaveLength(1);
    const loose = md.slice(md.indexOf("## Not in a frame"));
    expect(loose).toContain("- Group: *Untitled group*\n  - **Far**\n  - Rectangle: Step");
    // A grouped shape isn't listed again under Labels and shapes.
    expect(md).not.toContain("## Labels and shapes");
    expect(md).not.toMatch(/(^|[^\\])<img/);
  });
});

describe("PNG export with groups", () => {
  it("the image holds every group box; the chip's UI parts are left out", () => {
    const note = (id: string, x: number, y: number): Note => ({ id, x, y, ...NOTE_DEFAULTS, text: "", color: "yellow", z: 0, rev: 1, authorId: "A" });
    const group: Group = { id: "G", label: "", color: "blue", members: ["a", "b"], rev: 1 };
    const board = applyGroupsSnapshot(applySnapshot(EMPTY_BOARD, [note("a", 100, 100), note("b", 400, 100)]), [group]);
    expect(exportItems(board)).toContainEqual({ x: 100 - GROUP_PAD, y: 100 - GROUP_PAD, w: 300 + NOTE_DEFAULTS.w + 2 * GROUP_PAD, h: NOTE_DEFAULTS.h + 2 * GROUP_PAD });
    const el = (attr: string) => {
      const e = document.createElement("div");
      e.setAttribute(attr, "");
      return e;
    };
    expect(keepInExport(el("data-group-box"))).toBe(true);
    expect(keepInExport(el("data-group-edit"))).toBe(false);
    expect(keepInExport(el("data-group-selected"))).toBe(false);
    expect(exportBoardOf(board, null).groups).toEqual([{ label: "", members: ["a", "b"] }]);
  });
});
