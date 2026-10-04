import { FRAME_STYLE_FIELDS, type Frame, type FrameColor } from "@stickyard/shared";

/*
 * Templates: ready-made sets of frames, as plain data (trusted, written here). A new template is
 * one entry in TEMPLATES; its palette tile follows from it (palette/registry.ts). Applying one
 * goes through the normal frame path (RoomSession.applyTemplate): each frame is added, then
 * resized and styled once the relay confirms it, so titles are cleaned like any other.
 *
 * Template units are board units, with the template's top-left at 0, 0. Every template fits on
 * the board, and every frame is within the frame size limits (test/templates.test.ts).
 */

/** A frame title's style keys (protocol v10). */
export type FrameTitleStyle = Pick<Frame, (typeof FRAME_STYLE_FIELDS)[number]>;

export interface TemplateFrame {
  /** At most MAX_FRAME_TITLE characters, one line. */
  title: string;
  color: FrameColor;
  x: number;
  y: number;
  w: number;
  h: number;
  style: FrameTitleStyle;
}

export interface Template {
  id: string;
  /** The tile's visible label and accessible name. */
  label: string;
  /** Extra words palette search matches. */
  keywords: readonly string[];
  frames: readonly TemplateFrame[];
}

/** Column and heading titles: large, bold, centred. */
const HEADING: FrameTitleStyle = { titleFontSize: "l", titleBold: true, titleItalic: false, titleTextColor: "auto", titleAlign: "center" };
/** The one-line goal above a sprint: the largest size. */
const BANNER: FrameTitleStyle = { ...HEADING, titleFontSize: "xl" };

const COLUMN_W = 480;
const GAP = 40;
/** Three columns side by side, `h` tall, starting at `y`. */
const columns = (y: number, h: number, cols: readonly [title: string, color: FrameColor][]): TemplateFrame[] =>
  cols.map(([title, color], i) => ({ title, color, x: i * (COLUMN_W + GAP), y, w: COLUMN_W, h, style: HEADING }));

const QUADRANT_W = 600;
const QUADRANT_H = 440;

export const TEMPLATES: readonly Template[] = [
  {
    id: "retro",
    label: "Retro",
    keywords: ["retro", "retrospective", "went well", "didn't go well", "actions", "review", "columns"],
    frames: columns(0, 720, [
      ["Went well", "green"],
      ["Didn't go well", "pink"],
      ["Actions", "blue"],
    ]),
  },
  {
    id: "start-stop-continue",
    label: "Start Stop Continue",
    keywords: ["start", "stop", "continue", "retro", "retrospective", "feedback", "columns"],
    frames: columns(0, 720, [
      ["Start", "green"],
      ["Stop", "orange"],
      ["Continue", "purple"],
    ]),
  },
  {
    id: "impact-effort",
    label: "2x2 Impact and Effort",
    keywords: ["2x2", "matrix", "quadrant", "impact", "effort", "prioritise", "prioritize", "priority", "quick wins"],
    frames: [
      { title: "Quick wins: high impact, low effort", color: "green", x: 0, y: 0, w: QUADRANT_W, h: QUADRANT_H, style: HEADING },
      { title: "Major projects: high impact, high effort", color: "blue", x: QUADRANT_W + GAP, y: 0, w: QUADRANT_W, h: QUADRANT_H, style: HEADING },
      { title: "Fill-ins: low impact, low effort", color: "yellow", x: 0, y: QUADRANT_H + GAP, w: QUADRANT_W, h: QUADRANT_H, style: HEADING },
      { title: "Thankless tasks: low impact, high effort", color: "pink", x: QUADRANT_W + GAP, y: QUADRANT_H + GAP, w: QUADRANT_W, h: QUADRANT_H, style: HEADING },
    ],
  },
  {
    id: "sprint-planning",
    label: "Sprint planning",
    keywords: ["sprint", "planning", "plan", "goal", "agile", "scrum", "kanban", "backlog", "candidates", "committed", "risks", "questions"],
    frames: [
      { title: "Sprint goal", color: "yellow", x: 0, y: 0, w: 3 * COLUMN_W + 2 * GAP, h: 200, style: BANNER },
      ...columns(200 + GAP, 560, [
        ["Candidates", "neutral"],
        ["Committed", "green"],
        ["Risks and questions", "orange"],
      ]),
    ],
  },
];
