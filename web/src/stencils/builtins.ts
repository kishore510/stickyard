import { CONNECTOR_DEFAULTS, FRAME_DEFAULTS, NOTE_DEFAULTS, shapeDefaults, type FrameColor, type NoteColor, type ShapeKind } from "@stickyard/shared";
import type { Stencil, StencilArrow, StencilEnd, StencilFrame, StencilNote, StencilShape } from "./data";

/*
 * The built-in stencils (v0.39.0): small, generic areas to drop in, written as data in the
 * stencil format (stencils/data.ts) and checked through the same parser as saved ones (test).
 * Board units, top-left at 0, 0. Generic wording only.
 */

const note = (ref: string, x: number, y: number, color: NoteColor, text = ""): StencilNote => ({ ref, x, y, ...NOTE_DEFAULTS, text, color });
const shape = (ref: string, kind: ShapeKind, x: number, y: number, text: string): StencilShape => ({ ref, kind, x, y, ...shapeDefaults(kind), text });
const frame = (ref: string, x: number, y: number, w: number, h: number, title: string, color: FrameColor): StencilFrame => ({
  ref,
  x,
  y,
  w,
  h,
  title,
  color,
  ...FRAME_DEFAULTS,
  titleFontSize: "l",
  titleAlign: "center",
});
const on = (ref: string, anchor: "auto" | "top" | "right" | "bottom" | "left" = "auto"): StencilEnd => ({ ref, anchor });
const arrow = (start: StencilEnd, end: StencilEnd, extra: Partial<StencilArrow> = {}): StencilArrow => ({ start, end, ...CONNECTOR_DEFAULTS, ...extra });

const W = NOTE_DEFAULTS.w;
const GAP = 40;

export const BUILTIN_STENCILS: readonly Stencil[] = [
  {
    id: "labelled-area",
    name: "Labelled area",
    frames: [frame("f1", 0, 0, 3 * W + 4 * GAP, W + 140, "Topic", "neutral")],
    notes: [note("n1", GAP, 100, "yellow"), note("n2", 2 * GAP + W, 100, "yellow"), note("n3", 3 * GAP + 2 * W, 100, "yellow")],
    shapes: [],
    arrows: [],
    groups: [],
  },
  {
    id: "flow",
    name: "Three-step flow",
    frames: [],
    notes: [],
    shapes: [shape("s1", "rect", 0, 0, "Step 1"), shape("s2", "rect", 300, 0, "Step 2"), shape("s3", "rect", 600, 0, "Step 3")],
    arrows: [arrow(on("s1", "right"), on("s2", "left")), arrow(on("s2", "right"), on("s3", "left"))],
    groups: [],
  },
  {
    id: "note-cluster",
    name: "Note cluster",
    frames: [],
    notes: [note("n1", 0, 0, "blue"), note("n2", W + GAP, 0, "blue"), note("n3", 0, W + GAP, "blue"), note("n4", W + GAP, W + GAP, "blue")],
    shapes: [],
    arrows: [],
    groups: [{ label: "Theme", color: "blue", members: ["n1", "n2", "n3", "n4"] }],
  },
  {
    id: "decision",
    name: "Decision",
    frames: [frame("f1", 0, 0, 760, 520, "Decision", "orange")],
    shapes: [shape("s1", "diamond", 280, 90, "Question?")],
    notes: [note("n1", 80, 310, "green", "Option A"), note("n2", 520, 310, "pink", "Option B")],
    arrows: [arrow(on("s1", "left"), on("n1", "top")), arrow(on("s1", "right"), on("n2", "top"))],
    groups: [],
  },
  {
    id: "pros-cons",
    name: "Pros and cons",
    frames: [frame("f1", 0, 0, 2 * W + 3 * GAP + W + 3 * GAP, 2 * W + 220, "Pros and cons", "neutral")],
    shapes: [shape("s1", "text", GAP, 90, "Pros"), shape("s2", "text", 2 * W + 4 * GAP, 90, "Cons")],
    notes: [
      note("n1", GAP, 160, "green"),
      note("n2", GAP, 200 + W, "green"),
      note("n3", 2 * W + 4 * GAP, 160, "pink"),
      note("n4", 2 * W + 4 * GAP, 200 + W, "pink"),
    ],
    arrows: [],
    groups: [
      { label: "Pros", color: "green", members: ["n1", "n2"] },
      { label: "Cons", color: "pink", members: ["n3", "n4"] },
    ],
  },
];
