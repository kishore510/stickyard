import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  FRAME_COLORS,
  FRAME_DEFAULTS,
  FRAME_DEFAULT_H,
  FRAME_DEFAULT_W,
  FRAME_MAX_H,
  FRAME_MAX_W,
  FRAME_MIN_H,
  FRAME_MIN_W,
  MAX_FRAME_TITLE,
  NOTE_COLORS,
  NOTE_DEFAULTS,
  cleanFrameTitle,
  cleanNoteText,
  codePointLength,
  truncateCodePoints,
  type FrameColor,
  type NoteColor,
} from "@stickyard/shared";
import type { ImportContent } from "../importer/parse";
import { parseStencil, type StencilFrame, type StencilNote } from "../stencils/data";
import { SETUP_LIMITS } from "./setupPrompt";

/*
 * Board setup from a prompt (v0.43.0): the model's reply, read as untrusted data. Code fences are
 * stripped and JSON.parse is the only reader; then every item is checked against the board-file
 * item format and the caps. Fixable problems are fixed and listed as warnings; a reply with nothing
 * usable is one "unreadable" error. Text is cut to its cap and cleaned with the shared cleaner (the
 * relay's), so what the preview shows is what the board gets. The layout is the model's when it is
 * complete and tidy, otherwise re-done by one fixed rule (layoutSetup), so a bad layout never blocks
 * a good board. The result is Import's content (refs, places from 0, 0), placed by the same path.
 */

export interface PreviewNote {
  ref: string;
  text: string;
  color: NoteColor;
}
export interface PreviewFrame {
  ref: string;
  title: string;
  color: FrameColor;
  notes: PreviewNote[];
}

export interface SetupResult {
  content: ImportContent;
  /** In order, each with its notes. */
  frames: PreviewFrame[];
  /** Notes in no frame. */
  loose: PreviewNote[];
  /** What was fixed, in words. */
  warnings: string[];
  /** The model's layout was missing or untidy, and the fixed rule placed everything. */
  relaidOut: boolean;
}

export type SetupParse = { ok: true; result: SetupResult } | { ok: false; reason: "unreadable" };

/** The room's free capacity, as setupRules.setupFree gives it. */
export interface SetupFree {
  notes: number;
  frames: number;
}

const items = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;
const notes = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;
const was = (n: number) => (n === 1 ? "was" : "were");

export const SETUP_WARNINGS = {
  colour: (n: number) => `${items(n)} had a colour the board doesn’t have, so ${n === 1 ? "it gets" : "they get"} the default.`,
  cut: (n: number) => `${items(n)} ${was(n)} longer than allowed and ${was(n)} cut to fit.`,
  resized: (n: number) => `${n} ${n === 1 ? "frame’s size was" : "frames’ sizes were"} adjusted to the frame limits.`,
  loose: (n: number) => `${notes(n)} named a frame that isn’t there, so ${n === 1 ? "it goes" : "they go"} outside the frames.`,
  renamed: (n: number) => `${n} ${n === 1 ? "frame" : "frames"} shared a name with another; each was kept on its own.`,
  unreadable: (n: number) => `${items(n)} couldn’t be read and ${was(n)} left out.`,
  overCap: (n: number) => `${items(n)} beyond the limit (${SETUP_LIMITS.items} items, at most ${SETUP_LIMITS.frames} frames) ${was(n)} left out.`,
  noRoom: (n: number) => `${items(n)} ${was(n)} left out: the board hasn’t room for more.`,
  relaid: "The layout was redone, because some places were missing or overlapped.",
} as const;

/* ── Layout ─────────────────────────────────────────────────────────── */

const NOTE_W = NOTE_DEFAULTS.w;
const NOTE_H = NOTE_DEFAULTS.h;
/** Inside a frame: the title strip, then notes in a grid with this padding and gap. */
export const SETUP_LAYOUT = { header: 64, pad: 24, gap: 24, frameGap: 80, looseColumns: 8 } as const;
/** The most rows of notes a frame of the largest height holds. */
const MAX_ROWS = Math.floor((FRAME_MAX_H - SETUP_LAYOUT.header - SETUP_LAYOUT.pad + SETUP_LAYOUT.gap) / (NOTE_H + SETUP_LAYOUT.gap));

type Rect = { x: number; y: number; w: number; h: number };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const anyOverlap = (rects: readonly Rect[]) => rects.some((a, i) => rects.slice(i + 1).some((b) => overlaps(a, b)));

interface DraftFrame {
  ref: string;
  title: string;
  color: FrameColor;
  x: number | null;
  y: number | null;
  w: number;
  h: number;
}
interface DraftNote {
  ref: string;
  text: string;
  color: NoteColor;
  frame: string | null;
  x: number | null;
  y: number | null;
}
type Placed<T> = Omit<T, "x" | "y"> & { x: number; y: number };

/** The model's layout, if every place is given and nothing overlaps: notes inside their frame (below its title), loose notes off every frame. */
function modelLayout(frames: readonly DraftFrame[], noteList: readonly DraftNote[]): { frames: Placed<DraftFrame>[]; notes: Placed<DraftNote>[] } | null {
  const placed = <T extends { x: number | null; y: number | null }>(v: T): v is T & { x: number; y: number } => v.x !== null && v.y !== null;
  if (!frames.every(placed) || !noteList.every(placed)) return null;
  const f = frames as Placed<DraftFrame>[];
  const n = noteList as Placed<DraftNote>[];
  const noteRect = (v: Placed<DraftNote>): Rect => ({ x: v.x, y: v.y, w: NOTE_W, h: NOTE_H });
  if (anyOverlap(f) || anyOverlap(n.map(noteRect))) return null;
  for (const note of n) {
    const r = noteRect(note);
    if (note.frame === null) {
      if (f.some((frame) => overlaps(r, frame))) return null;
      continue;
    }
    const frame = f.find((x) => x.ref === note.frame)!;
    const inside = r.x >= frame.x && r.x + r.w <= frame.x + frame.w && r.y >= frame.y + SETUP_LAYOUT.header && r.y + r.h <= frame.y + frame.h;
    if (!inside) return null;
  }
  const all = [...f, ...n.map(noteRect)];
  const minX = Math.min(...all.map((r) => r.x));
  const minY = Math.min(...all.map((r) => r.y));
  const width = Math.max(...all.map((r) => r.x + r.w)) - minX;
  const height = Math.max(...all.map((r) => r.y + r.h)) - minY;
  if (width > BOARD_WIDTH || height > BOARD_HEIGHT) return null;
  return { frames: f.map((v) => ({ ...v, x: v.x - minX, y: v.y - minY })), notes: n.map((v) => ({ ...v, x: v.x - minX, y: v.y - minY })) };
}

/** Columns for `n` notes in one frame: about square, never more rows than the tallest frame holds. */
const columnsFor = (n: number) => Math.max(Math.ceil(Math.sqrt(n)), Math.ceil(n / MAX_ROWS));
const span = (count: number, size: number, gap: number) => count * size + Math.max(0, count - 1) * gap;

/**
 * The fixed rule: each frame sized to its notes (a grid of about square, the default size when it
 * has none), frames left to right in rows of about square count (wrapping before the board's edge),
 * loose notes in a grid below. Depends only on the order and counts, so the same reply gives the
 * same board.
 */
export function layoutSetup(frames: readonly DraftFrame[], noteList: readonly DraftNote[]): { frames: Placed<DraftFrame>[]; notes: Placed<DraftNote>[] } {
  const { header, pad, gap, frameGap, looseColumns } = SETUP_LAYOUT;
  const outFrames: Placed<DraftFrame>[] = [];
  const outNotes: Placed<DraftNote>[] = [];
  const perRow = Math.max(1, Math.ceil(Math.sqrt(frames.length)));
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let inRow = 0;
  for (const frame of frames) {
    const mine = noteList.filter((n) => n.frame === frame.ref);
    const cols = mine.length === 0 ? 0 : columnsFor(mine.length);
    const rows = cols === 0 ? 0 : Math.ceil(mine.length / cols);
    const w = mine.length === 0 ? FRAME_DEFAULT_W : Math.min(FRAME_MAX_W, Math.max(FRAME_MIN_W, 2 * pad + span(cols, NOTE_W, gap)));
    const h = mine.length === 0 ? FRAME_DEFAULT_H : Math.min(FRAME_MAX_H, Math.max(FRAME_MIN_H, header + span(rows, NOTE_H, gap) + pad));
    if (inRow > 0 && (inRow >= perRow || x + w > BOARD_WIDTH)) {
      x = 0;
      y += rowHeight + frameGap;
      rowHeight = 0;
      inRow = 0;
    }
    outFrames.push({ ...frame, x, y, w, h });
    mine.forEach((note, i) => outNotes.push({ ...note, x: x + pad + (i % cols) * (NOTE_W + gap), y: y + header + Math.floor(i / cols) * (NOTE_H + gap) }));
    x += w + frameGap;
    rowHeight = Math.max(rowHeight, h);
    inRow++;
  }
  const loose = noteList.filter((n) => n.frame === null);
  const top = frames.length === 0 ? 0 : y + rowHeight + frameGap;
  const cols = Math.min(looseColumns, Math.max(1, Math.ceil(Math.sqrt(loose.length))));
  loose.forEach((note, i) => outNotes.push({ ...note, x: (i % cols) * (NOTE_W + gap), y: top + Math.floor(i / cols) * (NOTE_H + gap) }));
  // Notes in their reply order (the stacking order), whatever order the frames placed them in.
  const order = new Map(noteList.map((n, i) => [n.ref, i]));
  outNotes.sort((a, b) => order.get(a.ref)! - order.get(b.ref)!);
  return { frames: outFrames, notes: outNotes };
}

/* ── Reading ────────────────────────────────────────────────────────── */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
const between = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The text without a Markdown code fence around it. */
function withoutFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[^\n]*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced ? fenced[1]! : trimmed).trim();
}

/** Text cut to `max` characters and cleaned like typed text; `cut` says whether it was too long. */
function cleanTo(raw: string, max: number, clean: (s: string) => string | null): { text: string; cut: boolean } {
  const cut = codePointLength(raw.trim()) > max;
  return { text: clean(truncateCodePoints(raw.trim(), max)) ?? "", cut };
}

/** The model's reply as a board to preview and place, or "unreadable". `free`: the room's spare notes and frames. */
export function parseSetupReply(text: string, free: SetupFree): SetupParse {
  const unreadable: SetupParse = { ok: false, reason: "unreadable" };
  let raw: unknown;
  try {
    raw = JSON.parse(withoutFences(text));
  } catch {
    return unreadable;
  }
  if (!isRecord(raw)) return unreadable;
  const rawFrames = raw.frames ?? [];
  const rawNotes = raw.notes ?? [];
  if (!Array.isArray(rawFrames) || !Array.isArray(rawNotes)) return unreadable;

  const counts = { colour: 0, cut: 0, resized: 0, loose: 0, renamed: 0, unreadable: 0, overCap: 0, noRoom: 0 };

  // Frames: refs are the page's own (f1, f2...); the model's name each, the first use winning.
  const frames: DraftFrame[] = [];
  const refOf = new Map<string, string>();
  for (const f of rawFrames) {
    if (!isRecord(f) || typeof f.title !== "string") {
      counts.unreadable++;
      continue;
    }
    const ref = `f${frames.length + 1}`;
    if (typeof f.ref === "string") {
      if (refOf.has(f.ref)) counts.renamed++;
      else refOf.set(f.ref, ref);
    }
    const title = cleanTo(f.title, MAX_FRAME_TITLE, cleanFrameTitle);
    if (title.cut) counts.cut++;
    const color = (FRAME_COLORS as readonly unknown[]).includes(f.color) ? (f.color as FrameColor) : "neutral";
    if (color !== f.color) counts.colour++;
    const givenW = whole(f.w) ?? FRAME_DEFAULT_W;
    const givenH = whole(f.h) ?? FRAME_DEFAULT_H;
    const w = between(givenW, FRAME_MIN_W, FRAME_MAX_W);
    const h = between(givenH, FRAME_MIN_H, FRAME_MAX_H);
    if (w !== givenW || h !== givenH) counts.resized++;
    frames.push({ ref, title: title.text, color, x: whole(f.x), y: whole(f.y), w, h });
  }

  const noteList: DraftNote[] = [];
  for (const n of rawNotes) {
    if (!isRecord(n) || typeof n.text !== "string") {
      counts.unreadable++;
      continue;
    }
    const text = cleanTo(n.text, SETUP_LIMITS.noteText, cleanNoteText);
    if (text.cut) counts.cut++;
    const color = (NOTE_COLORS as readonly unknown[]).includes(n.color) ? (n.color as NoteColor) : "yellow";
    if (color !== n.color) counts.colour++;
    let frame: string | null = null;
    if (typeof n.frame === "string") {
      frame = refOf.get(n.frame) ?? null;
      if (frame === null) counts.loose++;
    }
    noteList.push({ ref: `n${noteList.length + 1}`, text: text.text, color, frame, x: whole(n.x), y: whole(n.y) });
  }
  if (frames.length + noteList.length === 0) return unreadable;

  // Caps: at most 8 frames and 60 items, then the room's spare capacity. Frames go first, as they're placed first.
  const frameCap = Math.min(SETUP_LIMITS.frames, frames.length);
  const keptFrames = frames.slice(0, Math.min(frameCap, Math.max(0, free.frames)));
  counts.overCap += frames.length - frameCap;
  counts.noRoom += frameCap - keptFrames.length;
  const noteCap = Math.min(noteList.length, SETUP_LIMITS.items - keptFrames.length);
  const keptNotes = noteList.slice(0, Math.min(noteCap, Math.max(0, free.notes)));
  counts.overCap += noteList.length - noteCap;
  counts.noRoom += noteCap - keptNotes.length;
  // A note whose frame was left out goes outside the frames (counted when its frame was over the cap of 8).
  const kept = new Set(keptFrames.map((f) => f.ref));
  const overCapFrames = new Set(frames.slice(frameCap).map((f) => f.ref));
  for (const note of keptNotes) {
    if (note.frame === null || kept.has(note.frame)) continue;
    if (overCapFrames.has(note.frame)) counts.loose++;
    note.frame = null;
  }
  if (keptFrames.length + keptNotes.length === 0) return unreadable;

  const model = modelLayout(keptFrames, keptNotes);
  const layout = model ?? layoutSetup(keptFrames, keptNotes);

  const stencilFrames: StencilFrame[] = layout.frames.map(({ ref, title, color, x, y, w, h }) => ({ ref, x, y, w, h, title, color, ...FRAME_DEFAULTS }));
  const stencilNotes: StencilNote[] = layout.notes.map(({ ref, text, color, x, y }) => ({ ref, x, y, ...NOTE_DEFAULTS, text, color }));
  const stencil = parseStencil({ id: "setup", name: "Board setup", notes: stencilNotes, shapes: [], frames: stencilFrames, arrows: [], groups: [] });
  if (!stencil) return unreadable;

  const warnings: string[] = [];
  if (counts.unreadable > 0) warnings.push(SETUP_WARNINGS.unreadable(counts.unreadable));
  if (counts.overCap > 0) warnings.push(SETUP_WARNINGS.overCap(counts.overCap));
  if (counts.noRoom > 0) warnings.push(SETUP_WARNINGS.noRoom(counts.noRoom));
  if (counts.cut > 0) warnings.push(SETUP_WARNINGS.cut(counts.cut));
  if (counts.colour > 0) warnings.push(SETUP_WARNINGS.colour(counts.colour));
  if (counts.resized > 0) warnings.push(SETUP_WARNINGS.resized(counts.resized));
  if (counts.renamed > 0) warnings.push(SETUP_WARNINGS.renamed(counts.renamed));
  if (counts.loose > 0) warnings.push(SETUP_WARNINGS.loose(counts.loose));
  if (!model) warnings.push(SETUP_WARNINGS.relaid);

  const preview = (n: StencilNote): PreviewNote => ({ ref: n.ref, text: n.text, color: n.color });
  const frameOf = new Map(keptNotes.map((n) => [n.ref, n.frame]));
  return {
    ok: true,
    result: {
      content: { ...stencil, stack: stencil.notes.map((n) => n.ref), cut: 0 },
      frames: stencil.frames.map((f) => ({ ref: f.ref, title: f.title, color: f.color, notes: stencil.notes.filter((n) => frameOf.get(n.ref) === f.ref).map(preview) })),
      loose: stencil.notes.filter((n) => frameOf.get(n.ref) === null).map(preview),
      warnings,
      relaidOut: !model,
    },
  };
}
