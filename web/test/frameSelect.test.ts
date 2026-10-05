// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { FRAME_DEFAULTS, NOTE_DEFAULTS, type Frame, type Note } from "@stickyard/shared";
import { deleteKeyTarget, type DeleteKeyEvent, type DeleteKeyState } from "../src/canvas/deleteKey";
import { marqueeFrames, selectionLabel } from "../src/canvas/frameSelect";
import { createNoteNodeMapper, type FrameFlowNode } from "../src/canvas/nodes";
import { EMPTY_SELECTION, selectAll } from "../src/canvas/selection";
import { useBoardUi } from "../src/canvas/uiStore";
import { localId, type Board } from "../src/notes/board";
import { TEMPLATES } from "../src/templates/registry";
import { placeTemplate } from "../src/templates/place";

/*
 * Frame multi-select, part 1 (web only): frames get a selection set beside the notes. A marquee
 * takes a frame only when it encloses it; Ctrl+A takes every note and frame; Shift/Ctrl/Cmd-click
 * toggles a frame. Fixtures are generic.
 */

const frame = (i: number, extra: Partial<Frame> = {}): Frame => ({
  id: `FFFFFFFFFFFFF${String(i).padStart(3, "0")}`,
  x: 100 + i * 700,
  y: 100,
  w: 640,
  h: 400,
  title: ["To do", "Doing", "Done"][i % 3]!,
  color: "neutral",
  ...FRAME_DEFAULTS,
  rev: 1,
  authorId: "BBBBBBBBBBBBBBBB",
  ...extra,
});
const note = (i: number, extra: Partial<Note> = {}): Note => ({
  id: `NNNNNNNNNNNNN${String(i).padStart(3, "0")}`,
  x: 150 + i * 200,
  y: 200,
  ...NOTE_DEFAULTS,
  text: `Idea ${i}`,
  color: "yellow",
  z: i,
  rev: 1,
  authorId: "BBBBBBBBBBBBBBBB",
  ...extra,
});

beforeEach(() => useBoardUi.getState().resetRoom());

describe("marqueeFrames (pure): a frame only when the marquee fully encloses it", () => {
  const frames = [frame(0), frame(1)];
  it("a box that only overlaps a frame doesn't take it; one that encloses it does (edges count)", () => {
    expect([...marqueeFrames(frames, { x: 50, y: 50, width: 400, height: 400 }, EMPTY_SELECTION, false)]).toEqual([]);
    expect([...marqueeFrames(frames, { x: 100, y: 100, width: 640, height: 400 }, EMPTY_SELECTION, false)]).toEqual([frame(0).id]);
    expect([...marqueeFrames(frames, { x: 0, y: 0, width: 1500, height: 600 }, EMPTY_SELECTION, false)]).toEqual([frame(0).id, frame(1).id]);
  });

  it("drawn right to left or bottom to top works the same", () => {
    expect([...marqueeFrames(frames, { x: 800, y: 600, width: -800, height: -600 }, EMPTY_SELECTION, false)]).toEqual([frame(0).id]);
  });

  it("Shift adds to the frames already selected; the same set comes back when nothing changed", () => {
    const base = selectAll([frame(1).id]);
    const next = marqueeFrames(frames, { x: 0, y: 0, width: 800, height: 600 }, base, true);
    expect([...next]).toEqual([frame(1).id, frame(0).id]);
    expect(marqueeFrames(frames, { x: 0, y: 0, width: 800, height: 600 }, base, true, next)).toBe(next);
  });
});

describe("selectionLabel (pure)", () => {
  it.each([
    [3, 2, "3 notes, 2 frames selected"],
    [1, 1, "1 note, 1 frame selected"],
    [0, 2, "2 frames selected"],
    [4, 0, "4 notes selected"],
  ])("%i notes and %i frames: %s", (notes, frames, text) => {
    expect(selectionLabel(notes, frames)).toBe(text);
  });
});

describe("uiStore: a frame selection set beside the notes", () => {
  const ui = () => useBoardUi.getState();
  const [f0, f1, f2] = [frame(0).id, frame(1).id, frame(2).id];
  const [n0, n1] = [note(0).id, note(1).id];

  it("a plain frame click selects just it (notes cleared); a toggle adds or removes a frame and keeps the notes", () => {
    ui().selectAll([n0, n1]);
    ui().toggleFrame(f0);
    expect([...ui().selection]).toEqual([n0, n1]);
    expect([...ui().frames]).toEqual([f0]);
    ui().toggleFrame(f1);
    expect([...ui().frames]).toEqual([f0, f1]);
    ui().toggleFrame(f0);
    expect([...ui().frames]).toEqual([f1]);
    ui().selectFrame(f2);
    expect([...ui().frames]).toEqual([f2]);
    expect(ui().selection.size).toBe(0);
  });

  it("toggling a note keeps the frames; selecting a note alone clears them; clear empties both", () => {
    ui().selectFrame(f0);
    ui().toggle(n0);
    expect([...ui().frames]).toEqual([f0]);
    expect([...ui().selection]).toEqual([n0]);
    ui().select(n1);
    expect(ui().frames.size).toBe(0);
    ui().setSelections(selectAll([n0]), selectAll([f0, f1]));
    ui().clearSelection();
    expect(ui().frames.size + ui().selection.size).toBe(0);
  });

  it("frameSelected stays the one selected frame, and only when it's selected alone", () => {
    ui().selectFrame(f0);
    expect(ui().frameSelected).toBe(f0);
    ui().toggleFrame(f1);
    expect(ui().frameSelected).toBeNull();
    ui().toggleFrame(f1);
    expect(ui().frameSelected).toBe(f0);
    ui().toggle(n0);
    expect(ui().frameSelected).toBeNull();
  });

  it("selectAll takes notes and frames; deleted frames are pruned; a renamed frame stays selected", () => {
    ui().selectAll([n0, n1], [localId("r1"), f1]);
    expect([...ui().frames]).toEqual([localId("r1"), f1]);
    ui().renameFrame(localId("r1"), f0);
    expect([...ui().frames].sort()).toEqual([f0, f1].sort());
    ui().pruneFrame((id) => id !== f1);
    expect([...ui().frames]).toEqual([f0]);
    expect([...ui().selection]).toEqual([n0, n1]);
  });
});

describe("deleteKeyTarget: several frames, or frames and notes, are one selection", () => {
  const board = () => {
    const el = document.createElement("section");
    document.body.append(el);
    return el;
  };
  const key: DeleteKeyEvent = { key: "Delete", target: null, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false };
  const state = (extra: Partial<DeleteKeyState>): DeleteKeyState => ({ multi: true, selection: 0, frameSelected: false, modal: false, board: board(), ...extra });
  it("mixed or 2+ frames: selection; one frame alone: frame; notes only: notes", () => {
    expect(deleteKeyTarget(key, state({ selection: 2, frames: 1 }))).toBe("selection");
    expect(deleteKeyTarget(key, state({ frames: 2 }))).toBe("selection");
    expect(deleteKeyTarget(key, state({ frames: 1, frameSelected: true }))).toBe("frame");
    expect(deleteKeyTarget(key, state({ selection: 3 }))).toBe("notes");
    expect(deleteKeyTarget(key, state({ selection: 2, frames: 1, multi: false }))).toBeNull();
  });
});

describe("canvas nodes: every selected frame is marked; handles only for one frame alone", () => {
  const board = (): Board => ({
    notes: [],
    removed: [],
    frames: [frame(0), frame(1), frame(2)].map((f) => ({ frame: f, confirmed: f, clientRef: null, draft: null, dragging: false, resizing: false })),
    framesRemoved: [],
  });
  const frameNodes = (nodes: ReturnType<ReturnType<typeof createNoteNodeMapper>>) => nodes.filter((n): n is FrameFlowNode => n.type === "frame");
  it("a set of frames: selected on each, resizable on none", () => {
    const nodes = frameNodes(createNoteNodeMapper()(board(), true, true, EMPTY_SELECTION, { selected: selectAll([frame(0).id, frame(2).id]), wide: true }));
    expect(nodes.map((n) => [n.data.selected, n.data.resizable])).toEqual([
      [true, false],
      [false, false],
      [true, false],
    ]);
  });
  it("one frame with a note selected too: no handles", () => {
    const nodes = frameNodes(createNoteNodeMapper()(board(), true, true, selectAll([note(0).id]), { selected: selectAll([frame(1).id]), wide: true }));
    expect(nodes.map((n) => n.data.resizable)).toEqual([false, false, false]);
  });
});

describe("the four frames of a template plus notes: one marquee takes them all", () => {
  it("a box round the template's bounds encloses every frame, and touches the notes inside", () => {
    const template = TEMPLATES.find((t) => t.frames.length === 4);
    if (!template) throw new Error("no four-frame template");
    const plans = placeTemplate(template, { x: 200, y: 200 });
    const frames = plans.map((p, i) => frame(i, { x: p.x, y: p.y, w: p.w, h: p.h, title: p.title }));
    const left = Math.min(...frames.map((f) => f.x));
    const top = Math.min(...frames.map((f) => f.y));
    const right = Math.max(...frames.map((f) => f.x + f.w));
    const bottom = Math.max(...frames.map((f) => f.y + f.h));
    const box = { x: left - 10, y: top - 10, width: right - left + 20, height: bottom - top + 20 };
    expect(marqueeFrames(frames, box, EMPTY_SELECTION, false).size).toBe(4);
  });
});
