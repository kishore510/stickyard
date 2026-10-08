import { FRAME_STYLE_FIELDS, type Frame, type FrameColor } from "@stickyard/shared";

/*
 * Templates: ready-made sets of frames, as plain data (trusted, written here). A new template is
 * one entry in TEMPLATES; its palette tile follows from it (palette/registry.ts). Applying one
 * goes through RoomSession.applyTemplate, which sends every frame with its size, title and title
 * style in one itemsAdd (protocol v11), so titles are cleaned like any other and the frames appear
 * at once.
 *
 * Template units are board units, with the template's top-left at 0, 0. Every template fits on
 * the board, and every frame is within the frame size limits (test/templates.test.ts).
 *
 * Every template belongs to one group (TEMPLATE_GROUPS). The palette lists each group as its own
 * section headed by the group's name (palette/registry.ts), entries in registry order, so entries
 * here are kept group by group, groups in TEMPLATE_GROUPS order.
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

/** The template groups, in palette order. `categoryId` is the group's palette category. */
export const TEMPLATE_GROUPS = [
  { label: "Retros", categoryId: "templates-retros" },
  { label: "Planning and facilitation", categoryId: "templates-planning" },
  { label: "Architecture and analysis", categoryId: "templates-architecture" },
] as const;

export type TemplateGroup = (typeof TEMPLATE_GROUPS)[number]["label"];

export interface Template {
  id: string;
  /** The palette section it's listed under. */
  group: TemplateGroup;
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
/** Columns side by side (three, or four), `h` tall, starting at `y`. */
const columns = (y: number, h: number, cols: readonly [title: string, color: FrameColor][]): TemplateFrame[] =>
  cols.map(([title, color], i) => ({ title, color, x: i * (COLUMN_W + GAP), y, w: COLUMN_W, h, style: HEADING }));

const QUADRANT_W = 600;
const QUADRANT_H = 440;
/** A 2 x 2 matrix: top left, top right, bottom left, bottom right. */
const quadrants = (cells: readonly [title: string, color: FrameColor][]): TemplateFrame[] =>
  cells.map(([title, color], i) => ({
    title,
    color,
    x: (i % 2) * (QUADRANT_W + GAP),
    y: Math.floor(i / 2) * (QUADRANT_H + GAP),
    w: QUADRANT_W,
    h: QUADRANT_H,
    style: HEADING,
  }));

/** The width of three columns and their gaps: a banner over them spans this. */
const THREE_W = 3 * COLUMN_W + 2 * GAP;
/** A row of `cols` column-wide frames, `QUADRANT_H` tall, at `y`, shifted right by `x`. */
const row = (x: number, y: number, cols: readonly [title: string, color: FrameColor][]): TemplateFrame[] =>
  cols.map(([title, color], i) => ({ title, color, x: x + i * (COLUMN_W + GAP), y, w: COLUMN_W, h: QUADRANT_H, style: HEADING }));

export const TEMPLATES: readonly Template[] = [
  /* ── Retros ── */
  {
    id: "retro",
    group: "Retros",
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
    group: "Retros",
    label: "Start Stop Continue",
    keywords: ["start", "stop", "continue", "retro", "retrospective", "feedback", "columns"],
    frames: columns(0, 720, [
      ["Start", "green"],
      ["Stop", "orange"],
      ["Continue", "purple"],
    ]),
  },
  {
    id: "mad-sad-glad",
    group: "Retros",
    label: "Mad Sad Glad",
    keywords: ["mad", "sad", "glad", "feelings", "emotions", "retro", "retrospective", "columns"],
    frames: columns(0, 720, [
      ["Mad", "pink"],
      ["Sad", "blue"],
      ["Glad", "green"],
    ]),
  },
  {
    id: "four-ls",
    group: "Retros",
    label: "4Ls",
    keywords: ["4ls", "four ls", "liked", "learned", "learnt", "lacked", "longed for", "retro", "retrospective", "columns"],
    frames: columns(0, 720, [
      ["Liked", "green"],
      ["Learned", "blue"],
      ["Lacked", "pink"],
      ["Longed for", "purple"],
    ]),
  },
  {
    id: "starfish",
    group: "Retros",
    label: "Starfish",
    keywords: ["starfish", "keep", "less of", "more of", "start", "stop", "retro", "retrospective"],
    frames: [
      ...row(0, 0, [
        ["Keep", "green"],
        ["Less of", "orange"],
        ["More of", "blue"],
      ]),
      // The two below are centred under the three.
      ...row((THREE_W - (2 * COLUMN_W + GAP)) / 2, QUADRANT_H + GAP, [
        ["Start", "purple"],
        ["Stop", "pink"],
      ]),
    ],
  },
  {
    id: "sailboat",
    group: "Retros",
    label: "Sailboat",
    keywords: ["sailboat", "speedboat", "boat", "goal", "wind", "anchors", "rocks", "risks", "retro", "retrospective"],
    frames: [
      { title: "Goal", color: "yellow", x: 0, y: 0, w: THREE_W, h: 200, style: BANNER },
      ...columns(200 + GAP, 560, [
        ["Wind (helps us)", "green"],
        ["Anchors (slow us)", "orange"],
        ["Rocks (risks)", "pink"],
      ]),
    ],
  },
  /* ── Planning and facilitation ── */
  {
    id: "sprint-planning",
    group: "Planning and facilitation",
    label: "Sprint planning",
    keywords: ["sprint", "planning", "plan", "goal", "agile", "scrum", "kanban", "backlog", "candidates", "committed", "risks", "questions"],
    frames: [
      { title: "Sprint goal", color: "yellow", x: 0, y: 0, w: THREE_W, h: 200, style: BANNER },
      ...columns(200 + GAP, 560, [
        ["Candidates", "neutral"],
        ["Committed", "green"],
        ["Risks and questions", "orange"],
      ]),
    ],
  },
  {
    id: "impact-effort",
    group: "Planning and facilitation",
    label: "2x2 Impact and Effort",
    keywords: ["2x2", "matrix", "quadrant", "impact", "effort", "prioritise", "prioritize", "priority", "quick wins"],
    frames: quadrants([
      ["Quick wins: high impact, low effort", "green"],
      ["Major projects: high impact, high effort", "blue"],
      ["Fill-ins: low impact, low effort", "yellow"],
      ["Thankless tasks: low impact, high effort", "pink"],
    ]),
  },
  {
    id: "lean-coffee",
    group: "Planning and facilitation",
    label: "Lean coffee",
    keywords: ["lean coffee", "coffee", "agenda", "topics", "to discuss", "discussing", "discussed", "meeting", "kanban", "columns"],
    frames: columns(0, 720, [
      ["To discuss", "yellow"],
      ["Discussing", "blue"],
      ["Discussed", "green"],
    ]),
  },
  /* ── Architecture and analysis ── */
  {
    id: "swot",
    group: "Architecture and analysis",
    label: "SWOT",
    keywords: ["swot", "strengths", "weaknesses", "opportunities", "threats", "2x2", "matrix", "quadrant", "analysis", "strategy"],
    // Rows: internal on top, external below. Columns: helpful on the left, harmful on the right.
    frames: quadrants([
      ["Strengths: internal, helpful", "green"],
      ["Weaknesses: internal, harmful", "pink"],
      ["Opportunities: external, helpful", "blue"],
      ["Threats: external, harmful", "orange"],
    ]),
  },
  {
    id: "time",
    group: "Architecture and analysis",
    label: "TIME",
    keywords: ["time", "tolerate", "invest", "migrate", "eliminate", "application", "portfolio", "rationalisation", "rationalization", "2x2", "matrix", "quadrant"],
    // Business value up, technical fit to the right.
    frames: quadrants([
      ["Migrate: high value, poor fit", "blue"],
      ["Invest: high value, good fit", "green"],
      ["Eliminate: low value, poor fit", "pink"],
      ["Tolerate: low value, good fit", "yellow"],
    ]),
  },
  {
    id: "migration-strategy",
    group: "Architecture and analysis",
    label: "Migration strategy",
    keywords: ["migration", "strategy", "cloud", "rehost", "replatform", "refactor", "repurchase", "retire", "retain", "6 rs", "six rs"],
    frames: [
      ...row(0, 0, [
        ["Rehost: move as it is", "blue"],
        ["Replatform: move with small changes", "purple"],
        ["Refactor: rebuild for the new platform", "green"],
      ]),
      ...row(0, QUADRANT_H + GAP, [
        ["Repurchase: replace with a product", "orange"],
        ["Retire: switch off", "pink"],
        ["Retain: keep as it is for now", "yellow"],
      ]),
    ],
  },
  {
    id: "tech-radar",
    group: "Architecture and analysis",
    label: "Technology radar",
    keywords: ["technology", "tech", "radar", "adopt", "trial", "assess", "hold", "tools", "platforms", "columns"],
    frames: columns(0, 720, [
      ["Adopt", "green"],
      ["Trial", "blue"],
      ["Assess", "yellow"],
      ["Hold", "pink"],
    ]),
  },
  {
    id: "raid",
    group: "Architecture and analysis",
    label: "RAID",
    keywords: ["raid", "risks", "assumptions", "issues", "dependencies", "log", "project", "columns"],
    frames: columns(0, 720, [
      ["Risks", "pink"],
      ["Assumptions", "yellow"],
      ["Issues", "orange"],
      ["Dependencies", "blue"],
    ]),
  },
  {
    id: "architecture-decision",
    group: "Architecture and analysis",
    label: "Architecture decision",
    keywords: ["architecture", "decision", "record", "adr", "context", "options", "consequences", "design", "columns"],
    frames: columns(0, 720, [
      ["Context", "neutral"],
      ["Options", "blue"],
      ["Decision", "green"],
      ["Consequences", "orange"],
    ]),
  },
];
